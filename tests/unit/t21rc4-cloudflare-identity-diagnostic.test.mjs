import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatT21RC4IdentityReceipt, runT21RC4IdentityDiagnostic, T21RC4I_COMMANDS,
  verifyT21RC4IdentityConfig } from '../../scripts/t21rc4-cloudflare-identity-diagnostic.mjs';
import { verifyProductionWranglerConfig } from '../../scripts/d1-migration-check.mjs';
import { verifyT21RC2CloudflareIdentity } from '../../scripts/t21rc2-production-capture.mjs';
import { assertReviewedExecutionClosure, T21RC2_REVIEW_BOUND_PATHS } from '../../scripts/t21rc2-production-approval.mjs';

const ACCOUNT = 'a'.repeat(32);
const OTHER_ACCOUNT = 'b'.repeat(32);
const TOKEN = 'FAKE_DIAGNOSTIC_TOKEN_MUST_NOT_APPEAR';
const UUID = 'f975ec39-b2c8-4a2a-80e1-0366054599d3';
const OTHER_UUID = 'unexpected-private-database-uuid';
const WHOAMI = `Private user private-email@example.invalid\nAccount ${ACCOUNT.toUpperCase()}\nOther ${OTHER_ACCOUNT}`;
const LIST = [{ name: 'frigo-db', uuid: UUID }, { name: 'other-private-name', uuid: OTHER_UUID }];
const configText = readFileSync('wrangler.jsonc', 'utf8');
const root = process.cwd();
let cwd;
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 't21rc4i-test-'));
  writeFileSync(path.join(cwd, 'wrangler.jsonc'), configText);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });

function fixture({ env = {}, whoami = WHOAMI, list = LIST, whoamiError, listError } = {}) {
  const execute = vi.fn((command, args, options) => {
    expect(command).toBe('pnpm');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(options.maxBuffer).toBe(4 * 1024 * 1024);
    expect(options.timeout).toBe(60_000);
    expect(readlinkSync(options.env.WRANGLER_LOG_PATH)).toBe('/dev/null');
    expect(statSync(path.dirname(options.env.WRANGLER_LOG_PATH)).mode & 0o777).toBe(0o700);
    if (JSON.stringify(args) === JSON.stringify(T21RC4I_COMMANDS.whoami)) {
      if (whoamiError) throw whoamiError;
      return whoami;
    }
    expect(args).toEqual(T21RC4I_COMMANDS.list);
    if (listError) throw listError;
    return typeof list === 'string' ? list : JSON.stringify(list);
  });
  const result = runT21RC4IdentityDiagnostic({ cwd, execute,
    env: { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, ...env } });
  return { result, execute, formatted: formatT21RC4IdentityReceipt(result) };
}

describe('T21RC4I isolated metadata diagnosis', () => {
  it('rejects missing token before any command or config check', () => {
    const { result, execute } = fixture({ env: { CLOUDFLARE_API_TOKEN: '' } });
    expect(result.status).toBe('T21RC4I_TOKEN_MISSING');
    expect(result.tokenPresent).toBe(false);
    expect(result.accountIdSecretFormat).toBe('NOT_RUN');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([undefined, '', 'short', 'a'.repeat(31), 'a'.repeat(33), ACCOUNT + '\n',
    ` ${ACCOUNT}`, `${ACCOUNT} `, 'g'.repeat(32)])(
    'rejects invalid secret syntax %s without commands', (accountId) => {
      const { result, execute } = fixture({ env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
      expect(result.status).toBe('T21RC4I_ACCOUNT_ID_SECRET_INVALID_FORMAT');
      expect(result.accountIdSecretFormat).toBe('INVALID');
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it.each([ACCOUNT, 'A'.repeat(32), 'aA'.repeat(16)])(
    'accepts lowercase, uppercase and mixed-case syntax in parity with C2: %s', (accountId) => {
      expect(() => verifyT21RC2CloudflareIdentity({ accountId, whoami: WHOAMI, list: LIST })).not.toThrow();
      const { result } = fixture({ env: { CLOUDFLARE_ACCOUNT_ID: accountId } });
      expect(result.accountIdSecretFormat).toBe('VALID');
      expect(result.accountIdMatchesWhoami).toBe(true);
      expect(result.status).toBe('T21RC4I_CLOUDFLARE_IDENTITY_CERTIFIED');
    },
  );
  it('rejects config mismatch before credentials are used by a child', () => {
    writeFileSync(path.join(cwd, 'wrangler.jsonc'), configText.replace(UUID, OTHER_UUID));
    const { result, execute, formatted } = fixture();
    expect(result.status).toBe('T21RC4I_WRANGLER_CONFIG_MISMATCH');
    expect(result.wranglerConfigIdentity).toBe('FAIL');
    expect(execute).not.toHaveBeenCalled();
    expect(formatted).not.toContain(OTHER_UUID);
  });
  it('maps whoami command/timeout/buffer errors without underlying exception output', () => {
    const error = Object.assign(new Error(`${TOKEN} ${WHOAMI}`), { stdout: WHOAMI, stderr: OTHER_ACCOUNT });
    const { result, execute, formatted } = fixture({ whoamiError: error });
    expect(result.status).toBe('T21RC4I_WHOAMI_COMMAND_FAILED');
    expect(result.wranglerWhoami).toBe('FAILURE');
    expect(result.d1List).toBe('NOT_RUN');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(formatted).not.toContain(TOKEN);
    expect(formatted).not.toContain(OTHER_ACCOUNT);
  });
  it.each([`Only ${OTHER_ACCOUNT}`, `x${ACCOUNT}x`, `0${ACCOUNT}0`])(
    'uses the same bounded account matching as C2 and stops before D1 list', (whoami) => {
      const { result, execute } = fixture({ whoami });
      expect(result.status).toBe('T21RC4I_ACCOUNT_ID_SECRET_MISMATCH');
      expect(result.accountIdMatchesWhoami).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );
  it('reports D1 list command failure without claiming auth or scope', () => {
    const { result, execute } = fixture({ listError: new Error(`${TOKEN} request-id private-path`) });
    expect(result.status).toBe('T21RC4I_D1_LIST_COMMAND_FAILED');
    expect(result.wranglerWhoami).toBe('SUCCESS');
    expect(result.accountIdMatchesWhoami).toBe(true);
    expect(result.d1List).toBe('FAILURE');
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each(['not-json', '{}', 'null', '[null]', '[[]]', '[{}]', '[{"name":1,"uuid":"x"}]',
    '[{"name":"frigo-db","uuid":1}]'])(
    'reports invalid D1 metadata response separately: %s', (list) => {
      expect(fixture({ list }).result.status).toBe('T21RC4I_D1_LIST_RESPONSE_INVALID');
    },
  );
  it('distinguishes a missing production database name', () => {
    const { result } = fixture({ list: [LIST[1]] });
    expect(result.status).toBe('T21RC4I_PRODUCTION_D1_NAME_MISSING');
    expect(result.frigoDbMatchCount).toBe(0);
    expect(result.productionD1UuidMatch).toBeNull();
  });
  it('emits MULTIPLE rather than disclosing arbitrary duplicate counts', () => {
    const { result } = fixture({ list: Array.from({ length: 4 }, () => LIST[0]) });
    expect(result.status).toBe('T21RC4I_PRODUCTION_D1_NAME_DUPLICATE');
    expect(result.frigoDbMatchCount).toBe('MULTIPLE');
    expect(result.productionD1UuidMatch).toBeNull();
  });
  it('rejects a wrong UUID without disclosing it', () => {
    const { result, formatted } = fixture({ list: [{ name: 'frigo-db', uuid: OTHER_UUID }] });
    expect(result.status).toBe('T21RC4I_PRODUCTION_D1_UUID_MISMATCH');
    expect(result.productionD1UuidMatch).toBe(false);
    expect(formatted).not.toContain(OTHER_UUID);
  });
  it('certifies identity only, without asserting read-only permissions', () => {
    const { result, execute } = fixture();
    expect(result).toEqual({
      status: 'T21RC4I_CLOUDFLARE_IDENTITY_CERTIFIED', tokenPresent: true,
      accountIdSecretFormat: 'VALID', wranglerConfigIdentity: 'PASS', wranglerWhoami: 'SUCCESS',
      accountIdMatchesWhoami: true, d1List: 'SUCCESS', frigoDbMatchCount: 1,
      productionD1UuidMatch: true, d1SqlExecuted: false, productionMutations: 0,
      tokenScopeReadOnlyProven: false, tokenScope: 'UNKNOWN',
    });
    expect(execute.mock.calls.map(([, args]) => args)).toEqual([T21RC4I_COMMANDS.whoami, T21RC4I_COMMANDS.list]);
  });
  it('emits no raw secret, account, email, output, metadata or exception', () => {
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    const consoleError = vi.spyOn(console, 'error');
    const { formatted } = fixture();
    for (const secret of [TOKEN, ACCOUNT, OTHER_ACCOUNT, WHOAMI, JSON.stringify(LIST), UUID,
      OTHER_UUID, 'private-email@example.invalid', 'other-private-name']) expect(formatted).not.toContain(secret);
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });
  it('formatter rejects arbitrary strings, extras and permission overrides', () => {
    const { result } = fixture();
    const receipt = JSON.parse(formatT21RC4IdentityReceipt({ ...result, status: TOKEN,
      accountIdSecretFormat: ACCOUNT, wranglerWhoami: WHOAMI, frigoDbMatchCount: LIST,
      rawList: LIST, token: TOKEN, tokenScopeReadOnlyProven: true, tokenScope: 'READ_ONLY',
      d1SqlExecuted: true, productionMutations: 999 }));
    expect(receipt.status).toBe('T21RC4I_DIAGNOSTIC_INTERNAL_FAILURE');
    expect(receipt.accountIdSecretFormat).toBe('NOT_RUN');
    expect(receipt.wranglerWhoami).toBe('NOT_RUN');
    expect(receipt.frigoDbMatchCount).toBeNull();
    expect(receipt.tokenScopeReadOnlyProven).toBe(false); expect(receipt.tokenScope).toBe('UNKNOWN');
    expect(receipt.d1SqlExecuted).toBe(false); expect(receipt.productionMutations).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
    expect(receipt).not.toHaveProperty('rawList'); expect(receipt).not.toHaveProperty('token');
  });
  it('does not inherit alternate credentials, provider endpoints, GitHub tokens or debug settings', () => {
    const { execute } = fixture({ env: { GH_TOKEN: 'private-gh', GITHUB_TOKEN: 'private-gh',
      CLOUDFLARE_API_BASE_URL: 'https://unexpected.invalid', CLOUDFLARE_API_KEY: 'other-key',
      WRANGLER_LOG_PATH: '/unexpected/file', WRANGLER_SEND_METRICS: 'true', WRANGLER_LOG: 'debug' } });
    const child = execute.mock.calls[0][2].env;
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'CLOUDFLARE_API_BASE_URL', 'CLOUDFLARE_API_KEY']) {
      expect(child).not.toHaveProperty(key);
    }
    expect(child.WRANGLER_SEND_METRICS).toBe('false'); expect(child.WRANGLER_LOG).toBe('error');
    expect(child.WRANGLER_LOG_PATH).not.toBe('/unexpected/file');
    expect(() => statSync(path.dirname(child.WRANGLER_LOG_PATH))).toThrow();
  });
  it('arbitrary CLI arguments cannot execute another Wrangler command', () => {
    const child = spawnSync(process.execPath, ['scripts/t21rc4-cloudflare-identity-diagnostic.mjs', 'd1', 'execute'],
      { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(child.status).toBe(1); expect(child.stderr).toBe('');
    expect(JSON.parse(child.stdout).status).toBe('T21RC4I_INPUT_REJECTED');
  });
});

describe('C4I isolated JSONC identity contract matches existing verifier', () => {
  it.each([
    configText, configText.replace(UUID, OTHER_UUID), configText.replace('frigo-db', 'other-name'),
    '{bad-json', '{"d1_databases":[]}',
    `{"d1_databases":[],"d1_databases":[{"binding":"DB","database_name":"frigo-db","database_id":"${UUID}"}]}`,
    `{"nested":{"same":1,"same":2},"d1_databases":[{"binding":"DB","database_name":"frigo-db","database_id":"${UUID}"}]}`,
    `/* comments */ {"d1_databases":[{"binding":"DB","database_name":"frigo-db","database_id":"${UUID}",}],}`,
  ])('accepts/rejects the same config identity shape', (text) => {
    const accepted = (fn) => { try { fn(); return true; } catch { return false; } };
    expect(accepted(() => verifyT21RC4IdentityConfig(text)))
      .toBe(accepted(() => verifyProductionWranglerConfig({ text })));
  });
});

describe('C4I additions preserve independently reviewed C2 execution bytes', () => {
  it('real reviewed SHA remains eligible after additive diagnostic; a bound-byte mutation rejects', () => {
    const repo = path.join(cwd, 'binding-repo');
    execFileSync('git', ['init', '--quiet', repo], { stdio: 'pipe' });
    mkdirSync(path.join(repo, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'),
      `${path.join(root, '.git', 'objects')}\n`);
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('config', 'user.name', 'C4I Test'); git('config', 'user.email', 'c4i@example.invalid');
    const reviewed = '93c4055a42cd2d94f4db296d8ca10d555c2c52c2';
    const base = '7cd58968c3b4c0f7936c75d74b6965d229b57c69';
    git('read-tree', base);
    const added = ['.github/workflows/production-d1-identity-diagnostic.yml',
      'scripts/t21rc4-cloudflare-identity-diagnostic.mjs',
      'tests/unit/t21rc4-cloudflare-identity-diagnostic.test.mjs',
      'tests/unit/t21rc4-identity-workflow.test.mjs'];
    expect(T21RC2_REVIEW_BOUND_PATHS).toHaveLength(73);
    for (const file of added) {
      expect(T21RC2_REVIEW_BOUND_PATHS).not.toContain(file);
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), readFileSync(path.join(root, file)));
    }
    git('add', '--', ...added);
    const future = git('commit-tree', git('write-tree'), '-p', base, '-m', 'add isolated diagnostic');
    expect(() => assertReviewedExecutionClosure(reviewed, future, { cwd: repo })).not.toThrow();
    const bound = '.github/workflows/production-d1-t21rc-row-reconciliation.yml';
    writeFileSync(path.join(repo, bound), git('show', `${base}:${bound}`) + '\n# unreviewed bound byte\n');
    git('add', '--', bound);
    const mutated = git('commit-tree', git('write-tree'), '-p', future, '-m', 'mutate bound bytes');
    expect(() => assertReviewedExecutionClosure(reviewed, mutated, { cwd: repo }))
      .toThrow('T21RC2_REVIEW_BINDING_REJECTED');
  });
});
