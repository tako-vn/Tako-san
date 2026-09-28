import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScanHarness, fixtureImage, providerFailure, scanIdOf, usableItem, type ScanHarness } from '../helpers/scan-quota-harness';
import { processScanJob } from '../../src/worker/services/scan-queue';
import { reconcileStaleScanReservations } from '../../src/worker/services/scan-quota';

// ADR-039 matrix (brief cases A-J): reserve when a valid command is accepted,
// consume in the consumer's fenced `ready` commit, release on terminal failure.
const ai = vi.hoisted(() => ({ vision: vi.fn(), receiptScan: vi.fn() }));
vi.mock('@frigo/ai', () => ({
  AIRouter: class {
    vision = ai.vision;
    receiptScan = ai.receiptScan;
  },
}));

type StatusBody = { scan: Record<string, unknown> & { items: Array<Record<string, unknown>> } };

describe('async scan quota lifecycle (ADR-039)', () => {
  let h: ScanHarness;

  beforeEach(() => {
    h = createScanHarness();
    ai.vision.mockReset();
    ai.receiptScan.mockReset();
  });

  afterEach(() => h.db.close());

  async function accepted(cookie: string, type: 'fridge' | 'food' | 'receipt', key: string) {
    const response = await h.postScan(cookie, type, key);
    expect(response.status).toBe(202);
    return scanIdOf(response);
  }

  async function status(cookie: string, scanId: string) {
    const response = await h.getScan(cookie, scanId);
    expect(response.status).toBe(200);
    return (await response.json() as StatusBody).scan;
  }

  const onlyScanId = (userId: string) => h.db.query<{ id: string }>('SELECT id FROM scans WHERE user_id = ?', userId)[0].id;

  it('A: holds the reservation while queued and consumes it exactly once on ready', async () => {
    const guest = await h.createGuest();
    ai.vision.mockResolvedValueOnce({ items: [usableItem] });
    const scanId = await accepted(guest.cookie, 'fridge', 'case-a');
    expect(h.ledger(scanId)).toBe('reserved');
    expect(await status(guest.cookie, scanId)).toMatchObject({ status: 'pending', quotaStatus: 'reserved' });
    expect(await h.subscription(guest.cookie)).toMatchObject({ used: 1, remaining: 4 });

    expect(await h.deliver(h.messages[0])).toEqual(['ack']);
    const ready = await status(guest.cookie, scanId);
    expect(ready).toMatchObject({ status: 'ready', quotaStatus: 'consumed' });
    expect(ready.supportRef).toMatch(/^[0-9a-f]{12}$/);
    expect(h.ledger(scanId)).toBe('consumed');
    expect(h.projectedUsage(guest.userId)).toBe(1);
  });

  it.each([
    'MODEL_NOT_FOUND', 'AUTHENTICATION_FAILED', 'PERMISSION_DENIED', 'UNSUPPORTED_REQUEST_OPTION',
    'INVALID_RESPONSE', 'SCHEMA_VALIDATION', 'AI_SCAN_NO_USABLE_ITEMS',
  ])('B: permanent %s fails on the first attempt and releases the reservation', async (code) => {
    const guest = await h.createGuest();
    ai.receiptScan.mockRejectedValueOnce(providerFailure(code, false));
    const scanId = await accepted(guest.cookie, 'receipt', `case-b-${code}`);

    expect(await h.deliver(h.messages[0])).toEqual([`ack:${code}`]);
    expect(ai.receiptScan).toHaveBeenCalledOnce();
    expect(h.scanStatus(scanId)).toBe('failed');
    expect(h.ledger(scanId)).toBe('released');
    expect(h.usedCount(guest.userId)).toBe(0);
    expect(h.projectedUsage(guest.userId)).toBe(0);
    const failed = await status(guest.cookie, scanId);
    expect(failed).toMatchObject({ status: 'failed', errorCode: code, quotaStatus: 'released', attempts: 1, maxAttempts: 3 });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_PROVIDER_DETAIL');
  });

  it.each(['REQUEST_TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED', 'UPSTREAM_ERROR', 'UPSTREAM_BUSY'])(
    'C/E: retryable %s keeps the reservation between attempts and releases it when attempts are exhausted',
    async (code) => {
      const guest = await h.createGuest();
      ai.vision.mockRejectedValue(providerFailure(code, true));
      const scanId = await accepted(guest.cookie, 'fridge', `case-c-${code}`);

      await expect(processScanJob(h.env, h.messages[0])).rejects.toMatchObject({ code, retryable: true });
      expect(h.scanStatus(scanId)).toBe('pending');
      expect(h.job(scanId)).toMatchObject({ status: 'pending', attempts: 1, error_code: code });
      expect(h.ledger(scanId)).toBe('reserved');
      expect(h.usedCount(guest.userId)).toBe(1);

      expect(await h.deliver(h.messages[0])).toEqual([`retry:${code}`, `ack:${code}`]);
      expect(ai.vision).toHaveBeenCalledTimes(3);
      expect(h.scanStatus(scanId)).toBe('failed');
      expect(h.job(scanId)).toMatchObject({ status: 'failed', attempts: 3, error_code: code });
      expect(h.ledger(scanId)).toBe('released');
      expect(h.usedCount(guest.userId)).toBe(0);
      expect(h.projectedUsage(guest.userId)).toBe(0);
    },
  );

  it('D: a retry that eventually succeeds consumes exactly once', async () => {
    const guest = await h.createGuest();
    ai.vision
      .mockRejectedValueOnce(providerFailure('REQUEST_TIMEOUT', true))
      .mockResolvedValueOnce({ items: [usableItem, { ...usableItem, raw_name: 'Trứng gà' }] });
    const scanId = await accepted(guest.cookie, 'fridge', 'case-d');

    expect(await h.deliver(h.messages[0])).toEqual(['retry:REQUEST_TIMEOUT', 'ack']);
    expect(h.scanStatus(scanId)).toBe('ready');
    expect(h.ledger(scanId)).toBe('consumed');
    expect(h.db.query('SELECT COUNT(*) AS n FROM scan_items WHERE scan_id = ?', scanId)).toEqual([{ n: 2 }]);
    expect(h.db.query('SELECT COUNT(*) AS n FROM scan_quota_ledger WHERE scan_id = ?', scanId)).toEqual([{ n: 1 }]);
    expect(h.usedCount(guest.userId)).toBe(1);
  });

  it('F: a queue-intent failure before any send refunds at once; a same-key retry re-reserves one row', async () => {
    const guest = await h.createGuest();
    h.db.hooks.beforeStatement = (event) => {
      if (event.sql.includes('INSERT OR IGNORE INTO scan_queue_jobs')) throw new Error('D1 unavailable');
    };
    const failed = await h.postScan(guest.cookie, 'fridge', 'case-f');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'QUEUE_UNAVAILABLE', retryable: true, quotaStatus: 'released' });
    const scanId = onlyScanId(guest.userId);
    expect(h.scanStatus(scanId)).toBe('failed');
    expect(h.ledger(scanId)).toBe('released');
    expect(h.messages).toHaveLength(0);
    expect(h.usedCount(guest.userId)).toBe(0);

    h.db.hooks.beforeStatement = undefined;
    ai.vision.mockResolvedValueOnce({ items: [usableItem] });
    expect((await h.postScan(guest.cookie, 'fridge', 'case-f')).status).toBe(202);
    expect(await h.deliver(h.messages[0])).toEqual(['ack']);
    expect(h.ledger(scanId)).toBe('consumed');
    expect(h.db.query('SELECT COUNT(*) AS n FROM scan_quota_ledger WHERE user_id = ?', guest.userId)).toEqual([{ n: 1 }]);
  });

  it('F: a rejected send keeps the hold until same-key recovery or bounded reconciliation refunds it', async () => {
    const guest = await h.createGuest();
    h.sendModes.push('reject');
    const failed = await h.postScan(guest.cookie, 'receipt', 'case-f-send');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'QUEUE_UNAVAILABLE', retryable: true, quotaStatus: 'reserved' });
    const scanId = onlyScanId(guest.userId);
    expect(h.scanStatus(scanId)).toBe('pending');
    expect(h.job(scanId)).toMatchObject({ status: 'pending' });
    expect(h.ledger(scanId)).toBe('reserved');

    h.db.seed(`UPDATE scan_quota_ledger SET created_at = datetime('now', '-2 hours') WHERE scan_id = '${scanId}';
      UPDATE scan_queue_jobs SET created_at = datetime('now', '-2 hours'), updated_at = datetime('now', '-2 hours')
        WHERE scan_id = '${scanId}';`);
    await expect(reconcileStaleScanReservations(h.db, 60)).resolves.toMatchObject({ released: 1, expiredJobs: 1, expiredScans: 1 });
    expect(h.scanStatus(scanId)).toBe('failed');
    expect(h.ledger(scanId)).toBe('released');
    expect(h.usedCount(guest.userId)).toBe(0);
  });

  it('G: an accepted-but-unacknowledged send is recovered with the same job and charged once', async () => {
    const guest = await h.createGuest();
    h.sendModes.push('accept-then-reject');
    const first = await h.postScan(guest.cookie, 'fridge', 'case-g');
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ code: 'QUEUE_UNAVAILABLE', quotaStatus: 'reserved' });

    const retry = await h.postScan(guest.cookie, 'fridge', 'case-g');
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ idempotentReplay: true, scan: { status: 'pending' } });
    expect(h.messages).toHaveLength(2);
    expect(h.messages[0]).toEqual(h.messages[1]);

    ai.vision.mockResolvedValueOnce({ items: [usableItem] });
    expect(await h.deliver(h.messages[0])).toEqual(['ack']);
    expect(await h.deliver(h.messages[1])).toEqual(['ack']);
    expect(ai.vision).toHaveBeenCalledOnce();
    expect(h.ledger(h.messages[0].scanId)).toBe('consumed');
    expect(h.usedCount(guest.userId)).toBe(1);
  });

  it('H: an R2 storage failure is refunded before any queue or provider work', async () => {
    const guest = await h.createGuest();
    h.images.failPuts = 1;
    const response = await h.postScan(guest.cookie, 'receipt', 'case-h');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'IMAGE_STORAGE_FAILED' });
    const scanId = onlyScanId(guest.userId);
    expect(h.scanStatus(scanId)).toBe('failed');
    expect(h.ledger(scanId)).toBe('released');
    expect(h.messages).toHaveLength(0);
    expect(ai.receiptScan).not.toHaveBeenCalled();
    expect(h.usedCount(guest.userId)).toBe(0);
  });

  it('I: a failed result commit keeps the reservation, retries, and consumes once on the committed attempt', async () => {
    const guest = await h.createGuest();
    let failCommit = true;
    h.db.hooks.beforeBatch = (statements) => {
      if (failCommit && statements.some((statement) => statement.sql.includes("SET status = 'ready'"))) {
        failCommit = false;
        throw new Error('D1 commit failed');
      }
    };
    ai.receiptScan.mockResolvedValue({ items: [usableItem] });
    const scanId = await accepted(guest.cookie, 'receipt', 'case-i');

    expect(await h.deliver(h.messages[0])).toEqual(['retry:AI_SCAN_FAILED', 'ack']);
    expect(ai.receiptScan).toHaveBeenCalledTimes(2);
    expect(h.scanStatus(scanId)).toBe('ready');
    expect(h.ledger(scanId)).toBe('consumed');
    expect(h.usedCount(guest.userId)).toBe(1);
  });

  it('J: replays while pending and after ready add neither AI work nor charges', async () => {
    const guest = await h.createGuest();
    const scanId = await accepted(guest.cookie, 'fridge', 'case-j');
    const pendingReplay = await h.postScan(guest.cookie, 'fridge', 'case-j');
    expect(pendingReplay.status).toBe(202);
    expect(await pendingReplay.json()).toMatchObject({ idempotentReplay: true, scan: { id: scanId, status: 'pending' } });
    expect(h.messages).toHaveLength(2);

    ai.vision.mockResolvedValueOnce({ items: [usableItem] });
    for (const message of h.messages) expect(await h.deliver(message)).toEqual(['ack']);
    const readyReplay = await h.postScan(guest.cookie, 'fridge', 'case-j');
    expect(readyReplay.status).toBe(200);
    const body = await readyReplay.json() as StatusBody;
    expect(body.scan).toMatchObject({ id: scanId, status: 'ready' });
    expect(body.scan.items).toHaveLength(1);
    expect(h.messages).toHaveLength(2);
    expect(ai.vision).toHaveBeenCalledOnce();
    expect(h.ledger(scanId)).toBe('consumed');
    expect(h.usedCount(guest.userId)).toBe(1);
  });

  it('J: concurrent duplicate POSTs are one logical operation with one reservation and one AI run', async () => {
    const guest = await h.createGuest();
    const responses = await Promise.all([
      h.postScan(guest.cookie, 'fridge', 'case-j-race'),
      h.postScan(guest.cookie, 'fridge', 'case-j-race'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(new Set(await Promise.all(responses.map(scanIdOf))).size).toBe(1);
    expect(h.db.query('SELECT COUNT(*) AS n FROM scan_quota_ledger WHERE user_id = ?', guest.userId)).toEqual([{ n: 1 }]);

    ai.vision.mockResolvedValueOnce({ items: [usableItem] });
    for (const message of h.messages) await h.deliver(message);
    expect(ai.vision).toHaveBeenCalledOnce();
    expect(h.usedCount(guest.userId)).toBe(1);
  });

  it('J: same key with other bytes or MIME conflicts without a new charge; keys are tenant scoped', async () => {
    const a = await h.createGuest();
    const b = await h.createGuest();
    const scanId = await accepted(a.cookie, 'fridge', 'case-j-bind');
    const otherBytes = await h.postScan(a.cookie, 'fridge', 'case-j-bind', fixtureImage('different-bytes'));
    expect(otherBytes.status).toBe(409);
    expect(await otherBytes.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const otherMime = await h.postScan(a.cookie, 'fridge', 'case-j-bind', `data:image/png;base64,${fixtureImage('case-j-bind')}`);
    expect(otherMime.status).toBe(409);

    const bScanId = await accepted(b.cookie, 'fridge', 'case-j-bind');
    expect(bScanId).not.toBe(scanId);
    expect(h.usedCount(a.userId)).toBe(1);
    expect(h.usedCount(b.userId)).toBe(1);
  });

  it('keeps scan status and confirmation tenant isolated', async () => {
    const a = await h.createGuest();
    const b = await h.createGuest();
    ai.receiptScan.mockResolvedValueOnce({ items: [usableItem] });
    const scanId = await accepted(a.cookie, 'receipt', 'tenant-a');
    expect(await h.deliver(h.messages[0])).toEqual(['ack']);

    expect((await h.getScan(b.cookie, scanId)).status).toBe(404);
    expect((await h.confirmScan(b.cookie, scanId)).status).toBe(404);
    expect(h.scanStatus(scanId)).toBe('ready');
    expect(h.usedCount(b.userId)).toBe(0);
  });

  it.each(['receipt', 'fridge'] as const)(
    '%s: POST -> queue -> provider -> D1 ready -> GET -> confirm -> inventory, charged once',
    async (type) => {
      const guest = await h.createGuest();
      const provider = type === 'receipt' ? ai.receiptScan : ai.vision;
      provider.mockResolvedValueOnce({
        items: [{ ...usableItem, canonical_id: 'TOMATO', unit: 'piece', estimated_quantity: 2 }],
      });
      const scanId = await accepted(guest.cookie, type, `e2e-${type}`);
      expect(await h.deliver(h.messages[0])).toEqual(['ack']);

      const ready = await status(guest.cookie, scanId);
      expect(ready).toMatchObject({ status: 'ready', quotaStatus: 'consumed' });
      expect(ready.items).toEqual([expect.objectContaining({ rawName: 'Cà chua', canonicalId: 'TOMATO' })]);

      const confirmed = await h.confirmScan(guest.cookie, scanId);
      expect(confirmed.status).toBe(200);
      const confirmation = await confirmed.json() as { success: boolean; items: unknown[] };
      expect(confirmation.success).toBe(true);
      expect(JSON.stringify(confirmation.items)).toContain('Cà chua');
      expect(h.scanStatus(scanId)).toBe('confirmed');

      const replay = await h.confirmScan(guest.cookie, scanId);
      expect(await replay.json()).toMatchObject({ success: true, idempotentReplay: true });
      expect(h.ledger(scanId)).toBe('consumed');
      expect(h.usedCount(guest.userId)).toBe(1);
    },
  );

  it('fences a late worker after its lease was reclaimed: one commit, one charge', async () => {
    const guest = await h.createGuest();
    let releaseFirst!: (value: unknown) => void;
    ai.vision
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce({ items: [{ ...usableItem, raw_name: 'second worker' }] });
    const scanId = await accepted(guest.cookie, 'fridge', 'late-worker');

    const firstWorker = processScanJob(h.env, h.messages[0]).then(() => 'committed', (error) => error.code);
    await vi.waitFor(() => expect(ai.vision).toHaveBeenCalledTimes(1));
    h.db.seed(`UPDATE scan_queue_jobs SET locked_at = datetime('now', '-11 minutes') WHERE scan_id = '${scanId}'`);
    await expect(processScanJob(h.env, h.messages[0])).resolves.toBeUndefined();
    releaseFirst({ items: [{ ...usableItem, raw_name: 'first worker' }] });

    await expect(firstWorker).resolves.toBe('CLAIM_LOST');
    expect(h.db.query('SELECT raw_name FROM scan_items WHERE scan_id = ?', scanId)).toEqual([{ raw_name: 'second worker' }]);
    expect(h.ledger(scanId)).toBe('consumed');
    expect(h.usedCount(guest.userId)).toBe(1);
  });

  it('fences a late worker after reconciliation refunded its stale reservation', async () => {
    const guest = await h.createGuest();
    let release!: (value: unknown) => void;
    ai.vision.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const scanId = await accepted(guest.cookie, 'fridge', 'late-after-refund');

    const worker = processScanJob(h.env, h.messages[0]).then(() => 'committed', (error) => error.code);
    await vi.waitFor(() => expect(ai.vision).toHaveBeenCalledTimes(1));
    h.db.seed(`UPDATE scan_quota_ledger SET created_at = datetime('now', '-2 hours') WHERE scan_id = '${scanId}';
      UPDATE scan_queue_jobs SET locked_at = datetime('now', '-2 hours'), updated_at = datetime('now', '-2 hours')
        WHERE scan_id = '${scanId}';`);
    await expect(reconcileStaleScanReservations(h.db, 60)).resolves.toMatchObject({ released: 1, expiredJobs: 1, expiredScans: 1 });
    release({ items: [usableItem] });

    await expect(worker).resolves.toBe('CLAIM_LOST');
    expect(h.scanStatus(scanId)).toBe('failed');
    expect(h.ledger(scanId)).toBe('released');
    expect(h.db.query('SELECT COUNT(*) AS n FROM scan_items WHERE scan_id = ?', scanId)).toEqual([{ n: 0 }]);
    expect(h.usedCount(guest.userId)).toBe(0);
  });

  it('refunds a lease that expired on its final attempt (MAX_ATTEMPTS_EXCEEDED)', async () => {
    const guest = await h.createGuest();
    const scanId = await accepted(guest.cookie, 'receipt', 'crashed-final-attempt');
    h.db.seed(`UPDATE scan_queue_jobs SET status = 'processing', attempts = 3, locked_at = datetime('now', '-11 minutes')
        WHERE scan_id = '${scanId}';
      UPDATE scans SET status = 'processing' WHERE id = '${scanId}';`);

    expect(await h.deliver(h.messages[0])).toEqual(['ack']);
    expect(ai.receiptScan).not.toHaveBeenCalled();
    expect(h.job(scanId)).toMatchObject({ status: 'failed', error_code: 'MAX_ATTEMPTS_EXCEEDED' });
    expect(h.scanStatus(scanId)).toBe('failed');
    expect(h.ledger(scanId)).toBe('released');
    expect(h.usedCount(guest.userId)).toBe(0);
  });
});
