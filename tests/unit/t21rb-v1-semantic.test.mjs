import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_RECIPES } from '../../packages/recipes/src/data';
import { composeCatalogRelease } from '../../packages/recipes/src/import/release-manifest';
import { approvedBatchesFromRegistry } from '../helpers/recipe-catalog-growth';
import { compareV1IngredientSemantics } from '../../scripts/t21rb-v1-semantic.mjs';

const committed = JSON.parse(readFileSync('packages/recipes/src/import/catalog-release.current.json', 'utf8'));
let targetRecipes;

beforeAll(async () => {
  const composed = await composeCatalogRelease(ALL_RECIPES, await approvedBatchesFromRegistry());
  expect(composed.manifest).toEqual(committed);
  targetRecipes = composed.recipes;
});

function runtimeResults() {
  const recipes = targetRecipes.map((recipe) => ({ id: recipe.id }));
  let id = 0;
  const lines = targetRecipes.flatMap((recipe) => recipe.ingredients.map((line) => ({
    id: `line-${++id}`, recipe_id: recipe.id, ingredient_id: line.ingredientId,
    name: line.name, required_quantity: line.requiredQuantity, unit: line.unit,
    is_optional: line.isOptional === true ? 1 : 0, position: null,
  })));
  return [recipes, lines, [], [], []].map((results) => ({ success: true, results }));
}

function compare(snapshot, reconciliation = []) {
  return compareV1IngredientSemantics({
    targetRecipes, runtimeResults: snapshot, releaseManifest: committed, reconciliation,
  });
}

function uniqueLine(snapshot) {
  const lines = snapshot[1].results;
  const counts = new Map();
  for (const line of lines) {
    const key = JSON.stringify([line.recipe_id, line.name, line.required_quantity, line.unit, line.is_optional]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return lines.find((line) => counts.get(JSON.stringify([
    line.recipe_id, line.name, line.required_quantity, line.unit, line.is_optional,
  ])) === 1);
}

describe('T21R-B certified V1 ingredient comparator', () => {
  it('counts exact semantic tuples without granting position authority or exposing content', () => {
    const snapshot = runtimeResults();
    const report = compare(snapshot);
    expect(report.release).toMatchObject({
      releaseId: committed.releaseId, targetRecipeCount: 500,
      targetIngredientLines: snapshot[1].results.length, fingerprintVerified: true,
    });
    expect(report.comparison).toMatchObject({
      exactTupleMatches: snapshot[1].results.length, bridgedTupleMatches: 0,
      unmatchedProductionLines: 0, unmatchedTargetLines: 0,
    });
    expect(report.semanticParity).toBe(true);
    expect(report.manualReviewRequired).toBe(true);
    expect(report.snapshot.missingIngredientPositions).toBe(snapshot[1].results.length);
    expect(report.runtimePositionAuthority).toBe(false);
    expect(report.repairAuthorized).toBe(false);
    expect(JSON.stringify(report)).not.toContain(snapshot[1].results[0].id);
    expect(JSON.stringify(report)).not.toContain(snapshot[1].results[0].name);
  });

  it('preserves duplicate multiplicity and does not infer physical row order', () => {
    const snapshot = runtimeResults();
    const extra = { ...snapshot[1].results[0], id: 'private-extra-line' };
    snapshot[1].results.push(extra);
    const report = compare(snapshot);
    expect(report.comparison.exactTupleMatches).toBe(report.release.targetIngredientLines);
    expect(report.comparison.unmatchedProductionLines).toBe(1);
    expect(report.comparison.duplicateTupleOccurrences).toBeGreaterThanOrEqual(2);
    expect(report.semanticParity).toBe(false);
    expect(report.runtimePositionAuthority).toBe(false);
    expect(JSON.stringify(report)).not.toContain(extra.id);
  });

  it('accepts a unique reviewed cross-ID bridge as evidence but not exact V1 parity', () => {
    const snapshot = runtimeResults();
    const line = uniqueLine(snapshot);
    expect(line).toBeDefined();
    const canonicalId = line.ingredient_id;
    line.ingredient_id = 'SOURCE_PRIVATE_ID';
    const report = compare(snapshot, [{
      sourceId: 'SOURCE_PRIVATE_ID', canonicalId, resolution: 'existing_canonical_id', review: null,
    }]);
    expect(report.comparison.bridgedTupleMatches).toBe(1);
    expect(report.comparison.unmatchedProductionLines).toBe(0);
    expect(report.comparison.unmatchedTargetLines).toBe(0);
    expect(report.semanticParity).toBe(false);
    expect(report.manualReviewRequired).toBe(true);
    expect(JSON.stringify(report)).not.toContain('SOURCE_PRIVATE_ID');
  });

  it('keeps unreviewed, conflicting and ambiguous cross-ID rows unresolved', () => {
    const snapshot = runtimeResults();
    const line = uniqueLine(snapshot);
    const canonicalId = line.ingredient_id;
    line.ingredient_id = 'SOURCE_PRIVATE_ID';
    const unreviewed = compare(snapshot, [{
      sourceId: 'SOURCE_PRIVATE_ID', canonicalId, resolution: 'provisional_new_canonical_id', review: null,
    }]);
    expect(unreviewed.comparison.idConflictReviewRequired).toBe(1);
    expect(unreviewed.comparison.bridgedTupleMatches).toBe(0);

    const ambiguous = compare(snapshot, [
      { sourceId: 'SOURCE_PRIVATE_ID', canonicalId, resolution: 'existing_canonical_id', review: null },
      { sourceId: 'SOURCE_PRIVATE_ID', canonicalId: 'OTHER_TARGET', resolution: 'existing_canonical_id', review: null },
    ]);
    expect(ambiguous.comparison.bridgedTupleMatches).toBe(0);
    expect(ambiguous.comparison.idConflictReviewRequired).toBe(1);
    expect(ambiguous.manualReviewRequired).toBe(true);
  });

  it('counts malformed optional/quantity and duplicate physical IDs without coercion', () => {
    const snapshot = runtimeResults();
    snapshot[1].results[0].is_optional = '0';
    snapshot[1].results[1].required_quantity = '1';
    snapshot[1].results[2].id = snapshot[1].results[3].id;
    const report = compare(snapshot);
    expect(report.snapshot.malformedIngredientRows).toBe(4);
    expect(report.snapshot.duplicatePhysicalLineIds).toBe(1);
    expect(report.comparison.unmatchedProductionLines).toBe(4);
    expect(report.comparison.unmatchedTargetLines).toBe(4);
    expect(report.semanticParity).toBe(false);
  });

  it('rejects boolean optional values in raw D1 rows', () => {
    for (const value of [true, false]) {
      const snapshot = runtimeResults();
      snapshot[1].results[0].is_optional = value;
      const report = compare(snapshot);
      expect(report.snapshot.malformedIngredientRows).toBe(1);
      expect(report.comparison.unmatchedProductionLines).toBe(1);
      expect(report.comparison.unmatchedTargetLines).toBe(1);
      expect(report.semanticParity).toBe(false);
    }
  });

  it('treats whitespace-only ingredient IDs and names as malformed', () => {
    for (const field of ['id', 'recipe_id', 'ingredient_id', 'name']) {
      const snapshot = runtimeResults();
      snapshot[1].results[0][field] = ' \t ';
      const report = compare(snapshot);
      expect(report.snapshot.malformedIngredientRows).toBe(1);
      expect(report.snapshot.unknownParentLines).toBe(0);
      expect(report.comparison.unmatchedProductionLines).toBe(1);
      expect(report.comparison.unmatchedTargetLines).toBe(1);
      expect(report.semanticParity).toBe(false);
    }
  });

  it('rejects failed or malformed trailing SELECT results before parity', () => {
    for (const index of [2, 3, 4]) {
      const failed = runtimeResults();
      failed[index].success = false;
      expect(() => compare(failed)).toThrow('Five-statement runtime snapshot is incomplete');

      const malformed = runtimeResults();
      malformed[index].results = null;
      expect(() => compare(malformed)).toThrow('Five-statement runtime snapshot is incomplete');
    }
  });

  it('rejects release drift and incomplete snapshots before classification', () => {
    const snapshot = runtimeResults();
    expect(() => compareV1IngredientSemantics({
      targetRecipes, runtimeResults: snapshot,
      releaseManifest: { ...committed, expectedRuntimeFingerprint: 'a'.repeat(64) },
    })).toThrow('Certified V1 release proof');
    const drifted = [...targetRecipes];
    drifted[0] = { ...drifted[0], title: 'Unreviewed content' };
    expect(() => compareV1IngredientSemantics({
      targetRecipes: drifted, runtimeResults: snapshot, releaseManifest: committed,
    })).toThrow('Certified V1 release proof');
    expect(() => compare(snapshot.slice(0, 4))).toThrow('Five-statement runtime snapshot');
  });
});

describe('T21R-B unresolved field and position diagnostics', () => {
  it('keeps same-ID quantity, name and optional changes outside exact V1 tuple parity', () => {
    const snapshot = runtimeResults();
    snapshot[1].results[0].required_quantity += 1;
    snapshot[1].results[1].name += ' unreviewed';
    snapshot[1].results[2].is_optional = snapshot[1].results[2].is_optional === 1 ? 0 : 1;
    const report = compare(snapshot);
    expect(report.comparison.sameIdContentDrift).toBe(3);
    expect(report.comparison.unmatchedProductionLines).toBe(3);
    expect(report.comparison.unmatchedTargetLines).toBe(3);
    expect(report.semanticParity).toBe(false);
    expect(report.manualReviewRequired).toBe(true);
    expect(JSON.stringify(report)).not.toContain('unreviewed');
  });

  it('counts invalid persisted positions without using them as matching evidence', () => {
    const snapshot = runtimeResults();
    snapshot[1].results[0].position = 1.5;
    snapshot[1].results[1].position = -1;
    const report = compare(snapshot);
    expect(report.snapshot.invalidIngredientPositions).toBe(2);
    expect(report.snapshot.missingIngredientPositions).toBe(snapshot[1].results.length - 2);
    expect(report.comparison.exactTupleMatches).toBe(report.release.targetIngredientLines);
    expect(report.semanticParity).toBe(true);
    expect(report.manualReviewRequired).toBe(true);
    expect(report.runtimePositionAuthority).toBe(false);
  });
});
