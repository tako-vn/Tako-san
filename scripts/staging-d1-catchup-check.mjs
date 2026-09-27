import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  CATALOG_RELEASE_MANIFEST,
  PRODUCTION_D1,
  classifyPreLedger,
  parseWranglerJsonc,
  verifyHealth,
  verifyPostLedger,
  verifyRecipeMediaSeed,
} from './d1-migration-check.mjs';
import { listMigrations, renderSchemaGateCommand } from './d1-schema-gate.mjs';
import { migrationManifest, requireSuccessfulCi } from './release-check.mjs';

export const STAGING_D1 = Object.freeze({
  name: 'frigo-db-staging-v3',
  id: '7854298a-20f5-46aa-9cbf-917079c2a3dd',
});
export const STAGING_CONFIG = 'wrangler.staging.jsonc';
export const PRODUCTION_CONFIG = 'wrangler.jsonc';
export const CANONICAL_REPOSITORY_ID = '1385308553';
export const FORBIDDEN_MIGRATION = '0039_meal_composition_v2.sql';
export const HISTORICAL_REPORTED_BOOKMARK = '0000004a-00000000-000050f2-7928d4b4454c106316cc7063bd854d3e';
export const ARTIFACT_ROOT = '.artifacts/staging-d1-catchup';
export const GLOBAL_RECIPE_IDS = Object.freeze(
  Array.from({ length: 12 }, (_, index) => `gl-${String(index + 1).padStart(2, '0')}`),
);

const SHA = /^[a-f0-9]{40}$/;
const STALE_OWNER = /^(tako-vn2|tako-vn|vn-tako[0-9]*)\b/i;
const CATALOG_TABLES = Object.freeze([
  'recipes',
  'recipe_ingredients',
  'recipe_steps',
  'recipe_runtime_fields',
  'recipe_runtime_ingredient_order',
  'recipe_media',
]);
// Non-catalog aggregates read by aggregateQuery(); a catch-up migration must never change them.
const DELTA_TABLES = Object.freeze([
  'ingredients',
  'nutrition_profiles',
  'recipe_nutrition',
  'profiles',
]);

export const CATCHUP_STEPS = Object.freeze({
  '0034': Object.freeze({
    target: '0034',
    preTip: '0033_scan_evidence_completeness.sql',
    file: '0034_global_recipe_catalog_parity.sql',
    preRecipes: 59,
    postRecipes: 71,
    certification: 'STAGING_0034_CERTIFIED',
    catalogGrowth: true,
  }),
  '0035': Object.freeze({
    target: '0035',
    preTip: '0034_global_recipe_catalog_parity.sql',
    file: '0035_recipe_media_layer.sql',
    preRecipes: 71,
    postRecipes: 71,
    certification: 'STAGING_0035_CERTIFIED',
    catalogGrowth: false,
    media: true,
  }),
  '0036': Object.freeze({
    target: '0036',
    preTip: '0035_recipe_media_layer.sql',
    file: '0036_recipe_catalog_pilot.sql',
    preRecipes: 71,
    postRecipes: 101,
    certification: 'STAGING_0036_CERTIFIED',
    catalogGrowth: true,
    collision: true,
    batchId: 't14f-pilot-30-v1',
    batchHash: '4d13915c075cd1b418d2454f7f03968349b779766cdb96b92df90f4138bc8cce',
    batchRecipes: 30,
  }),
  '0037': Object.freeze({
    target: '0037',
    preTip: '0036_recipe_catalog_pilot.sql',
    file: '0037_recipe_catalog_scale.sql',
    preRecipes: 101,
    postRecipes: 500,
    certification: 'STAGING_0037_CERTIFIED',
    catalogGrowth: true,
    collision: true,
    batchId: 't14f-scale-399-v1',
    batchHash: '1bdf29bde821b5183f0f41d920c7b747a5290f7772e6adc1a51de60ba3adda35',
    batchRecipes: 399,
  }),
  '0038': Object.freeze({
    target: '0038',
    preTip: '0037_recipe_catalog_scale.sql',
    file: '0038_auth_onboarding_completion.sql',
    preRecipes: 500,
    postRecipes: 500,
    certification: 'STAGING_0038_CERTIFIED',
    catalogGrowth: false,
    onboarding: true,
  }),
});

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(file) {
  return sha256Bytes(readFileSync(file));
}

export function sha256Json(value) {
  return sha256Bytes(JSON.stringify(value));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function save(file, receipt) {
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

function rows(statements, label) {
  if (
    !Array.isArray(statements) ||
    statements.length !== 1 ||
    statements[0]?.success !== true ||
    !Array.isArray(statements[0].results)
  ) {
    throw new Error(`${label}: expected one successful D1 result`);
  }
  return statements[0].results;
}

function tableExistsAt(fileName, table) {
  if (table === 'recipe_runtime_fields' || table === 'recipe_runtime_ingredient_order') {
    return fileName >= '0034_global_recipe_catalog_parity.sql';
  }
  if (table === 'recipe_media') return fileName >= '0035_recipe_media_layer.sql';
  return true;
}

export function resolveCatchupStep(target) {
  if (target === '0039' || target === FORBIDDEN_MIGRATION) {
    throw new Error('target=0039 belongs to the existing staging-d1-migrate workflow');
  }
  const step = CATCHUP_STEPS[target];
  if (!step) throw new Error(`Unsupported catch-up target ${target}`);
  return step;
}

export function assertRepositoryIdentity({
  repository = process.env.GITHUB_REPOSITORY,
  repositoryId = process.env.GITHUB_REPOSITORY_ID,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) {
    throw new Error('Repository-scoped Actions identity is required');
  }
  const owner = repository.split('/')[0];
  if (STALE_OWNER.test(owner) || owner === 'tako-vn2') {
    throw new Error('Stale repository owner value is not authorized for staging catch-up');
  }
  if (repositoryId == null || String(repositoryId).trim() === '') {
    throw new Error('GitHub repository id is required');
  }
  if (String(repositoryId) !== CANONICAL_REPOSITORY_ID) {
    throw new Error('GitHub repository id does not match the canonical Tako-san repository');
  }
  return { fullName: repository, id: String(repositoryId) };
}

export function stagingConfig(text = readFileSync(STAGING_CONFIG, 'utf8')) {
  const config = parseWranglerJsonc(text, STAGING_CONFIG);
  const binding = config.d1_databases?.[0];
  const production = parseWranglerJsonc(readFileSync(PRODUCTION_CONFIG, 'utf8'), PRODUCTION_CONFIG);
  const productionId = production.d1_databases?.[0]?.database_id;
  if (
    config.name !== 'frigo-staging' ||
    config.vars?.ENVIRONMENT !== 'staging' ||
    config.d1_databases?.length !== 1 ||
    binding?.binding !== 'DB' ||
    binding.database_name !== STAGING_D1.name ||
    binding.database_id !== STAGING_D1.id ||
    binding.migrations_dir !== 'migrations' ||
    productionId === binding.database_id ||
    productionId !== PRODUCTION_D1.id
  ) {
    throw new Error('Staging Wrangler config identity differs from the pinned catch-up target');
  }
  if (config.vars?.MEAL_COMPOSITION_V2_ENABLED !== 'false') {
    throw new Error('T20 must remain off for staging historical catch-up');
  }
  return { name: binding.database_name, id: binding.database_id, productionRejected: true };
}

export function verifyStagingD1Identity({
  list,
  info,
  expected = STAGING_D1,
  production = PRODUCTION_D1,
} = {}) {
  if (expected.id === production.id || expected.name === production.name) {
    throw new Error('Production D1 is not a valid staging catch-up target');
  }
  if (expected.id !== STAGING_D1.id || expected.name !== STAGING_D1.name) {
    throw new Error('Staging D1 identity changed');
  }
  if (!Array.isArray(list)) {
    throw new Error('STAGING_CLOUDFLARE_CREDENTIAL_REVALIDATION_REQUIRED');
  }
  const matches = list.filter((database) => database.name === expected.name);
  if (matches.length !== 1 || matches[0].uuid !== expected.id) {
    throw new Error('Staging D1 database name/id mismatch in d1 list');
  }
  if (info !== null && info !== undefined && (info.name !== expected.name || info.uuid !== expected.id)) {
    throw new Error('Staging D1 database name/id mismatch in d1 info');
  }
  return {
    accountAuthenticated: true,
    databaseName: expected.name,
    databaseId: expected.id,
    productionRejected: true,
    infoCrossCheck: info == null ? 'unavailable' : 'match',
  };
}

export function catchupWranglerConfig({ migrationsDir, database = STAGING_D1 } = {}) {
  if (!migrationsDir) throw new Error('Catch-up Wrangler config requires a prefix migrations_dir');
  if (database.id === PRODUCTION_D1.id || database.name === PRODUCTION_D1.name) {
    throw new Error('Production D1 is not a valid staging catch-up target');
  }
  if (database.id !== STAGING_D1.id || database.name !== STAGING_D1.name) {
    throw new Error('Staging D1 identity changed');
  }
  return {
    name: 'frigo-staging',
    compatibility_date: '2024-11-01',
    d1_databases: [{
      binding: 'DB',
      database_name: STAGING_D1.name,
      database_id: STAGING_D1.id,
      migrations_dir: migrationsDir.replaceAll('\\', '/'),
    }],
    vars: {
      ENVIRONMENT: 'staging',
      MEAL_COMPOSITION_V2_ENABLED: 'false',
    },
  };
}

export function writeCatchupWranglerConfig({ destFile, migrationsDir, database } = {}) {
  const config = catchupWranglerConfig({ migrationsDir, database });
  const forbidden = JSON.stringify(config);
  if (
    forbidden.includes(PRODUCTION_D1.id) ||
    /"r2_buckets"/.test(forbidden) ||
    /"kv_namespaces"/.test(forbidden) ||
    /"queues"/.test(forbidden) ||
    /"routes"/.test(forbidden)
  ) {
    throw new Error('Ephemeral catch-up config must be D1-only staging');
  }
  mkdirSync(path.dirname(destFile), { recursive: true });
  writeFileSync(
    destFile,
    `// Ephemeral staging catch-up config. Do not commit.\n${JSON.stringify(config, null, 2)}\n`,
  );
  const parsed = parseWranglerJsonc(readFileSync(destFile, 'utf8'), destFile);
  if (parsed.d1_databases[0].database_id !== STAGING_D1.id) {
    throw new Error('Ephemeral catch-up config lost the staging D1 identity');
  }
  return { configPath: destFile, config };
}

export function buildMigrationPrefix({
  target,
  sourceDir = path.resolve('migrations'),
  destDir,
} = {}) {
  const step = resolveCatchupStep(target);
  const all = listMigrations(sourceDir);
  if (new Set(all.map((name) => name.slice(0, 4))).size !== all.length) {
    throw new Error('duplicate migration number');
  }
  const targetIndex = all.indexOf(step.file);
  if (targetIndex === -1) throw new Error(`missing migration ${step.file}`);
  const included = all.slice(0, targetIndex + 1);
  if (!included.includes(step.preTip) || included.at(-1) !== step.file) {
    throw new Error('Catch-up prefix is not the exact historical chain through the target');
  }
  if (included.some((name) => name === FORBIDDEN_MIGRATION || name.startsWith('0039') || name.startsWith('0040'))) {
    throw new Error('0039 leakage into prefix dir');
  }
  if (!destDir) throw new Error('Prefix destination is required');
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const files = [];
  for (const name of included) {
    const source = path.join(sourceDir, name);
    const copy = path.join(destDir, name);
    copyFileSync(source, copy);
    const sourceSha = sha256File(source);
    const copySha = sha256File(copy);
    if (sourceSha !== copySha) throw new Error(`modified copy of ${name}`);
    files.push({ filename: name, sourceSha, copySha });
  }
  const destFiles = readdirSync(destDir).filter((name) => name.endsWith('.sql')).sort();
  if (JSON.stringify(destFiles) !== JSON.stringify(included)) {
    throw new Error('Prefix directory does not match the included historical chain');
  }
  if (destFiles.some((name) => name >= FORBIDDEN_MIGRATION)) {
    throw new Error('future 0039 leakage into prefix dir');
  }
  const manifest = {
    target: step.target,
    file: step.file,
    preTip: step.preTip,
    included: files,
  };
  manifest.sha256 = sha256Json(manifest.included);
  return manifest;
}

export function verifyPrefixIntegrity(manifest, { sourceDir = path.resolve('migrations'), destDir } = {}) {
  if (!manifest?.included?.length) throw new Error('Prefix manifest is missing');
  if (manifest.included.some((entry) => entry.filename === FORBIDDEN_MIGRATION)) {
    throw new Error('0039 leakage into prefix dir');
  }
  for (const entry of manifest.included) {
    const sourceSha = sha256File(path.join(sourceDir, entry.filename));
    if (sourceSha !== entry.sourceSha) throw new Error(`migration hash drift for ${entry.filename}`);
    if (destDir) {
      const copySha = sha256File(path.join(destDir, entry.filename));
      if (copySha !== entry.copySha || copySha !== sourceSha) {
        throw new Error(`modified copy of ${entry.filename}`);
      }
    }
  }
  if (sha256Json(manifest.included) !== manifest.sha256) throw new Error('prefix manifest hash drift');
  if (destDir) {
    const destFiles = readdirSync(destDir).filter((name) => name.endsWith('.sql')).sort();
    if (destFiles.includes(FORBIDDEN_MIGRATION) || destFiles.some((name) => name.startsWith('0039') || name.startsWith('0040'))) {
      throw new Error('0039 leakage into prefix dir');
    }
    const included = manifest.included.map((entry) => entry.filename);
    if (JSON.stringify(destFiles) !== JSON.stringify(included)) {
      throw new Error('Prefix directory does not match the included historical chain');
    }
  }
  return 'PASS';
}

export function parsePendingMigrations(planOutput) {
  if (typeof planOutput !== 'string') throw new Error('Migration plan output is missing');
  if (/No migrations to apply/i.test(planOutput)) return [];
  const pendingIdx = planOutput.search(/Migrations to be applied/i);
  let section = planOutput;
  if (pendingIdx >= 0) {
    section = planOutput.slice(pendingIdx);
    const end = section.search(/\n[^\n]*Migrations already applied/i);
    if (end > 0) section = section.slice(0, end);
  } else if (/Migrations already applied/i.test(planOutput)) {
    throw new Error('Catch-up plan did not list pending migrations distinctly');
  }
  const planned = [...new Set(section.match(/\d{4}_[A-Za-z0-9_-]+\.sql/g) || [])];
  if (planned.includes(FORBIDDEN_MIGRATION)) throw new Error('0039 leakage into catch-up migration plan');
  return planned;
}

export function verifyCatchupPlan(planOutput, { file, mode }) {
  const planned = parsePendingMigrations(planOutput);
  if (mode === 'certify') {
    if (planned.length !== 0) throw new Error('Certification-only mode expected an empty migration plan');
    return { planned };
  }
  if (JSON.stringify(planned) !== JSON.stringify([file])) {
    throw new Error(`Catch-up plan must contain exactly [${file}]; got [${planned.join(', ')}]`);
  }
  return { planned };
}

export function aggregateQuery(fileName) {
  const tables = ['recipes', 'recipe_ingredients', 'recipe_steps', 'ingredients', 'nutrition_profiles', 'recipe_nutrition', 'profiles'];
  if (tableExistsAt(fileName, 'recipe_runtime_fields')) {
    tables.push('recipe_runtime_fields', 'recipe_runtime_ingredient_order');
  }
  if (tableExistsAt(fileName, 'recipe_media')) tables.push('recipe_media');
  const counts = tables.map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`);
  const extra = [
    '(SELECT COUNT(*) FROM recipes r WHERE NOT EXISTS (SELECT 1 FROM recipe_ingredients i WHERE i.recipe_id = r.id)) AS recipes_without_ingredients',
    '(SELECT COUNT(*) FROM recipes r WHERE NOT EXISTS (SELECT 1 FROM recipe_steps s WHERE s.recipe_id = r.id)) AS recipes_without_steps',
    '(SELECT COUNT(*) - COUNT(DISTINCT id) FROM recipes) AS duplicate_recipe_ids',
    '(SELECT COUNT(*) - COUNT(DISTINCT slug) FROM recipes) AS duplicate_slugs',
  ];
  if (tableExistsAt(fileName, 'recipe_runtime_fields')) {
    extra.push(
      '(SELECT MIN(runtime_order) FROM recipe_runtime_fields) AS order_min',
      '(SELECT MAX(runtime_order) FROM recipe_runtime_fields) AS order_max',
      '(SELECT COUNT(DISTINCT runtime_order) FROM recipe_runtime_fields) AS order_distinct',
      '(SELECT COUNT(*) FROM recipes r WHERE NOT EXISTS (SELECT 1 FROM recipe_runtime_fields f WHERE f.recipe_id = r.id)) AS recipes_without_runtime_fields',
      '(SELECT COUNT(*) FROM recipe_ingredients i WHERE NOT EXISTS (SELECT 1 FROM recipe_runtime_ingredient_order o WHERE o.recipe_ingredient_id = i.id)) AS ingredients_without_order',
    );
  }
  if (tableExistsAt(fileName, 'recipe_media')) {
    extra.push(
      "(SELECT COUNT(*) FROM recipe_media WHERE status = 'pending') AS media_pending",
      "(SELECT COUNT(*) FROM recipe_media WHERE status = 'ready') AS media_ready",
      "(SELECT COUNT(*) FROM recipe_media WHERE role = 'hero') AS media_hero",
    );
  }
  if (fileName >= '0038_auth_onboarding_completion.sql') {
    extra.push('(SELECT COUNT(onboarding_completed_at) FROM profiles) AS profiles_onboarded');
  }
  return `SELECT ${counts.join(', ')}, ${extra.join(', ')}`;
}

export function identityQuery(fileName) {
  if (tableExistsAt(fileName, 'recipe_runtime_fields')) {
    return 'SELECT r.id, r.slug, f.runtime_order, r.source_type, r.source_reference, r.verification_state, r.version FROM recipe_runtime_fields f JOIN recipes r ON r.id = f.recipe_id ORDER BY f.runtime_order, r.id';
  }
  return 'SELECT id, slug, source_type, source_reference, verification_state, version FROM recipes ORDER BY id';
}

export function mediaSummaryQuery() {
  return "SELECT COUNT(*) AS total, SUM(role = 'hero') AS hero, SUM(role = 'thumbnail') AS thumbnail, SUM(status = 'pending') AS pending, SUM(status = 'ready') AS ready, SUM(status = 'rejected') AS rejected, SUM(status = 'superseded') AS superseded FROM recipe_media";
}

export function mediaSlotsQuery() {
  return "SELECT COUNT(*) AS recipes_without_exact_hero_v1_pending FROM recipes r WHERE (SELECT COUNT(*) FROM recipe_media m WHERE m.recipe_id = r.id AND m.role = 'hero' AND m.version = 1 AND m.status = 'pending') <> 1 OR (SELECT COUNT(*) FROM recipe_media m WHERE m.recipe_id = r.id) <> 1";
}

export function mediaSchemaQuery() {
  return "SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'recipe_media' ORDER BY type, name";
}

export function onboardingQuery() {
  return "SELECT COUNT(*) AS profiles, COUNT(onboarding_completed_at) AS onboarded, (SELECT COUNT(*) FROM pragma_table_info('profiles') WHERE name = 'onboarding_completed_at') AS column_present, (SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_profiles_onboarding_completed') AS index_sql FROM profiles";
}

export function runtimeSchemaQuery() {
  return "SELECT name, type, sql FROM sqlite_master WHERE name IN ('recipe_runtime_fields', 'recipe_runtime_ingredient_order') ORDER BY name";
}

export const CHECKPOINT_TIPS = Object.freeze([
  '0033_scan_evidence_completeness.sql',
  ...Object.values(CATCHUP_STEPS).map((step) => step.file),
]);
const BASELINE_TIP = CHECKPOINT_TIPS[0];
const MEDIA_TIP = '0035_recipe_media_layer.sql';
const ONBOARDING_TIP = '0038_auth_onboarding_completion.sql';

export function d1Result(results) {
  return [{ success: true, results }];
}

/** Runs the same bounded read-only queries the workflow sends to remote D1, against a local DB. */
export function collectCheckpointEvidence(db, fileName) {
  const all = (sql) => db.prepare(sql).all().map((row) => ({ ...row }));
  const evidence = {
    aggregates: d1Result(all(aggregateQuery(fileName))),
    identities: d1Result(all(identityQuery(fileName))),
    health: {
      foreignKeys: d1Result(all('PRAGMA foreign_key_check')),
      quickCheck: d1Result(all('PRAGMA quick_check')),
    },
  };
  if (fileName >= MEDIA_TIP) {
    evidence.mediaSummary = d1Result(all(mediaSummaryQuery()));
    evidence.mediaSlots = d1Result(all(mediaSlotsQuery()));
    evidence.mediaSchema = d1Result(all(mediaSchemaQuery()));
  }
  if (fileName >= ONBOARDING_TIP) evidence.onboarding = d1Result(all(onboardingQuery()));
  return evidence;
}

const expectedCache = new Map();

function replayCheckpoints(sourceDir) {
  const all = listMigrations(sourceDir);
  const last = CHECKPOINT_TIPS.at(-1);
  if (!all.includes(last)) throw new Error(`missing migration ${last}`);
  const wanted = new Set(CHECKPOINT_TIPS);
  const evidence = new Map();
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of all.slice(0, all.indexOf(last) + 1)) {
      db.exec(readFileSync(path.join(sourceDir, name), 'utf8'));
      if (wanted.has(name)) evidence.set(name, collectCheckpointEvidence(db, name));
    }
  } finally {
    db.close();
  }
  return evidence;
}

/** Reviewed evidence for a historical checkpoint, derived by replaying the repository migrations. */
export function expectedCheckpointEvidence(fileName, { sourceDir = path.resolve('migrations') } = {}) {
  if (!CHECKPOINT_TIPS.includes(fileName)) throw new Error(`No historical catch-up checkpoint for ${fileName}`);
  if (!expectedCache.has(sourceDir)) expectedCache.set(sourceDir, replayCheckpoints(sourceDir));
  return expectedCache.get(sourceDir).get(fileName);
}

export function expectedSnapshot(fileName, options = {}) {
  const evidence = expectedCheckpointEvidence(fileName, options);
  return snapshotFromRemote({ aggregates: evidence.aggregates, identities: evidence.identities, fileName });
}

export function loadHistoricalRelease(cwd = process.cwd()) {
  return JSON.parse(readFileSync(path.join(cwd, CATALOG_RELEASE_MANIFEST), 'utf8'));
}

export function incomingCatalog(step, options = {}) {
  if (!step.catalogGrowth) return { ids: [], slugs: [] };
  const pre = expectedSnapshot(step.preTip, options);
  const post = expectedSnapshot(step.file, options);
  const preIds = new Set(pre.ids);
  const preSlugs = new Set(pre.slugs);
  return {
    ids: post.ids.filter((id) => !preIds.has(id)),
    slugs: post.slugs.filter((slug) => !preSlugs.has(slug)),
  };
}

export function verifyBatchMarker(step, { cwd = process.cwd(), release = loadHistoricalRelease(cwd) } = {}) {
  if (!step.batchId) return 'SKIP';
  const sql = readFileSync(path.join(cwd, 'migrations', step.file), 'utf8');
  const marker = sql.match(/batch_hash=([0-9a-f]{64})\s+recipes=(\d+)/i);
  if (!marker || marker[1] !== step.batchHash || Number(marker[2]) !== step.batchRecipes) {
    throw new Error(`Approved batch ${step.batchId} migration marker does not match the catch-up contract`);
  }
  const batch = release.approvedImportBatches?.find((entry) => entry.batchId === step.batchId);
  if (!batch || batch.batchHash !== step.batchHash || batch.recipeCount !== step.batchRecipes) {
    throw new Error(`Approved batch ${step.batchId} is not the historical T14F batch`);
  }
  return 'PASS';
}

export function certify0033Baseline(actual, expected = expectedSnapshot('0033_scan_evidence_completeness.sql')) {
  const problems = [];
  if (actual.ids.length !== actual.recipeCount) problems.push('identity row count');
  if (actual.recipeCount !== 59 || expected.recipeCount !== 59) problems.push(`recipes=${actual.recipeCount}`);
  if (actual.idSetHash !== expected.idSetHash) problems.push('recipe ID set');
  if (actual.integrity?.duplicate_slugs) problems.push('duplicate slug');
  if (actual.integrity?.duplicate_recipe_ids) problems.push('duplicate recipe IDs');
  if (actual.integrity?.recipes_without_ingredients) problems.push('recipe_ingredients');
  if (actual.integrity?.recipes_without_steps) problems.push('recipe_steps');
  const actualSet = new Set(actual.ids);
  const missing = expected.ids.filter((id) => !actualSet.has(id));
  const extra = actual.ids.filter((id) => !new Set(expected.ids).has(id));
  if (missing.length || extra.length) problems.push('wrong ID set');
  if (problems.length) throw new Error(`STAGING_0033_BASELINE_DRIFT: ${problems.join(', ')}`);
  return { certification: 'STAGING_0033_BASELINE_CERTIFIED', recipeCount: 59, recipeIdSetHash: actual.idSetHash };
}

function catalogShapeProblems(actual, expected) {
  const problems = [];
  if (actual.recipeCount !== expected.recipeCount) {
    problems.push(`recipes ${actual.recipeCount} != ${expected.recipeCount}`);
  }
  if (actual.ids.length !== actual.recipeCount) problems.push('identity row count');
  if (actual.idSetHash !== expected.idSetHash) problems.push('recipe ID set');
  if (actual.orderedHash !== expected.orderedHash) problems.push('ordered recipe IDs');
  if (actual.identityHash !== expected.identityHash) problems.push('recipe identity/provenance');
  for (const table of CATALOG_TABLES) {
    if (expected.counts[table] == null && actual.counts[table] == null) continue;
    if (actual.counts[table] !== expected.counts[table]) {
      problems.push(`${table} ${actual.counts[table]} != ${expected.counts[table]}`);
    }
  }
  const integrity = actual.integrity || {};
  if (integrity.duplicate_slugs) problems.push('duplicate slug');
  if (integrity.duplicate_recipe_ids) problems.push('duplicate recipe IDs');
  if (integrity.recipes_without_ingredients) problems.push('recipe_ingredients coverage');
  if (integrity.recipes_without_steps) problems.push('recipe_steps coverage');
  if (expected.integrity?.order_min != null) {
    if (
      integrity.order_min !== 0 ||
      integrity.order_max !== expected.recipeCount - 1 ||
      integrity.order_distinct !== expected.recipeCount
    ) {
      problems.push('runtime_order gaps');
    }
    if (
      !Array.isArray(actual.runtimeOrders) ||
      actual.runtimeOrders.length !== expected.recipeCount ||
      actual.runtimeOrders.some((order, index) => order !== index)
    ) {
      problems.push('runtime_order sequence');
    }
    if (integrity.recipes_without_runtime_fields) problems.push('recipe_runtime_fields coverage');
    if (integrity.ingredients_without_order) problems.push('recipe_runtime_ingredient_order coverage');
  }
  if (expected.integrity?.media_pending != null) {
    for (const key of ['media_pending', 'media_hero']) {
      if (integrity[key] !== expected.integrity[key]) problems.push(`${key} ${integrity[key]} != ${expected.integrity[key]}`);
    }
    if (integrity.media_ready !== 0) problems.push(`media_ready=${integrity.media_ready}`);
  }
  return problems;
}

const normalizeSql = (sql) => (typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : '');
const MEDIA_OBJECT_CONTRACT = Object.freeze({
  idx_recipe_media_current_ready: /CREATE UNIQUE INDEX idx_recipe_media_current_ready ON recipe_media ?\(recipe_id, role\) WHERE status = 'ready'/i,
  idx_recipe_media_recipe_role_status: /CREATE INDEX idx_recipe_media_recipe_role_status ON recipe_media ?\(recipe_id, role, status\)$/i,
  idx_recipe_media_content_hash: /CREATE INDEX idx_recipe_media_content_hash ON recipe_media ?\(content_hash\) WHERE content_hash IS NOT NULL/i,
  trg_recipe_media_ready_immutable_update: /BEFORE UPDATE OF recipe_id, role, version, storage_key, mime_type, width, height, content_length, content_hash ON recipe_media WHEN OLD\.status = 'ready' BEGIN SELECT RAISE\(ABORT, 'recipe_media ready versions are immutable'\); END/i,
});
const MEDIA_TABLE_FRAGMENTS = Object.freeze([
  "mime_type TEXT CHECK (mime_type IS NULL OR mime_type IN ('image/webp', 'image/avif', 'image/jpeg', 'image/png'))",
  "instr(storage_key, '..') = 0",
  "storage_key = 'recipes/' || recipe_id || '/' || role || '/v' || version || CASE mime_type",
  "WHEN 'image/webp' THEN '.webp' WHEN 'image/avif' THEN '.avif' WHEN 'image/jpeg' THEN '.jpg' WHEN 'image/png' THEN '.png'",
  'UNIQUE (recipe_id, role, version)',
]);

/** 0035 media seed plus exact index/trigger/MIME/storage-key contract, compared with local replay. */
export function verifyMediaCheckpoint({ summary, slots, schema, recipes, expectedSchema }) {
  const seed = verifyRecipeMediaSeed({ summary, slots, schema, recipes });
  const objects = rows(schema, 'recipe_media schema');
  const named = (list) => list.map((object) => object.name).filter((name) => !name.startsWith('sqlite_autoindex_')).sort();
  const expectedNames = named(rows(expectedSchema, 'expected recipe_media schema'));
  if (JSON.stringify(named(objects)) !== JSON.stringify(expectedNames)) {
    throw new Error(`recipe_media schema objects differ: [${named(objects).join(', ')}]`);
  }
  for (const [name, pattern] of Object.entries(MEDIA_OBJECT_CONTRACT)) {
    if (!pattern.test(normalizeSql(objects.find((object) => object.name === name)?.sql))) {
      throw new Error(`recipe_media schema object ${name} does not match the reviewed 0035 SQL`);
    }
  }
  const table = normalizeSql(objects.find((object) => object.type === 'table' && object.name === 'recipe_media')?.sql);
  for (const fragment of MEDIA_TABLE_FRAGMENTS) {
    if (!table.includes(fragment)) throw new Error(`recipe_media table is missing contract fragment: ${fragment}`);
  }
  return { ...seed, schemaContract: 'exact' };
}

function batchProvenanceProblems(fileName, actual, { cwd, release }) {
  const problems = [];
  for (const step of Object.values(CATCHUP_STEPS)) {
    if (!step.batchId || step.file > fileName) continue;
    try {
      verifyBatchMarker(step, { cwd, release });
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    const batch = release.approvedImportBatches.find((entry) => entry.batchId === step.batchId);
    const expectedIds = release.orderedRecipeIds.slice(batch.releaseBaseCount, batch.releaseBaseCount + batch.recipeCount);
    const tagged = actual.provenance.filter((row) => row.source_reference === batch.sourceReference);
    if (
      tagged.length !== step.batchRecipes ||
      JSON.stringify(tagged.map((row) => row.id)) !== JSON.stringify(expectedIds) ||
      tagged.some((row) => row.source_type !== 'ai_generated' || row.verification_state !== 'reviewed' || row.version !== 1)
    ) {
      problems.push(`approved batch ${step.batchId} provenance`);
    }
  }
  return problems;
}

export function checkpointStatus(fileName, phase = 'pre') {
  if (fileName === BASELINE_TIP) return 'STAGING_0033_BASELINE_CERTIFIED';
  return `STAGING_${fileName.slice(0, 4)}_${phase === 'post' ? 'POSTSTATE' : 'PRESTATE'}_CERTIFIED`;
}

/**
 * Certifies a live historical checkpoint to its full reviewed contract: exact catalog identity,
 * order, provenance, child/runtime counts, media seed/schema, batch provenance and onboarding
 * schema. FK/quick_check are included when `evidence.health` is supplied.
 */
export function certifyCheckpoint(fileName, evidence, {
  phase = 'pre',
  requireNoneOnboarded = false,
  preProfiles = null,
  cwd = process.cwd(),
  release = loadHistoricalRelease(cwd),
  sourceDir,
} = {}) {
  const expectedEvidence = expectedCheckpointEvidence(fileName, { sourceDir });
  const expected = expectedSnapshot(fileName, { sourceDir });
  const actual = snapshotFromRemote({ aggregates: evidence?.aggregates, identities: evidence?.identities, fileName });
  const label = fileName === BASELINE_TIP
    ? 'STAGING_0033_BASELINE_DRIFT'
    : `STAGING_${fileName.slice(0, 4)}_${phase === 'post' ? 'POSTSTATE' : 'PRESTATE'}_DRIFT`;
  const result = { tip: fileName, snapshot: actual, catalog: 'PASS', media: 'NOT_APPLICABLE', batches: [], onboarding: 'NOT_APPLICABLE' };
  if (fileName === BASELINE_TIP) {
    result.baseline = certify0033Baseline(actual, expected);
  } else {
    const problems = catalogShapeProblems(actual, expected);
    const releaseIds = release.orderedRecipeIds;
    if (!Array.isArray(releaseIds) || new Set(releaseIds).size !== release.expectedRecipeCount ||
        JSON.stringify(actual.orderedIds) !== JSON.stringify(releaseIds.slice(0, expected.recipeCount))) {
      problems.push('historical release order');
    }
    const missingGlobal = GLOBAL_RECIPE_IDS.filter((id) => !actual.ids.includes(id));
    if (missingGlobal.length) problems.push(`missing global recipe IDs ${missingGlobal.join(', ')}`);
    problems.push(...batchProvenanceProblems(fileName, actual, { cwd, release }));
    result.batches = Object.values(CATCHUP_STEPS)
      .filter((step) => step.batchId && step.file <= fileName)
      .map((step) => ({ batchId: step.batchId, batchHash: step.batchHash }));
    if (fileName >= MEDIA_TIP) {
      if (!evidence.mediaSummary || !evidence.mediaSlots || !evidence.mediaSchema) {
        problems.push('recipe_media evidence missing');
      } else {
        try {
          result.media = verifyMediaCheckpoint({
            summary: evidence.mediaSummary,
            slots: evidence.mediaSlots,
            schema: evidence.mediaSchema,
            recipes: expected.recipeCount,
            expectedSchema: expectedEvidence.mediaSchema,
          });
        } catch (error) {
          problems.push(error.message);
        }
      }
    }
    if (fileName >= ONBOARDING_TIP) {
      if (!evidence.onboarding) {
        problems.push('onboarding evidence missing');
      } else {
        try {
          result.onboarding = certifyOnboarding(rows(evidence.onboarding, 'onboarding')[0], preProfiles, { requireNoneOnboarded });
        } catch (error) {
          problems.push(error.message);
        }
      }
    }
    if (problems.length) throw new Error(`${label}: ${problems.join('; ')}`);
  }
  result.health = 'PENDING';
  if (evidence.health) {
    try {
      verifyHealth(evidence.health);
    } catch (error) {
      throw new Error(`${label}: ${error.message}`);
    }
    result.health = 'PASS';
  }
  result.status = result.health === 'PASS' ? checkpointStatus(fileName, phase) : 'CATALOG_CERTIFIED_HEALTH_PENDING';
  return result;
}

/** The pre-tip must satisfy the same contract as a completed post-state before any mutation. */
export function certifyPreState(step, evidence, options = {}) {
  return certifyCheckpoint(step.preTip, evidence, { ...options, phase: 'pre' });
}

export function assertDeltaContract(pre, post, step) {
  const drift = [];
  for (const table of DELTA_TABLES) {
    if (pre.counts[table] == null && post.counts[table] == null) continue;
    if (pre.counts[table] !== post.counts[table]) drift.push(table);
  }
  if (!step.catalogGrowth) {
    for (const table of CATALOG_TABLES) {
      if (step.media && table === 'recipe_media') continue;
      if (pre.counts[table] !== post.counts[table]) drift.push(table);
    }
  }
  if (drift.length) throw new Error(`Aggregate delta outside ${step.file} contract: ${drift.join(', ')}`);
  return 'PASS';
}

export function findCollisions(existing, incoming) {
  const ids = new Set(existing.ids);
  const slugs = new Set(existing.slugs);
  const idHits = incoming.ids.filter((id) => ids.has(id));
  const slugHits = incoming.slugs.filter((slug) => slugs.has(slug));
  if (idHits.length || slugHits.length) {
    throw new Error(`Catalog collision before ${incoming.label || 'import'}: ids=${idHits.length} slugs=${slugHits.length}`);
  }
  return 'PASS';
}

export function certifyPostState(step, evidence, { pre, mode = 'apply', ...options } = {}) {
  const checkpoint = certifyCheckpoint(step.file, evidence, {
    ...options,
    phase: 'post',
    requireNoneOnboarded: mode === 'apply',
    preProfiles: mode === 'apply' ? pre?.counts?.profiles ?? null : null,
  });
  if (checkpoint.snapshot.recipeCount !== step.postRecipes) {
    throw new Error(`${step.file} recipe count ${checkpoint.snapshot.recipeCount} != ${step.postRecipes}`);
  }
  if (pre) assertDeltaContract(pre, checkpoint.snapshot, step);
  return { certification: step.certification, checkpoint };
}

export function certifyOnboarding(row, preProfiles, { requireNoneOnboarded = true } = {}) {
  if (row?.column_present !== 1) throw new Error('profiles.onboarding_completed_at is missing');
  if (typeof row.index_sql !== 'string' || !/idx_profiles_onboarding_completed/.test(row.index_sql)) {
    throw new Error('idx_profiles_onboarding_completed is missing');
  }
  if (!/onboarding_completed_at/.test(row.index_sql) || !/WHERE onboarding_completed_at IS NOT NULL/i.test(row.index_sql)) {
    throw new Error('idx_profiles_onboarding_completed does not match the reviewed SQL');
  }
  if (preProfiles != null && row.profiles !== preProfiles) {
    throw new Error('Existing profile row count was rewritten');
  }
  // Only provable right after this run applied 0038; a certify-only run cannot know prior writes.
  if (requireNoneOnboarded && row.onboarded !== 0) throw new Error('Existing profiles were unexpectedly marked onboarded');
  return 'PASS';
}

export function captureBookmark(info, { historicalReportedBookmark = HISTORICAL_REPORTED_BOOKMARK } = {}) {
  const bookmark = info?.bookmark;
  if (typeof bookmark !== 'string' || !bookmark) throw new Error('No D1 Time Travel bookmark returned');
  return {
    bookmark,
    capturedAt: new Date().toISOString(),
    source: 'time-travel-info',
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    historicalReportedBookmark,
  };
}

/**
 * Verifies the active bookmark came from `d1 time-travel info` in this workflow run (same run id
 * when Actions provides one), carries capturedAt, and is not a reused/historical value. The
 * workflow captures it as the step immediately before apply; this does not independently prove
 * wall-clock freshness.
 */
export function assertCurrentRunBookmark(timeTravel) {
  if (!timeTravel || timeTravel.source !== 'time-travel-info' || !timeTravel.capturedAt || !timeTravel.bookmark) {
    throw new Error('Catch-up requires a Time Travel bookmark captured by this run immediately before mutation');
  }
  if (timeTravel.reused === true) throw new Error('Stale or reused Time Travel bookmark is not authorized');
  if (process.env.GITHUB_RUN_ID && timeTravel.runId !== process.env.GITHUB_RUN_ID) {
    throw new Error('Time Travel bookmark was not captured by the current workflow run');
  }
  return 'PASS';
}

export function snapshotFromRemote({ aggregates, identities, fileName }) {
  const integrity = Array.isArray(aggregates) ? rows(aggregates, 'aggregates')[0] : aggregates;
  if (!integrity || typeof integrity !== 'object') throw new Error('Catalog aggregate result is missing');
  const identityRows = Array.isArray(identities) && identities[0]?.success === true
    ? rows(identities, 'identities')
    : identities;
  if (!Array.isArray(identityRows)) throw new Error('Catalog identity result is missing');
  const ids = identityRows.map((row) => row.id);
  const slugs = identityRows.map((row) => row.slug);
  const counts = {};
  for (const table of [...CATALOG_TABLES, ...DELTA_TABLES]) {
    counts[table] = Object.hasOwn(integrity, table) ? integrity[table] : null;
  }
  const runtime = tableExistsAt(fileName, 'recipe_runtime_fields');
  const ordered = runtime ? ids : [...ids].sort();
  const provenance = identityRows.map((row) => ({
    id: row.id,
    source_type: row.source_type ?? null,
    source_reference: row.source_reference ?? null,
    verification_state: row.verification_state ?? null,
    version: row.version ?? null,
  }));
  return {
    fileName,
    recipeCount: integrity.recipes,
    ids,
    slugs,
    orderedIds: ordered,
    runtimeOrders: runtime ? identityRows.map((row) => row.runtime_order) : null,
    provenance,
    idSetHash: sha256Json([...ids].sort()),
    orderedHash: sha256Json(ordered),
    identityHash: sha256Json(identityRows.map((row) => [
      row.id, row.slug, row.runtime_order ?? null, row.source_type ?? null,
      row.source_reference ?? null, row.verification_state ?? null, row.version ?? null,
    ])),
    counts,
    integrity,
  };
}

async function exactMainCi(sha, repository = process.env.GITHUB_REPOSITORY) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !process.env.GH_TOKEN) {
    throw new Error('Repository-scoped Actions read token is required');
  }
  const query = new URLSearchParams({
    branch: 'main', event: 'push', head_sha: sha, per_page: '100',
  });
  const response = await fetch(
    `https://api.github.com/repos/${repository}/actions/workflows/ci.yml/runs?${query}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    },
  );
  if (!response.ok) throw new Error(`Hosted CI lookup failed: HTTP ${response.status}`);
  return requireSuccessfulCi((await response.json()).workflow_runs, { sha, repository });
}

export function validateCatchupCandidate({ ref, target, cwd = process.cwd() } = {}) {
  const step = resolveCatchupStep(target);
  if (!SHA.test(ref || '')) throw new Error('Catch-up ref must be a full immutable SHA, never a branch or tag');
  const sha = git(cwd, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  const mainSha = git(cwd, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}');
  try {
    git(cwd, 'merge-base', '--is-ancestor', sha, mainSha);
  } catch {
    throw new Error('Catch-up candidate is not contained in main');
  }
  if (sha !== mainSha) throw new Error('Catch-up ref must equal current main, not an ancestor');
  const schema = migrationManifest(cwd, sha);
  const names = schema.migrations.map((entry) => entry.name);
  if (!names.includes(step.preTip) || !names.includes(step.file)) {
    throw new Error('Catch-up target is not part of the candidate migration history');
  }
  if (!names.includes(FORBIDDEN_MIGRATION)) {
    throw new Error('Canonical history must still contain 0039 after catch-up tooling lands');
  }
  const prefixNames = names.slice(0, names.indexOf(step.file) + 1);
  if (prefixNames.includes(FORBIDDEN_MIGRATION)) throw new Error('0039 leakage into prefix dir');
  const pinned = JSON.parse(
    execFileSync('git', ['show', `${sha}:tests/fixtures/migration-sha256.json`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  for (const [name, digest] of Object.entries(pinned.migrations || {})) {
    const actual = schema.migrations.find((entry) => entry.name === name);
    if (!actual || actual.sha256 !== digest) {
      throw new Error(`Historical migration ${name} differs from its pinned hash`);
    }
  }
  return {
    sha,
    mainSha,
    step,
    chain: [step.file],
    schema,
    prefixNames,
    pinnedCount: Object.keys(pinned.migrations || {}).length,
  };
}

export async function gate({ ref = process.env.MIGRATION_REF, target = process.env.CATCHUP_TARGET } = {}) {
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Dispatch must run from main');
  const repository = assertRepositoryIdentity();
  const candidate = validateCatchupCandidate({ ref, target });
  const database = stagingConfig();
  const ci = await exactMainCi(candidate.sha, repository.fullName);
  const expectedPre = expectedSnapshot(candidate.step.preTip);
  const expectedPost = expectedSnapshot(candidate.step.file);
  if (candidate.step.batchId) verifyBatchMarker(candidate.step);
  return {
    status: 'GATED',
    environment: 'staging',
    repository,
    sha: candidate.sha,
    mainSha: candidate.mainSha,
    database,
    ci,
    target: candidate.step.target,
    step: candidate.step,
    chain: candidate.chain,
    schema: {
      migrations: candidate.prefixNames.map((name) => ({ name })),
      fullTip: candidate.schema.version,
      fullCount: candidate.schema.count,
    },
    expected: {
      pre: {
        ledgerTip: candidate.step.preTip,
        recipeCount: expectedPre.recipeCount,
        recipeIdSetHash: expectedPre.idSetHash,
        orderedHash: expectedPre.orderedHash,
        counts: expectedPre.counts,
      },
      post: {
        ledgerTip: candidate.step.file,
        recipeCount: expectedPost.recipeCount,
        recipeIdSetHash: expectedPost.idSetHash,
        orderedHash: expectedPost.orderedHash,
        counts: expectedPost.counts,
      },
      incoming: incomingCatalog(candidate.step),
    },
    historicalReportedBookmark: HISTORICAL_REPORTED_BOOKMARK,
    checkedAt: new Date().toISOString(),
  };
}

function requireReceipt(receipt, fields) {
  for (const field of fields) {
    if (!receipt[field]) throw new Error(`Catch-up receipt is missing ${field}`);
  }
}

export async function run(command, file, args = []) {
  if (command === 'query') {
    const kind = file;
    const tip = args[0];
    if (kind === 'baseline') return aggregateQuery(tip);
    if (kind === 'identities') return identityQuery(tip);
    if (kind === 'media-summary') return mediaSummaryQuery();
    if (kind === 'media-slots') return mediaSlotsQuery();
    if (kind === 'media-schema') return mediaSchemaQuery();
    if (kind === 'onboarding') return onboardingQuery();
    if (kind === 'runtime-schema') return runtimeSchemaQuery();
    if (kind === 'schema-gate') return renderSchemaGateCommand({ migrationsDirectory: tip });
    throw new Error('Unknown read-only query');
  }
  if (command === 'gate') {
    const receipt = await gate();
    save(file, receipt);
    return receipt;
  }
  const receipt = readJson(file);
  if (command === 'prefix') {
    requireReceipt(receipt, ['step', 'database']);
    const destDir = path.join(ARTIFACT_ROOT, receipt.step.target, 'migrations');
    const configPath = path.join(ARTIFACT_ROOT, receipt.step.target, 'wrangler.catchup.jsonc');
    receipt.prefix = buildMigrationPrefix({ target: receipt.step.target, destDir });
    receipt.prefix.destDir = destDir;
    // Wrangler resolves migrations_dir relative to the config file, not cwd.
    receipt.prefix.configPath = writeCatchupWranglerConfig({
      destFile: configPath, migrationsDir: 'migrations',
    }).configPath;
    verifyPrefixIntegrity(receipt.prefix, { destDir });
  } else if (command === 'identity') {
    requireReceipt(receipt, ['database']);
    receipt.cloudflare = verifyStagingD1Identity({
      list: readJson(args[0]),
      info: readJson(args[1]),
      expected: receipt.database,
    });
  } else if (command === 'pre-ledger') {
    requireReceipt(receipt, ['cloudflare', 'schema', 'chain']);
    receipt.preLedger = classifyPreLedger(
      { schema: receipt.schema, chain: receipt.chain, migration: receipt.step.file },
      readJson(args[0]),
    );
    const expectedTip = receipt.preLedger.mode === 'apply' ? receipt.step.preTip : receipt.step.file;
    if (receipt.preLedger.tip !== expectedTip) {
      throw new Error(`Catch-up ledger tip ${receipt.preLedger.tip} is not ${expectedTip}`);
    }
    if (receipt.preLedger.mode === 'apply' && receipt.preLedger.chain.length !== 1) {
      throw new Error('Catch-up may apply exactly one historical migration');
    }
  } else if (command === 'pre-catalog') {
    requireReceipt(receipt, ['preLedger', 'step', 'expected']);
    const fileName = receipt.preLedger.mode === 'apply' ? receipt.step.preTip : receipt.step.file;
    const optional = (file) => (file ? readJson(file) : undefined);
    const evidence = { aggregates: readJson(args[0]), identities: readJson(args[1]) };
    if (fileName >= MEDIA_TIP) {
      Object.assign(evidence, {
        mediaSummary: optional(args[2]), mediaSlots: optional(args[3]), mediaSchema: optional(args[4]),
      });
    }
    if (fileName >= ONBOARDING_TIP) evidence.onboarding = optional(args[5]);
    const checkpoint = certifyCheckpoint(fileName, evidence, { phase: 'pre' });
    const actual = checkpoint.snapshot;
    if (checkpoint.baseline) receipt.preBaseline = checkpoint.baseline;
    receipt.preState = {
      tip: fileName,
      mode: receipt.preLedger.mode,
      catalog: checkpoint.catalog,
      media: checkpoint.media === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : 'PASS',
      batches: checkpoint.batches,
      onboarding: checkpoint.onboarding,
      health: 'PENDING',
      status: checkpoint.status,
    };
    receipt.preSnapshot = {
      recipeCount: actual.recipeCount,
      recipeIdSetHash: actual.idSetHash,
      orderedHash: actual.orderedHash,
      identityHash: actual.identityHash,
      counts: actual.counts,
      integrity: actual.integrity,
      ids: actual.ids,
      slugs: actual.slugs,
    };
    if (receipt.preLedger.mode === 'apply' && receipt.step.collision) {
      findCollisions(actual, { ...receipt.expected.incoming, label: receipt.step.file });
      receipt.collisionGate = 'PASS';
    }
  } else if (command === 'bookmark') {
    requireReceipt(receipt, ['preState', 'preSnapshot']);
    receipt.timeTravel = captureBookmark(readJson(args[0]), {
      historicalReportedBookmark: receipt.historicalReportedBookmark,
    });
    assertCurrentRunBookmark(receipt.timeTravel);
  } else if (command === 'pre-health') {
    requireReceipt(receipt, ['timeTravel', 'preState']);
    receipt.preHealth = verifyHealth({ foreignKeys: readJson(args[0]), quickCheck: readJson(args[1]) });
    receipt.preState.health = 'PASS';
    receipt.preState.status = checkpointStatus(receipt.preState.tip, 'pre');
  } else if (command === 'plan') {
    requireReceipt(receipt, ['preHealth', 'prefix', 'preState']);
    if (receipt.preState.health !== 'PASS' || receipt.preState.status !== checkpointStatus(receipt.preState.tip, 'pre')) {
      throw new Error('Pre-state checkpoint is not fully certified; mutation is not eligible');
    }
    verifyPrefixIntegrity(receipt.prefix, { destDir: receipt.prefix.destDir });
    receipt.plan = verifyCatchupPlan(readFileSync(args[0], 'utf8'), {
      file: receipt.step.file,
      mode: receipt.preLedger.mode,
    });
  } else if (command === 'recheck') {
    requireReceipt(receipt, ['plan', 'sha']);
    const currentMain = git(process.cwd(), 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}');
    if (currentMain !== receipt.sha) throw new Error('main moved during catch-up workflow');
    receipt.ciRecheck = await exactMainCi(receipt.sha, receipt.repository.fullName);
    verifyPrefixIntegrity(receipt.prefix, { destDir: receipt.prefix.destDir });
    if (args[0]) {
      const ledger = classifyPreLedger(
        { schema: receipt.schema, chain: receipt.chain, migration: receipt.step.file },
        readJson(args[0]),
      );
      if (JSON.stringify(ledger) !== JSON.stringify(receipt.preLedger)) {
        throw new Error('Migration ledger changed between preflight and apply');
      }
    }
    if (args[1]) {
      const plan = verifyCatchupPlan(readFileSync(args[1], 'utf8'), {
        file: receipt.step.file,
        mode: receipt.preLedger.mode,
      });
      if (JSON.stringify(plan) !== JSON.stringify(receipt.plan)) {
        throw new Error('Migration plan changed between preflight and apply');
      }
    }
    receipt.recheck = {
      mainSha: currentMain,
      prefix: 'PASS',
      ledger: args[0] ? 'PASS' : 'SKIPPED',
      plan: args[1] ? 'PASS' : 'SKIPPED',
      checkedAt: new Date().toISOString(),
    };
  } else if (command === 'bookmark-final') {
    requireReceipt(receipt, ['recheck']);
    receipt.timeTravelPreflight = receipt.timeTravel;
    receipt.timeTravel = captureBookmark(readJson(args[0]), {
      historicalReportedBookmark: receipt.historicalReportedBookmark,
    });
    assertCurrentRunBookmark(receipt.timeTravel);
  } else if (command === 'apply-gate') {
    requireReceipt(receipt, ['preState', 'plan', 'recheck', 'timeTravel']);
    if (receipt.preState.status !== checkpointStatus(receipt.preState.tip, 'pre')) {
      throw new Error('Pre-state checkpoint is not fully certified; mutation is not eligible');
    }
    if (receipt.recheck.ledger !== 'PASS' || receipt.recheck.plan !== 'PASS') {
      throw new Error('Ledger and plan must be rechecked immediately before apply');
    }
    assertCurrentRunBookmark(receipt.timeTravel);
    if (!(Date.parse(receipt.timeTravel.capturedAt) >= Date.parse(receipt.recheck.checkedAt))) {
      throw new Error('Active Time Travel bookmark must be captured after the final recheck');
    }
    receipt.applyGate = { mode: receipt.preLedger.mode, checkedAt: new Date().toISOString() };
  } else if (command === 'post') {
    requireReceipt(receipt, ['plan', 'timeTravel', 'preState', 'preSnapshot']);
    assertCurrentRunBookmark(receipt.timeTravel);
    receipt.postLedger = verifyPostLedger(
      { schema: receipt.schema, migration: receipt.step.file },
      readJson(args[0]),
    );
    const optional = (file) => (file ? readJson(file) : undefined);
    const evidence = {
      aggregates: readJson(args[3]),
      identities: readJson(args[4]),
      health: { foreignKeys: readJson(args[1]), quickCheck: readJson(args[2]) },
      mediaSummary: optional(args[5]),
      mediaSlots: optional(args[6]),
      mediaSchema: optional(args[7]),
      onboarding: optional(args[8]),
    };
    const { certification, checkpoint } = certifyPostState(receipt.step, evidence, {
      pre: receipt.preSnapshot,
      mode: receipt.preLedger.mode,
    });
    const actual = checkpoint.snapshot;
    receipt.postHealth = { foreignKeyCheck: '[]', quickCheck: 'ok' };
    receipt.postCertification = certification;
    receipt.post = {
      ledgerTip: receipt.postLedger.tip,
      recipeCount: actual.recipeCount,
      recipeIdSetHash: actual.idSetHash,
      identityHash: actual.identityHash,
      foreignKeyCheck: 'PASS',
      quickCheck: 'PASS',
      certification: 'PASS',
    };
    if (checkpoint.media !== 'NOT_APPLICABLE') receipt.recipeMedia = checkpoint.media;
    if (receipt.step.onboarding) {
      receipt.onboarding = checkpoint.onboarding;
      if (!args[9]) throw new Error('Repository D1 schema gate evidence is required for 0038');
      const gateRows = rows(readJson(args[9]), 'schema-gate');
      if (gateRows.length !== 0) throw new Error('Repository D1 schema gate found drift');
      receipt.schemaGate = 'PASS';
    }
    receipt.migration = {
      filename: receipt.step.file,
      sha256: receipt.prefix.included.find((entry) => entry.filename === receipt.step.file)?.sourceSha,
      prefixManifestSha256: receipt.prefix.sha256,
    };
    receipt.pre = {
      ledgerTip: receipt.preLedger.tip,
      recipeCount: receipt.preSnapshot.recipeCount,
      recipeIdSetHash: receipt.preSnapshot.recipeIdSetHash,
      certification: receipt.preState.status,
      foreignKeyCheck: 'PASS',
      quickCheck: 'PASS',
      bookmark: receipt.timeTravel.bookmark,
      capturedAt: receipt.timeTravel.capturedAt,
    };
    receipt.status = receipt.step.certification;
    receipt.production_d1_mutation = 'NO';
    receipt.staging_mutation = receipt.preLedger.mode === 'apply' ? 'YES' : 'NO';
  } else {
    throw new Error('Unknown staging catch-up check');
  }
  save(file, receipt);
  return receipt;
}

export function localReplayAndCertify({ sourceDir = path.resolve('migrations') } = {}) {
  const names = listMigrations(sourceDir);
  const workDir = mkdtempSync(path.join(tmpdir(), 'staging-catchup-replay-'));
  const db = new DatabaseSync(':memory:');
  const applied = [];
  const apply = (dir, name) => {
    db.exec(readFileSync(path.join(dir, name), 'utf8'));
    applied.push(name);
  };
  const results = [];
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of names.slice(0, names.indexOf(BASELINE_TIP) + 1)) apply(sourceDir, name);
    const baseline = certifyCheckpoint(BASELINE_TIP, collectCheckpointEvidence(db, BASELINE_TIP), { sourceDir });
    results.push({ tip: '0033', recipes: baseline.snapshot.recipeCount, preState: baseline.status, certified: baseline.status });
    for (const step of Object.values(CATCHUP_STEPS)) {
      const preState = certifyPreState(step, collectCheckpointEvidence(db, step.preTip), { sourceDir });
      if (step.collision) findCollisions(preState.snapshot, { ...incomingCatalog(step, { sourceDir }), label: step.file });
      const destDir = path.join(workDir, step.target, 'migrations');
      const prefix = buildMigrationPrefix({ target: step.target, sourceDir, destDir });
      verifyPrefixIntegrity(prefix, { sourceDir, destDir });
      const pending = prefix.included.map((entry) => entry.filename).filter((name) => !applied.includes(name));
      if (JSON.stringify(pending) !== JSON.stringify([step.file])) {
        throw new Error(`Local replay prefix for ${step.target} must leave exactly one pending migration`);
      }
      apply(destDir, step.file);
      const post = certifyPostState(step, collectCheckpointEvidence(db, step.file), {
        pre: preState.snapshot, mode: 'apply', sourceDir,
      });
      results.push({
        tip: step.target,
        recipes: post.checkpoint.snapshot.recipeCount,
        preState: preState.status,
        certified: post.certification,
      });
    }
  } finally {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file, ...args] = process.argv.slice(2);
  run(command, file, args).then((value) => {
    if (command === 'query') process.stdout.write(value);
    else console.log(`Staging D1 catch-up ${command}: ${value.status ?? 'PASS'}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
