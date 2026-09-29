import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const DB = { name: 'frigo-db', id: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' };
const HISTORICAL_TIP = '0038_auth_onboarding_completion.sql';
const CANDIDATE_TIP = '0039_meal_composition_v2.sql';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const LINE_FIELDS = ['id', 'recipe_id', 'ingredient_id', 'name', 'required_quantity', 'unit', 'is_optional'];

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function rows(statement, label) {
  if (statement?.success !== true || !Array.isArray(statement.results)) {
    throw new Error(`${label} proof is incomplete`);
  }
  return statement.results;
}

function lineTuple(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      ['id', 'recipe_id', 'ingredient_id', 'name', 'unit'].some((key) => typeof row[key] !== 'string' || !row[key]) ||
      !Number.isFinite(row.required_quantity) || row.required_quantity <= 0 ||
      ![0, 1].includes(row.is_optional)) {
    throw new Error('Ingredient line has an invalid comparison shape');
  }
  return LINE_FIELDS.map((key) => row[key]);
}

function indexedLines(lines, label) {
  const byId = new Map();
  for (const row of lines) {
    const tuple = lineTuple(row);
    if (byId.has(row.id)) throw new Error(`${label} has duplicate ingredient line IDs`);
    byId.set(row.id, { tuple, row });
  }
  return byId;
}

function countVersions(recipes) {
  const ids = new Set();
  const versions = { v1: 0, v2: 0, other: 0 };
  for (const recipe of recipes) {
    if (typeof recipe?.id !== 'string' || !recipe.id || ids.has(recipe.id)) {
      throw new Error('Recipe identity proof is invalid');
    }
    ids.add(recipe.id);
    if (recipe.version === 1) versions.v1++;
    else if (recipe.version === 2) versions.v2++;
    else versions.other++;
  }
  return { ids, versions };
}

export function replayHistoricalIngredientSource(manifest, { cwd = process.cwd() } = {}) {
  const migrations = manifest?.schema?.migrations;
  if (!Array.isArray(migrations) || migrations.length !== 39 || migrations[37]?.name !== HISTORICAL_TIP ||
      migrations[38]?.name !== CANDIDATE_TIP) {
    throw new Error('Historical migration source is not the reviewed 0038 prefix');
  }
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const [index, migration] of migrations.slice(0, 38).entries()) {
      if (!/^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(migration.name) ||
          Number(migration.name.slice(0, 4)) !== index + 1 || !HASH.test(migration.sha256)) {
        throw new Error('Historical migration sequence is invalid');
      }
      const sql = readFileSync(path.join(cwd, 'migrations', migration.name));
      if (createHash('sha256').update(sql).digest('hex') !== migration.sha256) {
        throw new Error('Historical migration source hash drift');
      }
      db.exec(sql.toString('utf8'));
    }
    const lines = db.prepare(`SELECT ${LINE_FIELDS.join(', ')} FROM recipe_ingredients ORDER BY id`).all();
    const orders = db.prepare('SELECT recipe_ingredient_id, recipe_id, position FROM recipe_runtime_ingredient_order ORDER BY recipe_ingredient_id').all();
    const recipeIds = db.prepare('SELECT id FROM recipes ORDER BY id').all().map((row) => row.id);
    if (recipeIds.length !== 500 || lines.length !== 2702 || orders.length !== lines.length ||
        db.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Historical 0038 replay is not the reviewed 500-recipe catalog');
    }
    const byId = indexedLines(lines, 'Historical source');
    const positions = new Map();
    for (const row of orders) {
      if (!byId.has(row.recipe_ingredient_id) || positions.has(row.recipe_ingredient_id) ||
          byId.get(row.recipe_ingredient_id).row.recipe_id !== row.recipe_id ||
          !Number.isInteger(row.position) || row.position < 0) {
        throw new Error('Historical ingredient position proof is invalid');
      }
      positions.set(row.recipe_ingredient_id, row.position);
    }
    const positionsByRecipe = new Map();
    for (const row of orders) {
      const positionsForRecipe = positionsByRecipe.get(row.recipe_id) ?? [];
      positionsForRecipe.push(row.position);
      positionsByRecipe.set(row.recipe_id, positionsForRecipe);
    }
    for (const values of positionsByRecipe.values()) {
      values.sort((a, b) => a - b);
      if (values.some((value, index) => value !== index)) {
        throw new Error('Historical ingredient positions are not contiguous');
      }
    }
    return { lines, positions, recipeIds, recipeCount: recipeIds.length, sourceDigest: digest(lines.map(lineTuple)) };
  } finally {
    db.close();
  }
}

export function summarizeCatalogLineage({ manifest, before, after, runtime, orderCoverage, historical, checkedAt = new Date().toISOString() }) {
  if (manifest?.environment !== 'production' || !SHA.test(manifest.sha || '') ||
      manifest.mainSha !== manifest.sha || manifest.cloudflare?.databaseName !== DB.name ||
      manifest.cloudflare?.databaseId !== DB.id || !historical || historical.recipeCount !== 500) {
    throw new Error('Exact-main production D1 identity or historical source proof is incomplete');
  }
  const pre = rows(before?.[0], 'Pre-ledger').map((row) => row?.name);
  const post = rows(after?.[0], 'Post-ledger').map((row) => row?.name);
  const expectedLedger = manifest.schema.migrations.slice(0, 38).map((entry) => entry.name);
  if (before.length !== 1 || after.length !== 1 || JSON.stringify(pre) !== JSON.stringify(expectedLedger) ||
      JSON.stringify(post) !== JSON.stringify(pre)) {
    throw new Error('Production ledger is not stable at exact historical 0038');
  }
  if (!Array.isArray(runtime) || runtime.length !== 5) throw new Error('Runtime catalog proof needs five SELECT results');
  const recipes = rows(runtime[0], 'Recipe');
  const actualLines = rows(runtime[1], 'Ingredient');
  for (const [index, statement] of runtime.entries()) rows(statement, `Runtime SELECT ${index + 1}`);
  const coverageRows = rows(orderCoverage?.[0], 'Order coverage');
  if (orderCoverage.length !== 1 || coverageRows.length !== 1) throw new Error('Order coverage proof is incomplete');
  const coverage = coverageRows[0];
  const { ids: recipeIds, versions } = countVersions(recipes);
  if (recipeIds.size !== 500) throw new Error('Production recipe identity count is not 500');
  const historicalRecipeIds = new Set(historical.recipeIds);
  if (historicalRecipeIds.size !== 500) throw new Error('Historical recipe identity proof is invalid');
  const liveOnlyRecipes = [...recipeIds].filter((id) => !historicalRecipeIds.has(id)).length;
  const absentHistoricalRecipes = [...historicalRecipeIds].filter((id) => !recipeIds.has(id)).length;
  const actual = indexedLines(actualLines, 'Production');
  const expected = indexedLines(historical.lines, 'Historical source');
  let exact = 0;
  let contentDrift = 0;
  let unmatchedLive = 0;
  let absentHistorical = 0;
  let matchingPosition = 0;
  let changedPosition = 0;
  const completeRecipes = new Set([...recipeIds].filter((id) => historicalRecipeIds.has(id)));
  for (const [id, line] of actual) {
    if (!recipeIds.has(line.row.recipe_id)) throw new Error('Ingredient line references an unknown recipe');
    const prior = expected.get(id);
    if (!prior) { unmatchedLive++; completeRecipes.delete(line.row.recipe_id); }
    else if (JSON.stringify(line.tuple) === JSON.stringify(prior.tuple)) {
      exact++;
      if (line.row.position === historical.positions.get(id)) matchingPosition++;
      else if (line.row.position !== null && line.row.position !== undefined) changedPosition++;
    }
    else { contentDrift++; completeRecipes.delete(line.row.recipe_id); completeRecipes.delete(prior.row.recipe_id); }
  }
  for (const [id, line] of expected) {
    if (!actual.has(id)) { absentHistorical++; completeRecipes.delete(line.row.recipe_id); }
  }
  const coverageKeys = ['ingredient_rows', 'order_rows', 'ingredients_without_matching_order',
    'recipes_with_missing_order', 'orders_without_matching_ingredient'];
  if (coverageKeys.some((key) => !Number.isSafeInteger(coverage[key]) || coverage[key] < 0) ||
      coverage.ingredient_rows !== actual.size || coverage.recipes_with_missing_order > recipeIds.size ||
      exact + contentDrift + unmatchedLive !== actual.size ||
      exact + contentDrift + absentHistorical !== expected.size) {
    throw new Error('Ingredient comparison counts disagree with the D1 aggregate');
  }
  const observedPositions = actualLines.filter((row) => row.position !== null && row.position !== undefined).length;
  if (observedPositions !== coverage.ingredient_rows - coverage.ingredients_without_matching_order ||
      coverage.order_rows - coverage.orders_without_matching_ingredient !== observedPositions) {
    throw new Error('Ingredient position join disagrees with the D1 aggregate');
  }
  const sortedActual = [...actual.values()].map(({ tuple }) => tuple).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return {
    schemaVersion: 1,
    status: exact === actual.size && absentHistorical === 0 && liveOnlyRecipes === 0 &&
      absentHistoricalRecipes === 0 && matchingPosition === actual.size &&
      coverage.ingredients_without_matching_order === 0 && coverage.orders_without_matching_ingredient === 0
      ? 'HISTORICAL_V1_INGREDIENT_LINES_AND_ORDER_MATCH' : 'CATALOG_LINEAGE_UNRESOLVED',
    certification: 'NOT_A_RELEASE_CERTIFICATION',
    readOnly: true,
    productionMutations: [],
    candidateSha: manifest.sha,
    checkedAt,
    database: DB,
    ledger: { count: pre.length, tip: pre.at(-1) },
    source: { kind: 'immutable_migrations_through_0038', recipeCount: historical.recipeCount,
      ingredientRows: expected.size, orderedRows: historical.positions.size, aggregateSha256: historical.sourceDigest },
    production: { recipeCount: recipeIds.size, recipeVersions: versions, ingredientRows: actual.size,
      orderRows: coverage.order_rows, missingOrderRows: coverage.ingredients_without_matching_order,
      affectedRecipes: coverage.recipes_with_missing_order, aggregateSha256: digest(sortedActual) },
    comparison: { liveRecipeIdsNotInHistoricalSource: liveOnlyRecipes,
      historicalRecipeIdsAbsentFromLive: absentHistoricalRecipes,
      exactHistoricalLines: exact, exactHistoricalPositions: matchingPosition,
      changedHistoricalPositions: changedPosition, historicalIdsWithContentDrift: contentDrift,
      liveIdsNotInHistoricalSource: unmatchedLive, historicalIdsAbsentFromLive: absentHistorical,
      recipesWithCompleteHistoricalLineSet: completeRecipes.size },
    researchV2LineageProven: false,
    positionAuthority: 'NONE_GRANTED_BY_THIS_DIAGNOSTIC',
  };
}

async function main() {
  const [manifestPath, beforePath, runtimePath, coveragePath, afterPath, receiptPath] = process.argv.slice(2);
  if (!receiptPath || process.argv.length !== 8) throw new Error('Expected manifest, pre-ledger, runtime, order coverage, post-ledger and receipt paths');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const historical = replayHistoricalIngredientSource(manifest);
  const receipt = summarizeCatalogLineage({
    manifest,
    before: JSON.parse(readFileSync(beforePath, 'utf8')),
    runtime: JSON.parse(readFileSync(runtimePath, 'utf8')),
    orderCoverage: JSON.parse(readFileSync(coveragePath, 'utf8')),
    after: JSON.parse(readFileSync(afterPath, 'utf8')),
    historical,
  });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`Production catalog lineage: ${receipt.status}; exact historical lines=${receipt.comparison.exactHistoricalLines}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Production catalog lineage failed before a complete sanitized receipt could be written');
    process.exitCode = 1;
  });
}
