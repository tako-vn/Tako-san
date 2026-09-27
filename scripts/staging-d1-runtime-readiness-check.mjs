import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APPROVED_BATCHES_REGISTRY,
  catalogQuery,
  runtimeCatalogQueries,
  verifyApprovedBatchRegistry,
  verifyCloudflareIdentity,
  verifyHealth,
  verifyPostLedger,
} from './d1-migration-check.mjs';
import { migrationManifest, requireSuccessfulCi } from './release-check.mjs';
import { STAGING_CONFIG, STAGING_DATABASE, stagingConfig } from './staging-d1-migration-check.mjs';

export const STAGING_D1 = Object.freeze({
  name: 'frigo-db-staging-v3',
  id: '7854298a-20f5-46aa-9cbf-917079c2a3dd',
});
export const LEDGER_TIP = '0039_meal_composition_v2.sql';
export const CANONICAL_REPOSITORY_ID = '1385308553';

export const STATUS = Object.freeze({
  CERTIFIED: 'STAGING_D1_RUNTIME_READINESS_CERTIFIED',
  BLOCKED_MAIN: 'STAGING_D1_RUNTIME_READINESS_BLOCKED_MAIN',
  BLOCKED_CI: 'STAGING_D1_RUNTIME_READINESS_BLOCKED_CI',
  BLOCKED_IDENTITY: 'STAGING_D1_RUNTIME_READINESS_BLOCKED_IDENTITY',
  BLOCKED_LEDGER: 'STAGING_D1_RUNTIME_READINESS_BLOCKED_LEDGER',
  COUNT_DRIFT: 'STAGING_D1_RUNTIME_READINESS_COUNT_DRIFT',
  ID_DRIFT: 'STAGING_D1_RUNTIME_READINESS_ID_DRIFT',
  ORDER_DRIFT: 'STAGING_D1_RUNTIME_READINESS_ORDER_DRIFT',
  CATALOG_DIAGNOSTICS: 'STAGING_D1_RUNTIME_READINESS_CATALOG_DIAGNOSTICS',
  LEGACY_BASELINE_DRIFT: 'STAGING_D1_RUNTIME_READINESS_LEGACY_BASELINE_DRIFT',
  FINGERPRINT_DRIFT: 'STAGING_D1_RUNTIME_READINESS_FINGERPRINT_DRIFT',
  PROVENANCE_DRIFT: 'STAGING_D1_RUNTIME_READINESS_PROVENANCE_DRIFT',
  HEALTH_FAILED: 'STAGING_D1_RUNTIME_READINESS_HEALTH_FAILED',
  D1_READ_FAILED: 'STAGING_D1_RUNTIME_READINESS_D1_READ_FAILED',
  RELEASE_MANIFEST_INVALID: 'STAGING_D1_RUNTIME_READINESS_RELEASE_MANIFEST_INVALID',
});

const READINESS_STATUS = Object.freeze({
  D1_READ_FAILED: STATUS.D1_READ_FAILED,
  RELEASE_MANIFEST_INVALID: STATUS.RELEASE_MANIFEST_INVALID,
  CATALOG_DIAGNOSTICS: STATUS.CATALOG_DIAGNOSTICS,
  COUNT_DRIFT: STATUS.COUNT_DRIFT,
  ID_DRIFT: STATUS.ID_DRIFT,
  ORDER_DRIFT: STATUS.ORDER_DRIFT,
  LEGACY_BASELINE_DRIFT: STATUS.LEGACY_BASELINE_DRIFT,
  FINGERPRINT_DRIFT: STATUS.FINGERPRINT_DRIFT,
});

const SHA = /^[a-f0-9]{40}$/;
const FORBIDDEN_SQL =
  /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|ATTACH|DETACH|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|load_extension|writefile|readfile)\b/i;
const APPROVED_PRAGMA_STATEMENT = /^PRAGMA\s+(foreign_key_check|quick_check)\s*$/i;
const APPROVED_PRAGMA_FUNCTIONS = new Set(['pragma_foreign_key_check', 'pragma_table_info']);

export const QUERY_CONTRACT = Object.freeze({
  ledger: { count: 1, start: /^SELECT\b/i },
  catalog: { count: 2, start: /^SELECT\b/i },
  provenance: { count: 1, start: /^SELECT\b/i },
  'runtime-catalog': { count: 5, start: /^SELECT\b/i },
  'foreign-key-check': { count: 1, start: /^PRAGMA\b/i, pragma: true },
  'quick-check': { count: 1, start: /^PRAGMA\b/i, pragma: true },
});

export class StagingRuntimeReadinessError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'StagingRuntimeReadinessError';
    this.status = status;
  }
}

function blocked(status, message) {
  return new StagingRuntimeReadinessError(status, message);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function save(file, receipt) {
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function stripSqlLiterals(statement) {
  return statement.replace(/'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
}

export function splitSqlStatements(sql) {
  if (typeof sql !== 'string') throw new Error('SQL must be text');
  return sql.split(';').map((statement) => statement.trim()).filter(Boolean);
}

export function assertReadOnlySql(sql, { allowPragmaStatements = false } = {}) {
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) throw new Error('Read-only SQL is empty');
  for (const statement of statements) {
    const guarded = stripSqlLiterals(statement).replace(/\s+/g, ' ').trim();
    if (allowPragmaStatements && APPROVED_PRAGMA_STATEMENT.test(guarded)) continue;
    if (!/^(SELECT|WITH)\b/i.test(guarded) || FORBIDDEN_SQL.test(guarded)) {
      throw new Error('Non-read-only SQL rejected');
    }
    for (const name of guarded.match(/\bpragma_\w+/gi) || []) {
      if (!APPROVED_PRAGMA_FUNCTIONS.has(name.toLowerCase())) {
        throw new Error('Unapproved PRAGMA function');
      }
    }
  }
  return statements;
}

export function ledgerQuery() {
  const sql = 'SELECT name FROM d1_migrations ORDER BY name';
  assertReadOnlySql(sql);
  return sql;
}

export function provenanceQuery() {
  const sql =
    'SELECT r.id, f.runtime_order, r.source_type, r.source_reference, r.verification_state, r.version FROM recipe_runtime_fields f JOIN recipes r ON r.id = f.recipe_id ORDER BY f.runtime_order, r.id';
  assertReadOnlySql(sql);
  return sql;
}

export function catalogReadQuery() {
  const sql = catalogQuery();
  assertReadOnlySql(sql);
  return sql;
}

export function foreignKeyCheckQuery() {
  return 'PRAGMA foreign_key_check';
}

export function quickCheckQuery() {
  return 'PRAGMA quick_check';
}

export function querySql(name, prepareRecipeContentRead) {
  if (name === 'ledger') return ledgerQuery();
  if (name === 'catalog') return catalogReadQuery();
  if (name === 'provenance') return provenanceQuery();
  if (name === 'foreign-key-check') return foreignKeyCheckQuery();
  if (name === 'quick-check') return quickCheckQuery();
  if (name === 'runtime-catalog') {
    if (typeof prepareRecipeContentRead !== 'function') {
      throw new Error('runtime-catalog query requires prepareRecipeContentRead');
    }
    const sql = `${runtimeCatalogQueries(prepareRecipeContentRead).join(';\n')};\n`;
    assertReadOnlySql(sql);
    return sql;
  }
  throw new Error('Unknown read-only query');
}

export function guardSql(name, sql) {
  const contract = QUERY_CONTRACT[name];
  if (!contract) throw new Error('Unknown read-only query');
  const statements = assertReadOnlySql(sql, { allowPragmaStatements: contract.pragma === true });
  if (statements.length !== contract.count) throw new Error(`${name} statement count changed`);
  for (const statement of statements) {
    const guarded = stripSqlLiterals(statement).replace(/\s+/g, ' ').trim();
    if (!contract.start.test(guarded)) throw new Error(`${name} is not the reviewed read-only shape`);
  }
  return statements;
}

export function pinnedStagingDatabase(text = readFileSync(STAGING_CONFIG, 'utf8')) {
  const config = stagingConfig(text);
  if (config.name !== STAGING_D1.name || config.id !== STAGING_D1.id || config.name !== STAGING_DATABASE) {
    throw blocked(STATUS.BLOCKED_IDENTITY, 'Staging Wrangler config is not the pinned staging D1');
  }
  return config;
}

function successfulStatements(value, count, label) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw blocked(STATUS.D1_READ_FAILED, `${label} is not valid JSON`);
    }
  }
  if (!Array.isArray(value) || value.length !== count) {
    throw blocked(STATUS.D1_READ_FAILED, `${label} did not return ${count} successful result(s)`);
  }
  for (const [index, statement] of value.entries()) {
    if (statement?.success !== true || !Array.isArray(statement.results)) {
      throw blocked(STATUS.D1_READ_FAILED, `${label} statement ${index + 1} was not successful JSON output`);
    }
  }
  return value;
}

function singleRows(statements, label) {
  return successfulStatements(statements, 1, label)[0].results;
}

export function mapReadinessStatus(code) {
  return READINESS_STATUS[code] ?? STATUS.D1_READ_FAILED;
}

export function catalogFlags(readiness) {
  const ready = readiness?.status === 'ready';
  const code = ready ? null : readiness?.code ?? null;
  const detail = readiness?.detail ?? {};
  return {
    recipeCount: ready ? readiness.recipeCount : (detail.actualCount ?? null),
    idSetMatch: ready || (code !== 'ID_DRIFT' && code !== 'COUNT_DRIFT'),
    orderMatch: ready || (code !== 'ORDER_DRIFT' && code !== 'COUNT_DRIFT' && code !== 'ID_DRIFT'),
    hydrationFailures: ready ? 0 : (detail.hydrationFailureCount ?? null),
    legacyBaselineMatch: ready ? true : detail.legacyBaselineMatch === true,
    runtimeFingerprintMatch: ready ? true : detail.fingerprintMatch === true,
  };
}

function sanitizedReadiness(readiness) {
  if (!readiness) return { status: 'error', code: 'D1_READ_FAILED' };
  if (readiness.status === 'ready') return { status: 'ready', code: null };
  return {
    status: readiness.status,
    code: readiness.code ?? null,
    hydrationFailureSample: (readiness.detail?.hydrationFailureSample ?? []).slice(0, 5),
    idDriftSample: (readiness.detail?.idDriftSample ?? []).slice(0, 5),
    orderDriftSample: (readiness.detail?.orderDriftSample ?? []).slice(0, 5),
    fieldDriftSample: (readiness.detail?.fieldDriftSample ?? []).slice(0, 5),
  };
}

export function verifyExactLedger(schema, statements) {
  try {
    if (!schema?.version || schema.version !== LEDGER_TIP) {
      throw new Error('Repository migration tip is not 0039_meal_composition_v2.sql');
    }
    const ledger = verifyPostLedger({ schema }, statements);
    if (ledger.tip !== LEDGER_TIP) throw new Error(`Staging ledger tip ${ledger.tip} is not ${LEDGER_TIP}`);
    return { tip: ledger.tip, count: ledger.count };
  } catch (error) {
    throw blocked(STATUS.BLOCKED_LEDGER, error instanceof Error ? error.message : 'Ledger certification failed');
  }
}

export function verifyReadinessHealth({ foreignKeys, quickCheck }) {
  try {
    verifyHealth({ foreignKeys, quickCheck });
    return { foreignKeyCheck: 'PASS', quickCheck: 'PASS' };
  } catch (error) {
    throw blocked(STATUS.HEALTH_FAILED, error instanceof Error ? error.message : 'Health certification failed');
  }
}

export function verifyCatalogCount(statements, release) {
  const [aggregate] = successfulStatements(statements, 2, 'Catalog');
  const row = aggregate.results[0];
  if (!row || typeof row !== 'object') throw blocked(STATUS.D1_READ_FAILED, 'Catalog aggregate result is missing');
  if (row.recipes !== release.expectedRecipeCount) {
    throw blocked(STATUS.COUNT_DRIFT, `Physical recipe count ${row.recipes} != ${release.expectedRecipeCount}`);
  }
  return { recipeCount: row.recipes };
}

export function verifyRemoteProvenance(statements, release, registry, { cwd = process.cwd() } = {}) {
  let identities;
  try {
    identities = verifyApprovedBatchRegistry(release, registry, { cwd });
  } catch (error) {
    throw blocked(STATUS.PROVENANCE_DRIFT, error instanceof Error ? error.message : 'Approved batch registry drift');
  }
  const rows = singleRows(statements, 'Provenance');
  const problems = [];
  for (const batch of identities) {
    const expectedIds = release.orderedRecipeIds.slice(
      batch.releaseBaseCount,
      batch.releaseBaseCount + batch.recipeCount,
    );
    const tagged = rows.filter((row) => row.source_reference === batch.sourceReference);
    if (
      tagged.length !== batch.recipeCount ||
      JSON.stringify(tagged.map((row) => row.id)) !== JSON.stringify(expectedIds) ||
      tagged.some(
        (row) =>
          row.source_type !== 'ai_generated' ||
          row.verification_state !== 'reviewed' ||
          Number(row.version) !== 1,
      )
    ) {
      problems.push(batch.batchId);
    }
  }
  const approvedReferences = new Set(identities.map((batch) => batch.sourceReference));
  if (rows.some((row) => row.source_type === 'ai_generated' && !approvedReferences.has(row.source_reference))) {
    problems.push('unknown-release-batch');
  }
  if (problems.length) {
    throw blocked(STATUS.PROVENANCE_DRIFT, `Approved batch provenance drift: ${problems.slice(0, 5).join(', ')}`);
  }
  return {
    approvedBatchesMatch: true,
    batches: identities.map((batch) => ({ batchId: batch.batchId, recipeCount: batch.recipeCount })),
  };
}

export async function loadStagingReadinessPipeline({ cwd = process.cwd() } = {}) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: cwd,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const dbReader = await vite.ssrLoadModule('/packages/db/src/recipe-content.ts');
    const hydration = await vite.ssrLoadModule('/packages/recipes/src/runtime-hydration.ts');
    const authority = await vite.ssrLoadModule('/packages/recipes/src/recipe-authority.ts');
    return {
      queries: runtimeCatalogQueries(dbReader.prepareRecipeContentRead),
      prepareRecipeContentRead: dbReader.prepareRecipeContentRead,
      mapRecipeContentRead: dbReader.mapRecipeContentRead,
      hydrateRuntimeRecipes: hydration.hydrateRuntimeRecipes,
      assessD1Readiness: authority.assessD1Readiness,
      StaticRecipeAuthority: authority.StaticRecipeAuthority,
      currentCatalogRelease: authority.currentCatalogRelease,
      close: () => vite.close(),
    };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

export async function assessStagingRuntimeCatalog({ snapshot, statements, pipeline, release } = {}) {
  if (!pipeline?.hydrateRuntimeRecipes || !pipeline.assessD1Readiness || !pipeline.StaticRecipeAuthority) {
    throw blocked(STATUS.D1_READ_FAILED, 'Runtime readiness pipeline is incomplete');
  }
  const resolvedRelease = release ?? pipeline.currentCatalogRelease();
  let content = snapshot;
  if (!content) {
    try {
      content = pipeline.mapRecipeContentRead(
        successfulStatements(statements, pipeline.queries?.length ?? 5, 'Runtime catalog'),
      );
    } catch (error) {
      if (error instanceof StagingRuntimeReadinessError) throw error;
      throw blocked(STATUS.D1_READ_FAILED, error instanceof Error ? error.message : 'D1 content mapping failed');
    }
  }
  let hydration;
  try {
    hydration = pipeline.hydrateRuntimeRecipes(content);
  } catch (error) {
    throw blocked(STATUS.D1_READ_FAILED, error instanceof Error ? error.message : 'Runtime hydration failed');
  }
  const baseline = await new pipeline.StaticRecipeAuthority().load();
  const { readiness } = await pipeline.assessD1Readiness(baseline, hydration, resolvedRelease);
  if (readiness.status !== 'ready') {
    const failure = blocked(
      mapReadinessStatus(readiness.code),
      `D1 runtime readiness ${readiness.status}: ${readiness.code}`,
    );
    failure.readiness = readiness;
    throw failure;
  }
  return { readiness, release: resolvedRelease, catalog: catalogFlags(readiness) };
}

async function exactMainCi(sha, { fetchImpl = fetch } = {}) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !process.env.GH_TOKEN) {
    throw blocked(STATUS.BLOCKED_CI, 'Repository-scoped Actions read token is required');
  }
  try {
    const query = new URLSearchParams({ branch: 'main', event: 'push', head_sha: sha, per_page: '100' });
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?${query}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Hosted CI lookup failed: HTTP ${response.status}`);
    return requireSuccessfulCi((await response.json()).workflow_runs, { sha, repository });
  } catch (error) {
    if (error instanceof StagingRuntimeReadinessError) throw error;
    throw blocked(STATUS.BLOCKED_CI, error instanceof Error ? error.message : 'Hosted CI lookup failed');
  }
}

export async function gate(file, {
  cwd = process.cwd(),
  ref = process.env.READINESS_REF,
  now = () => new Date(),
  hostedCi,
} = {}) {
  const receipt = {
    status: 'STAGING_D1_RUNTIME_READINESS_IN_PROGRESS',
    repository: {
      id: Number(process.env.GITHUB_REPOSITORY_ID || CANONICAL_REPOSITORY_ID),
      name: process.env.GITHUB_REPOSITORY || null,
      sha: null,
    },
    database: pinnedStagingDatabase(),
    checkedAt: now().toISOString(),
  };
  save(file, receipt);
  try {
    if (process.env.GITHUB_REF !== 'refs/heads/main') {
      throw blocked(STATUS.BLOCKED_MAIN, 'Dispatch must run from main');
    }
    if (!SHA.test(ref || '')) {
      throw blocked(STATUS.BLOCKED_MAIN, 'Readiness ref must be a full immutable SHA, never a branch or tag');
    }
    if (process.env.GITHUB_REPOSITORY_ID && process.env.GITHUB_REPOSITORY_ID !== CANONICAL_REPOSITORY_ID) {
      throw blocked(STATUS.BLOCKED_MAIN, 'Repository id is not the canonical Tako-san repository');
    }
    const head = git(cwd, 'rev-parse', '--verify', 'HEAD');
    const mainSha = git(cwd, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}');
    if (ref !== head || ref !== mainSha) {
      throw blocked(STATUS.BLOCKED_MAIN, 'Readiness ref must equal exact current main');
    }
    if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== ref) {
      throw blocked(STATUS.BLOCKED_MAIN, 'Checkout SHA is not the dispatched main SHA');
    }
    const schema = migrationManifest(cwd, ref);
    if (schema.version !== LEDGER_TIP) {
      throw blocked(STATUS.BLOCKED_LEDGER, `Repository ledger tip ${schema.version} is not ${LEDGER_TIP}`);
    }
    receipt.repository.sha = ref;
    receipt.sha = ref;
    receipt.schema = schema;
    receipt.ci = hostedCi ? await hostedCi(ref) : await exactMainCi(ref);
    save(file, receipt);
    return receipt;
  } catch (error) {
    const status = error instanceof StagingRuntimeReadinessError ? error.status : STATUS.BLOCKED_MAIN;
    receipt.status = status;
    save(file, receipt);
    throw error instanceof StagingRuntimeReadinessError
      ? error
      : blocked(status, error instanceof Error ? error.message : 'Gate failed');
  }
}

export async function recheck(file, options = {}) {
  const previous = readJson(file);
  const cloudflare = previous.cloudflare;
  const current = await gate(file, { ...options, ref: previous.sha });
  if (current.sha !== previous.sha || current.database.id !== previous.database.id) {
    throw blocked(STATUS.BLOCKED_MAIN, 'Current main or staging identity changed after dispatch');
  }
  if (cloudflare) {
    current.cloudflare = cloudflare;
    save(file, current);
  }
  return current;
}

export function identity(file, list, info) {
  const receipt = readJson(file);
  const expected = pinnedStagingDatabase();
  if (expected.id !== receipt.database.id || expected.name !== receipt.database.name) {
    throw blocked(STATUS.BLOCKED_IDENTITY, 'Staging database identity changed');
  }
  try {
    receipt.cloudflare = verifyCloudflareIdentity({
      list: typeof list === 'string' ? readJson(list) : list,
      info: info == null ? null : typeof info === 'string' ? readJson(info) : info,
      expected,
    });
  } catch (error) {
    throw blocked(STATUS.BLOCKED_IDENTITY, error instanceof Error ? error.message : 'Staging D1 identity mismatch');
  }
  save(file, receipt);
  return receipt;
}

export function remoteQuery(sqlFile, outFile, { execute = execFileSync, allowPragmaStatements = false } = {}) {
  const statements = assertReadOnlySql(readFileSync(sqlFile, 'utf8'), { allowPragmaStatements });
  const results = [];
  for (const [index, statement] of statements.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(execute('pnpm', [
        'wrangler', 'd1', 'execute', STAGING_D1.name, '--remote', '--yes',
        '--config', STAGING_CONFIG, '--command', statement, '--json',
      ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch {
      throw blocked(STATUS.D1_READ_FAILED, `Staging D1 read-only query ${index + 1} failed`);
    }
    if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0]?.success !== true || !Array.isArray(parsed[0].results)) {
      throw blocked(STATUS.D1_READ_FAILED, `Staging D1 read-only query ${index + 1} returned incomplete evidence`);
    }
    results.push(parsed[0]);
  }
  writeFileSync(outFile, `${JSON.stringify(results)}\n`);
  return results;
}

function finalizeFailure(file, receipt, error) {
  const status = error instanceof StagingRuntimeReadinessError ? error.status : STATUS.D1_READ_FAILED;
  receipt.status = status;
  if (error instanceof StagingRuntimeReadinessError && error.readiness) {
    receipt.catalog = catalogFlags(error.readiness);
    receipt.readiness = sanitizedReadiness(error.readiness);
  }
  save(file, receipt);
  return error instanceof StagingRuntimeReadinessError
    ? error
    : blocked(status, error instanceof Error ? error.message : 'Certification failed');
}

export async function certify(file, evidence, { cwd = process.cwd(), pipeline, now = () => new Date() } = {}) {
  const receipt = readJson(file);
  if (!receipt.cloudflare) throw blocked(STATUS.BLOCKED_IDENTITY, 'Remote staging identity not certified');
  let owned = pipeline;
  try {
    owned = owned ?? (await loadStagingReadinessPipeline({ cwd }));
    const release = evidence.release ?? owned.currentCatalogRelease();
    const registry = evidence.registry ?? readJson(path.join(cwd, APPROVED_BATCHES_REGISTRY));
    receipt.database = { name: STAGING_D1.name, id: STAGING_D1.id };
    receipt.ledger = verifyExactLedger(receipt.schema, evidence.ledger);
    receipt.health = verifyReadinessHealth({ foreignKeys: evidence.foreignKeys, quickCheck: evidence.quickCheck });
    if (evidence.catalog) receipt.physicalCatalog = verifyCatalogCount(evidence.catalog, release);
    const assessed = await assessStagingRuntimeCatalog({
      snapshot: evidence.snapshot,
      statements: evidence.runtimeCatalog,
      pipeline: owned,
      release,
    });
    receipt.release = {
      releaseId: assessed.release.releaseId,
      expectedRecipeCount: assessed.release.expectedRecipeCount,
      expectedRuntimeFingerprint: assessed.release.expectedRuntimeFingerprint,
    };
    receipt.catalog = assessed.catalog;
    receipt.provenance = verifyRemoteProvenance(evidence.provenance, assessed.release, registry, { cwd });
    receipt.readiness = sanitizedReadiness(assessed.readiness);
    receipt.status = STATUS.CERTIFIED;
    receipt.checkedAt = now().toISOString();
    save(file, receipt);
    return receipt;
  } catch (error) {
    throw finalizeFailure(file, receipt, error);
  } finally {
    if (!pipeline && owned) await owned.close();
  }
}

export async function run(command, file, args = []) {
  if (command === 'query') {
    if (file === 'runtime-catalog') {
      const pipeline = await loadStagingReadinessPipeline();
      try {
        return querySql(file, pipeline.prepareRecipeContentRead);
      } finally {
        await pipeline.close();
      }
    }
    return querySql(file);
  }
  if (command === 'guard') return guardSql(path.basename(file, '.sql'), readFileSync(file, 'utf8'));
  if (command === 'gate') return gate(file);
  if (command === 'recheck') return recheck(file);
  if (command === 'identity') return identity(file, args[0], args[1]);
  if (command === 'remote-query') {
    return remoteQuery(file, args[0], { allowPragmaStatements: /foreign-key-check|quick-check/.test(file) });
  }
  if (command === 'certify') {
    return certify(file, {
      ledger: readJson(args[0]),
      runtimeCatalog: readJson(args[1]),
      provenance: readJson(args[2]),
      foreignKeys: readJson(args[3]),
      quickCheck: readJson(args[4]),
      catalog: args[5] ? readJson(args[5]) : undefined,
    });
  }
  throw new Error('Unknown staging D1 runtime readiness check');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file, ...args] = process.argv.slice(2);
  run(command, file, args).then((value) => {
    if (command === 'query') process.stdout.write(typeof value === 'string' ? value : `${value}`);
    else if (command !== 'guard') console.log(`Staging D1 runtime readiness ${command}: ${value.status ?? 'PASS'}`);
  }).catch((error) => {
    const status = error instanceof StagingRuntimeReadinessError ? error.status : null;
    console.error(status ? `${status}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}
