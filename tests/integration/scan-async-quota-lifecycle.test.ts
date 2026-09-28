import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteD1 } from '../helpers/sqlite-d1';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { scanRoutes } from '../../src/worker/routes/scans';
import { processScanJob, type ScanQueueMessage } from '../../src/worker/services/scan-queue';
import { sha256Hex, SESSION_COOKIE } from '../../src/worker/utils/session';
import type { AuthContext, Env } from '../../src/worker/types';

const vision = vi.hoisted(() => vi.fn());
vi.mock('@frigo/ai', () => ({ AIRouter: class { vision = vision; receiptScan = vision; } }));
const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
app.use('*', authMiddleware);
app.route('/', scanRoutes);
const aiResult = { items: [{ raw_name: 'Cà chua', estimated_quantity: 1, unit: 'piece', confidence: 0.9,
  category: 'vegetable', storage: 'fridge' }] };

describe('guest async scan quota lifecycle', () => {
  let db: SqliteD1;
  let messages: ScanQueueMessage[];
  let env: Env;
  const ledger = () => db.query('SELECT status FROM scan_quota_ledger ORDER BY scan_id').map((row) => row.status);
  const usage = () => Number(db.query('SELECT used_count FROM scan_quota_periods')[0]?.used_count || 0);

  beforeEach(async () => {
    db = new SqliteD1();
    db.seed(`INSERT INTO users (id,email,is_guest) VALUES ('guest-test','guest-test@example.test',1);
      INSERT INTO households (id,name,created_by) VALUES ('hh_guest-test','Guest','guest-test');
      INSERT INTO household_members (id,user_id,household_id,role) VALUES ('guest-member','guest-test','hh_guest-test','owner');
      INSERT INTO subscriptions (id,user_id,plan,status,max_scans_per_month) VALUES ('guest-sub','guest-test','free','active',5);`);
    await db.prepare(`INSERT INTO sessions_v2 (id,user_id,household_id,token_hash,expires_at)
      VALUES ('guest-session','guest-test','hh_guest-test',?,datetime('now','+1 day'))`)
      .bind(await sha256Hex('guest-token')).run();
    messages = [];
    env = { DB: db, CACHE: { get: async () => null, put: async () => undefined },
      APP_URL: 'https://frigo.example.com', ENVIRONMENT: 'production', SCAN_QUEUE_MODE: 'async',
      SCAN_QUEUE: { send: async (message: ScanQueueMessage) => { messages.push(message); } },
      IMAGES: undefined } as unknown as Env;
    vision.mockReset().mockResolvedValue(aiResult);
  });
  afterEach(() => db.close());

  function post(key: string, type: 'fridge' | 'receipt' = 'fridge', image = 'aGVsbG8=') {
    return app.request(`/scans/${type}`, {
      method: 'POST', headers: { Cookie: `${SESSION_COOKIE}=guest-token`, Origin: 'https://frigo.example.com',
        'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ imageBase64: image }),
    }, env);
  }

  it('reserves five scans and rejects the sixth before persistence or provider work', async () => {
    for (let n = 1; n <= 5; n += 1) {
      expect((await post(`scan-${n}`)).status).toBe(202);
      expect(usage()).toBe(n);
      expect(ledger()).toEqual(Array(n).fill('reserved'));
    }
    const sixth = await post('scan-6');
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toMatchObject({ code: 'SCAN_QUOTA_EXCEEDED', quota: { limit: 5, remaining: 0 } });
    expect(messages).toHaveLength(5);
    expect(db.query('SELECT id FROM scans')).toHaveLength(5);
    expect(vision).not.toHaveBeenCalled();
  });

  it.each(['fridge', 'receipt'] as const)('consumes one %s scan only with a ready result', async (type) => {
    expect((await post(`success-${type}`, type)).status).toBe(202);
    expect(ledger()).toEqual(['reserved']);
    await processScanJob(env, messages[0]);
    expect(db.query('SELECT status FROM scans')).toEqual([{ status: 'ready' }]);
    expect(ledger()).toEqual(['consumed']);
    expect(usage()).toBe(1);
    await processScanJob(env, messages[0]);
    expect(vision).toHaveBeenCalledTimes(1);
  });

  it('releases permanent failure and replays it without another charge', async () => {
    vision.mockRejectedValueOnce({ code: 'MODEL_NOT_FOUND', retryable: false, message: 'private detail' });
    expect((await post('permanent')).status).toBe(202);
    await expect(processScanJob(env, messages[0])).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND', retryable: false });
    expect(ledger()).toEqual(['released']);
    expect(usage()).toBe(0);
    const replay = await post('permanent');
    expect(replay.status).toBe(503);
    expect(await replay.json()).toMatchObject({ code: 'MODEL_NOT_FOUND' });
    expect(messages).toHaveLength(1);
    expect(vision).toHaveBeenCalledTimes(1);
    expect((await post('explicit-new-attempt')).status).toBe(202);
  });

  it('reserves during transient failure, consumes on eventual success, and releases on exhaustion', async () => {
    vision.mockRejectedValueOnce({ code: 'REQUEST_TIMEOUT', retryable: true }).mockResolvedValueOnce(aiResult);
    expect((await post('retry-success')).status).toBe(202);
    await expect(processScanJob(env, messages[0])).rejects.toMatchObject({ retryable: true });
    expect(ledger()).toEqual(['reserved']);
    await processScanJob(env, messages[0]);
    expect(ledger()).toEqual(['consumed']);
    expect(usage()).toBe(1);
    vision.mockRejectedValue({ code: 'REQUEST_TIMEOUT', retryable: true });
    expect((await post('retry-exhausted')).status).toBe(202);
    db.seed("UPDATE scan_queue_jobs SET max_attempts = 2 WHERE status = 'pending'");
    await expect(processScanJob(env, messages[1])).rejects.toMatchObject({ retryable: true });
    await expect(processScanJob(env, messages[1])).rejects.toMatchObject({ retryable: false });
    expect(ledger().sort()).toEqual(['consumed', 'released']);
    expect(usage()).toBe(1);
  });

  it('reuses the queue intent and reservation after an ambiguous send', async () => {
    let first = true;
    (env.SCAN_QUEUE as any).send = async (message: ScanQueueMessage) => {
      messages.push(message);
      if (first) { first = false; throw new Error('response lost'); }
    };
    expect((await post('ambiguous')).status).toBe(503);
    expect(ledger()).toEqual(['reserved']);
    expect((await post('ambiguous')).status).toBe(202);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual(messages[1]);
    await processScanJob(env, messages[0]);
    expect(ledger()).toEqual(['consumed']);
    expect(usage()).toBe(1);
  });

  it('releases on storage failure and rolls back a scan persistence failure', async () => {
    env.IMAGES = { put: async () => { throw new Error('storage unavailable'); } } as unknown as Env['IMAGES'];
    const response = await post('storage-failure');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'IMAGE_STORAGE_FAILED' });
    expect(ledger()).toEqual(['released']);
    expect(usage()).toBe(0);
    db.seed("CREATE TRIGGER fail_scan BEFORE INSERT ON scans BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    const dbFailure = await post('db-failure');
    expect(dbFailure.status).toBe(503);
    expect(await dbFailure.json()).toMatchObject({ code: 'QUOTA_UNAVAILABLE' });
    expect(ledger()).toEqual(['released']);
    expect(messages).toHaveLength(0);
  });

  it('releases quota when queue intent persistence fails before send', async () => {
    db.seed("CREATE TRIGGER fail_intent BEFORE INSERT ON scan_queue_jobs BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    const response = await post('intent-failure');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'DATABASE_ERROR' });
    expect(ledger()).toEqual(['released']);
    expect(usage()).toBe(0);
    expect(messages).toHaveLength(0);
    expect(db.query('SELECT status FROM scans')).toEqual([{ status: 'failed' }]);
  });

  it('rejects different bytes and MIME under one async command', async () => {
    expect((await post('bound')).status).toBe(202);
    const bytes = await post('bound', 'fridge', 'd29ybGQ=');
    expect(bytes.status).toBe(409);
    expect(await bytes.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const mime = await post('bound', 'fridge', 'data:image/png;base64,aGVsbG8=');
    expect(mime.status).toBe(409);
    expect(await mime.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(messages).toHaveLength(1);
    expect(usage()).toBe(1);
  });

  it('does not retry a permanent model error despite a provider retry hint', async () => {
    vision.mockRejectedValueOnce({ code: 'MODEL_NOT_FOUND', retryable: true });
    expect((await post('bad-model')).status).toBe(202);
    await expect(processScanJob(env, messages[0])).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND', retryable: false });
    expect(ledger()).toEqual(['released']);
  });

  it('keeps reads and confirmations tenant scoped', async () => {
    const response = await post('tenant-a');
    const body = await response.json() as { scan: { id: string } };
    db.seed(`INSERT INTO users (id,email) VALUES ('other-user','other@example.test');
      INSERT INTO households (id,name,created_by) VALUES ('other-house','Other','other-user');
      INSERT INTO household_members (id,user_id,household_id,role) VALUES ('other-member','other-user','other-house','owner');`);
    await db.prepare(`INSERT INTO sessions_v2 (id,user_id,household_id,token_hash,expires_at)
      VALUES ('other-session','other-user','other-house',?,datetime('now','+1 day'))`)
      .bind(await sha256Hex('other-token')).run();
    const headers = { Cookie: `${SESSION_COOKIE}=other-token`, Origin: 'https://frigo.example.com' };
    expect((await app.request(`/scans/${encodeURIComponent(body.scan.id)}`, { headers }, env)).status).toBe(404);
    const confirm = await app.request(`/scans/${encodeURIComponent(body.scan.id)}/confirm`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [] }),
    }, env);
    expect(confirm.status).toBeGreaterThanOrEqual(400);
    expect(db.query('SELECT status FROM scans')).toEqual([{ status: 'pending' }]);
  });
});
