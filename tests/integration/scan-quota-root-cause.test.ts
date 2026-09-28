import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScanHarness, providerFailure, scanIdOf, usableItem, type ScanHarness } from '../helpers/scan-quota-harness';

// Regression for the 27/09/2026 QA incident. Commit 36004e8 recorded the
// pre-fix contract of this same sequence: every async scan was `consumed`
// right after its 202 and failed scans were never refunded (5/5 used after
// 2 usable results). ADR-039 moves consumption to the consumer's `ready`
// commit and refunds terminal failures.
const ai = vi.hoisted(() => ({ vision: vi.fn(), receiptScan: vi.fn() }));
vi.mock('@frigo/ai', () => ({
  AIRouter: class {
    vision = ai.vision;
    receiptScan = ai.receiptScan;
  },
}));

describe('ROOT CAUSE regression: guest/free async scan quota (ADR-039 contract)', () => {
  let h: ScanHarness;

  beforeEach(() => {
    h = createScanHarness();
    ai.vision.mockReset();
    ai.receiptScan.mockReset();
  });

  afterEach(() => h.db.close());

  const providerCalls = () => ai.vision.mock.calls.length + ai.receiptScan.mock.calls.length;

  it('reserves at enqueue, charges only usable results, refunds failures, and reports exhaustion with the server snapshot', async () => {
    const guest = await h.createGuest();
    expect(h.db.query('SELECT plan, status, max_scans_per_month FROM subscriptions WHERE user_id = ?', guest.userId)).toEqual([
      { plan: 'free', status: 'active', max_scans_per_month: 5 },
    ]);

    const qaSequence = [
      { key: 'receipt_easy', type: 'receipt', arrange: () => ai.receiptScan.mockResolvedValueOnce({ items: [usableItem] }) },
      { key: 'receipt_medium', type: 'receipt', arrange: () => ai.receiptScan.mockRejectedValueOnce(providerFailure('MODEL_NOT_FOUND', false)) },
      {
        key: 'receipt_hard',
        type: 'receipt',
        arrange: () => ai.receiptScan
          .mockRejectedValueOnce(providerFailure('REQUEST_TIMEOUT', true))
          .mockRejectedValueOnce(providerFailure('REQUEST_TIMEOUT', true))
          .mockRejectedValueOnce(providerFailure('REQUEST_TIMEOUT', true)),
      },
      { key: 'receipt_veryhard', type: 'receipt', arrange: () => ai.receiptScan.mockRejectedValueOnce(providerFailure('AI_SCAN_NO_USABLE_ITEMS', false)) },
      { key: 'fridge_easy', type: 'fridge', arrange: () => ai.vision.mockResolvedValueOnce({ items: [usableItem] }) },
    ] as const;

    const trace = [];
    for (const step of qaSequence) {
      step.arrange();
      const response = await h.postScan(guest.cookie, step.type, step.key);
      const scanId = await scanIdOf(response);
      const ledgerAfterEnqueue = h.ledger(scanId);
      const outcomes = await h.deliver(h.messages.at(-1)!);
      trace.push({ key: step.key, http: response.status, ledgerAfterEnqueue, outcomes, scan: h.scanStatus(scanId), ledger: h.ledger(scanId) });
    }

    expect(trace).toEqual([
      { key: 'receipt_easy', http: 202, ledgerAfterEnqueue: 'reserved', outcomes: ['ack'], scan: 'ready', ledger: 'consumed' },
      { key: 'receipt_medium', http: 202, ledgerAfterEnqueue: 'reserved', outcomes: ['ack:MODEL_NOT_FOUND'], scan: 'failed', ledger: 'released' },
      {
        key: 'receipt_hard',
        http: 202,
        ledgerAfterEnqueue: 'reserved',
        outcomes: ['retry:REQUEST_TIMEOUT', 'retry:REQUEST_TIMEOUT', 'ack:REQUEST_TIMEOUT'],
        scan: 'failed',
        ledger: 'released',
      },
      { key: 'receipt_veryhard', http: 202, ledgerAfterEnqueue: 'reserved', outcomes: ['ack:AI_SCAN_NO_USABLE_ITEMS'], scan: 'failed', ledger: 'released' },
      { key: 'fridge_easy', http: 202, ledgerAfterEnqueue: 'reserved', outcomes: ['ack'], scan: 'ready', ledger: 'consumed' },
    ]);
    expect(await h.subscription(guest.cookie)).toMatchObject({ plan: 'free', limit: 5, used: 2, remaining: 3 });
    expect(h.projectedUsage(guest.userId)).toBe(2);

    // The QA session's 6th request is now accepted because failures were refunded.
    for (const key of ['fridge_medium', 'fridge_hard', 'fridge_veryhard']) {
      ai.vision.mockResolvedValueOnce({ items: [usableItem] });
      const response = await h.postScan(guest.cookie, 'fridge', key);
      expect(response.status).toBe(202);
      expect(await h.deliver(h.messages.at(-1)!)).toEqual(['ack']);
    }
    expect(await h.subscription(guest.cookie)).toMatchObject({ used: 5, remaining: 0 });

    const callsBefore = providerCalls();
    const messagesBefore = h.messages.length;
    const rejected = await h.postScan(guest.cookie, 'fridge', 'stability_1');
    expect(rejected.status).toBe(429);
    const now = new Date();
    expect(await rejected.json()).toEqual({
      error: 'Đã vượt hạn mức quét trong tháng',
      code: 'SCAN_QUOTA_EXCEEDED',
      retryable: false,
      quota: {
        plan: 'free',
        limit: 5,
        used: 5,
        remaining: 0,
        resetAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
      },
    });
    expect(h.messages).toHaveLength(messagesBefore);
    expect(providerCalls()).toBe(callsBefore);
    expect(h.db.query('SELECT COUNT(*) AS n FROM scans WHERE user_id = ?', guest.userId)).toEqual([{ n: 8 }]);
  });

  it('treats a same-key replay of a refunded failure as a new attempt of one command, charged once on success', async () => {
    const guest = await h.createGuest();
    ai.receiptScan.mockRejectedValueOnce(providerFailure('MODEL_NOT_FOUND', false));
    const scanId = await scanIdOf(await h.postScan(guest.cookie, 'receipt', 'receipt_medium'));
    expect(await h.deliver(h.messages.at(-1)!)).toEqual(['ack:MODEL_NOT_FOUND']);
    expect(h.ledger(scanId)).toBe('released');
    expect(h.usedCount(guest.userId)).toBe(0);

    ai.receiptScan.mockResolvedValueOnce({ items: [usableItem] });
    const attempt = await h.postScan(guest.cookie, 'receipt', 'receipt_medium');
    expect(attempt.status).toBe(202);
    expect(h.ledger(scanId)).toBe('reserved');
    expect(h.job(scanId)).toMatchObject({ status: 'pending', attempts: 0, error_code: null });
    expect(await h.deliver(h.messages.at(-1)!)).toEqual(['ack']);
    expect(h.scanStatus(scanId)).toBe('ready');
    expect(h.ledger(scanId)).toBe('consumed');
    expect(h.db.query('SELECT COUNT(*) AS n FROM scan_quota_ledger WHERE scan_id = ?', scanId)).toEqual([{ n: 1 }]);

    const messagesBefore = h.messages.length;
    const replay = await h.postScan(guest.cookie, 'receipt', 'receipt_medium');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotentReplay: true, receipt: { id: scanId, status: 'ready' } });
    expect(h.messages).toHaveLength(messagesBefore);
    expect(ai.receiptScan).toHaveBeenCalledTimes(2);
    expect(h.usedCount(guest.userId)).toBe(1);
  });
});
