import { execFileSync } from 'node:child_process';
import { mkdtempSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTION_D1 } from '../../scripts/d1-migration-check.mjs';
import {
  assertFixedProductionSelect, captureT21RC2Snapshot, classifyT21RC2Snapshot,
  executeFixedProductionSelect, proveT21RC2CloudflareIdentity, reviewedLedgerNames,
  runT21RC2CaptureCommand, T21RC2_SELECTS, verifyT21RC2CloudflareIdentity,
} from '../../scripts/t21rc2-production-capture.mjs';
import { loadCertifiedV1Authority } from '../../scripts/t21r-v1-authority.mjs';
import { buildT21RC2ProductionReceipt } from '../../scripts/t21rc2-production-receipt.mjs';
import {
  buildT21RC2FailureReceipt, cleanupT21RC2Files, privateDirectory, readPrivateJson,
  recordT21RC2Failure, runnerPaths, t21rc2Error, writePrivateJson, writePublicReceipt,
} from '../../scripts/t21rc2-production-files.mjs';

const base = '518818458a354c5e180da52ae9bb73c9d3c1af78';
const expectedLedger = reviewedLedgerNames(process.cwd(), base);
const markers = ['PRIVATE_PHYSICAL_ID_123', 'SECRET_PRODUCTION_NAME_ABC', '987654.125'];
const quantity = Number(markers[2]);
const row = () => ({ id: markers[0], recipe_id: 'recipe-one', ingredient_id: 'ING_TEST', name: markers[1], required_quantity: quantity, unit: 'g', is_optional: 0 });
const authorization = { mainSha: base, proof: 'synthetic' };
const proof = {
  canonicalTargetSha256: 'a'.repeat(64), releaseManifestSha256: 'b'.repeat(64),
  approvedBatchesSha256: 'c'.repeat(64), canonicalRegistrySourceSha256: 'd'.repeat(64),
  reconciliationSha256: 'e'.repeat(64), releaseId: 'synthetic-release',
  runtimeFingerprint: 'f'.repeat(64), reviewedBridgeCount: 0,
};
const database = { ...PRODUCTION_D1, accountVerified: true };
function actionFixture() {
  const actor = 'dispatch-user';
  const authorized = {
    schemaVersion: 1, repositoryId: 1385308553, repository: 'vn-tak/Tako-san',
    mainSha: base, reviewedSha: base, runId: '42', runAttempt: '1', actor, triggeringActor: actor,
    ci: { id: 400, attempt: 1, headSha: base },
    approval: { environment: 'production', state: 'approved', reviewer: 'vn-taphoanhatung', actor, historySha256: 'a'.repeat(64), policySha256: 'b'.repeat(64) },
  };
  const env = {
    ...process.env, GH_TOKEN: '', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: base,
    GITHUB_REPOSITORY_ID: '1385308553', GITHUB_REPOSITORY: authorized.repository,
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_ACTOR: actor, GITHUB_TRIGGERING_ACTOR: actor,
    RELEASE_REF: base, REVIEWED_SHA: base, CONFIRM_T21RC_READ_ONLY_CAPTURE: 'true',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-only',
  };
  return { authorized, env };
}
const clone = (value) => structuredClone(value);
const temporary = [];
const temp = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 't21rc2-unit-'));
  temporary.push(directory);
  return directory;
};
beforeEach(() => vi.stubEnv('RUNNER_TEMP', temp()));
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function fixture(overrides = {}) {
  const queries = ['ledger', 'counts', 'roster', 'occurrences', 'counts', 'ledger', 'counts', 'roster', 'occurrences', 'counts', 'ledger'];
  const count = [{ recipe_count: 1, ingredient_occurrence_count: 1 }];
  const ledger = expectedLedger.map((name) => ({ name }));
  const values = [ledger, count, [{ id: 'recipe-one' }], [row()], count, ledger, count, [{ id: 'recipe-one' }], [row()], count, ledger].map(clone);
  Object.entries(overrides).forEach(([index, value]) => { values[Number(index)] = clone(value); });
  const calls = [], saved = {};
  const read = vi.fn(async (name) => {
    const index = calls.length;
    expect(name).toBe(queries[index]);
    calls.push(name);
    return values[index];
  });
  return {
    read, calls, saved, values,
    run: () => captureT21RC2Snapshot({ read, expectedRecipeIds: ['recipe-one'], expectedLedger, authorityProof: proof, authorization, database, store: (name, value) => { saved[name] = value; } }),
  };
}

describe('T21R-C2 fixed production SELECT executable path', () => {
  it.each(Object.entries(T21RC2_SELECTS))('executes only the reviewed %s SELECT through the UUID-pinned config', (name, sql) => {
    const execute = vi.fn(() => JSON.stringify([{ success: true, results: [], meta: { changes: 0, rows_written: 0 } }]));
    expect(executeFixedProductionSelect(name, { execute })).toEqual([]);
    expect(execute.mock.calls[0][0]).toBe('pnpm');
    expect(execute.mock.calls[0][1]).toEqual(['wrangler', 'd1', 'execute', PRODUCTION_D1.name, '--remote', '--yes', '--json', '--config', 'wrangler.jsonc', '--command', sql]);
    expect(execute.mock.calls[0][2].stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(execute.mock.calls[0][2].env.WRANGLER_LOG_PATH).toBe(path.join(process.env.RUNNER_TEMP, 't21rc2', 'wrangler.log'));
    expect(execute.mock.calls[0][2].env).not.toHaveProperty('GH_TOKEN');
    expect(assertFixedProductionSelect(sql)).toBe(sql);
  });

  it.each(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX'])('rejects %s before the subprocess can run', (keyword) => {
    const execute = vi.fn();
    expect(() => executeFixedProductionSelect(`${keyword} ${markers[1]}`, { execute })).toThrow('T21RC2_QUERY_REJECTED');
    expect(() => assertFixedProductionSelect(`SELECT id FROM recipes; ${keyword} ${markers[1]};`)).toThrow('T21RC2_QUERY_REJECTED');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['constructor', '__proto__', '', 'SELECT * FROM users;', 'SELECT id FROM recipes;', 'SELECT readfile("private");', 'SELECT 1;', 'roster;DELETE FROM recipes'])('rejects an unsupported selector/statement %s', (input) => {
    const execute = vi.fn();
    expect(() => executeFixedProductionSelect(input, { execute })).toThrow('T21RC2_QUERY_REJECTED');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([[], [{ success: false, results: [] }], [{ success: true }], [{ success: true, results: [], truncated: true }], [{ success: true, results: [], meta: { cursor: 'private' } }], [{ success: true, results: [], meta: { rows_written: 1 } }], [{ success: true, results: [], meta: { changes: 1 } }]])('rejects failed, incomplete, paged or write-reporting result %# privately', (response) => {
    expect(() => executeFixedProductionSelect('occurrences', { execute: () => JSON.stringify(response) })).toThrow('T21RC2_QUERY_FAILED');
  });

  it('does not carry raw subprocess stdout/stderr into an exception or failure receipt', () => {
    const error = Object.assign(new Error(markers.join(' ')), { stdout: markers.join(' '), stderr: markers.join(' '), code: markers[0] });
    let failure;
    try { executeFixedProductionSelect('occurrences', { execute: () => { throw error; } }); } catch (caught) { failure = caught; }
    const serialized = JSON.stringify({ message: failure.message, receipt: buildT21RC2FailureReceipt(error), wrapper: buildT21RC2FailureReceipt(failure) });
    markers.forEach((marker) => expect(serialized).not.toContain(marker));
  });
});

describe('T21R-C2 account and exact database identity', () => {
  const accountId = 'a'.repeat(32);
  const list = [{ name: PRODUCTION_D1.name, uuid: PRODUCTION_D1.id }];
  it('requires both authenticated configured account and pinned database name/id', () => {
    expect(verifyT21RC2CloudflareIdentity({ accountId, whoami: `Account ${accountId}`, list })).toEqual(database);
  });
  it.each([
    { whoami: `Account ${'b'.repeat(32)}`, list },
    { whoami: `Account ${accountId}`, list: [{ name: PRODUCTION_D1.name, uuid: 'b'.repeat(36) }] },
    { whoami: `Account ${accountId}`, list: [{ name: 'wrong-name', uuid: PRODUCTION_D1.id }] },
    { whoami: `Account ${accountId}`, list: [...list, ...list] },
    { whoami: markers[1], list },
  ])('fails closed on identity mismatch %# without exposing evidence', (values) => {
    expect(() => verifyT21RC2CloudflareIdentity({ accountId, ...values })).toThrow('T21RC2_IDENTITY_REJECTED');
  });
  it('captures identity commands, never prints account output, and refuses missing credentials first', () => {
    const execute = vi.fn((_, args) => args[1] === 'whoami' ? `Private account ${accountId}` : JSON.stringify(list));
    expect(proveT21RC2CloudflareIdentity({ execute, env: { RUNNER_TEMP: process.env.RUNNER_TEMP, CLOUDFLARE_API_TOKEN: 'synthetic-token', CLOUDFLARE_ACCOUNT_ID: accountId } })).toEqual(database);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every((call) => call[2].stdio.join(',') === 'ignore,pipe,pipe')).toBe(true);
    const rejected = vi.fn();
    expect(() => proveT21RC2CloudflareIdentity({ execute: rejected, env: {} })).toThrow('T21RC2_IDENTITY_REJECTED');
    expect(rejected).not.toHaveBeenCalled();
  });
});

describe('T21R-C2 complete non-atomic two-read snapshot', () => {
  it('executes the complete reviewed sequence and keeps all raw values in local evidence only', async () => {
    const run = fixture();
    const result = await run.run();
    expect(run.calls).toHaveLength(11);
    expect(result.capture.status).toBe('OBSERVED_STABLE_NON_ATOMIC');
    expect(result.capture.counts).toEqual({ recipeCount: 1, ingredientOccurrenceCount: 1 });
    expect(result.input.occurrences).toEqual([row()]);
    expect(run.saved['capture-a.json']).toEqual([row()]);
    expect(run.saved['capture-b.json']).toEqual([row()]);
    const publicProof = JSON.stringify(result.capture);
    markers.forEach((marker) => expect(publicProof).not.toContain(marker));
  });

  it('compares deterministic multisets rather than natural result order', async () => {
    const second = { ...row(), id: 'different-physical-id', required_quantity: 2 };
    const count = [{ recipe_count: 1, ingredient_occurrence_count: 2 }];
    const run = fixture({ 1: count, 3: [row(), second], 4: count, 6: count, 8: [second, row()], 9: count });
    expect((await run.run()).capture.status).toBe('OBSERVED_STABLE_NON_ATOMIC');
  });

  it.each([1, 4, 6, 9])('rejects changing independent counts at capture index %s', async (index) => {
    const run = fixture({ [index]: [{ recipe_count: 1, ingredient_occurrence_count: 2 }] });
    await expect(run.run()).rejects.toThrow('T21RC2_CAPTURE_INCOMPLETE');
  });

  it.each([0, 5, 10])('rejects 0039 or any ledger divergence at observation %s', async (index) => {
    const rows = [...expectedLedger.map((name) => ({ name })), { name: '0039_meal_composition_v2.sql' }];
    await expect(fixture({ [index]: rows }).run()).rejects.toThrow('T21RC2_LEDGER_CHANGED');
  });

  it('checks the entire ledger sequence, not its count/tip alone', async () => {
    const rows = expectedLedger.map((name) => ({ name }));
    rows[0].name = '0001_wrong_history.sql';
    await expect(fixture({ 0: rows }).run()).rejects.toThrow('T21RC2_LEDGER_CHANGED');
    await expect(fixture({ 0: [...rows].reverse() }).run()).rejects.toThrow('T21RC2_LEDGER_CHANGED');
  });

  it.each([[], [{ id: 'private-user-recipe' }], [{ id: 'recipe-one' }, { id: 'recipe-one' }]])('rejects an unexpected, missing or duplicated roster before ingredient names are read %#', async (rows) => {
    const run = fixture({ 2: rows });
    await expect(run.run()).rejects.toThrow('T21RC2_RECIPE_ROSTER_CHANGED');
    expect(run.calls).toEqual(['ledger', 'counts', 'roster']);
  });

  it('also checks the repeat roster before its occurrence read', async () => {
    const run = fixture({ 7: [{ id: 'private-user-recipe' }] });
    await expect(run.run()).rejects.toThrow('T21RC2_RECIPE_ROSTER_CHANGED');
    expect(run.calls).toHaveLength(8);
  });

  it.each(['id', 'name', 'required_quantity', 'unit', 'is_optional'])('rejects moving %s content despite unchanged counts', async (field) => {
    const changed = { ...row(), [field]: field === 'required_quantity' ? quantity + 1 : field === 'is_optional' ? 1 : `different-${field}` };
    await expect(fixture({ 8: [changed] }).run()).rejects.toThrow('T21RC2_PRODUCTION_SNAPSHOT_UNSTABLE');
  });

  it.each([[], [row(), row()], [{ ...row(), recipe_id: 'unexpected-recipe' }], [{ ...row(), household_id: 'private' }]])('rejects truncated, excess or out-of-scope occurrences %#', async (rows) => {
    await expect(fixture({ 3: rows }).run()).rejects.toThrow('T21RC2_CAPTURE_INCOMPLETE');
  });

  it('reuses the merged classifier and schema after stability, with strict malformed semantics retained', async () => {
    const source = { targetRecipes: [{ id: 'recipe-one', ingredients: [{ ingredientId: 'ING_TEST', name: markers[1], requiredQuantity: quantity, unit: 'g', isOptional: false }] }], canonicalIngredientIds: ['ING_TEST'], reconciliation: [], authorityProof: proof };
    const result = await fixture().run();
    const classified = await classifyT21RC2Snapshot({ ...result, authorization, authority: source });
    expect(classified.manifest.summary.productionClassCounts.EXACT_V1_MATCH).toBe(1);
    expect(classified.manifest.summary.targetClassCounts.SATISFIED_EXACT).toBe(1);
    expect(classified.manifest.runtimePositionAuthority).toBe(false);
    expect(classified.capture.digests.semanticSha256).toBe(classified.manifest.digests.semanticSha256);
    const badRow = { ...row(), is_optional: null };
    const malformed = await fixture({ 3: [badRow], 8: [badRow] }).run();
    const ambiguous = await classifyT21RC2Snapshot({ ...malformed, authorization, authority: source });
    expect(ambiguous.manifest.production[0].classification).toBe('MALFORMED_OCCURRENCE');
    expect(ambiguous.manifest.target[0].classification).toBe('AMBIGUOUS');
  });

  it('rejects tampering between private capture and credential-free classification', async () => {
    const captured = await fixture().run();
    captured.input.occurrences[0].required_quantity = 42;
    await expect(classifyT21RC2Snapshot({ ...captured, authorization, authority: { authorityProof: proof } })).rejects.toThrow('T21RC2_CLASSIFICATION_REJECTED');
  });
});

describe('T21R-C2 runner-local privacy on success and failure', () => {
  let certifiedAuthority;
  beforeAll(async () => { certifiedAuthority = await loadCertifiedV1Authority(); });

  it('runs the executable capture/classify/receipt pipeline with certified-source synthetic data and mocked Cloudflare only', async () => {
    const { authorized, env } = actionFixture();
    writePrivateJson('authorization.json', authorized, env);
    const authority = certifiedAuthority;
    const ids = authority.targetRecipes.map((recipe) => recipe.id);
    const rows = authority.targetRecipes.flatMap((recipe) => recipe.ingredients.map((ingredient, index) => ({
      id: `${recipe.id}-synthetic-${index}`, recipe_id: recipe.id, ingredient_id: ingredient.ingredientId,
      name: ingredient.name, required_quantity: ingredient.requiredQuantity, unit: ingredient.unit,
      is_optional: ingredient.isOptional === true ? 1 : 0,
    })));
    rows[0] = { ...rows[0], id: markers[0], name: markers[1], required_quantity: quantity };
    const execute = vi.fn((command, args) => {
      expect(command).toBe('pnpm');
      if (args[1] === 'whoami') return `Authenticated ${env.CLOUDFLARE_ACCOUNT_ID}`;
      if (args[2] === 'list') return JSON.stringify([{ name: PRODUCTION_D1.name, uuid: PRODUCTION_D1.id }]);
      const sql = args[args.indexOf('--command') + 1];
      const values = {
        [T21RC2_SELECTS.roster]: ids.map((id) => ({ id })),
        [T21RC2_SELECTS.occurrences]: rows,
        [T21RC2_SELECTS.counts]: [{ recipe_count: ids.length, ingredient_occurrence_count: rows.length }],
        [T21RC2_SELECTS.ledger]: expectedLedger.map((name) => ({ name })),
      };
      expect(Object.hasOwn(values, sql)).toBe(true);
      return JSON.stringify([{ success: true, results: values[sql], meta: { changes: 0, rows_written: 0 } }]);
    });
    const options = { env, execute, authorize: async () => clone(authorized), loadAuthority: async () => authority };
    await runT21RC2CaptureCommand('capture', options);
    expect(execute.mock.calls.filter((call) => call[1][2] === 'execute')).toHaveLength(11);
    await runT21RC2CaptureCommand('classify', options);
    writePrivateJson('authorization-final.json', authorized, env);
    const manifest = readPrivateJson('row-manifest.json', env);
    const capture = readPrivateJson('capture-proof.json', env);
    const receipt = buildT21RC2ProductionReceipt({ authorization: authorized, capture, manifest });
    writePublicReceipt(receipt, env);
    const output = readFileSync(runnerPaths(env).publicReceipt, 'utf8');
    markers.forEach((marker) => expect(output).not.toContain(marker));
    expect(manifest.summary.productionOccurrenceCount).toBe(2702);
    expect(manifest.summary.targetOccurrenceCount).toBe(2702);
    expect(output).not.toContain(ids[0]);
    expect(readPrivateJson('capture-a.json', env).some((value) => value.id === markers[0])).toBe(true);
    cleanupT21RC2Files(env);
  });

  it('a changed authorization stops the executable path before any Cloudflare subprocess', async () => {
    const { authorized, env } = actionFixture();
    writePrivateJson('authorization.json', authorized, env);
    const execute = vi.fn();
    await expect(runT21RC2CaptureCommand('capture', { env, execute, authorize: async () => ({ ...authorized, mainSha: 'b'.repeat(40) }) })).rejects.toThrow('T21RC2_APPROVAL_REJECTED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses restrictive storage outside checkout and never permits arbitrary evidence file names', () => {
    const env = { RUNNER_TEMP: temp() };
    const directory = privateDirectory(env);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    writePrivateJson('capture-a.json', [row()], env);
    expect(lstatSync(path.join(directory, 'capture-a.json')).mode & 0o777).toBe(0o600);
    expect(readPrivateJson('capture-a.json', env)).toEqual([row()]);
    expect(() => writePrivateJson('../leak.json', [row()], env)).toThrow('T21RC2_PRIVATE_PATH_REJECTED');
    expect(() => runnerPaths({ RUNNER_TEMP: process.cwd() })).toThrow('T21RC2_PRIVATE_PATH_REJECTED');
    cleanupT21RC2Files(env);
    expect(() => lstatSync(directory)).toThrow();
  });

  it('rejects symlinked or permissive private storage and cannot overwrite a capture', () => {
    const env = { RUNNER_TEMP: temp() };
    const other = temp();
    symlinkSync(other, path.join(env.RUNNER_TEMP, 't21rc2'));
    expect(() => writePrivateJson('capture-a.json', [row()], env)).toThrow('T21RC2_PRIVATE_PATH_REJECTED');
    rmSync(path.join(env.RUNNER_TEMP, 't21rc2'));
    mkdirSync(path.join(env.RUNNER_TEMP, 't21rc2'), { mode: 0o755 });
    expect(() => privateDirectory(env)).toThrow('T21RC2_PRIVATE_PATH_REJECTED');
    rmSync(path.join(env.RUNNER_TEMP, 't21rc2'), { recursive: true });
    writePrivateJson('capture-a.json', [row()], env);
    expect(() => writePrivateJson('capture-a.json', [], env)).toThrow('T21RC2_PRIVATE_PATH_REJECTED');
  });

  it('writes a fixed redacted failure receipt even when the original error contains private results', () => {
    const env = { RUNNER_TEMP: temp() };
    const error = Object.assign(new Error(markers.join(' ')), { code: markers[1], results: [row()] });
    recordT21RC2Failure(error, env);
    const output = readFileSync(runnerPaths(env).publicReceipt, 'utf8');
    markers.forEach((marker) => expect(output).not.toContain(marker));
    expect(JSON.parse(output).status).toBe('T21RC2_CAPTURE_BLOCKED');
    expect(() => writePublicReceipt({}, env)).toThrow('T21RC2_PRIVATE_PATH_REJECTED');
  });

  it('the real CLI failure path never prints passed raw markers or subprocess stack traces', () => {
    const env = { ...process.env, RUNNER_TEMP: temp(), CLOUDFLARE_API_TOKEN: '', GH_TOKEN: '' };
    let failure;
    try { execFileSync(process.execPath, ['scripts/t21rc2-production-capture.mjs', ...markers], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { failure = error; }
    expect(failure.status).toBe(1);
    const outputs = `${failure.stdout}\n${failure.stderr}\n${readFileSync(runnerPaths(env).publicReceipt, 'utf8')}`;
    markers.forEach((marker) => expect(outputs).not.toContain(marker));
    expect(outputs).not.toContain('at file:');
  });
});
