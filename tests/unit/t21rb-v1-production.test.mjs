import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildT21RBProductionReceipt } from '../../scripts/t21rb-v1-production.mjs';

const sha = 'a'.repeat(40);
const migrations = readdirSync('migrations').filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const manifest = {
  sha, mainSha: sha, environment: 'production',
  cloudflare: { databaseName: 'frigo-db', databaseId: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' },
  schema: { migrations: migrations.map((name) => ({ name })) },
};
const result = (results) => ({ success: true, results });
const ledger = [result(migrations.slice(0, 38).map((name) => ({ name })))];
const first = [
  result([{ id: 'private-recipe-id' }]),
  result([{ id: 'private-line-id', recipe_id: 'private-recipe-id', ingredient_id: 'PRIVATE_INGREDIENT',
    name: 'private name', required_quantity: 1, unit: 'g', is_optional: 0, position: null }]),
  result([]), result([]), result([]),
];
const coverage = [result([{
  ingredient_rows: 1, order_rows: 0, ingredients_without_matching_order: 1,
  recipes_with_missing_order: 1, orders_without_matching_ingredient: 0,
}])];
const diagnostic = {
  schemaVersion: 2, readOnly: true, productionMutations: [],
  certification: 'NOT_A_RELEASE_CERTIFICATION', candidateSha: sha,
  database: { name: 'frigo-db', id: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' },
  ledger: { count: 38, tip: '0038_auth_onboarding_completion.sql' },
  runtimeCatalog: { physicalRows: 1 }, orderCoverage: coverage[0].results[0],
};
const comparison = {
  schemaVersion: 1, certification: 'NOT_A_RELEASE_CERTIFICATION',
  targetManifestSha256: 'fa47d31f344736d338dc0ba50654e4604f793089fe97e44857e7dd5dd0134ac0', status: 'V1_INGREDIENT_SEMANTICS_MATCH',
  release: { releaseId: 'rel-bd00a4f53fcaeee4', targetRecipeCount: 500,
    targetIngredientLines: 1, fingerprintVerified: true },
  snapshot: {
    recipeRows: 1, ingredientRows: 1, malformedRecipeRows: 0, malformedIngredientRows: 0,
    duplicatePhysicalLineIds: 0, unknownParentLines: 0, missingIngredientPositions: 1,
    invalidIngredientPositions: 0, recipeIdSetMatch: true,
  },
  comparison: {
    exactTupleMatches: 1, bridgedTupleMatches: 0, unmatchedProductionLines: 0,
    unmatchedTargetLines: 0, sameIdContentDrift: 0, idConflictReviewRequired: 0,
    ambiguousBridgeCandidates: 0, duplicateTupleOccurrences: 0,
  },
  semanticParity: true, manualReviewRequired: true,
  runtimePositionAuthority: false, repairAuthorized: false,
};
const evidence = (overrides = {}) => ({
  manifest, before: ledger, first, repeat: structuredClone(first), coverage,
  after: ledger, afterRepeat: ledger, diagnostic, comparison,
  repositoryId: '1385308553', runId: '36706489599', runAttempt: '1', ...overrides,
});

describe('T21R-B protected V1 receipt', () => {
  it('emits only allowlisted aggregates after two matching observations', () => {
    const receipt = buildT21RBProductionReceipt(evidence());
    expect(receipt).toMatchObject({
      status: 'V1_INGREDIENT_SEMANTICS_MATCH',
      captureConsistency: 'OBSERVED_STABLE_NON_ATOMIC',
      certification: 'NOT_A_RELEASE_CERTIFICATION',
      repositoryId: 1385308553, candidateSha: sha, readOnly: true,
      productionMutations: [], runtimePositionAuthority: false, repairAuthorized: false,
      t21gReadiness: 'T21G_NOT_READY',
    });
    expect(receipt.capture.statementRowCounts).toEqual([1, 1, 0, 0, 0]);
    expect(receipt.capture.statementSha256).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toMatch(/private|PRIVATE_INGREDIENT/);
  });

  it('rejects a changing ingredient or trailing result without emitting a receipt', () => {
    const ingredientDrift = structuredClone(first);
    ingredientDrift[1].results[0].required_quantity = 2;
    expect(() => buildT21RBProductionReceipt(evidence({ repeat: ingredientDrift }))).toThrow(/changed/);
    const stepDrift = structuredClone(first);
    stepDrift[2].results.push({ instruction: 'private step' });
    expect(() => buildT21RBProductionReceipt(evidence({ repeat: stepDrift }))).toThrow(/changed/);
    const failed = structuredClone(first);
    failed[4].success = false;
    expect(() => buildT21RBProductionReceipt(evidence({ repeat: failed }))).toThrow(/incomplete/);
  });

  it('rejects wrong repository, D1, ledger, coverage and diagnostic identity', () => {
    expect(() => buildT21RBProductionReceipt(evidence({ repositoryId: 'other' }))).toThrow(/identity/);
    expect(() => buildT21RBProductionReceipt(evidence({ manifest: {
      ...manifest, cloudflare: { ...manifest.cloudflare, databaseId: 'wrong' },
    } }))).toThrow(/identity/);
    expect(() => buildT21RBProductionReceipt(evidence({ afterRepeat: [result([])] }))).toThrow(/ledger/);
    expect(() => buildT21RBProductionReceipt(evidence({ coverage: [result([{
      ...coverage[0].results[0], ingredient_rows: 2,
    }])] }))).toThrow(/coverage/);
    expect(() => buildT21RBProductionReceipt(evidence({ diagnostic: {
      ...diagnostic, candidateSha: 'c'.repeat(40),
    } }))).toThrow(/diagnostic/);
    expect(() => buildT21RBProductionReceipt(evidence({ diagnostic: {
      ...diagnostic, orderCoverage: { ...diagnostic.orderCoverage, order_rows: 1 },
    } }))).toThrow(/diagnostic/);
  });

  it('rejects a nonpartitioning or unsafe offline comparison', () => {
    const badCount = structuredClone(comparison);
    badCount.comparison.exactTupleMatches = 0;
    expect(() => buildT21RBProductionReceipt(evidence({ comparison: badCount }))).toThrow(/partition/);
    expect(() => buildT21RBProductionReceipt(evidence({ comparison: {
      ...comparison, targetManifestSha256: 'b'.repeat(64),
    } }))).toThrow(/proof/);
    const unsafe = { ...comparison, repairAuthorized: true };
    expect(() => buildT21RBProductionReceipt(evidence({ comparison: unsafe }))).toThrow(/proof/);
    const extraRaw = { ...comparison, rawRows: first[1].results };
    const receipt = buildT21RBProductionReceipt(evidence({ comparison: extraRaw }));
    expect(JSON.stringify(receipt)).not.toContain('private-line-id');
  });

  it('rejects contradictory comparison status and review flags', () => {
    expect(() => buildT21RBProductionReceipt(evidence({ comparison: {
      ...comparison, status: 'V1_INGREDIENT_SEMANTICS_UNRESOLVED',
    } }))).toThrow(/status/);
    expect(() => buildT21RBProductionReceipt(evidence({ comparison: {
      ...comparison, semanticParity: false,
    } }))).toThrow(/status/);
    expect(() => buildT21RBProductionReceipt(evidence({ comparison: {
      ...comparison, manualReviewRequired: false,
    } }))).toThrow(/status/);
  });
});
