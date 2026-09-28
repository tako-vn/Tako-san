import { Hono } from 'hono';
import { expect } from 'vitest';
import { SqliteD1 } from './sqlite-d1';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { authRoutes } from '../../src/worker/routes/auth';
import { scanRoutes } from '../../src/worker/routes/scans';
import { processScanJob, ScanQueueError, type ScanQueueMessage } from '../../src/worker/services/scan-queue';
import type { AuthContext, Env } from '../../src/worker/types';

/**
 * Production-shaped async scan harness: real guest sessions, real routes and
 * consumer, real SQLite constraints/transactions, in-memory R2 and queue
 * doubles. Test files must `vi.mock('@frigo/ai')` themselves.
 */
export const ORIGIN = 'https://frigo.example.com';

export const fixtureImage = (name: string) => Buffer.from(`fixture:${name}`).toString('base64');

export const usableItem = {
  raw_name: 'Cà chua',
  estimated_quantity: 1,
  unit: 'kg',
  confidence: 0.9,
  category: 'vegetable',
  storage: 'fridge',
};

export const providerFailure = (code: string, retryable: boolean) => ({
  name: 'AIRequestError',
  code,
  retryable,
  message: `PRIVATE_PROVIDER_DETAIL ${code}`,
});

export class MemoryR2 {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  failPuts = 0;

  async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    if (this.failPuts > 0) {
      this.failPuts -= 1;
      throw new Error('R2 put unavailable');
    }
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

/** `accept-then-reject` models a send the platform accepted but whose response was lost. */
export type SendMode = 'ok' | 'reject' | 'accept-then-reject';

export function createScanHarness() {
  const db = new SqliteD1();
  const images = new MemoryR2();
  const messages: ScanQueueMessage[] = [];
  const sendModes: SendMode[] = [];
  const env = {
    DB: db,
    CACHE: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    APP_URL: ORIGIN,
    ENVIRONMENT: 'production',
    JWT_SECRET: 'scan-quota-harness-secret-that-is-long-enough',
    WEEK_SCHEMA_MODE: 'legacy',
    SCAN_QUEUE_MODE: 'async',
    SCAN_QUEUE: {
      async send(message: ScanQueueMessage) {
        const mode = sendModes.shift() ?? 'ok';
        if (mode === 'reject') throw new Error('queue unavailable');
        messages.push(structuredClone(message));
        if (mode === 'accept-then-reject') throw new Error('accepted but response lost');
      },
    },
    IMAGES: images,
  } as unknown as Env;

  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.use('*', authMiddleware);
  app.route('/', authRoutes);
  app.route('/', scanRoutes);

  async function createGuest(): Promise<{ cookie: string; userId: string; householdId: string }> {
    const response = await app.request('/auth/guest', { method: 'POST', headers: { Origin: ORIGIN } }, env);
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string; householdId: string } };
    return {
      cookie: (response.headers.get('Set-Cookie') || '').split(';')[0],
      userId: body.user.id,
      householdId: body.user.householdId,
    };
  }

  function postScan(cookie: string, type: 'fridge' | 'food' | 'receipt', key: string, imageBase64 = fixtureImage(key)) {
    const path = type === 'receipt' ? '/scans/receipt' : '/scans/fridge';
    return app.request(path, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(type === 'receipt' ? { imageBase64 } : { imageBase64, scanType: type }),
    }, env);
  }

  function getScan(cookie: string, scanId: string) {
    return app.request(`/scans/${scanId}`, { headers: { Cookie: cookie } }, env);
  }

  function confirmScan(cookie: string, scanId: string) {
    const items = db.query<{ id: string }>('SELECT id FROM scan_items WHERE scan_id = ? ORDER BY id', scanId);
    return app.request(`/scans/${scanId}/confirm`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items.map((item) => ({ id: item.id })) }),
    }, env);
  }

  async function subscription(cookie: string) {
    const response = await app.request('/me', { headers: { Cookie: cookie } }, env);
    expect(response.status).toBe(200);
    return (await response.json() as { user: { subscription: Record<string, unknown> } }).user.subscription;
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
        outcomes.push(`${retryable ? 'retry' : 'ack'}:${(error as { code?: string }).code}`);
        if (!retryable) return outcomes;
      }
    }
    outcomes.push('dlq');
    return outcomes;
  }

  const one = <T>(sql: string, ...values: unknown[]) => db.query<T>(sql, ...values)[0];
  const ledger = (scanId: string) => one<{ status: string }>('SELECT status FROM scan_quota_ledger WHERE scan_id = ?', scanId)?.status;
  const scanStatus = (scanId: string) => one<{ status: string }>('SELECT status FROM scans WHERE id = ?', scanId)?.status;
  const job = (scanId: string) => one<{ status: string; attempts: number; error_code: string | null }>(
    'SELECT status, attempts, error_code FROM scan_queue_jobs WHERE scan_id = ?', scanId);
  const usedCount = (userId: string) => Number(one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM scan_quota_ledger WHERE user_id = ? AND status != 'released'", userId)?.n ?? 0);
  const projectedUsage = (userId: string) => Number(one<{ used_count: number }>(
    'SELECT used_count FROM scan_quota_periods WHERE user_id = ?', userId)?.used_count ?? 0);

  return {
    db, env, app, images, messages, sendModes,
    createGuest, postScan, getScan, confirmScan, subscription, deliver,
    ledger, scanStatus, job, usedCount, projectedUsage,
  };
}

export type ScanHarness = ReturnType<typeof createScanHarness>;

export async function scanIdOf(response: Response): Promise<string> {
  const body = await response.clone().json() as { scan?: { id: string }; receipt?: { id: string } };
  return (body.receipt || body.scan)!.id;
}
