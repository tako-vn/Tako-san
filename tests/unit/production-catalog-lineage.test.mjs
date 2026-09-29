import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { replayHistoricalIngredientSource, summarizeCatalogLineage } from '../../scripts/production-catalog-lineage.mjs';

const names = readdirSync('migrations').filter((name) => /^\d+.*\.sql$/.test(name)).sort();
const sha = 'a'.repeat(40);
const manifest = {
  sha, mainSha: sha, environment: 'production',
  cloudflare: { databaseName: 'frigo-db', databaseId: 'f975ec39-b2c8-4a2a-80e1-0366054599d3' },
  schema: { migrations: names.map((name) => ({ name, sha256: createHash('sha256').update(readFileSync(`migrations/${name}`)).digest('hex') })) },
};
const historical = replayHistoricalIngredientSource(manifest);
const ledger = [{ success: true, results: manifest.schema.migrations.slice(0, 38).map((entry) => ({ name: entry.name })) }];
const result = (results) => ({ success: true, results });
const expectedRows = historical.lines.map((line) => ({ ...line, position: historical.positions.get(line.id) }));
const recipes = historical.recipeIds.map((id) => ({ id, version: 1 }));
const runtime = [result(recipes), result(expectedRows), result([]), result([]), result([])];
const coverage = (ingredientRows, orderRows, missingRows, affectedRecipes, orphanRows = 0) =>
  [result([{ ingredient_rows: ingredientRows, order_rows: orderRows,
    ingredients_without_matching_order: missingRows, recipes_with_missing_order: affectedRecipes,
    orders_without_matching_ingredient: orphanRows }])];
const summarize = (overrides = {}) => summarizeCatalogLineage({
  manifest, before: ledger, after: ledger, runtime,
  orderCoverage: coverage(2702, 2702, 0, 0), historical,
  checkedAt: '2026-09-29T00:00:00.000Z', ...overrides,
});

describe('production catalog lineage read-only diagnosis', () => {
  it('replays and hashes the exact immutable 0038 recipe-line source', () => {
    expect(historical.recipeCount).toBe(500);
    expect(historical.lines).toHaveLength(2702);
    expect(historical.positions.size).toBe(2702);
    const tampered = structuredClone(manifest);
    tampered.schema.migrations[33].sha256 = '0'.repeat(64);
    expect(() => replayHistoricalIngredientSource(tampered)).toThrow(/hash drift/);
  });

  it('recognizes exact historical line content and positions but never certifies a release', () => {
    const receipt = summarize();
    expect(receipt.status).toBe('HISTORICAL_V1_INGREDIENT_LINES_AND_ORDER_MATCH');
    expect(receipt.certification).toBe('NOT_A_RELEASE_CERTIFICATION');
    expect(receipt.comparison).toMatchObject({ exactHistoricalLines: 2702, exactHistoricalPositions: 2702,
      changedHistoricalPositions: 0, historicalIdsWithContentDrift: 0, liveIdsNotInHistoricalSource: 0,
      historicalIdsAbsentFromLive: 0, recipesWithCompleteHistoricalLineSet: 500 });
    expect(receipt.positionAuthority).toBe('NONE_GRANTED_BY_THIS_DIAGNOSTIC');
    expect(receipt.researchV2LineageProven).toBe(false);
    expect(receipt.productionMutations).toEqual([]);
    expect(JSON.stringify(receipt)).not.toContain(historical.lines[0].id);
  });

  it('distinguishes changed content, absent old IDs, new IDs, and missing positions without guessing V2', () => {
    const changed = expectedRows.map((row) => ({ ...row, position: null }));
    changed[0].required_quantity += 1;
    changed.splice(1, 1);
    changed.push({ ...expectedRows[2], id: 'private-new-line', position: null });
    const receipt = summarize({
      runtime: [result(recipes.map((row) => ({ ...row, version: 2 }))), result(changed), result([]), result([]), result([])],
      orderCoverage: coverage(2702, 0, 2702, 500),
    });
    expect(receipt.status).toBe('CATALOG_LINEAGE_UNRESOLVED');
    expect(receipt.production.recipeVersions).toEqual({ v1: 0, v2: 500, other: 0 });
    expect(receipt.comparison).toMatchObject({ exactHistoricalLines: 2700, exactHistoricalPositions: 0,
      historicalIdsWithContentDrift: 1, liveIdsNotInHistoricalSource: 1, historicalIdsAbsentFromLive: 1 });
    expect(JSON.stringify(receipt)).not.toContain('private-new-line');
  });

  it('does not confuse matching line content with correct ingredient order', () => {
    const wrong = expectedRows.map((row) => ({ ...row }));
    wrong[0].position = 99;
    const receipt = summarize({ runtime: [result(recipes), result(wrong), result([]), result([]), result([])] });
    expect(receipt.status).toBe('CATALOG_LINEAGE_UNRESOLVED');
    expect(receipt.comparison).toMatchObject({ exactHistoricalLines: 2702, exactHistoricalPositions: 2701,
      changedHistoricalPositions: 1 });
  });

  it('handles the observed 6,720-line scale without promoting unmatched lines', () => {
    const extra = Array.from({ length: 4018 }, (_, index) => ({
      id: `private-new-${index}`, recipe_id: recipes[index % recipes.length].id,
      ingredient_id: 'UNKNOWN_SOURCE', name: 'Unreviewed source line', required_quantity: 1,
      unit: 'g', is_optional: 0, position: null,
    }));
    const rows = [...expectedRows.map((row) => ({ ...row, position: null })), ...extra];
    const receipt = summarize({ runtime: [result(recipes), result(rows), result([]), result([]), result([])],
      orderCoverage: coverage(6720, 0, 6720, 500) });
    expect(receipt.status).toBe('CATALOG_LINEAGE_UNRESOLVED');
    expect(receipt.comparison).toMatchObject({ exactHistoricalLines: 2702, liveIdsNotInHistoricalSource: 4018,
      recipesWithCompleteHistoricalLineSet: 0 });
    expect(JSON.stringify(receipt)).not.toContain('private-new-');
    expect(JSON.stringify(receipt)).not.toContain('Unreviewed source line');
  });

  it('reports recipe ID-set drift without asserting a source or order authority', () => {
    const changedRecipes = [{ id: 'private-other-recipe', version: 2 }, ...recipes.slice(1)];
    const changedLines = expectedRows.map((row) => row.recipe_id === recipes[0].id
      ? { ...row, recipe_id: 'private-other-recipe' } : row);
    const receipt = summarize({ runtime: [result(changedRecipes), result(changedLines), result([]), result([]), result([])] });
    expect(receipt.status).toBe('CATALOG_LINEAGE_UNRESOLVED');
    expect(receipt.comparison).toMatchObject({ liveRecipeIdsNotInHistoricalSource: 1,
      historicalRecipeIdsAbsentFromLive: 1 });
    expect(receipt.positionAuthority).toBe('NONE_GRANTED_BY_THIS_DIAGNOSTIC');
  });

  it('fails closed on a moving ledger, wrong D1, inconsistent order counts and malformed line IDs', () => {
    expect(() => summarize({ after: [result([])] })).toThrow(/ledger/);
    expect(() => summarize({ manifest: { ...manifest, cloudflare: { databaseName: 'frigo-db', databaseId: 'wrong' } } })).toThrow(/identity/);
    expect(() => summarize({ orderCoverage: coverage(2701, 2702, 0, 0) })).toThrow(/disagree/);
    const duplicate = [...expectedRows, expectedRows[0]];
    expect(() => summarize({ runtime: [result(recipes), result(duplicate), result([]), result([]), result([])] })).toThrow(/duplicate/);
  });
});
