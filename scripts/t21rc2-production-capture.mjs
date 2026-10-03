#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCTION_D1, verifyCloudflareIdentity, verifyProductionWranglerConfigFile } from './d1-migration-check.mjs';
import { migrationManifest } from './release-check.mjs';
import { reconcileIngredientOccurrences, serializeReconciliationManifest } from './t21rc-row-reconciliation.mjs';
import { loadCertifiedV1Authority } from './t21r-v1-authority.mjs';
import {
  cleanupT21RC2Files, privateDirectory, readPrivateJson, recordT21RC2Failure, safeT21RC2Error,
  t21rc2Error, writePrivateJson,
} from './t21rc2-production-files.mjs';

export const T21RC2_SELECTS = Object.freeze({
  roster: 'SELECT id FROM recipes ORDER BY id;',
  occurrences: 'SELECT id, recipe_id, ingredient_id, name, required_quantity, unit, is_optional FROM recipe_ingredients ORDER BY recipe_id, id;',
  counts: 'SELECT (SELECT COUNT(*) FROM recipes) AS recipe_count, (SELECT COUNT(*) FROM recipe_ingredients) AS ingredient_occurrence_count;',
  ledger: 'SELECT name FROM d1_migrations ORDER BY name;',
});
const ROW_FIELDS = ['id', 'recipe_id', 'ingredient_id', 'name', 'required_quantity', 'unit', 'is_optional'];
const LEDGER_TIP = '0038_auth_onboarding_completion.sql';
const canonical = (value) => serializeReconciliationManifest(value).slice(0, -1);
export const captureDigest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Every caller parses Wrangler stdout. Wrangler 3.114.17 emits whoami's account table and
// every --json payload via logger.log/table, which WRANGLER_LOG=error suppresses; stdout stays piped.
function parsedWranglerStdoutEnvironment(env, cwd) {
  const { GH_TOKEN, GITHUB_TOKEN, ...cloudflareEnv } = env;
  return {
    ...cloudflareEnv, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'log',
    WRANGLER_LOG_PATH: path.join(privateDirectory(env, cwd), 'wrangler.log'),
  };
}

export function assertFixedProductionSelect(sql) {
  if (typeof sql !== 'string' || !/^SELECT\b/.test(sql)
      || /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|load_extension|writefile|readfile)\b/i.test(sql)
      || !Object.values(T21RC2_SELECTS).includes(sql)) {
    throw t21rc2Error('T21RC2_QUERY_REJECTED');
  }
  return sql;
}

export function executeFixedProductionSelect(name, { execute = execFileSync, cwd = process.cwd(), env = process.env } = {}) {
  if (!Object.hasOwn(T21RC2_SELECTS, name)) throw t21rc2Error('T21RC2_QUERY_REJECTED');
  const sql = assertFixedProductionSelect(T21RC2_SELECTS[name]);
  try {
    verifyProductionWranglerConfigFile(path.join(cwd, 'wrangler.jsonc'));
    const statements = JSON.parse(execute('pnpm', [
      'wrangler', 'd1', 'execute', PRODUCTION_D1.name, '--remote', '--yes', '--json',
      '--config', 'wrangler.jsonc', '--command', sql,
    ], {
      cwd, env: parsedWranglerStdoutEnvironment(env, cwd), encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    }));
    if (!Array.isArray(statements) || statements.length !== 1 || statements[0]?.success !== true
        || !Array.isArray(statements[0].results) || statements[0].truncated === true
        || statements[0].has_more === true || statements[0].meta?.truncated === true
        || statements[0].meta?.has_more === true || statements[0].meta?.cursor
        || statements[0].meta?.next_page || statements[0].result_info?.cursor
        || (statements[0].meta?.changes !== undefined && statements[0].meta.changes !== 0)
        || (statements[0].meta?.rows_written !== undefined && statements[0].meta.rows_written !== 0)) {
      throw t21rc2Error('T21RC2_QUERY_FAILED');
    }
    return statements[0].results;
  } catch {
    throw t21rc2Error('T21RC2_QUERY_FAILED');
  }
}

export function verifyT21RC2CloudflareIdentity({ accountId, whoami, list }) {
  try {
    if (!/^[0-9a-f]{32}$/i.test(accountId ?? '') || typeof whoami !== 'string'
        || !(whoami.match(/\b[0-9a-f]{32}\b/gi) ?? []).some((id) => id.toLowerCase() === accountId.toLowerCase())) {
      throw t21rc2Error('T21RC2_IDENTITY_REJECTED');
    }
    verifyCloudflareIdentity({ list, info: null });
    return { name: PRODUCTION_D1.name, id: PRODUCTION_D1.id, accountVerified: true };
  } catch {
    throw t21rc2Error('T21RC2_IDENTITY_REJECTED');
  }
}

export function proveT21RC2CloudflareIdentity({ execute = execFileSync, env = process.env, cwd = process.cwd() } = {}) {
  try {
    if (!env.CLOUDFLARE_API_TOKEN || !/^[0-9a-f]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? '')) {
      throw t21rc2Error('T21RC2_IDENTITY_REJECTED');
    }
    verifyProductionWranglerConfigFile(path.join(cwd, 'wrangler.jsonc'));
    const options = { cwd, env: parsedWranglerStdoutEnvironment(env, cwd), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 };
    const whoami = execute('pnpm', ['wrangler', 'whoami'], options);
    const list = JSON.parse(execute('pnpm', ['wrangler', 'd1', 'list', '--json', '--config', 'wrangler.jsonc'], options));
    return verifyT21RC2CloudflareIdentity({ accountId: env.CLOUDFLARE_ACCOUNT_ID, whoami, list });
  } catch {
    throw t21rc2Error('T21RC2_IDENTITY_REJECTED');
  }
}

export function reviewedLedgerNames(cwd, sha) {
  try {
    const schema = migrationManifest(cwd, sha);
    if (schema.count !== 39 || schema.migrations[37]?.name !== LEDGER_TIP
        || schema.migrations[38]?.name !== '0039_meal_composition_v2.sql') {
      throw t21rc2Error('T21RC2_LEDGER_CHANGED');
    }
    return schema.migrations.slice(0, 38).map((entry) => entry.name);
  } catch {
    throw t21rc2Error('T21RC2_LEDGER_CHANGED');
  }
}

function exactFields(row, fields) {
  return row && typeof row === 'object' && !Array.isArray(row)
    && same(Object.keys(row).sort(), [...fields].sort());
}

function ledger(rows, expected) {
  if (!Array.isArray(rows) || rows.some((row) => !exactFields(row, ['name']))
      || !same(rows.map((row) => row.name), expected)) throw t21rc2Error('T21RC2_LEDGER_CHANGED');
  return rows.map((row) => row.name);
}

function counts(rows) {
  if (!Array.isArray(rows) || rows.length !== 1 || !exactFields(rows[0], ['recipe_count', 'ingredient_occurrence_count'])
      || !integer(rows[0].recipe_count) || !integer(rows[0].ingredient_occurrence_count)) {
    throw t21rc2Error('T21RC2_CAPTURE_INCOMPLETE');
  }
  return { recipeCount: rows[0].recipe_count, ingredientOccurrenceCount: rows[0].ingredient_occurrence_count };
}

function roster(rows, expected) {
  if (!Array.isArray(rows) || rows.some((row) => !exactFields(row, ['id']) || typeof row.id !== 'string')) {
    throw t21rc2Error('T21RC2_RECIPE_ROSTER_CHANGED');
  }
  const ids = rows.map((row) => row.id).sort();
  if (!same(ids, [...expected].sort()) || new Set(ids).size !== ids.length) throw t21rc2Error('T21RC2_RECIPE_ROSTER_CHANGED');
  return ids;
}

function occurrenceRows(rows, recipeIds) {
  if (!Array.isArray(rows) || rows.some((row) => !exactFields(row, ROW_FIELDS)
      || !recipeIds.includes(row.recipe_id)
      || Object.values(row).some((value) => value !== null
        && !['string', 'number', 'boolean'].includes(typeof value))
      || Object.values(row).some((value) => typeof value === 'number' && !Number.isFinite(value)))) {
    throw t21rc2Error('T21RC2_CAPTURE_INCOMPLETE');
  }
  return [...rows].sort((a, b) => order(canonical(a), canonical(b)));
}

function requireCountsEqual(expected, observed, ids, rows) {
  if (!same(expected, observed) || observed.recipeCount !== ids.length
      || observed.ingredientOccurrenceCount !== rows.length) throw t21rc2Error('T21RC2_CAPTURE_INCOMPLETE');
}

export async function captureT21RC2Snapshot({ read, expectedRecipeIds, expectedLedger, authorityProof, authorization, database, store = () => {} }) {
  if (typeof read !== 'function' || !Array.isArray(expectedRecipeIds) || expectedRecipeIds.length === 0
      || new Set(expectedRecipeIds).size !== expectedRecipeIds.length || !Array.isArray(expectedLedger)
      || expectedLedger.length !== 38 || expectedLedger.at(-1) !== LEDGER_TIP
      || new Set(expectedLedger).size !== expectedLedger.length) throw t21rc2Error('T21RC2_CAPTURE_INCOMPLETE');
  const l0 = ledger(await read('ledger'), expectedLedger);
  const c0 = counts(await read('counts'));
  const r0 = roster(await read('roster'), expectedRecipeIds);
  if (c0.recipeCount !== r0.length) throw t21rc2Error('T21RC2_CAPTURE_INCOMPLETE');
  const a = occurrenceRows(await read('occurrences'), r0);
  store('capture-a.json', a);
  const c1 = counts(await read('counts'));
  requireCountsEqual(c0, c1, r0, a);
  const l1 = ledger(await read('ledger'), expectedLedger);
  const c2 = counts(await read('counts'));
  if (!same(c0, c2)) throw t21rc2Error('T21RC2_CAPTURE_INCOMPLETE');
  const r1 = roster(await read('roster'), expectedRecipeIds);
  const b = occurrenceRows(await read('occurrences'), r1);
  store('capture-b.json', b);
  const c3 = counts(await read('counts'));
  requireCountsEqual(c0, c3, r1, b);
  const l2 = ledger(await read('ledger'), expectedLedger);
  const input = { recipeIds: r0, occurrences: a, captureCounts: c0 };
  const repeated = { recipeIds: r1, occurrences: b, captureCounts: c3 };
  if (captureDigest(input) !== captureDigest(repeated)) throw t21rc2Error('T21RC2_PRODUCTION_SNAPSHOT_UNSTABLE');
  store('capture-observations.json', { l0, l1, l2, c0, c1, c2, c3, r0, r1 });
  return {
    input,
    capture: {
      schemaVersion: 1, status: 'OBSERVED_STABLE_NON_ATOMIC', database,
      ledger: { count: expectedLedger.length, tip: LEDGER_TIP, namesSha256: captureDigest(expectedLedger) },
      counts: c0, authorityProof, authorizationSha256: captureDigest(authorization),
      snapshotDigestSha256: captureDigest(input),
    },
  };
}

export async function classifyT21RC2Snapshot({ input, capture, authorization, authority,
  loadAuthority = loadCertifiedV1Authority, cwd = process.cwd() }) {
  try {
    if (capture?.status !== 'OBSERVED_STABLE_NON_ATOMIC' || capture.authorizationSha256 !== captureDigest(authorization)
        || !same(input?.captureCounts, capture.counts) || captureDigest(input) !== capture.snapshotDigestSha256) {
      throw t21rc2Error('T21RC2_CLASSIFICATION_CAPTURE_BINDING_REJECTED');
    }
  } catch {
    throw t21rc2Error('T21RC2_CLASSIFICATION_CAPTURE_BINDING_REJECTED');
  }
  try {
    authority ??= await loadAuthority(cwd);
    if (!authority || typeof authority !== 'object') {
      throw t21rc2Error('T21RC2_CLASSIFICATION_AUTHORITY_REJECTED');
    }
  } catch {
    throw t21rc2Error('T21RC2_CLASSIFICATION_AUTHORITY_REJECTED');
  }
  try {
    if (!same(capture.authorityProof, authority.authorityProof)) {
      throw t21rc2Error('T21RC2_CLASSIFICATION_CAPTURE_BINDING_REJECTED');
    }
  } catch {
    throw t21rc2Error('T21RC2_CLASSIFICATION_CAPTURE_BINDING_REJECTED');
  }
  let manifest;
  try {
    manifest = reconcileIngredientOccurrences({
      ...authority, productionRows: input.occurrences, productionRecipeIds: input.recipeIds, captureCounts: input.captureCounts,
    });
    manifest.authorityProof = authority.authorityProof;
  } catch (error) {
    throw t21rc2Error(error?.message === 'T21RC_AUTHORITY_CONTRADICTION' || error?.code === 'T21RC_AUTHORITY_CONTRADICTION'
      ? 'T21RC2_CLASSIFICATION_AUTHORITY_REJECTED' : 'T21RC2_CLASSIFICATION_RECONCILIATION_REJECTED');
  }
  let validateT21RC2Manifest;
  try {
    ({ validateT21RC2Manifest } = await import('./t21rc2-production-receipt.mjs'));
  } catch (error) {
    throw t21rc2Error(error?.code === 'T21RC2_CLASSIFICATION_AUTHORITY_REJECTED'
      ? 'T21RC2_CLASSIFICATION_AUTHORITY_REJECTED' : 'T21RC2_CLASSIFICATION_SCHEMA_REJECTED');
  }
  validateT21RC2Manifest(manifest);
  return { manifest, capture: { ...capture, digests: {
    occurrenceSha256: manifest.digests.occurrenceSha256, semanticSha256: manifest.digests.semanticSha256,
  } } };
}

export async function runT21RC2CaptureCommand(command, { env = process.env, cwd = process.cwd(), execute = execFileSync, authorize, loadAuthority = loadCertifiedV1Authority } = {}) {
  if (command === 'cleanup') return cleanupT21RC2Files(env, cwd);
  const { authorizeProductionRun, requireStoredAuthorizationBinding } = await import('./t21rc2-production-approval.mjs');
  const authorization = readPrivateJson('authorization.json', env, cwd);
  requireStoredAuthorizationBinding(authorization, env);
  if (command === 'capture') {
    const current = await (authorize ?? authorizeProductionRun)({ env, cwd, execute });
    if (!same(current, authorization)) throw t21rc2Error('T21RC2_APPROVAL_REJECTED');
    const authority = await loadAuthority(cwd);
    const expectedLedger = reviewedLedgerNames(cwd, authorization.mainSha);
    const database = proveT21RC2CloudflareIdentity({ execute, env, cwd });
    const result = await captureT21RC2Snapshot({
      read: (name) => executeFixedProductionSelect(name, { execute, env, cwd }),
      expectedRecipeIds: authority.targetRecipes.map((recipe) => recipe.id), expectedLedger,
      authorityProof: authority.authorityProof, authorization, database,
      store: (name, value) => writePrivateJson(name, value, env, cwd),
    });
    writePrivateJson('classifier-input.json', result.input, env, cwd);
    writePrivateJson('capture-verified.json', result.capture, env, cwd);
  } else if (command === 'classify') {
    const result = await classifyT21RC2Snapshot({
      input: readPrivateJson('classifier-input.json', env, cwd),
      capture: readPrivateJson('capture-verified.json', env, cwd),
      authorization, loadAuthority, cwd,
    });
    writePrivateJson('row-manifest.json', result.manifest, env, cwd);
    writePrivateJson('capture-proof.json', result.capture, env, cwd);
  } else {
    throw t21rc2Error('T21RC2_QUERY_REJECTED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    if (process.argv.length !== 3 || !['capture', 'classify', 'cleanup'].includes(process.argv[2])) throw t21rc2Error('T21RC2_QUERY_REJECTED');
    await runT21RC2CaptureCommand(process.argv[2]);
    console.log('t21rc2=RUNNER_LOCAL_STEP_COMPLETE');
  } catch (error) {
    recordT21RC2Failure(error);
    console.error(`t21rc2=${safeT21RC2Error(error)}`);
    process.exitCode = 1;
  }
}
