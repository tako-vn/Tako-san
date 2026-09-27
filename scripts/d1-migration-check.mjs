import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { migrationManifest, requireSuccessfulCi } from './release-check.mjs';

// Production D1 identity is pinned; a mismatch aborts before any mutation.
export const PRODUCTION_D1 = { name: 'frigo-db', id: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' };
export const PRODUCTION_WRANGLER_CONFIG = 'wrangler.jsonc';
export const RUNTIME_CATALOG_READ_STATEMENT_COUNT = 5;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIGRATION_NAME = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;

// Aggregate-only baseline: counts, never rows.
export const BASELINE_TABLES = [
  'users',
  'households',
  'inventory_items',
  'inventory_lots',
  'inventory_events',
  'inventory_commands',
  'meal_plans',
  'cooked_meals',
  'scans',
  'recipes',
  'recipe_ingredients',
  'recipe_steps',
  'recipe_runtime_fields',
  'recipe_runtime_ingredient_order',
];
export const CATALOG_TABLES = [
  'recipes',
  'recipe_ingredients',
  'recipe_steps',
  'recipe_runtime_fields',
  'recipe_runtime_ingredient_order',
];
export const CATALOG_RELEASE_MANIFEST = 'packages/recipes/src/import/catalog-release.current.json';
export const APPROVED_BATCHES_REGISTRY = 'data/recipe-import/approved-batches.json';

function formatJsoncDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function jsoncPropertyName(property, sourceFile) {
  if (!property.name) return null;
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  return property.name.getText(sourceFile);
}

/** TypeScript parses JSONC, but deliberately accepts duplicate object keys. Reject them explicitly. */
function assertUniqueJsoncProperties(sourceFile) {
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set();
      for (const property of node.properties) {
        const name = jsoncPropertyName(property, sourceFile);
        if (name === null) continue;
        if (seen.has(name)) throw new Error(`Wrangler JSONC contains duplicate property ${name}`);
        seen.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Parse JSONC with syntax diagnostics and duplicate-key protection; comments/trailing commas remain valid. */
export function parseWranglerJsonc(text, fileName = PRODUCTION_WRANGLER_CONFIG) {
  if (typeof text !== 'string') throw new Error('Wrangler config source must be text');
  const sourceFile = ts.parseJsonText(fileName, text);
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error(
      `Unable to parse ${fileName} as JSONC: ${sourceFile.parseDiagnostics
        .map(formatJsoncDiagnostic)
        .join('; ')}`,
    );
  }
  assertUniqueJsoncProperties(sourceFile);
  const parsed = ts.parseConfigFileTextToJson(fileName, text);
  if (parsed.error) throw new Error(`Unable to parse ${fileName} as JSONC: ${formatJsoncDiagnostic(parsed.error)}`);
  if (!parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
    throw new Error(`${fileName} must contain a JSON object`);
  }
  return parsed.config;
}

/** Certifies the committed production Wrangler source before any remote D1 call is attempted. */
export function verifyProductionWranglerConfig({
  text,
  fileName = PRODUCTION_WRANGLER_CONFIG,
  expected = PRODUCTION_D1,
} = {}) {
  const config = parseWranglerJsonc(text, fileName);
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    throw new Error(
      `${fileName} must contain exactly one production D1 binding in d1_databases`,
    );
  }
  const binding = config.d1_databases[0];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error(`${fileName} production D1 binding must be an object`);
  }
  const expectedBinding = {
    binding: expected.binding ?? 'DB',
    database_name: expected.database_name ?? expected.name,
    database_id: expected.database_id ?? expected.id,
  };
  const mismatches = Object.entries(expectedBinding)
    .filter(([field, value]) => binding[field] !== value)
    .map(([field, value]) => `${field}=${JSON.stringify(binding[field])} (expected ${JSON.stringify(value)})`);
  if (mismatches.length > 0) {
    throw new Error(`${fileName} production D1 binding mismatch: ${mismatches.join(', ')}`);
  }
  return {
    configFile: fileName,
    bindingCount: config.d1_databases.length,
    binding: {
      binding: binding.binding,
      database_name: binding.database_name,
      database_id: binding.database_id,
    },
  };
}

export function verifyProductionWranglerConfigFile(fileName = PRODUCTION_WRANGLER_CONFIG, options = {}) {
  return verifyProductionWranglerConfig({
    ...options,
    fileName,
    text: readFileSync(fileName, 'utf8'),
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function baselineQuery() {
  const counts = BASELINE_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`);
  return `SELECT ${counts.join(', ')}, (SELECT COUNT(*) FROM recipes WHERE id LIKE 'vn-%') AS recipes_vn, (SELECT COUNT(*) FROM recipes WHERE id LIKE 'gl-%') AS recipes_global`;
}

// Catalog identity is global, non-customer data. Exact IDs/order and slug uniqueness are certified
// alongside aggregate completeness; recipe prose and household data are never selected.
export function catalogQuery() {
  const aggregate = [
    '(SELECT COUNT(*) FROM recipes) AS recipes',
    '(SELECT COUNT(*) - COUNT(DISTINCT id) FROM recipes) AS duplicate_recipe_ids',
    '(SELECT COUNT(*) - COUNT(DISTINCT slug) FROM recipes) AS duplicate_slugs',
    '(SELECT COUNT(*) FROM recipe_runtime_fields) AS runtime_fields',
    '(SELECT MIN(runtime_order) FROM recipe_runtime_fields) AS order_min',
    '(SELECT MAX(runtime_order) FROM recipe_runtime_fields) AS order_max',
    '(SELECT COUNT(DISTINCT runtime_order) FROM recipe_runtime_fields) AS order_distinct',
    '(SELECT COUNT(*) FROM recipes r WHERE NOT EXISTS (SELECT 1 FROM recipe_runtime_fields f WHERE f.recipe_id = r.id)) AS recipes_without_runtime_fields',
    '(SELECT COUNT(*) FROM recipes r WHERE NOT EXISTS (SELECT 1 FROM recipe_ingredients i WHERE i.recipe_id = r.id)) AS recipes_without_ingredients',
    '(SELECT COUNT(*) FROM recipes r WHERE NOT EXISTS (SELECT 1 FROM recipe_steps s WHERE s.recipe_id = r.id)) AS recipes_without_steps',
    '(SELECT COUNT(*) FROM recipe_ingredients i WHERE NOT EXISTS (SELECT 1 FROM recipe_runtime_ingredient_order o WHERE o.recipe_ingredient_id = i.id)) AS ingredients_without_order',
    "(SELECT COUNT(*) FROM recipe_media WHERE status = 'ready') AS media_ready",
    "(SELECT COUNT(*) FROM recipes r WHERE (SELECT COUNT(*) FROM recipe_media m WHERE m.recipe_id = r.id AND m.role = 'hero' AND m.status = 'pending') <> 1) AS recipes_without_pending_hero",
  ]
    .join(', ')
    .replace(/^/, 'SELECT ');
  const identities =
    'SELECT r.id, r.slug, f.runtime_order FROM recipe_runtime_fields f JOIN recipes r ON r.id = f.recipe_id ORDER BY f.runtime_order, r.id';
  return `${aggregate}; ${identities}`;
}

function approvedBatchSourceHeader(entry, cwd) {
  if (typeof entry.source !== 'string' || entry.source.length === 0) {
    throw new Error(`Approved batch ${entry.batchId ?? '<unknown>'} is missing its source path`);
  }
  const root = path.resolve(cwd);
  const sourcePath = path.resolve(root, entry.source);
  if (sourcePath !== root && !sourcePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Approved batch ${entry.batchId ?? '<unknown>'} source path escapes the repository`);
  }
  const lines = readFileSync(sourcePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 1) throw new Error(`Approved batch ${entry.batchId} source is empty`);
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw new Error(`Approved batch ${entry.batchId} source header is not valid JSON`);
  }
  const records = lines.length - 1;
  if (records !== entry.recipeCount) {
    throw new Error(
      `Approved batch ${entry.batchId} source has ${records} recipes, registry expects ${entry.recipeCount}`,
    );
  }
  return { header, records };
}

function approvedBatchMigrationMetadata(entry, cwd) {
  const migrationPath = path.resolve(cwd, 'migrations', entry.migration);
  const migration = readFileSync(migrationPath, 'utf8');
  const marker = migration.match(/batch_hash=([0-9a-f]{64})\s+recipes=(\d+)\s+/i);
  if (!marker) {
    throw new Error(`Approved batch ${entry.batchId} migration ${entry.migration} has no canonical batch hash marker`);
  }
  return { batchHash: marker[1], recipeCount: Number(marker[2]) };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Validate the release manifest against the committed registry and source/migration provenance.
 * `recipe:import:check` still recompiles every source; this check prevents a remote certification
 * from accepting a manifest whose identity metadata has simply been edited in place.
 */
export function verifyApprovedBatchRegistry(release, registry, { cwd = process.cwd() } = {}) {
  const batches = release?.approvedImportBatches;
  const registered = registry?.batches;
  if (!Array.isArray(batches) || !Array.isArray(registered)) {
    throw new Error('Approved batch release/registry metadata is missing');
  }
  if (batches.length !== registered.length) {
    throw new Error(
      `Approved batch ${batches[0]?.batchId ?? '<unknown>'} is not registered: release/registry batch counts differ`,
    );
  }
  const seenIds = new Set();
  const seenMigrations = new Set();
  const identities = [];
  let previousMigration = null;
  for (const [index, batch] of batches.entries()) {
    const entry = registered[index];
    if (!entry || entry.batchId !== batch.batchId) {
      throw new Error(`Approved batch ${batch.batchId ?? '<unknown>'} is not registered in release order`);
    }
    if (seenIds.has(batch.batchId)) throw new Error(`Approved batch ${batch.batchId} is registered more than once`);
    seenIds.add(batch.batchId);
    if (!MIGRATION_NAME.test(entry.migration || '')) {
      throw new Error(`Approved batch ${batch.batchId} is not registered with a canonical migration`);
    }
    if (seenMigrations.has(entry.migration) || (previousMigration !== null && entry.migration <= previousMigration)) {
      throw new Error(`Approved batch ${batch.batchId} migrations are not strictly ordered`);
    }
    seenMigrations.add(entry.migration);
    previousMigration = entry.migration;
    if (!Number.isInteger(entry.recipeCount) || entry.recipeCount < 0 || entry.recipeCount !== batch.recipeCount) {
      throw new Error(
        `Approved batch ${batch.batchId} is not registered with a canonical migration and matching recipe count`,
      );
    }
    if (!SHA256.test(batch.batchHash || '')) {
      throw new Error(`Approved batch ${batch.batchId} has an invalid batch hash`);
    }
    if (typeof batch.sourceNamespace !== 'string' || batch.sourceNamespace.length === 0 ||
        typeof batch.sourceReference !== 'string' || batch.sourceReference.length === 0) {
      throw new Error(`Approved batch ${batch.batchId} has incomplete source provenance`);
    }

    const source = approvedBatchSourceHeader(entry, cwd);
    if (source.header?.batchId !== batch.batchId) {
      throw new Error(`Approved batch ${batch.batchId} source header identity does not match the release`);
    }
    if (source.header?.source?.sourceNamespace !== batch.sourceNamespace ||
        source.header?.source?.sourceReference !== batch.sourceReference) {
      throw new Error(`Approved batch ${batch.batchId} source provenance does not match the release`);
    }
    const migration = approvedBatchMigrationMetadata(entry, cwd);
    if (migration.batchHash !== batch.batchHash || migration.recipeCount !== batch.recipeCount) {
      throw new Error(`Approved batch ${batch.batchId} migration identity does not match the release`);
    }
    identities.push({
      batchId: batch.batchId,
      batchHash: batch.batchHash,
      recipeCount: batch.recipeCount,
      releaseBaseCount: batch.releaseBaseCount,
      sourceNamespace: batch.sourceNamespace,
      sourceReference: batch.sourceReference,
      migration: entry.migration,
    });
  }
  const derivedReleaseId = `rel-${createHash('sha256')
    .update(
      canonicalJson({
        legacyBaselineFingerprint: release.legacyBaselineFingerprint,
        batches: identities.map((batch) => ({ batchId: batch.batchId, batchHash: batch.batchHash })),
      }),
    )
    .digest('hex')
    .slice(0, 16)}`;
  if (release.releaseId !== derivedReleaseId) {
    throw new Error(`Release manifest releaseId ${release.releaseId} does not match approved batch identity`);
  }
  return identities;
}

/**
 * The catalog the ledger tip promises. Each approved import batch names its migration, so the
 * expected recipe count after applying migration N is legacy + every batch whose migration is
 * <= N. Migrations before the first batch expect exactly the legacy baseline. The shipped
 * release manifest carries batch identity/count/base; the approved-batches registry names each
 * batch's promoted migration (`recipe:import:check` proves the two agree at the release SHA).
 */
export function expectedCatalogAtTip(release, tip, registry, options = {}) {
  if (!MIGRATION_NAME.test(tip || ''))
    throw new Error('Catalog expectation requires a canonical migration tip');
  const batches = release.approvedImportBatches ?? [];
  let releaseBase = release.legacyBaselineCount;
  for (const batch of batches) {
    if (batch.releaseBaseCount !== releaseBase) {
      throw new Error(
        `Approved batch ${batch.batchId} releaseBaseCount ${batch.releaseBaseCount} does not continue the release at ${releaseBase}`,
      );
    }
    releaseBase += batch.recipeCount;
  }
  const identities = verifyApprovedBatchRegistry(release, registry, options);
  let recipes = release.legacyBaselineCount;
  let applied = 0;
  for (const [index, batch] of batches.entries()) {
    const identity = identities[index];
    if (identity.migration > tip) break;
    if (batch.releaseBaseCount !== recipes)
      throw new Error(
        `Approved batch ${batch.batchId} releaseBaseCount ${batch.releaseBaseCount} does not continue the release at ${recipes}`,
      );
    recipes += batch.recipeCount;
    applied = index + 1;
  }
  const complete = applied === batches.length;
  if (complete && recipes !== release.expectedRecipeCount)
    throw new Error(
      `Release manifest expectedRecipeCount ${release.expectedRecipeCount} disagrees with legacy + batches ${recipes}`,
    );
  return {
    releaseId: release.releaseId,
    tip,
    recipes,
    appliedBatches: applied,
    totalBatches: batches.length,
    releaseComplete: complete,
    approvedBatches: identities,
    approvedBatchIds: identities.map((batch) => batch.batchId),
    approvedBatchHashes: identities.map((batch) => batch.batchHash),
  };
}

// Post-apply catalog certification: the database must hold exactly the catalog the tip promises.
export function verifyCatalogAtTip(release, tip, statements, registry) {
  const expected = expectedCatalogAtTip(release, tip, registry);
  if (
    !Array.isArray(statements) ||
    statements.length !== 2 ||
    statements.some((statement) => statement?.success !== true || !Array.isArray(statement.results))
  ) {
    throw new Error('Catalog certification query did not return two successful results');
  }
  const row = statements[0].results[0];
  const identities = statements[1].results;
  if (!row || typeof row !== 'object') throw new Error('Catalog aggregate result is missing');
  const problems = [];
  if (row.recipes !== expected.recipes)
    problems.push(`recipes ${row.recipes} != ${expected.recipes}`);
  if (row.runtime_fields !== expected.recipes)
    problems.push(`runtime_fields ${row.runtime_fields} != ${expected.recipes}`);
  if (row.duplicate_recipe_ids !== 0)
    problems.push(`duplicate_recipe_ids=${row.duplicate_recipe_ids}`);
  if (row.duplicate_slugs !== 0) problems.push(`duplicate_slugs=${row.duplicate_slugs}`);
  if (
    row.order_min !== 0 ||
    row.order_max !== expected.recipes - 1 ||
    row.order_distinct !== expected.recipes
  ) {
    problems.push(
      `runtime_order ${row.order_min}..${row.order_max} distinct ${row.order_distinct} != 0..${expected.recipes - 1} distinct ${expected.recipes}`,
    );
  }
  for (const key of [
    'recipes_without_runtime_fields',
    'recipes_without_ingredients',
    'recipes_without_steps',
    'ingredients_without_order',
    'recipes_without_pending_hero',
  ]) {
    if (row[key] !== 0) problems.push(`${key}=${row[key]}`);
  }
  // T15A pre-media-rollout condition: population is a separate task, so a catalog migration must
  // never mark media ready. Revisit this invariant before any migration that follows media rollout.
  if (row.media_ready !== 0) problems.push(`media_ready=${row.media_ready}`);

  const expectedIds = release.orderedRecipeIds?.slice(0, expected.recipes);
  if (
    !Array.isArray(expectedIds) ||
    expectedIds.length !== expected.recipes ||
    new Set(release.orderedRecipeIds ?? []).size !== release.expectedRecipeCount
  ) {
    throw new Error('Catalog release manifest orderedRecipeIds are invalid');
  }
  const actualIds = identities.map((identity) => identity?.id);
  const actualSlugs = identities.map((identity) => identity?.slug);
  if (identities.length !== expected.recipes)
    problems.push(`identity_rows ${identities.length} != ${expected.recipes}`);
  if (new Set(actualIds).size !== actualIds.length)
    problems.push('identity rows contain duplicate recipe IDs');
  if (new Set(actualSlugs).size !== actualSlugs.length)
    problems.push('identity rows contain duplicate recipe slugs');
  for (let index = 0; index < Math.max(expectedIds.length, identities.length); index += 1) {
    const identity = identities[index];
    if (identity?.runtime_order !== index) {
      problems.push(`runtime_order[${index}]=${identity?.runtime_order ?? 'missing'}`);
      break;
    }
    if (identity?.id !== expectedIds[index]) {
      problems.push(`ordered_recipe_id[${index}] does not match the release manifest`);
      break;
    }
    if (typeof identity?.slug !== 'string' || identity.slug.length === 0) {
      problems.push(`recipe_slug[${index}] is invalid`);
      break;
    }
  }
  if (problems.length)
    throw new Error(
      `Catalog at ${tip} does not match the release manifest: ${problems.join('; ')}`,
    );
  return {
    ...expected,
    actualRecipes: row.recipes,
    orderedRecipeIdsSha256: createHash('sha256').update(JSON.stringify(actualIds)).digest('hex'),
    expectedRuntimeFingerprint: expected.releaseComplete
      ? release.expectedRuntimeFingerprint
      : null,
    mediaReady: 0,
    checkedAt: new Date().toISOString(),
  };
}

/** Extract the five read-only SQL statements from the production content reader, without duplicating SQL. */
export function runtimeCatalogQueries(prepareRecipeContentRead) {
  if (typeof prepareRecipeContentRead !== 'function') {
    throw new Error('Runtime catalog query generator requires prepareRecipeContentRead');
  }
  const prepared = prepareRecipeContentRead({
    prepare(sql) {
      return { sql };
    },
  });
  if (!Array.isArray(prepared) || prepared.length !== RUNTIME_CATALOG_READ_STATEMENT_COUNT) {
    throw new Error(
      `Runtime catalog reader must generate exactly ${RUNTIME_CATALOG_READ_STATEMENT_COUNT} SELECT statements`,
    );
  }
  const queries = prepared.map((statement) => statement?.sql);
  if (queries.some((query) => typeof query !== 'string' || !/^\s*SELECT\b/i.test(query) || query.includes(';'))) {
    throw new Error('Runtime catalog reader generated a non-SELECT or compound statement');
  }
  return queries;
}

export function runtimeCatalogQuery(prepareRecipeContentRead) {
  return `${runtimeCatalogQueries(prepareRecipeContentRead).join(';\n')};\n`;
}

/**
 * Load the same DB reader, hydrator and fingerprint modules used by the Worker through Vite SSR.
 * The returned `close` hook keeps the CLI/test process from retaining a Vite server.
 */
export async function loadRuntimeCatalogPipeline({ cwd = process.cwd() } = {}) {
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
    const fingerprint = await vite.ssrLoadModule('/packages/recipes/src/catalog-fingerprint.ts');
    const queries = runtimeCatalogQueries(dbReader.prepareRecipeContentRead);
    return {
      queries,
      mapRecipeContentRead: dbReader.mapRecipeContentRead,
      hydrateRuntimeRecipes: hydration.hydrateRuntimeRecipes,
      fingerprintRecipes: fingerprint.fingerprintRecipes,
      close: () => vite.close(),
    };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

function runtimeCatalogStatements(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('Runtime catalog Wrangler JSON is not valid JSON');
    }
  }
  if (!Array.isArray(value) || value.length !== RUNTIME_CATALOG_READ_STATEMENT_COUNT) {
    throw new Error(
      `Runtime catalog Wrangler JSON must contain exactly ${RUNTIME_CATALOG_READ_STATEMENT_COUNT} statement results`,
    );
  }
  for (const [index, statement] of value.entries()) {
    if (statement?.success !== true || !Array.isArray(statement.results)) {
      throw new Error(`Runtime catalog statement ${index + 1} was not successful JSON output`);
    }
  }
  return value;
}

/**
 * Certify a read-only Wrangler five-statement result using the real content map → hydrator →
 * fingerprint pipeline. No D1 or Worker mutation occurs here; this is safe to run before deploy.
 */
export async function verifyRuntimeCatalogContent({
  release,
  registry,
  tip,
  statements,
  pipeline,
  cwd = process.cwd(),
} = {}) {
  const expected = expectedCatalogAtTip(release, tip, registry, { cwd });
  if (!expected.releaseComplete) {
    throw new Error(`Runtime catalog content certification requires the complete release at ${tip}`);
  }
  if (!pipeline || typeof pipeline.mapRecipeContentRead !== 'function' ||
      typeof pipeline.hydrateRuntimeRecipes !== 'function' ||
      typeof pipeline.fingerprintRecipes !== 'function') {
    throw new Error('Runtime catalog certification pipeline is incomplete');
  }
  const resultStatements = runtimeCatalogStatements(statements);
  let snapshot;
  try {
    snapshot = pipeline.mapRecipeContentRead(resultStatements);
  } catch (error) {
    throw new Error(
      `Runtime catalog content mapping failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let hydration;
  try {
    hydration = pipeline.hydrateRuntimeRecipes(snapshot);
  } catch (error) {
    throw new Error(
      `Runtime catalog hydration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const failures = Array.isArray(hydration?.failures) ? hydration.failures : [];
  if (failures.length > 0) {
    const sample = failures
      .slice(0, 5)
      .map((failure) => `${failure.id}:${failure.code}`)
      .join(', ');
    throw new Error(`Runtime catalog hydration failed (${failures.length} row(s)): ${sample}`);
  }
  const recipes = Array.isArray(hydration?.recipes) ? hydration.recipes : [];
  if (recipes.length !== expected.recipes) {
    throw new Error(`Runtime catalog recipe count ${recipes.length} != ${expected.recipes}`);
  }
  const expectedIds = release.orderedRecipeIds?.slice(0, expected.recipes);
  const actualIds = recipes.map((recipe) => recipe?.id);
  if (!Array.isArray(expectedIds) || expectedIds.length !== expected.recipes) {
    throw new Error('Catalog release manifest orderedRecipeIds are invalid');
  }
  const driftIndex = expectedIds.findIndex((id, index) => actualIds[index] !== id);
  if (driftIndex !== -1 || actualIds.length !== expectedIds.length) {
    throw new Error(
      `Runtime catalog IDs/order drift at [${driftIndex === -1 ? expectedIds.length : driftIndex}]`,
    );
  }
  let actualFingerprint;
  try {
    actualFingerprint = await pipeline.fingerprintRecipes(recipes);
  } catch (error) {
    throw new Error(
      `Runtime catalog fingerprint failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (actualFingerprint !== release.expectedRuntimeFingerprint) {
    throw new Error(
      `Runtime catalog content fingerprint drift: ${actualFingerprint} != ${release.expectedRuntimeFingerprint}`,
    );
  }
  return {
    ...expected,
    actualRecipes: recipes.length,
    hydrationFailureCount: 0,
    runtimeFingerprint: actualFingerprint,
    expectedRuntimeFingerprint: release.expectedRuntimeFingerprint,
    approvedBatchIds: expected.approvedBatchIds,
    approvedBatchHashes: expected.approvedBatchHashes,
    approvedBatches: expected.approvedBatches,
    contentReadStatementCount: RUNTIME_CATALOG_READ_STATEMENT_COUNT,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Candidate gate. `migration` must be the repository tip at `ref`; `expectedPreTip` must be an
 * earlier entry of that same manifest. The chain to apply is every manifest entry strictly after
 * `expectedPreTip` through `migration`, in order — each pinned by the hash recorded at `ref`.
 */
export function validateMigrationCandidate({
  ref,
  expectedPreTip,
  migration,
  cwd = process.cwd(),
}) {
  if (!SHA.test(ref || ''))
    throw new Error('Migration ref must be a full immutable SHA, never a branch or tag');
  if (!MIGRATION_NAME.test(migration || '') || !MIGRATION_NAME.test(expectedPreTip || '')) {
    throw new Error(
      'expected_pre_tip and migration must be canonical NNNN_name.sql migration file names',
    );
  }
  const sha = git(cwd, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  const mainSha = git(cwd, 'rev-parse', '--verify', 'refs/remotes/origin/main^{commit}');
  try {
    git(cwd, 'merge-base', '--is-ancestor', sha, mainSha);
  } catch {
    throw new Error('Migration candidate is not contained in main');
  }

  const schema = migrationManifest(cwd, sha);
  if (schema.version !== migration)
    throw new Error(
      `Repository migration tip at candidate is ${schema.version}, not ${migration}; unexpected later migration or wrong candidate`,
    );
  const preIndex = schema.migrations.findIndex((entry) => entry.name === expectedPreTip);
  if (preIndex === -1)
    throw new Error(
      `expected_pre_tip ${expectedPreTip} is not part of the candidate migration history`,
    );
  const chain = schema.migrations.slice(preIndex + 1).map((entry) => entry.name);
  if (chain.length === 0)
    throw new Error(
      `expected_pre_tip ${expectedPreTip} must precede ${migration}; nothing to apply`,
    );

  // Historical migrations must be byte-identical to the pinned fixture at the candidate.
  const pinned = JSON.parse(
    execFileSync('git', ['show', `${sha}:tests/fixtures/migration-sha256.json`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
  const pinnedEntries = Object.entries(pinned.migrations || {});
  if (pinnedEntries.length === 0) throw new Error('Pinned migration fixture is empty');
  for (const [name, sha256] of pinnedEntries) {
    const actual = schema.migrations.find((entry) => entry.name === name);
    if (!actual || actual.sha256 !== sha256)
      throw new Error(`Historical migration ${name} differs from its pinned hash`);
  }
  return {
    sha,
    mainSha,
    expectedPreTip,
    migration,
    chain,
    schema,
    pinnedCount: pinnedEntries.length,
  };
}

async function hostedCi(sha, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !process.env.GH_TOKEN) {
    throw new Error('Repository-scoped hosted CI read access is required');
  }
  const query = new URLSearchParams({
    event: 'push',
    branch: 'main',
    head_sha: sha,
    per_page: '100',
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
  if (!response.ok) throw new Error(`Hosted CI lookup failed (HTTP ${response.status})`);
  return requireSuccessfulCi((await response.json()).workflow_runs, { sha, repository });
}

function singleResult(statements, label) {
  if (
    !Array.isArray(statements) ||
    statements.length !== 1 ||
    statements[0]?.success !== true ||
    !Array.isArray(statements[0].results)
  ) {
    throw new Error(`${label} query did not return one successful result`);
  }
  return statements[0].results;
}

export function verifyCloudflareIdentity({ list, info, expected = PRODUCTION_D1 }) {
  if (!Array.isArray(list)) throw new Error('d1 list did not return a database array');
  const matches = list.filter((db) => db.name === expected.name);
  if (matches.length !== 1 || matches[0].uuid !== expected.id)
    throw new Error('Production D1 database name/id mismatch in d1 list');
  // d1 info additionally needs analytics scope; when available it must agree with d1 list.
  if (info !== null && (info?.name !== expected.name || info?.uuid !== expected.id))
    throw new Error('Production D1 database name/id mismatch in d1 info');
  return {
    accountAuthenticated: true,
    databaseName: expected.name,
    databaseId: expected.id,
    infoCrossCheck: info === null ? 'unavailable' : 'match',
  };
}

// Returns 'apply' when the ledger is exactly the candidate history through expected_pre_tip,
// 'certify' when it already equals the whole candidate history. Anything else is a stop.
export function classifyPreLedger(manifest, statements) {
  const names = singleResult(statements, 'Migration ledger')
    .map((row) => row.name)
    .sort();
  const all = manifest.schema.migrations.map((m) => m.name).sort();
  const chain = new Set(manifest.chain ?? [all.at(-1)]);
  const before = all.filter((name) => !chain.has(name));
  if (JSON.stringify(names) === JSON.stringify(before)) {
    return { mode: 'apply', count: names.length, tip: names.at(-1), names, chain: [...chain] };
  }
  if (JSON.stringify(names) === JSON.stringify(all)) {
    return { mode: 'certify', count: names.length, tip: names.at(-1), names, chain: [] };
  }
  throw new Error(
    'Migration ledger is neither at the expected pre-tip nor exactly at the candidate migration; stop and reconcile',
  );
}

export function verifyPostLedger(manifest, statements) {
  const names = singleResult(statements, 'Migration ledger')
    .map((row) => row.name)
    .sort();
  const all = manifest.schema.migrations.map((m) => m.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(all))
    throw new Error('Post-migration ledger differs from the candidate manifest');
  return { count: names.length, tip: names.at(-1) };
}

// Wrangler prints unapplied migrations as a table; only file names matter. The plan must be the
// exact pinned chain, in order — never a subset, superset or reordering.
export function verifyMigrationPlan(planOutput, { migration, chain = [migration], mode }) {
  const planned = [...new Set(planOutput.match(/\d{4}_[A-Za-z0-9_-]+\.sql/g) || [])];
  if (mode === 'certify') {
    if (planned.length !== 0 || !/No migrations to apply/.test(planOutput))
      throw new Error('Certification-only mode expected an empty migration plan');
    return { planned };
  }
  if (JSON.stringify(planned) !== JSON.stringify(chain))
    throw new Error(
      `Migration plan must contain exactly [${chain.join(', ')}]; got [${planned.join(', ')}]`,
    );
  return { planned };
}

// Every aggregate must be preserved, except the catalog tables when the applied chain contains a
// registered catalog-growth migration; the `catalog` step then pins their exact post-apply shape.
// Legacy id prefixes (vn-/gl-) are never allowed to change.
export function verifyBaselinePreserved(pre, post, { catalogGrowth = false } = {}) {
  const preRow = singleResult(pre, 'Pre-migration baseline')[0];
  const postRow = singleResult(post, 'Post-migration baseline')[0];
  const changed = Object.keys(preRow).filter((key) => preRow[key] !== postRow[key]);
  const drift = changed.filter((key) => !(catalogGrowth && CATALOG_TABLES.includes(key)));
  if (drift.length > 0) throw new Error(`Aggregate drift detected in ${drift.join(', ')}`);
  return { pre: preRow, post: postRow, drift: 'none', catalogGrowth: changed };
}

export function verifyHealth({ foreignKeys, quickCheck }) {
  const fk = singleResult(foreignKeys, 'PRAGMA foreign_key_check');
  if (fk.length !== 0) throw new Error(`foreign_key_check reported ${fk.length} violation(s)`);
  const qc = singleResult(quickCheck, 'PRAGMA quick_check');
  if (qc.length !== 1 || Object.values(qc[0])[0] !== 'ok')
    throw new Error('quick_check did not return ok');
  return { foreignKeyCheck: '[]', quickCheck: 'ok' };
}

// 0035 seeds exactly one pending hero v1 slot per recipe and nothing ready.
export function verifyRecipeMediaSeed({ summary, slots, schema, recipes }) {
  const row = singleResult(summary, 'recipe_media summary')[0];
  const counts = {
    rows: row.total,
    hero: row.hero,
    thumbnail: row.thumbnail,
    pending: row.pending,
    ready: row.ready,
    rejected: row.rejected,
    superseded: row.superseded,
  };
  const missing = singleResult(slots, 'recipe_media per-recipe slots')[0]
    .recipes_without_exact_hero_v1_pending;
  if (
    counts.rows !== recipes ||
    counts.hero !== recipes ||
    counts.pending !== recipes ||
    counts.thumbnail !== 0 ||
    counts.ready !== 0 ||
    counts.rejected !== 0 ||
    counts.superseded !== 0 ||
    missing !== 0
  ) {
    throw new Error(
      `recipe_media seed mismatch: ${JSON.stringify({ ...counts, recipes, missing })}`,
    );
  }
  const objects = singleResult(schema, 'recipe_media schema');
  const names = new Set(objects.map((o) => o.name));
  for (const required of [
    'idx_recipe_media_current_ready',
    'idx_recipe_media_recipe_role_status',
    'idx_recipe_media_content_hash',
    'trg_recipe_media_ready_immutable_update',
  ]) {
    if (!names.has(required)) throw new Error(`recipe_media schema object ${required} is missing`);
  }
  const table = objects.find((o) => o.type === 'table' && o.name === 'recipe_media')?.sql || '';
  for (const fragment of [
    'REFERENCES recipes(id)',
    "role IN ('hero', 'thumbnail')",
    "status IN ('pending', 'ready', 'rejected', 'superseded')",
    'version >= 1',
    'UNIQUE (recipe_id, role, version)',
    "'recipes/' || recipe_id || '/' || role || '/v' || version",
  ]) {
    if (!table.includes(fragment))
      throw new Error(`recipe_media table is missing contract fragment: ${fragment}`);
  }
  return {
    ...counts,
    perRecipeHeroV1Pending: 'exact',
    schemaObjects: [...names].sort(),
    storageKeyContract: 'exact',
  };
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

async function main() {
  const [command, suppliedFile, ...args] = process.argv.slice(2);
  const file = suppliedFile || 'migration-manifest.json';
  if (command === 'config') {
    const verified = verifyProductionWranglerConfigFile(
      suppliedFile || PRODUCTION_WRANGLER_CONFIG,
    );
    console.log(
      `Production Wrangler config verified: ${verified.binding.binding} -> ${verified.binding.database_name} (${verified.binding.database_id})`,
    );
    return;
  }
  if (command === 'runtime-catalog-query') {
    const pipeline = await loadRuntimeCatalogPipeline();
    try {
      process.stdout.write(`${pipeline.queries.join(';\n')};\n`);
    } finally {
      await pipeline.close();
    }
    return;
  }
  if (command === 'gate') {
    const candidate = validateMigrationCandidate({
      ref: process.env.MIGRATION_REF,
      expectedPreTip: process.env.EXPECTED_PRE_TIP,
      migration: process.env.MIGRATION,
    });
    const repository = process.env.GITHUB_REPOSITORY;
    const ci = await hostedCi(candidate.sha, repository);
    const manifest = {
      repository,
      database: PRODUCTION_D1,
      ...candidate,
      ci,
      gatedAt: new Date().toISOString(),
    };
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(process.env.GITHUB_OUTPUT, `candidate_sha=${candidate.sha}\n`, { flag: 'a' });
    console.log(
      `Migration candidate ${candidate.sha}: ${candidate.expectedPreTip} -> [${candidate.chain.join(', ')}] (${candidate.schema.count} migrations, ${candidate.pinnedCount} pinned hashes verified)`,
    );
    return;
  }
  const manifest = readJson(file);
  if (command === 'identity') {
    manifest.cloudflare = verifyCloudflareIdentity({
      list: readJson(args[0]),
      info: args[1] ? readJson(args[1]) : null,
    });
  } else if (command === 'pre-ledger') {
    manifest.preLedger = classifyPreLedger(manifest, readJson(args[0]));
    if (process.env.GITHUB_OUTPUT)
      writeFileSync(process.env.GITHUB_OUTPUT, `mode=${manifest.preLedger.mode}\n`, { flag: 'a' });
    console.log(
      `Pre-ledger: count=${manifest.preLedger.count} tip=${manifest.preLedger.tip} mode=${manifest.preLedger.mode}`,
    );
  } else if (command === 'bookmark') {
    const bookmark = readJson(args[0]);
    if (typeof bookmark?.bookmark !== 'string' || bookmark.bookmark.length === 0)
      throw new Error('Time Travel bookmark was not returned');
    manifest.timeTravel = { bookmark: bookmark.bookmark, capturedAt: new Date().toISOString() };
  } else if (command === 'baseline') {
    manifest.preBaseline = singleResult(readJson(args[0]), 'Pre-migration baseline')[0];
  } else if (command === 'plan') {
    manifest.plan = verifyMigrationPlan(readFileSync(args[0], 'utf8'), {
      migration: manifest.migration,
      chain: manifest.chain,
      mode: manifest.preLedger.mode,
    });
  } else if (command === 'applied') {
    manifest.applied = {
      at: new Date().toISOString(),
      mode: manifest.preLedger.mode,
      chain: manifest.preLedger.chain,
    };
  } else if (command === 'post-ledger') {
    manifest.postLedger = verifyPostLedger(manifest, readJson(args[0]));
  } else if (command === 'verify') {
    const [postBaseline, foreignKeys, quickCheck, mediaSummary, mediaSlots, mediaSchema] =
      args.map(readJson);
    const registry = JSON.parse(readFileSync(APPROVED_BATCHES_REGISTRY, 'utf8'));
    const growthMigrations = new Set(registry.batches.map((batch) => batch.migration));
    const catalogGrowth = (manifest.preLedger.chain ?? []).some((name) =>
      growthMigrations.has(name),
    );
    const preserved = verifyBaselinePreserved(
      [{ success: true, results: [manifest.preBaseline] }],
      postBaseline,
      { catalogGrowth },
    );
    manifest.postBaseline = preserved.post;
    manifest.aggregateDrift = preserved.drift;
    manifest.catalogGrowthTables = preserved.catalogGrowth;
    manifest.health = verifyHealth({ foreignKeys, quickCheck });
    // recipe_media exists from 0035 on; every recipe (legacy or imported) owns exactly one pending hero slot.
    if (manifest.postLedger.tip >= '0035_recipe_media_layer.sql') {
      manifest.recipeMedia = verifyRecipeMediaSeed({
        summary: mediaSummary,
        slots: mediaSlots,
        schema: mediaSchema,
        recipes: manifest.postBaseline.recipes,
      });
    }
  } else if (command === 'catalog') {
    const release = JSON.parse(readFileSync(CATALOG_RELEASE_MANIFEST, 'utf8'));
    const registry = JSON.parse(readFileSync(APPROVED_BATCHES_REGISTRY, 'utf8'));
    manifest.catalog = verifyCatalogAtTip(
      release,
      manifest.postLedger.tip,
      readJson(args[0]),
      registry,
    );
    console.log(
      `Catalog at ${manifest.catalog.tip}: recipes=${manifest.catalog.actualRecipes} batches=${manifest.catalog.appliedBatches}/${manifest.catalog.totalBatches} release=${manifest.catalog.releaseId}`,
    );
  } else if (command === 'runtime-catalog') {
    if (!args[0]) throw new Error('Runtime catalog certification requires Wrangler JSON statement output');
    const tip = manifest.observedMigrationLedger?.version || manifest.postLedger?.tip || manifest.schema?.version;
    if (!tip) throw new Error('Runtime catalog certification requires a certified migration ledger tip');
    const release = readJson(CATALOG_RELEASE_MANIFEST);
    const registry = readJson(APPROVED_BATCHES_REGISTRY);
    const pipeline = await loadRuntimeCatalogPipeline();
    try {
      manifest.runtimeCatalog = await verifyRuntimeCatalogContent({
        release,
        registry,
        tip,
        statements: readJson(args[0]),
        pipeline,
      });
    } finally {
      await pipeline.close();
    }
    console.log(
      `Runtime catalog at ${tip}: recipes=${manifest.runtimeCatalog.actualRecipes} fingerprint=${manifest.runtimeCatalog.runtimeFingerprint} batches=${manifest.runtimeCatalog.appliedBatches}/${manifest.runtimeCatalog.totalBatches}`,
    );
  } else if (command === 'release-certify') {
    const tip = manifest.observedMigrationLedger?.version;
    if (!tip || tip !== manifest.schema?.version)
      throw new Error('Release migration ledger tip is not certified');
    const release = JSON.parse(readFileSync(CATALOG_RELEASE_MANIFEST, 'utf8'));
    const registry = JSON.parse(readFileSync(APPROVED_BATCHES_REGISTRY, 'utf8'));
    manifest.catalog = verifyCatalogAtTip(release, tip, readJson(args[0]), registry);
    if (
      !manifest.catalog.releaseComplete ||
      manifest.catalog.expectedRuntimeFingerprint !== release.expectedRuntimeFingerprint
    ) {
      throw new Error('Release D1 catalog is not the complete runtime release');
    }
    manifest.health = verifyHealth({
      foreignKeys: readJson(args[1]),
      quickCheck: readJson(args[2]),
    });
    console.log(
      `Release D1 certified at ${tip}: recipes=${manifest.catalog.actualRecipes} release=${manifest.catalog.releaseId} quick_check=${manifest.health.quickCheck}`,
    );
  } else if (command === 'schema-gate') {
    manifest.schemaGate = { result: 'PASS', checkedAt: new Date().toISOString() };
  } else {
    throw new Error(
      'Usage: d1-migration-check.mjs <config|runtime-catalog-query|gate|identity|pre-ledger|bookmark|baseline|plan|applied|post-ledger|verify|catalog|runtime-catalog|release-certify|schema-gate> [manifest.json] [evidence...]',
    );
  }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Migration check failed');
    process.exitCode = 1;
  });
}
