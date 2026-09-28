import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from '../helpers/sqlite-d1';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { authRoutes } from '../../src/worker/routes/auth';
import { scanRoutes } from '../../src/worker/routes/scans';
import { processScanJob, ScanQueueError, type ScanQueueMessage } from '../../src/worker/services/scan-queue';
import type { AuthContext, Env } from '../../src/worker/types';

// Root-cause reproduction for the 27/09/2026 QA incident. It drives a real
// guest session through the production async path (producer -> queue ->
// consumer) with a deterministic provider double; no network, no real AI.
const ai = vi.hoisted(() => ({ vision: vi.fn(), receiptScan: vi.fn() }));
vi.mock('@frigo/ai', () => ({
  AIRouter: class {
    vision = ai.vision;
    receiptScan = ai.receiptScan;
  },
}));

const ORIGIN = 'https://frigo.example.com';

class MemoryR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
    return {};
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      httpMetadata: { contentType: object.contentType },
      arrayBuffer: async () => object.bytes.slice().buffer as ArrayBuffer,
    };
  }
}

const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', authRoutes);
app.route('/', scanRoutes);

const usableItem = {
  raw_name: 'Cà chua',
  estimated_quantity: 1,
  unit: 'kg',
  confidence: 0.9,
  category: 'vegetable',
  storage: 'fridge',
};
const failure = (code: string, retryable: boolean) => ({ name: 'AIRequestError', code, retryable, message: `provider ${code}` });
const image = (name: string) => Buffer.from(`fixture:${name}`).toString('base64');

describe('ROOT CAUSE reproduction: guest/free async scan quota (pre-fix contract)', () => {
  let db: SqliteD1;
  let env: Env;
  let messages: ScanQueueMessage[];

  beforeEach(() => {
    db = new SqliteD1();
    messages = [];
    env = {
      DB: db,
      CACHE: { get: async () => null, put: async () => undefined },
      APP_URL: ORIGIN,
      ENVIRONMENT: 'production',
      JWT_SECRET: 'root-cause-test-secret-that-is-long-enough',
      SCAN_QUEUE_MODE: 'async',
      SCAN_QUEUE: { send: async (message: ScanQueueMessage) => { messages.push(message); } },
      IMAGES: new MemoryR2(),
    } as unknown as Env;
    ai.vision.mockReset();
    ai.receiptScan.mockReset();
  });

  afterEach(() => db.close());

  async function createGuest(): Promise<{ cookie: string; userId: string }> {
    const response = await app.request('/auth/guest', { method: 'POST', headers: { Origin: ORIGIN } }, env);
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string } };
    return { cookie: (response.headers.get('Set-Cookie') || '').split(';')[0], userId: body.user.id };
  }

  function scan(cookie: string, type: 'fridge' | 'receipt', key: string) {
    return app.request(`/scans/${type}`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ imageBase64: image(key) }),
    }, env);
  }

  // Mirrors the Worker queue() handler: ack on success, retry retryable
  // failures, ack permanent ones; Cloudflare's default max_retries is 3.
  async function deliver(message: ScanQueueMessage): Promise<string[]> {
    const outcomes: string[] = [];
    for (let delivery = 1; delivery <= 4; delivery += 1) {
      try {
        await processScanJob(env, message);
        outcomes.push('ack');
        return outcomes;
      } catch (error) {
        const retryable = error instanceof ScanQueueError ? error.retryable : true;
        const code = (error as { code?: string }).code;
        outcomes.push(`${retryable ? 'retry' : 'ack'}:${code}`);
        if (!retryable) return outcomes;
      }
    }
    outcomes.push('dlq');
    return outcomes;
  }

  const ledger = (scanId: string) =>
    (db.query('SELECT status FROM scan_quota_ledger WHERE scan_id = ?', scanId)[0] as { status?: string } | undefined)?.status;
  const scanStatus = (scanId: string) =>
    (db.query('SELECT status FROM scans WHERE id = ?', scanId)[0] as { status?: string } | undefined)?.status;

  it('charges each async scan at enqueue, never refunds AI failures, and rejects scan 6 before AI or queue work', async () => {
    const { cookie, userId } = await createGuest();
    expect(db.query('SELECT plan, status, max_scans_per_month FROM subscriptions WHERE user_id = ?', userId)).toEqual([
      { plan: 'free', status: 'active', max_scans_per_month: 5 },
    ]);

    const sequence = [
      { key: 'receipt_easy', type: 'receipt', arrange: () => ai.receiptScan.mockResolvedValueOnce({ items: [usableItem] }) },
      { key: 'receipt_medium', type: 'receipt', arrange: () => ai.receiptScan.mockRejectedValueOnce(failure('MODEL_NOT_FOUND', false)) },
      {
        key: 'receipt_hard',
        type: 'receipt',
        arrange: () => ai.receiptScan
          .mockRejectedValueOnce(failure('REQUEST_TIMEOUT', true))
          .mockRejectedValueOnce(failure('REQUEST_TIMEOUT', true))
          .mockRejectedValueOnce(failure('REQUEST_TIMEOUT', true)),
      },
      { key: 'receipt_veryhard', type: 'receipt', arrange: () => ai.receiptScan.mockRejectedValueOnce(failure('AI_SCAN_NO_USABLE_ITEMS', false)) },
      { key: 'fridge_easy', type: 'fridge', arrange: () => ai.vision.mockResolvedValueOnce({ items: [usableItem] }) },
    ] as const;

    const trace = [];
    for (const step of sequence) {
      step.arrange();
      const response = await scan(cookie, step.type, step.key);
      const body = await response.json() as { scan?: { id: string }; receipt?: { id: string } };
      const scanId = (body.receipt || body.scan)!.id;
      const ledgerAfterEnqueue = ledger(scanId);
      const outcomes = await deliver(messages.at(-1)!);
      trace.push({ key: step.key, http: response.status, ledgerAfterEnqueue, outcomes, scan: scanStatus(scanId), ledger: ledger(scanId) });
    }

    expect(trace).toEqual([
      { key: 'receipt_easy', http: 202, ledgerAfterEnqueue: 'consumed', outcomes: ['ack'], scan: 'ready', ledger: 'consumed' },
      { key: 'receipt_medium', http: 202, ledgerAfterEnqueue: 'consumed', outcomes: ['ack:MODEL_NOT_FOUND'], scan: 'failed', ledger: 'consumed' },
      {
        key: 'receipt_hard',
        http: 202,
        ledgerAfterEnqueue: 'consumed',
        outcomes: ['retry:REQUEST_TIMEOUT', 'retry:REQUEST_TIMEOUT', 'ack:REQUEST_TIMEOUT'],
        scan: 'failed',
        ledger: 'consumed',
      },
      { key: 'receipt_veryhard', http: 202, ledgerAfterEnqueue: 'consumed', outcomes: ['ack:AI_SCAN_NO_USABLE_ITEMS'], scan: 'failed', ledger: 'consumed' },
      { key: 'fridge_easy', http: 202, ledgerAfterEnqueue: 'consumed', outcomes: ['ack'], scan: 'ready', ledger: 'consumed' },
    ]);

    // Only 2 of 5 scans produced a usable result, yet the free allowance is gone.
    const providerCalls = () => ai.vision.mock.calls.length + ai.receiptScan.mock.calls.length;
    const callsBefore = providerCalls();
    const sixth = await scan(cookie, 'fridge', 'fridge_medium');
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({ code: 'SCAN_QUOTA_EXCEEDED' });
    expect(messages).toHaveLength(5);
    expect(providerCalls()).toBe(callsBefore);
    expect(db.query('SELECT COUNT(*) AS n FROM scans')).toEqual([{ n: 5 }]);

    const me = await (await app.request('/me', { headers: { Cookie: cookie } }, env)).json() as {
      user: { subscription: Record<string, unknown> };
    };
    expect(me.user.subscription).toMatchObject({ plan: 'free', limit: 5, used: 5, remaining: 0 });

    // A same-key replay of a failed async scan reports the failure but the
    // producer-side release is a no-op because the row is already consumed.
    const replay = await scan(cookie, 'receipt', 'receipt_medium');
    expect(replay.status).toBe(503);
    expect(await replay.json()).toMatchObject({ code: 'MODEL_NOT_FOUND' });
    expect(db.query("SELECT COUNT(*) AS n FROM scan_quota_ledger WHERE status = 'consumed'")).toEqual([{ n: 5 }]);
  });
});
