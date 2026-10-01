#!/usr/bin/env node
// Runner-local receipt over two observed catalog reads; no D1 call or raw-row output.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const DB = { name: 'frigo-db', id: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' };
const REPOSITORY_ID = 1385308553;
const LEDGER_TIP = '0038_auth_onboarding_completion.sql';
const CANDIDATE_TIP = '0039_meal_composition_v2.sql';
const RELEASE_ID = 'rel-bd00a4f53fcaeee4';
const TARGET_MANIFEST_SHA256 = 'fa47d31f344736d338dc0ba50654e4604f793089fe97e44857e7dd5dd0134ac0';
const FIELD_COUNTS = [
  'exactTupleMatches', 'bridgedTupleMatches', 'unmatchedProductionLines',
  'unmatchedTargetLines', 'sameIdContentDrift', 'idConflictReviewRequired',
  'ambiguousBridgeCandidates', 'duplicateTupleOccurrences',
];
const SNAPSHOT_COUNTS = [
  'recipeRows', 'ingredientRows', 'malformedRecipeRows', 'malformedIngredientRows',
  'duplicatePhysicalLineIds', 'unknownParentLines', 'missingIngredientPositions',
  'invalidIngredientPositions',
];

function statementRows(value, label) {
  if (!Array.isArray(value) || value.length !== 5 || value.some((part) => part?.success !== true || !Array.isArray(part.results))) {
    throw new Error(`${label} five-statement capture is incomplete`);
  }
  return value.map((part) => part.results);
}

function ledgerNames(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0]?.success !== true || !Array.isArray(value[0].results)) {
    throw new Error('Migration ledger capture is incomplete');
  }
  const names = value[0].results.map((row) => row?.name);
  if (names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length) {
    throw new Error('Migration ledger entries are invalid');
  }
  return names;
}

function countsOf(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Aggregate counts are invalid');
  return Object.fromEntries(fields.map((field) => {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new Error('Aggregate count is invalid');
    return [field, value[field]];
  }));
}

export function buildT21RBProductionReceipt({
  manifest, before, first, repeat, coverage, after, afterRepeat, diagnostic,
  comparison, repositoryId, runId, runAttempt,
}) {
  if (Number(repositoryId) !== REPOSITORY_ID || !SHA.test(manifest?.sha || '')
      || manifest.mainSha !== manifest.sha || manifest.environment !== 'production'
      || manifest.cloudflare?.databaseName !== DB.name || manifest.cloudflare?.databaseId !== DB.id
      || !Array.isArray(manifest.schema?.migrations) || manifest.schema.migrations.length !== 39
      || manifest.schema.migrations[37]?.name !== LEDGER_TIP
      || manifest.schema.migrations[38]?.name !== CANDIDATE_TIP
      || !/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(runAttempt))) {
    throw new Error('Protected production identity or candidate proof is incomplete');
  }
  const expectedNames = manifest.schema.migrations.slice(0, 38).map((item) => item.name);
  if (expectedNames.some((name) => typeof name !== 'string' || !name)
      || [before, after, afterRepeat].some((value) => JSON.stringify(ledgerNames(value)) !== JSON.stringify(expectedNames))) {
    throw new Error('Production ledger changed or differs from the reviewed 0038 prefix');
  }
  const firstRows = statementRows(first, 'First');
  const repeatRows = statementRows(repeat, 'Repeat');
  const firstJson = firstRows.map((rows) => JSON.stringify(rows));
  const repeatJson = repeatRows.map((rows) => JSON.stringify(rows));
  if (firstJson.some((value, index) => value !== repeatJson[index])) {
    throw new Error('Repeated catalog read changed between observations');
  }
  if (!Array.isArray(coverage) || coverage.length !== 1 || coverage[0]?.success !== true
      || !Array.isArray(coverage[0].results) || coverage[0].results.length !== 1) {
    throw new Error('Order coverage proof is incomplete');
  }
  const orderCoverage = countsOf(coverage[0].results[0], [
    'ingredient_rows', 'order_rows', 'ingredients_without_matching_order',
    'recipes_with_missing_order', 'orders_without_matching_ingredient',
  ]);
  if (orderCoverage.ingredient_rows !== firstRows[1].length
      || orderCoverage.ingredients_without_matching_order > orderCoverage.ingredient_rows
      || orderCoverage.recipes_with_missing_order > orderCoverage.ingredient_rows
      || orderCoverage.orders_without_matching_ingredient > orderCoverage.order_rows) {
    throw new Error('Order coverage disagrees with captured rows');
  }
  if (diagnostic?.schemaVersion !== 2 || diagnostic.readOnly !== true
      || !Array.isArray(diagnostic.productionMutations) || diagnostic.productionMutations.length !== 0
      || diagnostic.certification !== 'NOT_A_RELEASE_CERTIFICATION'
      || diagnostic.candidateSha !== manifest.sha || diagnostic.database?.name !== DB.name
      || diagnostic.database?.id !== DB.id || diagnostic.ledger?.count !== 38
      || diagnostic.ledger?.tip !== LEDGER_TIP
      || diagnostic.runtimeCatalog?.physicalRows !== firstRows[0].length
      || Object.entries(orderCoverage).some(([key, value]) => diagnostic.orderCoverage?.[key] !== value)) {
    throw new Error('Protected diagnostic receipt does not bind to the capture');
  }
  if (comparison?.schemaVersion !== 1 || comparison.certification !== 'NOT_A_RELEASE_CERTIFICATION'
      || comparison.release?.releaseId !== RELEASE_ID || comparison.release?.targetRecipeCount !== 500
      || !Number.isSafeInteger(comparison.release?.targetIngredientLines)
      || comparison.release.targetIngredientLines <= 0
      || comparison.release?.fingerprintVerified !== true
      || comparison.snapshot?.recipeRows !== firstRows[0].length
      || comparison.snapshot?.ingredientRows !== firstRows[1].length
      || typeof comparison.snapshot?.recipeIdSetMatch !== 'boolean'
      || typeof comparison.semanticParity !== 'boolean'
      || typeof comparison.manualReviewRequired !== 'boolean'
      || comparison.runtimePositionAuthority !== false || comparison.repairAuthorized !== false
      || !['V1_INGREDIENT_SEMANTICS_MATCH', 'V1_INGREDIENT_SEMANTICS_UNRESOLVED'].includes(comparison.status)
      || comparison.targetManifestSha256 !== TARGET_MANIFEST_SHA256) {
    throw new Error('Offline V1 comparison proof is incomplete');
  }
  const snapshotCounts = countsOf(comparison.snapshot, SNAPSHOT_COUNTS);
  const comparisonCounts = countsOf(comparison.comparison, FIELD_COUNTS);
  if (comparisonCounts.exactTupleMatches + comparisonCounts.bridgedTupleMatches
      + comparisonCounts.unmatchedProductionLines !== firstRows[1].length
      || comparisonCounts.exactTupleMatches + comparisonCounts.bridgedTupleMatches
      + comparisonCounts.unmatchedTargetLines !== comparison.release.targetIngredientLines) {
    throw new Error('V1 comparison counts do not partition the captured rows');
  }
  const semanticParity = comparison.snapshot.recipeIdSetMatch
    && comparisonCounts.bridgedTupleMatches === 0
    && comparisonCounts.unmatchedProductionLines === 0
    && comparisonCounts.unmatchedTargetLines === 0;
  const manualReviewRequired = !semanticParity
    || snapshotCounts.missingIngredientPositions > 0
    || snapshotCounts.invalidIngredientPositions > 0
    || comparisonCounts.duplicateTupleOccurrences > 0
    || snapshotCounts.duplicatePhysicalLineIds > 0;
  if (comparison.semanticParity !== semanticParity
      || comparison.status !== (semanticParity ? 'V1_INGREDIENT_SEMANTICS_MATCH' : 'V1_INGREDIENT_SEMANTICS_UNRESOLVED')
      || comparison.manualReviewRequired !== manualReviewRequired) {
    throw new Error('V1 comparison status and review flags disagree with aggregate counts');
  }
  return {
    schemaVersion: 1,
    status: comparison.status,
    captureConsistency: 'OBSERVED_STABLE_NON_ATOMIC',
    certification: 'NOT_A_RELEASE_CERTIFICATION',
    readOnly: true,
    productionMutations: [],
    repositoryId: REPOSITORY_ID,
    candidateSha: manifest.sha,
    runId: String(runId),
    runAttempt: String(runAttempt),
    database: DB,
    ledger: { count: expectedNames.length, tip: LEDGER_TIP },
    release: {
      releaseId: RELEASE_ID,
      manifestSha256: comparison.targetManifestSha256,
      targetRecipeCount: comparison.release.targetRecipeCount,
      targetIngredientLines: comparison.release.targetIngredientLines,
      fingerprintVerified: true,
    },
    capture: {
      statementRowCounts: firstRows.map((rows) => rows.length),
      orderCoverage,
    },
    snapshot: { ...snapshotCounts, recipeIdSetMatch: comparison.snapshot.recipeIdSetMatch },
    comparison: comparisonCounts,
    ingredientSemanticParity: comparison.semanticParity,
    manualReviewRequired: comparison.manualReviewRequired,
    runtimePositionAuthority: false,
    repairAuthorized: false,
    t21gReadiness: 'T21G_NOT_READY',
  };
}

function main() {
  if (process.argv.length !== 11) throw new Error('Expected nine runner-local evidence paths');
  const [manifestPath, beforePath, firstPath, repeatPath, coveragePath, afterPath,
    afterRepeatPath, diagnosticPath, outputPath] = process.argv.slice(2);
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const firstBytes = readFileSync(firstPath, 'utf8');
  const comparison = JSON.parse(execFileSync(process.execPath, [
    'scripts/t21rb-v1-offline.mjs', '--input', firstPath,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 }));
  const receipt = buildT21RBProductionReceipt({
    manifest: readJson(manifestPath), before: readJson(beforePath),
    first: JSON.parse(firstBytes), repeat: readJson(repeatPath),
    coverage: readJson(coveragePath), after: readJson(afterPath),
    afterRepeat: readJson(afterRepeatPath), diagnostic: readJson(diagnosticPath),
    comparison, repositoryId: process.env.GITHUB_REPOSITORY_ID,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(`T21R-B V1 observed-stable comparison: ${receipt.status}; ingredient rows=${receipt.capture.statementRowCounts[1]}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch {
    console.error('T21R-B production receipt blocked before sanitized output');
    process.exitCode = 1;
  }
}
