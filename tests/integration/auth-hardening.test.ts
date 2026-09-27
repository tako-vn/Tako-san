import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authMiddleware } from '../../src/worker/middleware/auth';
import { authRoutes } from '../../src/worker/routes/auth';
import { inventoryRoutes } from '../../src/worker/routes/inventory';
import { preferencesRoutes } from '../../src/worker/routes/preferences';
import { sendEmail } from '../../src/worker/services/email';
import type { AuthContext, Env } from '../../src/worker/types';
import { signJwt } from '../../src/worker/utils/jwt';
import { verifyPassword } from '../../src/worker/utils/password';
import { hmacSha256Hex, SESSION_COOKIE, sha256Hex } from '../../src/worker/utils/session';
import { createOtpDigest } from '../../src/worker/utils/otp-digest';
import { createBarrier, SqliteD1 } from '../helpers/sqlite-d1';

// The Workers-only cloudflare:email module cannot load in Node; no network mail is sent.
vi.mock('../../src/worker/services/email', () => ({
  sendEmail: vi.fn(async () => ({ sent: true, provider: 'test' })),
  buildOtpEmail: (code: string) => ({ subject: 'Test OTP', html: `<p>${code}</p>`, text: code }),
}));

const ORIGIN = 'https://frigo.example.com';
const EMAIL = 'auth-hardening@example.com';
const PASSWORD = 'initial-password-strong';
const OTP_SECRET = 'integration-only-otp-secret-at-least-32-bytes';
const JWT_SECRET = 'integration-only-jwt-secret-at-least-32-bytes';
const authApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
authApp.use('*', authMiddleware);
authApp.route('/', authRoutes);
authApp.route('/', inventoryRoutes);
authApp.route('/', preferencesRoutes);
authApp.all('/private', (c) => c.json({ auth: c.get('auth') }));

interface RequestOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  origin?: string | null;
  referer?: string;
  headers?: Record<string, string>;
  env?: Partial<Env>;
  withoutTurnstile?: boolean;
}

interface OtpRow {
  id: string;
  code_digest: string;
  digest_version: number;
  expires_at: string;
  used: number;
  used_at: string | null;
  attempt_count: number;
  locked_until: string | null;
}

let fixtureNumber = 0;
let db: SqliteD1;
let env: Env;
let scheduled: Promise<unknown>[];

async function request(route: string, options: RequestOptions = {}) {
  const headers = new Headers({ 'CF-Connecting-IP': `198.51.100.${fixtureNumber}` });
  if (options.origin !== null) headers.set('Origin', options.origin ?? ORIGIN);
  if (options.referer) headers.set('Referer', options.referer);
  if (options.cookie) headers.set('Cookie', options.cookie);
  for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await authApp.fetch(new Request(`${ORIGIN}${route}`, {
    method: options.method ?? 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify({ turnstileToken: options.withoutTurnstile ? undefined : 'test-widget-token', ...options.body as object }),
  }), { ...env, ...options.env }, { waitUntil: (task) => { scheduled.push(task); }, passThroughOnException: () => {}, props: {} });
  return { response, status: response.status, json: await response.json() as any };
}

function deliveredCode(): string {
  const calls = vi.mocked(sendEmail).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const message = calls[calls.length - 1][1];
  expect(message.to).toBe(EMAIL);
  expect(message.text).toMatch(/^\d{6}$/);
  return message.text!;
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get('Set-Cookie');
  expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[a-f0-9]+;`));
  return cookie!.split(';')[0];
}

function otp(purpose = 'register'): OtpRow {
  return db.query<OtpRow>(
    'SELECT * FROM auth_otps WHERE email = ? AND purpose = ? ORDER BY rowid DESC LIMIT 1',
    EMAIL,
    purpose,
  )[0];
}

function expectOtpTtl(expiresInMinutes: number, startedAt: number, purpose = 'register') {
  const expiresAt = Date.parse(otp(purpose).expires_at);
  const durationMs = expiresInMinutes * 60 * 1000;
  expect(expiresAt).toBeGreaterThanOrEqual(startedAt + durationMs);
  expect(expiresAt).toBeLessThanOrEqual(Date.now() + durationMs);
}

function resendCache() {
  const records = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const value = records.get(key) ?? null;
      return value && type === 'json' ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => { records.set(key, value); }),
    delete: vi.fn(async (key: string) => { records.delete(key); }),
  };
}

function nextOtpDiffersFrom(code: string) {
  vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce((array) => {
    if (!(array instanceof Uint32Array)) throw new Error('Expected OTP randomness');
    array.fill(code === '100000' ? 1 : 0);
    return array;
  });
}

function sessionCount(): number {
  return Number(db.query('SELECT COUNT(*) AS count FROM sessions_v2')[0].count);
}

async function register() {
  const result = await request('/auth/register', {
    body: { name: 'Auth Test', email: `  ${EMAIL.toUpperCase()}  `, password: PASSWORD },
  });
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  expect(result.json).not.toHaveProperty('devOtp');
  expect(result.response.headers.get('Set-Cookie')).toBeNull();
  return { ...result, code: deliveredCode() };
}

async function verify(code: string, purpose = 'register') {
  return request('/auth/verify-otp', { body: { email: EMAIL, code, purpose } });
}

async function signup() {
  const registration = await register();
  const result = await verify(registration.code);
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  return { ...result, cookie: cookieFrom(result.response), code: registration.code };
}

async function forgotPassword() {
  const result = await request('/auth/forgot-password', { body: { email: EMAIL } });
  expect(result.status, JSON.stringify(result.json)).toBe(200);
  expect(result.json).not.toHaveProperty('devOtp');
  return deliveredCode();
}

beforeEach(() => {
  fixtureNumber += 1;
  scheduled = [];
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })));
  db = new SqliteD1();
  env = {
    DB: db,
    ENVIRONMENT: 'production',
    APP_URL: `${ORIGIN}/app`,
    OTP_HASH_SECRET: OTP_SECRET,
    JWT_SECRET,
    TURNSTILE_SITE_KEY: 'integration-site-key',
    TURNSTILE_SECRET_KEY: 'integration-secret-key',
  };
});

afterEach(async () => {
  await Promise.all(scheduled);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  db.close();
});

describe('real SQLite D1 integration harness', () => {
  it('applies all migrations through 0018 with real constraints and no plaintext OTP column', () => {
    expect(db.migrations).toContain('0018_payments.sql');
    const columns = db.query<{ name: string }>('PRAGMA table_info(auth_otps)').map((column) => column.name);
    expect(columns).toEqual(expect.arrayContaining(['code_digest', 'attempt_count', 'used_at', 'locked_until']));
    expect(columns).not.toContain('code');
    expect(db.query('PRAGMA foreign_keys')[0].foreign_keys).toBe(1);
    expect(db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('runs each concurrent batch serially without per-statement async interleaving', async () => {
    db.seed('CREATE TABLE test_atomic_events (sequence INTEGER PRIMARY KEY, owner TEXT NOT NULL)');
    const start = createBarrier(2);
    const perStatement = vi.fn();
    db.hooks = { beforeBatch: () => start.wait(), beforeStatement: perStatement };
    const batches = ['A', 'B'].map((owner) => db.batch([
      db.prepare('INSERT INTO test_atomic_events (owner) VALUES (?)').bind(owner),
      db.prepare('INSERT INTO test_atomic_events (owner) VALUES (?)').bind(owner),
    ]));
    await Promise.all(batches);
    expect(start.arrivals).toBe(2);
    expect(perStatement).not.toHaveBeenCalled();
    const owners = db.query<{ owner: string }>('SELECT owner FROM test_atomic_events ORDER BY sequence').map((row) => row.owner);
    expect(['AABB', 'BBAA']).toContain(owners.join(''));
    expect(await db.prepare('SELECT COUNT(*) AS count FROM test_atomic_events').first('count')).toBe(4);
    const read = await db.prepare('SELECT owner FROM test_atomic_events').all();
    expect(read.results).toHaveLength(4);
    expect(read.meta.changes).toBe(0);
  });

  it('rolls back a whole batch on a later constraint failure and accepts the next transaction', async () => {
    db.seed('CREATE TABLE test_batch_rollback (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    await expect(db.batch([
      db.prepare('INSERT INTO test_batch_rollback VALUES (?, ?)').bind('same', 1),
      db.prepare('INSERT INTO test_batch_rollback VALUES (?, ?)').bind('same', 2),
    ])).rejects.toThrow(/UNIQUE/);
    expect(db.query('SELECT * FROM test_batch_rollback')).toEqual([]);
    const results = await db.batch([db.prepare('INSERT INTO test_batch_rollback VALUES (?, ?) RETURNING value').bind('next', 3)]);
    expect(results[0].meta.changes).toBe(1);
    expect(results[0].results).toEqual([{ value: 3 }]);
  });

  it('commits earlier batch writes when a later conditional update changes zero rows, as D1 does', async () => {
    db.seed('CREATE TABLE test_batch_fence (id TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    const results = await db.batch([
      db.prepare('INSERT INTO test_batch_fence VALUES (?, ?)').bind('written', 1),
      db.prepare('UPDATE test_batch_fence SET value = 2 WHERE id = ?').bind('missing'),
    ]);
    expect(results.map((result) => result.meta.changes)).toEqual([1, 0]);
    expect(await db.prepare('SELECT value FROM test_batch_fence WHERE id = ?').bind('written').first('value')).toBe(1);
  });
});

describe('cookie authentication and production CSRF', () => {
  it('issues a production HttpOnly opaque cookie, persists only its hash, and authenticates against D1', async () => {
    const result = await signup();
    const setCookie = result.response.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('; Path=/;');
    expect(setCookie).toContain('; HttpOnly;');
    expect(setCookie).toContain('; Secure;');
    expect(setCookie).toContain('; SameSite=Lax;');
    expect(setCookie).toContain('Max-Age=604800');
    expect(setCookie).not.toMatch(/Domain=/i);
    const token = result.cookie.slice(SESSION_COOKIE.length + 1);
    const sessions = db.query<{ token_hash: string; user_id: string }>('SELECT * FROM sessions_v2');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].token_hash).toBe(await sha256Hex(token));
    expect(JSON.stringify(sessions)).not.toContain(token);
    expect(db.query('SELECT * FROM sessions')).toEqual([]);
    expect(result.json).not.toHaveProperty('token');
    expect(JSON.stringify(result.json)).not.toContain(token);
    const profile = await request('/me', { method: 'GET', cookie: result.cookie, origin: null });
    expect(profile.status).toBe(200);
    const privateRead = await request('/private', { method: 'GET', cookie: result.cookie, origin: null });
    expect(privateRead.json.auth.userId).toBe(sessions[0].user_id);
    expect((await request('/private', { method: 'GET', cookie: `${SESSION_COOKIE}=${sessions[0].token_hash}` })).status).toBe(401);
  });

  it('rejects a session immediately when it expires, is revoked, or is deleted in D1', async () => {
    const { cookie } = await signup();
    expect((await request('/private', { method: 'GET', cookie })).status).toBe(200);
    for (const expiry of [new Date(Date.now() - 60_000).toISOString(), '2000-01-01 00:00:00', 'invalid-date']) {
      await db.prepare('UPDATE sessions_v2 SET expires_at = ?').bind(expiry).run();
      expect((await request('/private', { method: 'GET', cookie })).status).toBe(401);
    }
    db.seed("UPDATE sessions_v2 SET expires_at = datetime('now', '+1 day'), revoked_at = datetime('now')");
    expect((await request('/private', { method: 'GET', cookie })).status).toBe(401);
    db.seed('DELETE FROM sessions_v2');
    expect((await request('/private', { method: 'GET', cookie })).status).toBe(401);
  });

  it('does not fall back to a cached identity when the authoritative session lookup fails', async () => {
    const { cookie } = await signup();
    expect((await request('/private', { method: 'GET', cookie })).status).toBe(200);
    db.hooks.beforeStatement = (event) => {
      if (event.method === 'first' && /FROM sessions_v2/.test(event.sql)) throw new Error('D1 unavailable');
    };
    const result = await request('/private', { method: 'GET', cookie });
    expect(result.status).toBe(503);
    expect(result.json).toMatchObject({ code: 'AUTH_UNAVAILABLE' });
    expect(result.json).not.toHaveProperty('auth');
    expect(result.response.headers.get('Set-Cookie')).toBeNull();
  });

  it('does not issue a cookie or token when session persistence fails', async () => {
    await signup();
    db.seed("CREATE TRIGGER fail_session_insert BEFORE INSERT ON sessions_v2 BEGIN SELECT RAISE(ABORT, 'session storage unavailable'); END");
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await request('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(result.status).toBe(500);
    expect(result.json.success).not.toBe(true);
    expect(result.json).not.toHaveProperty('token');
    expect(result.response.headers.get('Set-Cookie')).toBeNull();
    expect(sessionCount()).toBe(1);
  });

  it('accepts exact configured origins and trusted Referer-only requests for cookie mutations', async () => {
    const { cookie } = await signup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await request('/private', { method, cookie })).status).toBe(200);
      expect((await request('/private', { method, cookie, origin: null, referer: `${ORIGIN}/account?tab=profile` })).status).toBe(200);
    }
    const login = await request('/auth/login', {
      origin: null, referer: `${ORIGIN}/login`, body: { email: EMAIL, password: PASSWORD },
    });
    expect(login.status).toBe(200);
    cookieFrom(login.response);
  });

  it.each([
    ['prefix-lookalike', { origin: `${ORIGIN}.attacker.com` }],
    ['malformed', { origin: 'not a URL' }],
    ['missing', { origin: null }],
    ['opaque', { origin: 'null' }],
    ['untrusted Referer only', { origin: null, referer: `${ORIGIN}.attacker.com/account` }],
    ['malformed Referer only', { origin: null, referer: '::invalid::' }],
    ['malformed Origin with trusted Referer', { origin: 'null', referer: `${ORIGIN}/account` }],
    ['untrusted Origin with trusted Referer', { origin: 'https://attacker.example', referer: `${ORIGIN}/account` }],
    ['scheme mismatch', { origin: ORIGIN.replace('https:', 'http:') }],
    ['port mismatch', { origin: `${ORIGIN}:8443` }],
    ['Origin carrying a path', { origin: `${ORIGIN}/account` }],
    ['Origin carrying credentials', { origin: 'https://attacker@frigo.example.com' }],
    ['Referer carrying credentials', { origin: null, referer: 'https://attacker@frigo.example.com/account' }],
  ] satisfies [string, RequestOptions][])('denies %s origin signals for all cookie mutation methods', async (_name, signal) => {
    const { cookie } = await signup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const result = await request('/private', { method, cookie, ...signal });
      expect(result.status).toBe(403);
      expect(result.json.code).toBe('CSRF_ORIGIN_DENIED');
    }
  });

  it('does not exempt public authentication or logout from production origin checks, even without a cookie', async () => {
    const { cookie } = await signup();
    const initialSessions = sessionCount();
    const initialOtps = db.query('SELECT * FROM auth_otps');
    for (const route of ['login', 'register', 'verify-otp', 'resend-otp', 'forgot-password', 'reset-password', 'google', 'guest', 'logout']) {
      for (const currentCookie of [undefined, cookie]) {
        for (const origin of [null, `${ORIGIN}.attacker.com`, 'https://[broken']) {
          const result = await request(`/auth/${route}`, { cookie: currentCookie, origin, body: {} });
          expect(result.status, `${route}: ${origin}, cookie=${Boolean(currentCookie)}`).toBe(403);
          expect(result.json.code).toBe('CSRF_ORIGIN_DENIED');
          expect(result.response.headers.get('Set-Cookie')).toBeNull();
        }
      }
    }
    expect(sessionCount()).toBe(initialSessions);
    expect(db.query('SELECT * FROM auth_otps')).toEqual(initialOtps);
    expect((await request('/private', { method: 'GET', cookie })).status).toBe(200);
  });

  it('only permits explicitly configured development origins and never grants that exception in production', async () => {
    const { cookie } = await signup();
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8787', 'http://127.0.0.1:8787']) {
      expect((await request('/private', { cookie, origin, env: { ENVIRONMENT: 'development' } })).status).toBe(200);
      expect((await request('/private', { cookie, origin })).status).toBe(403);
    }
    for (const origin of ['http://localhost:9999', 'http://localhost:5173.attacker.com', 'https://localhost:5173']) {
      expect((await request('/private', { cookie, origin, env: { ENVIRONMENT: 'development' } })).status).toBe(403);
    }
  });

  it('does not apply browser CSRF rules to the separate development Bearer API or allow it in production', async () => {
    const token = await signJwt({ sub: 'dev-client', hid: 'dev-household', typ: 'access', exp: Math.floor(Date.now() / 1000) + 60 }, JWT_SECRET);
    const headers = { Authorization: `Bearer ${token}` };
    for (const origin of [null, 'https://another-client.example']) {
      const result = await request('/private', { headers, origin, env: { ENVIRONMENT: 'development' } });
      expect(result.status).toBe(200);
      expect(result.json.auth.userId).toBe('dev-client');
    }
    expect((await request('/private', { headers, origin: null })).status).toBe(401);
  });

  it('still requires CSRF for a cookie-bearing development request with a valid Bearer token', async () => {
    const { cookie } = await signup();
    const token = await signJwt({ sub: 'dev-client', hid: 'dev-household', typ: 'access', exp: Math.floor(Date.now() / 1000) + 60 }, JWT_SECRET);
    const result = await request('/private', {
      cookie, origin: null, headers: { Authorization: `Bearer ${token}` }, env: { ENVIRONMENT: 'development' },
    });
    expect(result.status).toBe(403);
    expect(result.json.code).toBe('CSRF_ORIGIN_DENIED');
  });

  it('fails closed when registration has no valid Turnstile token', async () => {
    const outbound = vi.fn();
    vi.stubGlobal('fetch', outbound);
    const result = await request('/auth/register', {
      withoutTurnstile: true,
      body: { name: 'Auth Test', email: EMAIL, password: PASSWORD },
      env: { TURNSTILE_SECRET_KEY: 'integration-turnstile-secret' },
    });
    expect(result.status).toBe(403);
    expect(result.json.code).toBe('TURNSTILE_FAILED');
    expect(outbound).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.query('SELECT * FROM auth_accounts WHERE email = ?', EMAIL)).toEqual([]);
  });

  it('registers and verifies a staging account with the test widget despite a retained Worker secret', async () => {
    const outbound = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal('fetch', outbound);
    const stagingEnv = {
      ENVIRONMENT: 'staging' as const,
      TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      TURNSTILE_SECRET_KEY: 'stale-real-secret',
    };
    const registration = await request('/auth/register', {
      body: { name: 'T20 Staging Test', email: EMAIL, password: PASSWORD, turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX' },
      env: stagingEnv,
    });
    expect(registration.status, JSON.stringify(registration.json)).toBe(200);
    expect(registration.json.devOtp).toMatch(/^\d{6}$/);
    const [, init] = outbound.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.body as FormData).get('secret')).toBe('1x0000000000000000000000000000000AA');
    const verified = await request('/auth/verify-otp', {
      body: { email: EMAIL, code: registration.json.devOtp, purpose: 'register' },
      env: stagingEnv,
    });
    expect(verified.status, JSON.stringify(verified.json)).toBe(200);
    expect(verified.json.user.isGuest).toBe(false);
    expect(cookieFrom(verified.response)).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
  });

  it('does not require another Turnstile challenge for login, password recovery, or OTP resend', async () => {
    const registration = await register();
    vi.mocked(fetch).mockClear();

    const resend = await request('/auth/resend-otp', {
      withoutTurnstile: true,
      body: { email: EMAIL, purpose: 'register' },
    });
    expect(resend.status).toBe(200);

    const verified = await verify(deliveredCode());
    expect(verified.status).toBe(200);

    const login = await request('/auth/login', {
      withoutTurnstile: true,
      body: { email: EMAIL, password: PASSWORD },
    });
    expect(login.status).toBe(200);

    const forgot = await request('/auth/forgot-password', {
      withoutTurnstile: true,
      body: { email: EMAIL },
    });
    expect(forgot.status).toBe(200);
    expect(registration.code).toMatch(/^\d{6}$/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('expected-owner fencing across cookie changes', () => {
  class MemoryStorage implements Storage {
    private values = new Map<string, string>();
    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    getItem(key: string) { return this.values.get(key) ?? null; }
    key(index: number) { return [...this.values.keys()][index] ?? null; }
    removeItem(key: string) { this.values.delete(key); }
    setItem(key: string, value: string) { this.values.set(key, String(value)); }
  }

  const expectedOwner = (userId = 'owner-a', householdId = 'house-a') => ({
    'X-Frigo-Expected-User-Id': userId,
    'X-Frigo-Expected-Household-Id': householdId,
  });

  async function seedOwner(userId = 'owner-a', householdId = 'house-a') {
    const token = crypto.randomUUID();
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)').bind(userId, `${userId}@example.test`),
      db.prepare('INSERT INTO households (id, name, created_by) VALUES (?, ?, ?)').bind(householdId, householdId, userId),
      db.prepare('INSERT INTO household_members (id, household_id, user_id) VALUES (?, ?, ?)').bind(`${userId}:${householdId}`, householdId, userId),
      db.prepare("INSERT INTO sessions_v2 (id, user_id, household_id, token_hash, expires_at) VALUES (?, ?, ?, ?, datetime('now', '+1 day'))")
        .bind(`session:${userId}:${householdId}`, userId, householdId, await sha256Hex(token)),
    ]);
    return `${SESSION_COOKIE}=${token}`;
  }

  async function loadOwnerClient() {
    vi.resetModules();
    vi.stubGlobal('localStorage', new MemoryStorage());
    vi.stubGlobal('sessionStorage', new MemoryStorage());
    vi.stubGlobal('window', new EventTarget());
    const { api } = await import('../../src/web/services/api');
    const { useAuthStore } = await import('../../src/web/stores/useAuthStore');
    const sync = await import('../../src/web/lib/sync');
    const session = await import('../../src/web/lib/private-session');
    useAuthStore.getState().setAuthSession({ id: 'owner-a', householdId: 'house-a', email: 'owner-a@example.test', displayName: 'Owner A' });
    return { api, sync, session, auth: useAuthStore };
  }

  it('allows matching owner pairs and legacy clients omitting both headers for reads and writes', async () => {
    const cookie = await seedOwner();
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const headers of [undefined, expectedOwner()]) {
        const result = await request('/private', { method, cookie, headers });
        expect(result.status).toBe(200);
        expect(result.json.auth).toMatchObject({ userId: 'owner-a', householdId: 'house-a' });
      }
    }
  });

  it.each([
    ['another user', expectedOwner('owner-b')],
    ['another household', expectedOwner('owner-a', 'house-b')],
    ['user only', { 'X-Frigo-Expected-User-Id': 'owner-a' }],
    ['household only', { 'X-Frigo-Expected-Household-Id': 'house-a' }],
    ['empty user', expectedOwner('', 'house-a')],
    ['empty household', expectedOwner('owner-a', '')],
    ['both empty', expectedOwner('', '')],
  ])('rejects %s before private read/write handlers or session touch', async (_name, headers) => {
    const cookie = await seedOwner();
    const changesBefore = db.query('SELECT total_changes() AS changes');
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const result = await request('/private', { method, cookie, headers });
      expect(result.status).toBe(403);
      expect(result.json).toMatchObject({ code: 'SESSION_OWNER_MISMATCH' });
      expect(result.json).not.toHaveProperty('auth');
    }
    expect((await request('/me', { method: 'GET', cookie, headers })).status).toBe(403);
    expect(db.query('SELECT total_changes() AS changes')).toEqual(changesBefore);
  });

  it.each(['access', 'guest'] as const)('preserves the legacy development %s Bearer contract but validates supplied owner pairs', async (typ) => {
    const token = await signJwt({ sub: 'owner-a', hid: 'house-a', typ, isGuest: typ === 'guest', exp: Math.floor(Date.now() / 1000) + 60 }, JWT_SECRET);
    for (const method of ['GET', 'POST']) {
      for (const owner of [undefined, expectedOwner()]) {
        const result = await request('/private', { method, origin: null, env: { ENVIRONMENT: 'development' },
          headers: { Authorization: `Bearer ${token}`, ...owner } });
        expect(result.status).toBe(200);
      }
      for (const owner of [expectedOwner('owner-b'), expectedOwner('owner-a', 'house-b'), { 'X-Frigo-Expected-User-Id': 'owner-a' }]) {
        const result = await request('/private', { method, origin: null, env: { ENVIRONMENT: 'development' },
          headers: { Authorization: `Bearer ${token}`, ...owner } });
        expect(result.status).toBe(403);
        expect(result.json.code).toBe('SESSION_OWNER_MISMATCH');
      }
    }
  });

  it('rejects an A replay when /me authenticates A but another tab installs B cookie before the mutation, retaining the owned outbox', async () => {
    const cookieA = await seedOwner();
    const cookieB = await seedOwner('owner-b', 'house-b');
    const client = await loadOwnerClient();
    client.sync.pushOp({ path: '/inventory', method: 'POST', label: 'A private food',
      body: JSON.stringify({ id: 'owner-bound-item', name: 'A private food', quantity: 1, unit: 'piece' }),
      userId: 'owner-a', householdId: 'house-a', operationId: 'owner-bound-command' });
    const pending = client.sync.getPendingOps();
    let browserCookie = cookieA;
    let swapCookie = true;
    let changesAfterMe: unknown;
    const responses: { path: string; status: number }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const path = url.replace('/api/v1', '');
      const headers = new Headers(init.headers);
      expect(headers.get('X-Frigo-Expected-User-Id')).toBe('owner-a');
      expect(headers.get('X-Frigo-Expected-Household-Id')).toBe('house-a');
      headers.set('Cookie', browserCookie);
      headers.set('Origin', ORIGIN);
      const response = await authApp.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env);
      responses.push({ path, status: response.status });
      if (path === '/me' && swapCookie) {
        expect(await response.clone().json()).toMatchObject({ user: { id: 'owner-a', household: { id: 'house-a' } } });
        browserCookie = cookieB;
        swapCookie = false;
        changesAfterMe = db.query('SELECT total_changes() AS changes');
      }
      return response;
    }));

    await expect(client.api.retryPendingWrites()).resolves.toEqual({ attempted: 0, remaining: 1 });
    expect(responses).toEqual([{ path: '/me', status: 200 }, { path: '/inventory', status: 403 }]);
    expect(db.query('SELECT total_changes() AS changes')).toEqual(changesAfterMe);
    expect(db.query('SELECT * FROM inventory_items WHERE household_id IN (?, ?)', 'house-a', 'house-b')).toEqual([]);
    expect(db.query('SELECT * FROM inventory_events WHERE household_id IN (?, ?)', 'house-a', 'house-b')).toEqual([]);
    expect(client.sync.getPendingOps()).toEqual(pending);
    expect(JSON.parse(localStorage.getItem('frigo_sync_outbox_v1')!)).toEqual(pending);
    expect(client.auth.getState()).toMatchObject({ userId: 'owner-a', householdId: 'house-a' });

    browserCookie = cookieA;
    await expect(client.api.retryPendingWrites()).resolves.toEqual({ attempted: 1, remaining: 0 });
    expect(db.query('SELECT id, household_id FROM inventory_items WHERE household_id IN (?, ?)', 'house-a', 'house-b'))
      .toEqual([{ id: 'owner-bound-item', household_id: 'house-a' }]);
    expect(db.query('SELECT * FROM inventory_items WHERE household_id = ?', 'house-b')).toEqual([]);
  });

  it('does not read or cache B inventory under A when the cookie changes before local storage', async () => {
    await seedOwner();
    const cookieB = await seedOwner('owner-b', 'house-b');
    const created = await request('/inventory', { cookie: cookieB, body: { id: 'private-b-item', name: 'B secret food', quantity: 1 } });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const client = await loadOwnerClient();
    const cacheKey = client.session.privateCacheKey('inventory');
    localStorage.setItem(cacheKey, '[{"name":"A cached food"}]');
    let privateResponse: Response | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Cookie', cookieB);
      privateResponse = await authApp.fetch(new Request(`${ORIGIN}${url.replace('/api/v1', '')}`, { ...init, headers }), env);
      return privateResponse.clone();
    }));

    await expect(client.api.getInventory()).rejects.toMatchObject({ kind: 'auth', status: 403 });
    expect(await privateResponse!.json()).toEqual({ error: 'Request owner does not match authenticated session', code: 'SESSION_OWNER_MISMATCH' });
    expect(localStorage.getItem(cacheKey)).toBe('[{"name":"A cached food"}]');
    expect(client.session.currentPrivateScope()).toEqual({ userId: 'owner-a', householdId: 'house-a' });
    const legitimate = await request('/inventory', { method: 'GET', cookie: cookieB, headers: expectedOwner('owner-b', 'house-b') });
    expect(legitimate.status).toBe(200);
    expect(legitimate.json.items).toMatchObject([{ id: 'private-b-item', name: 'B secret food', householdId: 'house-b' }]);
  });
});

describe('D1-authoritative OTP verification', () => {
  it('returns registration expiry metadata matching the persisted OTP TTL and ignores client TTL input', async () => {
    const startedAt = Date.now();
    const result = await request('/auth/register', {
      body: { name: 'Auth Test', email: EMAIL, password: PASSWORD, expiresInMinutes: 1 },
    });
    expect(result.status).toBe(200);
    expect(result.json.expiresInMinutes).toBe(10);
    expect(Object.keys(result.json).sort()).toEqual(['email', 'expiresInMinutes', 'message', 'success']);
    expectOtpTtl(result.json.expiresInMinutes, startedAt);
  });

  it('returns authoritative expiry for register resend and preserves replacement semantics', async () => {
    const initial = await register();
    const oldOtpId = otp().id;
    nextOtpDiffersFrom(initial.code);
    const startedAt = Date.now();
    const resend = await request('/auth/resend-otp', {
      body: { email: EMAIL, purpose: 'register', expiresInMinutes: 1 },
    });
    expect(resend.status).toBe(200);
    expect(resend.json).toMatchObject({ success: true, expiresInMinutes: 10 });
    expect(Object.keys(resend.json).sort()).toEqual(['expiresInMinutes', 'message', 'success']);
    expectOtpTtl(resend.json.expiresInMinutes, startedAt);
    expect(otp().id).not.toBe(oldOtpId);
    expect(db.query<{ used: number }>('SELECT used FROM auth_otps WHERE id = ?', oldOtpId)[0].used).toBe(1);
    expect(otp().used).toBe(0);

    expect((await verify(initial.code)).status).toBe(400);
    const replacement = deliveredCode();
    expect((await verify(replacement)).status).toBe(200);
  });

  it('returns authoritative expiry for login resend without crossing OTP purposes', async () => {
    await register();
    const startedAt = Date.now();
    const resend = await request('/auth/resend-otp', {
      body: { email: EMAIL, purpose: 'login', expiresInMinutes: 1 },
    });
    expect(resend.status).toBe(200);
    expect(resend.json).toMatchObject({ success: true, expiresInMinutes: 10 });
    expect(Object.keys(resend.json).sort()).toEqual(['expiresInMinutes', 'message', 'success']);
    expectOtpTtl(resend.json.expiresInMinutes, startedAt, 'login');
    const loginCode = deliveredCode();
    expect((await verify(loginCode, 'login')).status).toBe(200);
    expect(otp('register').used).toBe(0);
  });

  it('returns the same policy expiry for forgot-password request and resend', async () => {
    await signup();
    const initialStartedAt = Date.now();
    const initial = await request('/auth/forgot-password', { body: { email: EMAIL } });
    expect(initial.status).toBe(200);
    expect(initial.json.expiresInMinutes).toBe(10);
    expectOtpTtl(initial.json.expiresInMinutes, initialStartedAt, 'forgot_password');
    const oldCode = deliveredCode();
    const oldOtpId = otp('forgot_password').id;
    nextOtpDiffersFrom(oldCode);

    const resendStartedAt = Date.now();
    const resend = await request('/auth/resend-otp', {
      body: { email: EMAIL, purpose: 'forgot_password', expiresInMinutes: 1 },
    });
    expect(resend.status).toBe(200);
    expect(resend.json).toMatchObject({ success: true, expiresInMinutes: 10 });
    expectOtpTtl(resend.json.expiresInMinutes, resendStartedAt, 'forgot_password');
    expect(otp('forgot_password').id).not.toBe(oldOtpId);
    expect(db.query<{ used: number }>('SELECT used FROM auth_otps WHERE id = ?', oldOtpId)[0].used).toBe(1);
    const replacement = deliveredCode();
    expect((await verify(oldCode, 'forgot_password')).status).toBe(400);
    expect((await verify(replacement, 'forgot_password')).status).toBe(200);
    expect(otp('forgot_password').used).toBe(0);
  });

  it('keeps the existing development OTP response valid', async () => {
    const result = await request('/auth/register', {
      env: { ENVIRONMENT: 'development' },
      body: { name: 'Auth Test', email: EMAIL, password: PASSWORD },
    });
    expect(result.status).toBe(200);
    expect(result.json.devOtp).toMatch(/^\d{6}$/);

    const devLoginResend = await request('/auth/resend-otp', {
      env: { ENVIRONMENT: 'development' },
      body: { email: EMAIL, purpose: 'login' },
    });
    expect(devLoginResend.status).toBe(200);
    expect(devLoginResend.json).toMatchObject({ success: true, expiresInMinutes: 10 });
    expect(devLoginResend.json.devOtp).toMatch(/^\d{6}$/);
    const devLoginVerified = await request('/auth/verify-otp', {
      env: { ENVIRONMENT: 'development' },
      body: { email: EMAIL, code: devLoginResend.json.devOtp, purpose: 'login' },
    });
    expect(devLoginVerified.status).toBe(200);

    const verified = await request('/auth/verify-otp', {
      env: { ENVIRONMENT: 'development' },
      body: { email: EMAIL, code: result.json.devOtp, purpose: 'register' },
    });
    expect(verified.status).toBe(200);
  });

  it('fails registration honestly and invalidates the challenge when no provider accepts the OTP', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ sent: false, provider: 'workers-email', error: 'sender_not_verified' } as any);
    const result = await request('/auth/register', {
      body: { name: 'Auth Test', email: EMAIL, password: PASSWORD },
    });
    expect(result.status).toBe(503);
    expect(result.json).toMatchObject({
      success: false,
      code: 'OTP_DELIVERY_UNAVAILABLE',
      accountCreated: true,
      email: EMAIL,
    });
    expect(result.json.message).not.toContain('đã gửi');
    expect(result.json).not.toHaveProperty('devOtp');
    expect(result.response.headers.get('Set-Cookie')).toBeNull();
    expect(otp().used).toBe(1);
    expect(db.query('SELECT is_verified FROM auth_accounts WHERE email = ?', EMAIL)[0].is_verified).toBe(0);
    expect((await verify(deliveredCode())).status).toBe(400);
  });

  it('keeps a registration OTP usable when the secondary provider accepts delivery', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ sent: true, provider: 'resend', messageId: 'fallback-message' } as any);
    const registration = await request('/auth/register', {
      body: { name: 'Auth Test', email: EMAIL, password: PASSWORD },
    });
    expect(registration.status).toBe(200);
    expect(registration.json).toMatchObject({ success: true, expiresInMinutes: 10 });
    expect(registration.json).not.toHaveProperty('devOtp');
    expect(otp().used).toBe(0);

    const verified = await verify(deliveredCode());
    expect(verified.status).toBe(200);
    expect(otp().used).toBe(1);
    expect(db.query('SELECT is_verified FROM auth_accounts WHERE email = ?', EMAIL)[0].is_verified).toBe(1);
  });

  it('recovers from initial registration delivery failure through a secured resend', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ sent: false, provider: 'workers-email', error: 'provider_unavailable' } as any);
    const initial = await request('/auth/register', {
      body: { name: 'Auth Test', email: EMAIL, password: PASSWORD },
    });
    expect(initial.status).toBe(503);
    const failedCode = deliveredCode();
    expect(otp().used).toBe(1);

    nextOtpDiffersFrom(failedCode);
    const resend = await request('/auth/resend-otp', {
      body: { email: EMAIL, purpose: 'register' },
    });
    expect(resend.status).toBe(200);
    expect(resend.json).toMatchObject({ success: true, expiresInMinutes: 10 });
    const replacement = deliveredCode();
    expect(replacement).not.toBe(failedCode);
    expect((await verify(failedCode)).status).toBe(400);
    expect((await verify(replacement)).status).toBe(200);
  });

  it('fails resend honestly and leaves the newly generated challenge unusable', async () => {
    await register();
    const cache = resendCache();
    env.CACHE = cache as unknown as Env['CACHE'];
    vi.mocked(sendEmail).mockResolvedValueOnce({ sent: false, provider: 'workers-email', error: 'provider_unavailable' } as any);
    const result = await request('/auth/resend-otp', { body: { email: EMAIL, purpose: 'register' } });
    expect(result.status).toBe(503);
    expect(result.json).toMatchObject({ success: false, code: 'OTP_DELIVERY_UNAVAILABLE' });
    expect(result.json.message).not.toContain('Đã gửi');
    expect(result.json).not.toHaveProperty('expiresInMinutes');
    expect(otp().used).toBe(1);
    expect(cache.delete).toHaveBeenCalledWith(`otp_resend_${EMAIL}_register`);
    const retry = await request('/auth/resend-otp', { body: { email: EMAIL, purpose: 'register' } });
    expect(retry.status).toBe(200);
    expect(retry.json.expiresInMinutes).toBe(10);
  });

  it.each(['register', 'forgot_password'])('retains the 60-second %s resend cooldown without replacing a blocked OTP', async (purpose) => {
    await register();
    const cache = resendCache();
    env.CACHE = cache as unknown as Env['CACHE'];
    const body = { email: `  ${EMAIL.toUpperCase()}  `, purpose };
    expect((await request('/auth/resend-otp', { body })).status).toBe(200);
    const before = db.query('SELECT * FROM auth_otps');
    const mailCount = vi.mocked(sendEmail).mock.calls.length;
    const blocked = await request('/auth/resend-otp', { body });
    expect(blocked.status).toBe(429);
    expect(blocked.response.headers.get('Retry-After')).toBe('60');
    expect(blocked.json.retryAfterSeconds).toBe(60);
    expect(blocked.json).not.toHaveProperty('expiresInMinutes');
    expect(cache.put).toHaveBeenCalledWith(`otp_resend_${EMAIL}_${purpose}`, '1', { expirationTtl: 60 });
    expect(db.query('SELECT * FROM auth_otps')).toEqual(before);
    expect(sendEmail).toHaveBeenCalledTimes(mailCount);
  });

  it('retains route-level rate limiting before resend issuance', async () => {
    await register();
    const cache = resendCache();
    await cache.put(`rl_auth:198.51.100.${fixtureNumber}:/auth/resend-otp`, JSON.stringify({
      count: 15, resetTime: Math.floor(Date.now() / 1000) + 60,
    }));
    env.CACHE = cache as unknown as Env['CACHE'];
    const before = db.query('SELECT * FROM auth_otps');
    const blocked = await request('/auth/resend-otp', { body: { email: EMAIL, purpose: 'register' } });
    expect(blocked.status).toBe(429);
    expect(blocked.json.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(Number(blocked.response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(blocked.json).not.toHaveProperty('expiresInMinutes');
    expect(db.query('SELECT * FROM auth_otps')).toEqual(before);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it.each(['register', 'forgot_password'])('replaces a %s OTP without another Turnstile challenge', async (purpose) => {
    await register();
    const before = db.query('SELECT * FROM auth_otps');
    const result = await request('/auth/resend-otp', {
      body: { email: EMAIL, purpose }, withoutTurnstile: true,
    });
    expect(result.status).toBe(200);
    expect(result.json.expiresInMinutes).toBe(10);
    expect(db.query('SELECT * FROM auth_otps')).not.toEqual(before);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it.each(['register', 'login'])('does not issue or email a %s OTP for an unknown account', async (purpose) => {
    vi.mocked(sendEmail).mockClear();
    const result = await request('/auth/resend-otp', {
      withoutTurnstile: true,
      body: { email: 'unknown@example.com', purpose },
    });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      success: true,
      message: 'Nếu tài khoản đang chờ xác thực, mã OTP mới sẽ được gửi.',
      expiresInMinutes: 10,
    });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.query('SELECT * FROM auth_otps WHERE email = ?', 'unknown@example.com')).toEqual([]);
  });

  it('keeps resend available when the optional KV cooldown store is unavailable', async () => {
    await register();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    env.CACHE = {
      get: vi.fn(async () => { throw new Error('KV unavailable'); }),
      put: vi.fn(),
      delete: vi.fn(),
    } as unknown as Env['CACHE'];
    const result = await request('/auth/resend-otp', { body: { email: EMAIL, purpose: 'register' } });
    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: 'otp_resend_cooldown_unavailable' }));
  });

  it('stores contextual v2 HMAC only and consumes a correct registration OTP exactly once', async () => {
    const { code } = await register();
    expect(otp().code_digest).toBe(await createOtpDigest(EMAIL, 'register', code, OTP_SECRET));
    expect(otp().digest_version).toBe(2);
    expect(otp().used).toBe(0);
    expect(db.query('SELECT is_verified FROM auth_accounts WHERE email = ?', EMAIL)[0].is_verified).toBe(0);
    const first = await verify(code);
    expect(first.status).toBe(200);
    cookieFrom(first.response);
    expect(otp().used).toBe(1);
    expect(otp().used_at).not.toBeNull();
    expect(db.query('SELECT is_verified FROM auth_accounts WHERE email = ?', EMAIL)[0].is_verified).toBe(1);
    const second = await verify(code);
    expect(second.status).toBe(400);
    expect(second.response.headers.get('Set-Cookie')).toBeNull();
    expect(sessionCount()).toBe(1);
  });

  it('persists onboarding completion and returns it from the authoritative profile', async () => {
    const { cookie } = await signup();
    const before = await request('/me', { method: 'GET', cookie, origin: null });
    expect(before.json.user.onboardingCompleted).toBe(false);
    const saved = await request('/preferences', {
      method: 'PATCH',
      cookie,
      body: {
        householdSize: 3,
        spicyLevel: 'mild',
        favoriteCuisines: ['vietnamese', 'japanese'],
        dietaryRestrictions: ['peanuts'],
        completeOnboarding: true,
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.json.onboardingCompleted).toBe(true);
    const after = await request('/me', { method: 'GET', cookie, origin: null });
    expect(after.json.user).toMatchObject({
      onboardingCompleted: true,
      preferences: {
        householdSize: 3,
        spicyLevel: 'mild',
        favoriteCuisines: ['vietnamese', 'japanese'],
        dietaryRestrictions: ['peanuts'],
      },
    });
  });

  it('allows one concurrent registration consume even when both requests read the unused challenge', async () => {
    const { code } = await register();
    const readers = createBarrier(2);
    db.hooks.afterStatement = (event) => {
      if (event.method === 'first' && /FROM auth_otps\s+WHERE email/.test(event.sql)) return readers.wait();
    };
    const results = await Promise.all([verify(code), verify(code)]);
    expect(readers.arrivals).toBe(2);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(results.filter((result) => result.response.headers.has('Set-Cookie'))).toHaveLength(1);
    expect(sessionCount()).toBe(1);
    expect(otp().used).toBe(1);
  });

  it.each(['absent', 'down'] as const)('keeps attempt counts and lockout authoritative when KV is %s', async (availability) => {
    const { code } = await register();
    const get = vi.fn().mockRejectedValue(new Error('KV unavailable'));
    if (availability === 'down') env.CACHE = { get, put: vi.fn() } as unknown as Env['CACHE'];
    const wrong = code === '111111' ? '222222' : '111111';
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = await request('/auth/verify-otp', {
        body: { email: EMAIL, code: wrong, purpose: 'register' },
        headers: { 'CF-Connecting-IP': `203.0.${fixtureNumber}.${attempt}` },
      });
      expect(result.status).toBe(attempt < 5 ? 400 : 429);
      expect(result.response.headers.get('Set-Cookie')).toBeNull();
      expect(otp().attempt_count).toBe(Math.min(attempt, 5));
    }
    if (availability === 'down') expect(get).toHaveBeenCalled();
    expect(otp().locked_until).not.toBeNull();
    expect((await verify(code)).status).toBe(429);
    expect(otp().used).toBe(0);
    expect(sessionCount()).toBe(0);
  });

  it('caps concurrent wrong attempts in D1 after every request read the same initial count', async () => {
    const { code } = await register();
    const readers = createBarrier(6);
    db.hooks.afterStatement = (event) => {
      if (event.method === 'first' && /FROM auth_otps\s+WHERE email/.test(event.sql)) return readers.wait();
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => verify(code === '111111' ? '222222' : '111111')));
    expect(readers.arrivals).toBe(6);
    expect(results.every((result) => [400, 429].includes(result.status))).toBe(true);
    expect(otp().attempt_count).toBe(5);
    expect(otp().locked_until).not.toBeNull();
    expect(sessionCount()).toBe(0);
  });

  it.each([
    ['expiry', "expires_at = datetime('now')"],
    ['attempt exhaustion', 'attempt_count = 5'],
    ['active lock', "locked_until = datetime('now', '+15 minutes')"],
  ])('rechecks %s atomically at consume rather than trusting the earlier read', async (_name, update) => {
    const { code } = await register();
    const consume = vi.fn();
    db.hooks.beforeStatement = (event) => {
      if (event.method === 'run' && /UPDATE auth_otps SET used = 1/.test(event.sql)) {
        consume();
        db.seed(`UPDATE auth_otps SET ${update}`);
      }
    };
    const result = await verify(code);
    expect(consume).toHaveBeenCalledOnce();
    expect(result.status).toBe(400);
    expect(otp().used).toBe(0);
    expect(sessionCount()).toBe(0);
    expect(db.query('SELECT is_verified FROM auth_accounts WHERE email = ?', EMAIL)[0].is_verified).toBe(0);
  });

  it('rejects an expired ISO timestamp challenge without issuing a session', async () => {
    const { code } = await register();
    await db.prepare('UPDATE auth_otps SET expires_at = ?').bind(new Date(Date.now() - 60_000).toISOString()).run();
    expect((await verify(code)).status).toBe(400);
    expect(otp().used).toBe(0);
    expect(sessionCount()).toBe(0);
  });

  it('fails closed if OTP protection is not configured instead of accepting plaintext or bypassing verification', async () => {
    const { code } = await register();
    const result = await request('/auth/verify-otp', {
      body: { email: EMAIL, code, purpose: 'register' }, env: { OTP_HASH_SECRET: undefined },
    });
    expect(result.status).toBe(503);
    expect(result.json.code).toBe('OTP_PROTECTION_UNAVAILABLE');
    expect(otp().used).toBe(0);
    expect(sessionCount()).toBe(0);
  });

  it('leaves reset verification preliminary but allows exactly one final concurrent password reset', async () => {
    const original = await signup();
    const code = await forgotPassword();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const preliminary = await verify(code, 'forgot_password');
      expect(preliminary.status).toBe(200);
      expect(preliminary.json.resetToken).toEqual(expect.any(String));
      expect(preliminary.response.headers.get('Set-Cookie')).toBeNull();
      expect(otp('forgot_password').used).toBe(0);
      const access = await request('/private', {
        headers: { Authorization: `Bearer ${preliminary.json.resetToken}` }, origin: null, env: { ENVIRONMENT: 'development' },
      });
      expect(access.status).toBe(401);
      expect(access.json.code).toBe('TOKEN_TYPE_INVALID');
    }
    const readers = createBarrier(2);
    db.hooks.afterStatement = (event) => {
      if (event.method === 'first' && /FROM auth_otps\s+WHERE email/.test(event.sql)) return readers.wait();
    };
    const passwords = ['reset-winner-or-loser-A', 'reset-winner-or-loser-B'];
    const results = await Promise.all(passwords.map((newPassword) => request('/auth/reset-password', {
      body: { email: EMAIL, code, newPassword },
    })));
    expect(readers.arrivals).toBe(2);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    const winner = results.findIndex((result) => result.status === 200);
    const account = db.query<{ password_hash: string; salt: string }>('SELECT password_hash, salt FROM auth_accounts WHERE email = ?', EMAIL)[0];
    expect(await verifyPassword(passwords[winner], account.salt, account.password_hash)).toBe(true);
    expect(await verifyPassword(passwords[1 - winner], account.salt, account.password_hash)).toBe(false);
    expect(otp('forgot_password').used).toBe(1);
    expect(otp('forgot_password').used_at).not.toBeNull();
    expect(sessionCount()).toBe(2);
    expect(db.query('SELECT * FROM sessions_v2 WHERE revoked_at IS NULL')).toHaveLength(1);
    expect((await request('/private', { method: 'GET', cookie: original.cookie })).status).toBe(401);
    expect((await request('/private', { method: 'GET', cookie: cookieFrom(results[winner].response) })).status).toBe(200);
    expect(results[1 - winner].response.headers.get('Set-Cookie')).toBeNull();
    db.hooks = {};
    const replay = await request('/auth/reset-password', { body: { email: EMAIL, code, newPassword: 'replayed-password' } });
    expect(replay.status).toBe(400);
    expect(sessionCount()).toBe(2);
  });

  it.each([
    ['expiry', "expires_at = datetime('now')"],
    ['attempt exhaustion', 'attempt_count = 5'],
    ['active lock', "locked_until = datetime('now', '+15 minutes')"],
  ])('rejects a final reset that loses the %s race without changing the password or revoking sessions', async (_name, update) => {
    const original = await signup();
    const code = await forgotPassword();
    const accountBefore = db.query('SELECT password_hash, salt FROM auth_accounts WHERE email = ?', EMAIL);
    const invalidate = vi.fn(() => {
      db.seed(`UPDATE auth_otps SET ${update} WHERE purpose = 'forgot_password'`);
    });
    db.hooks.beforeStatement = (event) => {
      if (event.method === 'run' && /UPDATE auth_otps SET used = 1/.test(event.sql)) invalidate();
    };
    const result = await request('/auth/reset-password', { body: { email: EMAIL, code, newPassword: 'must-not-be-applied' } });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(result.status).toBe(400);
    expect(result.response.headers.get('Set-Cookie')).toBeNull();
    expect(db.query('SELECT password_hash, salt FROM auth_accounts WHERE email = ?', EMAIL)).toEqual(accountBefore);
    expect(otp('forgot_password').used).toBe(0);
    expect(sessionCount()).toBe(1);
    expect((await request('/private', { method: 'GET', cookie: original.cookie })).status).toBe(200);
  });

  it.each(['absent', 'down'] as const)('shares the D1 attempt budget between preliminary verify and final reset when KV is %s', async (availability) => {
    const original = await signup();
    const code = await forgotPassword();
    const accountBefore = db.query('SELECT password_hash, salt FROM auth_accounts WHERE email = ?', EMAIL);
    const get = vi.fn().mockRejectedValue(new Error('KV unavailable'));
    if (availability === 'down') env.CACHE = { get, put: vi.fn() } as unknown as Env['CACHE'];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const finalReset = attempt % 2 === 0;
      const result = await request(finalReset ? '/auth/reset-password' : '/auth/verify-otp', {
        body: {
          email: EMAIL, code: code === '111111' ? '222222' : '111111',
          ...(finalReset ? { newPassword: 'must-not-be-applied' } : { purpose: 'forgot_password' }),
        },
        headers: { 'CF-Connecting-IP': `203.0.${fixtureNumber}.${attempt}` },
      });
      expect(result.status).toBe(attempt < 5 ? 400 : 429);
      expect(otp('forgot_password').attempt_count).toBe(attempt);
      expect(result.response.headers.get('Set-Cookie')).toBeNull();
    }
    if (availability === 'down') expect(get).toHaveBeenCalled();
    const blocked = await request('/auth/reset-password', {
      body: { email: EMAIL, code, newPassword: 'must-not-be-applied' },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.response.headers.get('Retry-After')).toBe('900');
    expect(blocked.response.headers.get('Set-Cookie')).toBeNull();
    expect(otp('forgot_password').used).toBe(0);
    expect(otp('forgot_password').locked_until).not.toBeNull();
    expect(db.query('SELECT password_hash, salt FROM auth_accounts WHERE email = ?', EMAIL)).toEqual(accountBefore);
    expect(sessionCount()).toBe(1);
    expect((await request('/private', { method: 'GET', cookie: original.cookie })).status).toBe(200);
  });

  it('rolls back the password change and reports failure if old-session revocation cannot commit', async () => {
    const original = await signup();
    const code = await forgotPassword();
    const accountBefore = db.query('SELECT password_hash, salt FROM auth_accounts WHERE email = ?', EMAIL);
    db.seed("CREATE TRIGGER fail_reset_revocation BEFORE UPDATE OF revoked_at ON sessions_v2 BEGIN SELECT RAISE(ABORT, 'revocation unavailable'); END");
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await request('/auth/reset-password', {
      body: { email: EMAIL, code, newPassword: 'must-not-be-applied' },
    });
    expect(result.status).toBe(500);
    expect(result.json.success).not.toBe(true);
    expect(result.response.headers.get('Set-Cookie')).toBeNull();
    expect(db.query('SELECT password_hash, salt FROM auth_accounts WHERE email = ?', EMAIL)).toEqual(accountBefore);
    expect(db.query('SELECT * FROM sessions_v2 WHERE revoked_at IS NULL')).toHaveLength(1);
    expect(sessionCount()).toBe(1);
    expect((await request('/private', { method: 'GET', cookie: original.cookie })).status).toBe(200);
  });
});

describe('final auth hardening adversarial regressions', () => {
  it('invalidates superseded reset codes even after the replacement is consumed', async () => {
    await signup();
    vi.spyOn(crypto, 'getRandomValues')
      .mockImplementationOnce((array: any) => { array.fill(1); return array; })
      .mockImplementationOnce((array: any) => { array.fill(2); return array; });
    const codeA = await forgotPassword();
    const resend = await request('/auth/resend-otp', { body: { email: EMAIL, purpose: 'forgot_password' } });
    expect(resend.status).toBe(200);
    const codeB = deliveredCode();
    expect(codeB).not.toBe(codeA);
    expect(db.query("SELECT * FROM auth_otps WHERE email = ? AND purpose = 'forgot_password' AND used = 0", EMAIL)).toHaveLength(1);
    expect((await verify(codeA, 'forgot_password')).status).toBe(400);
    const reset = (code: string) => request('/auth/reset-password', { body: { email: EMAIL, code, newPassword: 'replacement-password-strong' } });
    expect((await reset(codeB)).status).toBe(200);
    expect((await reset(codeA)).status).toBe(400);
  });

  it('returns the same response while known-account email delivery is still pending', async () => {
    await signup();
    let deliver!: () => void;
    const pending = new Promise<void>((resolve) => { deliver = resolve; });
    vi.mocked(sendEmail).mockClear();
    vi.mocked(sendEmail).mockImplementationOnce(async () => { await pending; return { sent: true, provider: 'resend' }; });
    const knownRequest = request('/auth/forgot-password', { body: { email: EMAIL } });
    const unknown = await request('/auth/forgot-password', { body: { email: 'unknown@example.com' } });
    try {
      const known = await Promise.race([knownRequest, new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
      expect(known, 'response must not await the email provider').not.toBeNull();
      expect(known!.status).toBe(unknown.status);
      expect(known!.json).toEqual(unknown.json);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(scheduled).toHaveLength(1);
    } finally { deliver(); await knownRequest; }
  });

  it.each(['/auth/forgot-password', '/auth/resend-otp'])('does not expose account membership through %s', async (route) => {
    await signup();
    vi.mocked(sendEmail).mockClear();
    const known = await request(route, { body: { email: EMAIL, purpose: 'forgot_password' } });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(otp('forgot_password').digest_version).toBe(2);
    const unknown = await request(route, { body: { email: 'nobody@example.com', purpose: 'forgot_password' } });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(unknown.json).toEqual(known.json);
    expect(known.json).toEqual({
      success: true,
      message: expect.stringContaining('Nếu email này có tài khoản Frigo'),
      expiresInMinutes: 10,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(db.query('SELECT * FROM auth_otps WHERE email = ?', 'nobody@example.com')).toEqual([]);
  });

  it('hides delivery failures and exception PII without changing the reset response', async () => {
    await signup();
    const sensitive = `${EMAIL} private-password private-token private-otp`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error(sensitive));
    const known = await request('/auth/forgot-password', { body: { email: EMAIL } });
    const unknown = await request('/auth/forgot-password', { body: { email: 'nobody@example.com' } });
    await Promise.all(scheduled);
    expect(known.status).toBe(200);
    expect(known.json).toEqual(unknown.json);
    expect(otp('forgot_password').used).toBe(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
    expect(JSON.stringify(log.mock.calls)).not.toContain(EMAIL);
  });

  it('still verifies outstanding v1 challenges without issuing new v1 digests', async () => {
    const { code } = await register();
    await db.prepare('UPDATE auth_otps SET code_digest = ?, digest_version = 1 WHERE id = ?').bind(await hmacSha256Hex(code, OTP_SECRET), otp().id).run();
    expect((await verify(code)).status).toBe(200);
    expect((await verify(code)).status).toBe(400);
  });

  it.each(['email', 'purpose', 'version'])('rejects transplanted OTP %s context', async (context) => {
    const { code } = await register();
    const digest = await createOtpDigest(context === 'email' ? 'other@example.com' : EMAIL,
      context === 'purpose' ? 'forgot_password' : 'register', code, OTP_SECRET);
    await db.prepare('UPDATE auth_otps SET code_digest = ?, digest_version = ? WHERE id = ?').bind(digest, context === 'version' ? 99 : 2, otp().id).run();
    const result = await verify(code);
    expect(result.status).toBe(400);
    expect(otp().attempt_count).toBe(1);
    expect(otp().used).toBe(0);
    expect(sessionCount()).toBe(0);
  });

  it('reads D1 every request but writes last_seen only after 15 minutes', async () => {
    const { cookie } = await signup();
    const statements: string[] = [];
    db.hooks.beforeStatement = ({ sql }) => { statements.push(sql); };
    for (let i = 0; i < 3; i++) expect((await request('/private', { method: 'GET', cookie })).status).toBe(200);
    expect(statements.filter((sql) => sql.includes('FROM sessions_v2 s'))).toHaveLength(3);
    expect(statements.filter((sql) => sql.includes('UPDATE sessions_v2 SET last_seen_at'))).toHaveLength(0);
    db.seed("UPDATE sessions_v2 SET last_seen_at = datetime('now', '-16 minutes')");
    expect((await request('/private', { method: 'GET', cookie })).status).toBe(200);
    expect((await request('/private', { method: 'GET', cookie })).status).toBe(200);
    expect(statements.filter((sql) => sql.includes('UPDATE sessions_v2 SET last_seen_at'))).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS count FROM sessions_v2 WHERE datetime(last_seen_at) > datetime('now', '-1 minute')")[0].count).toBe(1);
  });

  it.each(['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY'] as const)('fails registration closed without production %s even outside the config gate', async (key) => {
    const result = await request('/auth/register', {
      body: { name: 'Auth Test', email: EMAIL, password: PASSWORD },
      env: { [key]: undefined },
    });
    expect(result.status).toBe(403);
    expect(result.json.code).toBe('TURNSTILE_FAILED');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('server-confirmed logout', () => {
  it('revokes the current session and expires its cookie without revoking another device session', async () => {
    const original = await signup();
    const other = await request('/auth/login', { body: { email: EMAIL, password: PASSWORD } });
    expect(other.status).toBe(200);
    const otherCookie = cookieFrom(other.response);
    expect((await request('/private', { method: 'GET', cookie: original.cookie })).status).toBe(200);
    const result = await request('/auth/logout', { cookie: original.cookie });
    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
    expect(result.response.headers.get('Set-Cookie')).toBe(`${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    expect(db.query('SELECT * FROM sessions_v2 WHERE revoked_at IS NOT NULL')).toHaveLength(1);
    expect((await request('/private', { method: 'GET', cookie: original.cookie })).status).toBe(401);
    expect((await request('/private', { method: 'GET', cookie: otherCookie })).status).toBe(200);
    expect((await request('/auth/logout', { cookie: original.cookie })).status).toBe(200);
  });

  it.each(['unbound database', 'database error', 'unsuccessful D1 result'] as const)('does not report successful revocation on %s', async (failure) => {
    const { cookie } = await signup();
    const overrides: Partial<Env> = {};
    if (failure === 'unbound database') overrides.DB = undefined;
    if (failure === 'database error') {
      db.hooks.beforeStatement = (event) => {
        if (/UPDATE sessions_v2 SET revoked_at/.test(event.sql)) throw new Error('D1 unavailable');
      };
    }
    if (failure === 'unsuccessful D1 result') {
      const execute = db.execute.bind(db);
      vi.spyOn(db, 'execute').mockImplementation((sql, bindings) => /UPDATE sessions_v2 SET revoked_at/.test(sql)
        ? { success: false, results: [], meta: { changes: 0 } }
        : execute(sql, bindings));
    }
    const result = await request('/auth/logout', { cookie, env: overrides });
    expect(result.status).toBe(503);
    expect(result.json.code).toBe('LOGOUT_FAILED');
    expect(result.json.success).not.toBe(true);
    expect(result.response.headers.get('Set-Cookie')).toBeNull();
    expect(db.query('SELECT * FROM sessions_v2 WHERE revoked_at IS NULL')).toHaveLength(1);
    db.hooks = {};
    expect((await request('/private', { method: 'GET', cookie })).status).toBe(200);
  });
});
