import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_RECIPES } from '../../packages/recipes/src/data';
import { composeCatalogRelease } from '../../packages/recipes/src/import/release-manifest';
import { approvedBatchesFromRegistry } from '../helpers/recipe-catalog-growth';
import { CatalogTextSchema } from '../../packages/domain/src/foundation';
import {
  PRODUCTION_CLASSES,
  TARGET_CLASSES,
  reconcileIngredientOccurrences,
  serializeReconciliationManifest,
} from '../../scripts/t21rc-row-reconciliation.mjs';

const RECIPE_ID = 'recipe-a';
const INGREDIENT_ID = 'ING_ALPHA';
const committedRelease = JSON.parse(
  readFileSync('packages/recipes/src/import/catalog-release.current.json', 'utf8'),
);
let realTargetRecipes;

beforeAll(async () => {
  const composed = await composeCatalogRelease(ALL_RECIPES, await approvedBatchesFromRegistry());
  expect(composed.manifest).toEqual(committedRelease);
  realTargetRecipes = composed.recipes.map((recipe) => ({
    id: recipe.id,
    ingredients: recipe.ingredients.map((ingredient) => ({
      ingredientId: ingredient.ingredientId,
      name: ingredient.name,
      requiredQuantity: ingredient.requiredQuantity,
      unit: ingredient.unit,
      isOptional: ingredient.isOptional,
    })),
  }));
});

function targetIngredient(overrides = {}) {
  return {
    ingredientId: INGREDIENT_ID,
    name: 'Alpha ingredient',
    requiredQuantity: 2,
    unit: 'g',
    ...overrides,
  };
}

function productionRow(overrides = {}) {
  return {
    id: 'physical-row-1',
    recipe_id: RECIPE_ID,
    ingredient_id: INGREDIENT_ID,
    name: 'Alpha ingredient',
    required_quantity: 2,
    unit: 'g',
    is_optional: 0,
    ...overrides,
  };
}

function runFixture({
  targetRecipes = [{ id: RECIPE_ID, ingredients: [targetIngredient()] }],
  productionRows = [productionRow()],
  productionRecipeIds = [RECIPE_ID],
  canonicalIngredientIds = [],
  reconciliation = [],
  captureCounts,
} = {}) {
  return reconcileIngredientOccurrences({
    targetRecipes,
    productionRows,
    productionRecipeIds,
    canonicalIngredientIds,
    reconciliation,
    captureCounts:
      captureCounts === undefined
        ? {
            recipeCount: productionRecipeIds.length,
            ingredientOccurrenceCount: productionRows.length,
          }
        : captureCounts,
  });
}

function total(counts) {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function expectAccounting(result) {
  expect(result.summary.productionOccurrenceCount).toBe(result.production.length);
  expect(result.summary.targetOccurrenceCount).toBe(result.target.length);
  expect(result.summary.accounting).toEqual({
    productionClassSum: result.production.length,
    targetClassSum: result.target.length,
    productionAccounted: true,
    targetAccounted: true,
  });
  expect(total(result.summary.productionClassCounts)).toBe(result.production.length);
  expect(total(result.summary.targetClassCounts)).toBe(result.target.length);
  expect(total(result.summary.identityPopulations)).toBe(result.production.length);
  expect(total(result.summary.populations)).toBe(result.production.length);
  expect(total(result.summary.driftBreakdown)).toBe(
    result.production.filter((row) => row.driftKind !== null).length,
  );
  expect(new Set(result.production.map((row) => row.occurrenceKey)).size).toBe(
    result.production.length,
  );
  expect(new Set(result.target.map((row) => row.occurrenceKey)).size).toBe(result.target.length);
  for (const row of result.production) {
    expect(PRODUCTION_CLASSES).toContain(row.classification);
    expect(Array.isArray(row.authority)).toBe(true);
    if (row.classification !== 'AMBIGUOUS') expect(row.authority.length).toBeGreaterThan(0);
  }
  for (const row of result.target) {
    expect(TARGET_CLASSES).toContain(row.classification);
    expect(Array.isArray(row.authority)).toBe(true);
    if (row.classification !== 'AMBIGUOUS') expect(row.authority.length).toBeGreaterThan(0);
  }
}

describe('T21R-C offline occurrence reconciliation', () => {
  it('requires explicit count-consistent capture evidence before proving target absence', () => {
    const result = runFixture({ productionRows: [], captureCounts: null });
    expect(result.captureEvidence).toEqual({
      completeness: 'UNVERIFIED',
      recipeCount: null,
      ingredientOccurrenceCount: null,
    });
    expect(result.target[0]).toMatchObject({
      classification: 'AMBIGUOUS',
      reviewReason: 'CAPTURE_COMPLETENESS_UNVERIFIED',
    });
    expect(result.summary.targetClassCounts.TARGET_ONLY_MISSING).toBe(0);
    expectAccounting(result);
  });

  it('does not certify exact membership from an unverified partial occurrence list', () => {
    const result = runFixture({ captureCounts: null });
    expect(result.production[0]).toMatchObject({
      classification: 'AMBIGUOUS',
      reviewReason: 'CAPTURE_COMPLETENESS_UNVERIFIED',
      comparison: { quantity: true, membership: null },
    });
    expect(result.target[0].classification).toBe('AMBIGUOUS');
    expectAccounting(result);
  });

  it('stops when captured counts show truncated rows or recipe IDs', () => {
    expect(() =>
      runFixture({ captureCounts: { recipeCount: 1, ingredientOccurrenceCount: 2 } }),
    ).toThrow();
    expect(() =>
      runFixture({ captureCounts: { recipeCount: 2, ingredientOccurrenceCount: 1 } }),
    ).toThrow();
    expect(() =>
      runFixture({ captureCounts: { recipeCount: -1, ingredientOccurrenceCount: 1 } }),
    ).toThrow();
    expect(() =>
      runFixture({
        captureCounts: { recipeCount: 1, ingredientOccurrenceCount: 1, complete: true },
      }),
    ).toThrow();
  });

  it('separates count-consistent offline input from live capture certification', () => {
    const result = runFixture({ productionRows: [] });
    expect(result.captureEvidence).toEqual({
      completeness: 'COUNT_CONSISTENT_OFFLINE_INPUT',
      recipeCount: 1,
      ingredientOccurrenceCount: 0,
    });
    expect(result.target[0].classification).toBe('TARGET_ONLY_MISSING');
    expect(result.certification).toBe('NOT_A_RELEASE_CERTIFICATION');
    expectAccounting(result);
  });

  it('does not call a mixed-tuple same-ID target missing behind excess duplicates', () => {
    const result = runFixture({
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [targetIngredient(), targetIngredient({ requiredQuantity: 4 })],
        },
      ],
      productionRows: [productionRow({ id: 'duplicate-a' }), productionRow({ id: 'duplicate-b' })],
    });
    expect(result.production.map((row) => row.classification)).toEqual([
      'DUPLICATE_SEMANTIC_OCCURRENCE',
      'DUPLICATE_SEMANTIC_OCCURRENCE',
    ]);
    expect(result.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
    const targetKeys = result.target.map((row) => row.occurrenceKey).sort();
    for (const row of result.production) {
      expect(row.candidateTargetOccurrenceKeys).toEqual(targetKeys);
      expect(row.comparison).toMatchObject({ quantity: null, membership: false });
    }
    expectAccounting(result);
  });

  it('retains all same-ID target candidates when a mixed-tuple bag is deficient', () => {
    const result = runFixture({
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [targetIngredient(), targetIngredient({ requiredQuantity: 4 })],
        },
      ],
    });
    expect(result.production[0]).toMatchObject({
      classification: 'SAME_ID_CONTENT_DRIFT',
      driftKind: 'indeterminate',
      comparison: { quantity: null, membership: false },
    });
    expect(result.production[0].candidateTargetOccurrenceKeys).toHaveLength(2);
    expect(result.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
    expectAccounting(result);
  });

  it('keeps an alternate-ID content conflict visible alongside same-ID drift', () => {
    const result = runFixture({
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [
            targetIngredient({ requiredQuantity: 3 }),
            targetIngredient({ ingredientId: 'ING_BETA' }),
          ],
        },
      ],
    });
    expect(result.production[0]).toMatchObject({
      classification: 'SAME_ID_CONTENT_DRIFT',
      confidence: 'REVIEW_REQUIRED',
      mapping: 'UNRESOLVED',
      driftKind: 'indeterminate',
      reviewReason: 'ALTERNATE_IDENTITY_CONTENT_CONFLICT',
      comparison: { ingredientId: null, quantity: null, membership: null },
    });
    expect(result.production[0].candidateTargetOccurrenceKeys).toHaveLength(2);
    expect(result.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
    expect(result.summary.idConflictOccurrenceKeys).toEqual([result.production[0].occurrenceKey]);
    expectAccounting(result);
  });

  it('does not hide an alternate-ID target behind same-ID duplicate evidence', () => {
    const result = runFixture({
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [
            targetIngredient(),
            targetIngredient({ requiredQuantity: 4 }),
            targetIngredient({ ingredientId: 'ING_BETA' }),
          ],
        },
      ],
      productionRows: [productionRow({ id: 'duplicate-a' }), productionRow({ id: 'duplicate-b' })],
    });
    for (const row of result.production) {
      expect(row.classification).toBe('DUPLICATE_SEMANTIC_OCCURRENCE');
      expect(row.reviewReason).toBe('ALTERNATE_IDENTITY_CONTENT_CONFLICT');
      expect(row.candidateTargetOccurrenceKeys).toHaveLength(3);
    }
    expect(result.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
    expectAccounting(result);
  });

  it('does not override satisfied exact identity with an unapproved cross-ID lookalike', () => {
    const result = runFixture({
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [targetIngredient(), targetIngredient({ ingredientId: 'ING_BETA' })],
        },
      ],
    });
    expect(result.production[0].classification).toBe('EXACT_V1_MATCH');
    expect(
      result.target.find((row) => row.targetIngredientId === INGREDIENT_ID).classification,
    ).toBe('SATISFIED_EXACT');
    expect(result.target.find((row) => row.targetIngredientId === 'ING_BETA').classification).toBe(
      'TARGET_ONLY_MISSING',
    );
    expect(result.summary.idConflictOccurrenceKeys).toEqual([]);
    expectAccounting(result);
  });

  it('validates trim-based text bounds without normalizing released semantic spelling', () => {
    const paddedName = `${' '.repeat(350)}Alpha ingredient${' '.repeat(350)}`;
    expect(CatalogTextSchema.safeParse(paddedName).success).toBe(true);
    const result = runFixture({ productionRows: [productionRow({ name: paddedName })] });
    expect(result.production[0]).toMatchObject({
      classification: 'SAME_ID_CONTENT_DRIFT',
      driftKind: 'name_only',
      comparison: { name: false },
    });
    expect(result.summary.productionClassCounts.MALFORMED_OCCURRENCE).toBe(0);
    expectAccounting(result);
  });

  it('classifies a unique exact occurrence with explicit semantic evidence', () => {
    const result = runFixture();
    const [production] = result.production;
    const [target] = result.target;

    expect(production).toMatchObject({
      classification: 'EXACT_V1_MATCH',
      confidence: 'DETERMINISTIC',
      mapping: 'UNIQUE',
      targetIngredientId: INGREDIENT_ID,
      reviewReason: null,
      comparison: {
        recipe: true,
        ingredientId: true,
        canonicalIdentity: true,
        name: true,
        quantity: true,
        unit: true,
        optional: true,
        membership: true,
      },
    });
    expect(production.authority).toContain('V1_RELEASE');
    expect(production.candidateTargetOccurrenceKeys).toEqual([target.occurrenceKey]);
    expect(target).toMatchObject({
      classification: 'SATISFIED_EXACT',
      confidence: 'DETERMINISTIC',
      mapping: 'UNIQUE',
      candidateProductionOccurrenceKeys: [production.occurrenceKey],
    });
    expectAccounting(result);
  });

  it('keeps the manifest evidence-only and excludes repair action classes', () => {
    const result = runFixture();
    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'OFFLINE_EVIDENCE_ONLY',
      certification: 'NOT_A_RELEASE_CERTIFICATION',
      runtimePositionAuthority: false,
      repairAuthorized: false,
      t21gStatus: 'T21G_NOT_READY',
      authorityProof: null,
    });
    const forbidden = new Set(['DELETE', 'UPDATE', 'REPLACE', 'INSERT_NOW', 'FIX', 'DROP']);
    expect([...PRODUCTION_CLASSES, ...TARGET_CLASSES].some((value) => forbidden.has(value))).toBe(
      false,
    );
    expectAccounting(result);
  });

  it('treats an omitted target optional flag as false and matches explicit optional true exactly', () => {
    const omitted = runFixture();
    expect(omitted.production[0].classification).toBe('EXACT_V1_MATCH');

    const optional = runFixture({
      targetRecipes: [{ id: RECIPE_ID, ingredients: [targetIngredient({ isOptional: true })] }],
      productionRows: [productionRow({ is_optional: 1 })],
    });
    expect(optional.production[0].classification).toBe('EXACT_V1_MATCH');
    expect(optional.target[0].classification).toBe('SATISFIED_EXACT');
    expectAccounting(omitted);
    expectAccounting(optional);
  });

  it('preserves balanced duplicate multiplicity without choosing physical row pairs', () => {
    const result = runFixture({
      targetRecipes: [{ id: RECIPE_ID, ingredients: [targetIngredient(), targetIngredient()] }],
      productionRows: [
        productionRow({ id: 'physical-row-a' }),
        productionRow({ id: 'physical-row-b' }),
      ],
    });

    expect(result.production).toHaveLength(2);
    expect(result.target).toHaveLength(2);
    expect(result.production.every((row) => row.classification === 'EXACT_V1_MATCH')).toBe(true);
    expect(result.production.every((row) => row.mapping === 'MULTISET_ONLY')).toBe(true);
    expect(result.production.every((row) => row.confidence === 'REVIEW_REQUIRED')).toBe(true);
    expect(
      result.production.every(
        (row) => row.reviewReason === 'PHYSICAL_MAPPING_UNKNOWN_FOR_DUPLICATES',
      ),
    ).toBe(true);
    expect(result.target.every((row) => row.classification === 'SATISFIED_EXACT')).toBe(true);
    for (const row of result.production) expect(row.candidateTargetOccurrenceKeys).toHaveLength(2);
    for (const row of result.target) expect(row.candidateProductionOccurrenceKeys).toHaveLength(2);
    expectAccounting(result);
  });

  it('marks every member of an excess identical production bag as duplicate and the target ambiguous', () => {
    const result = runFixture({
      productionRows: [
        productionRow({ id: 'physical-row-a' }),
        productionRow({ id: 'physical-row-b' }),
      ],
    });

    expect(result.production.map((row) => row.classification)).toEqual([
      'DUPLICATE_SEMANTIC_OCCURRENCE',
      'DUPLICATE_SEMANTIC_OCCURRENCE',
    ]);
    expect(result.production.every((row) => row.mapping !== 'UNIQUE')).toBe(true);
    expect(result.target[0].classification).toBe('AMBIGUOUS');
    expectAccounting(result);
  });

  it('marks a deficient identical bag as membership-only drift without selecting the absent target', () => {
    const result = runFixture({
      targetRecipes: [{ id: RECIPE_ID, ingredients: [targetIngredient(), targetIngredient()] }],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'SAME_ID_CONTENT_DRIFT',
      driftKind: 'membership_only',
      mapping: 'UNRESOLVED',
      comparison: { membership: false },
    });
    expect(result.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
    expect(result.production[0].candidateTargetOccurrenceKeys).toHaveLength(2);
    expectAccounting(result);
  });

  it('distinguishes same-ID name, quantity, unit, optional, and combined semantic drift without conversion', () => {
    const cases = [
      {
        label: 'name only',
        target: targetIngredient(),
        row: productionRow({ name: 'Alternate spelling' }),
        drift: 'name_only',
        field: 'name',
      },
      {
        label: 'quantity only',
        target: targetIngredient({ requiredQuantity: 3 }),
        row: productionRow(),
        drift: 'quantity_only',
        field: 'quantity',
      },
      {
        label: 'unit only',
        target: targetIngredient({ unit: 'kg' }),
        row: productionRow(),
        drift: 'unit_only',
        field: 'unit',
      },
      {
        label: 'optional only',
        target: targetIngredient({ isOptional: true }),
        row: productionRow(),
        drift: 'optional_only',
        field: 'optional',
      },
      {
        label: 'quantity and unit',
        target: targetIngredient({ requiredQuantity: 5000 }),
        row: productionRow({ required_quantity: 5, unit: 'kg' }),
        drift: 'quantity_unit',
        field: 'quantity',
      },
      {
        label: 'three semantic dimensions',
        target: targetIngredient({ requiredQuantity: 10, unit: 'kg', isOptional: true }),
        row: productionRow(),
        drift: 'multi_field',
        field: 'optional',
      },
    ];

    for (const { label, target, row, drift, field } of cases) {
      const result = runFixture({
        targetRecipes: [{ id: RECIPE_ID, ingredients: [target] }],
        productionRows: [row],
      });
      expect(result.production[0].classification, label).toBe('SAME_ID_CONTENT_DRIFT');
      expect(result.production[0].driftKind, label).toBe(drift);
      expect(result.production[0].comparison[field], label).toBe(false);
      expect(result.target[0].classification, label).toBe('AMBIGUOUS');
      expectAccounting(result);
    }
  });

  it('separates content changes combined with duplicate membership drift', () => {
    const result = runFixture({
      targetRecipes: [{ id: RECIPE_ID, ingredients: [targetIngredient(), targetIngredient()] }],
      productionRows: [productionRow({ required_quantity: 3 })],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'SAME_ID_CONTENT_DRIFT',
      driftKind: 'membership_plus_content',
      confidence: 'REVIEW_REQUIRED',
      mapping: 'UNRESOLVED',
    });
    expect(result.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
    expectAccounting(result);
  });

  it('returns null comparisons when multiple same-identity target candidates disagree', () => {
    const result = runFixture({
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [
            targetIngredient({ name: 'Name A', requiredQuantity: 2, unit: 'g' }),
            targetIngredient({ name: 'Name B', requiredQuantity: 4, unit: 'kg', isOptional: true }),
          ],
        },
      ],
      productionRows: [
        productionRow({ name: 'Name A', required_quantity: 4, unit: 'g', is_optional: 0 }),
      ],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'SAME_ID_CONTENT_DRIFT',
      confidence: 'REVIEW_REQUIRED',
      mapping: 'UNRESOLVED',
      driftKind: 'indeterminate',
      comparison: { name: null, quantity: null, unit: null, optional: null, membership: false },
    });
    expect(result.production[0].candidateTargetOccurrenceKeys).toHaveLength(2);
    expect(result.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
    expectAccounting(result);
  });

  it('labels a target with no possible production evidence as target-only missing', () => {
    const result = runFixture({ productionRows: [] });

    expect(result.target[0]).toMatchObject({
      classification: 'TARGET_ONLY_MISSING',
      confidence: 'DETERMINISTIC',
      mapping: 'NONE',
      reviewReason: null,
      candidateProductionOccurrenceKeys: [],
    });
    expectAccounting(result);
  });

  it('does not infer target absence when a well-formed unknown identity is present in the recipe', () => {
    const result = runFixture({
      productionRows: [productionRow({ ingredient_id: 'ING_UNLISTED', name: 'Unlisted item' })],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'AMBIGUOUS',
      confidence: 'UNKNOWN',
      mapping: 'UNRESOLVED',
      identityPopulation: 'UNKNOWN_ID',
    });
    expect(result.target[0].classification).toBe('AMBIGUOUS');
    expect(result.target[0].candidateProductionOccurrenceKeys).toEqual([
      result.production[0].occurrenceKey,
    ]);
    expectAccounting(result);
  });

  it('classifies a registry-known non-V1 identity without treating it as a target counterpart', () => {
    const result = runFixture({
      productionRows: [productionRow({ ingredient_id: 'ING_KNOWN', name: 'Other ingredient' })],
      canonicalIngredientIds: ['ING_KNOWN'],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'PRODUCTION_ONLY_KNOWN_ID',
      confidence: 'DETERMINISTIC',
      mapping: 'NONE',
      identityPopulation: 'NON_V1_CANONICAL_ID',
    });
    expect(result.target[0].classification).toBe('TARGET_ONLY_MISSING');
    expectAccounting(result);
  });

  it('classifies a strictly reviewed new identity as production-only evidence', () => {
    const result = runFixture({
      productionRows: [productionRow({ ingredient_id: 'SOURCE_NEW', name: 'Enriched item' })],
      reconciliation: [
        {
          sourceId: 'SOURCE_NEW',
          canonicalId: 'ING_ENR_NEW_ITEM',
          resolution: 'reviewed_new_canonical_id',
          review: { basis: 'curated source', evidenceReference: 'review:line-7' },
        },
      ],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'PRODUCTION_ONLY_NEW_ID',
      identityPopulation: 'REVIEWED_NEW_ID',
      mapping: 'NONE',
    });
    expect(result.production[0].authority).toContain('REVIEWED_RECONCILIATION');
    expect(result.target[0].classification).toBe('TARGET_ONLY_MISSING');
    expectAccounting(result);
  });

  it('does not treat an ING_ENR prefix as identity authority by itself', () => {
    const result = runFixture({
      productionRows: [
        productionRow({ ingredient_id: 'ING_ENR_UNREVIEWED', name: 'Unreviewed new item' }),
      ],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'AMBIGUOUS',
      identityPopulation: 'UNREVIEWED_ING_ENR',
      mapping: 'UNRESOLVED',
    });
    expect(result.target[0].classification).toBe('AMBIGUOUS');
    expectAccounting(result);
  });

  it('keeps a cross-ID exact-content match in review without an approved bridge', () => {
    const result = runFixture({
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE' })],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'ID_CONFLICT_REVIEW_REQUIRED',
      confidence: 'REVIEW_REQUIRED',
      mapping: 'UNRESOLVED',
      reviewReason: 'NO_UNIQUE_APPROVED_ID_BRIDGE',
      candidateTargetOccurrenceKeys: [result.target[0].occurrenceKey],
    });
    expect(result.target[0].classification).toBe('AMBIGUOUS');
    expectAccounting(result);
  });

  it('does not normalize case, translation, or similar names into a counterpart', () => {
    for (const name of ['alpha ingredient', 'Alfa ingredient', 'Cà chua']) {
      const result = runFixture({
        targetRecipes: [
          { id: RECIPE_ID, ingredients: [targetIngredient({ name: 'Alpha ingredient' })] },
        ],
        productionRows: [productionRow({ ingredient_id: 'ING_SOURCE', name })],
      });
      expect(result.production[0].classification, name).toBe('AMBIGUOUS');
      expect(result.production[0].mapping, name).toBe('UNRESOLVED');
      expect(result.target[0].classification, name).toBe('AMBIGUOUS');
      expectAccounting(result);
    }
  });

  it('does not pair an identical ingredient ID across a different recipe', () => {
    const result = runFixture({
      targetRecipes: [
        { id: 'recipe-a', ingredients: [] },
        { id: 'recipe-b', ingredients: [targetIngredient()] },
      ],
      productionRows: [productionRow({ recipe_id: 'recipe-a' })],
      productionRecipeIds: ['recipe-a'],
    });

    expect(result.production[0].classification).toBe('PRODUCTION_ONLY_KNOWN_ID');
    expect(result.target[0].classification).toBe('TARGET_ONLY_MISSING');
    expect(result.production[0].candidateTargetOccurrenceKeys).toEqual([]);
    expectAccounting(result);
  });

  it('allows a unique existing-canonical bridge only with null review and exact content', () => {
    const result = runFixture({
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE' })],
      canonicalIngredientIds: [INGREDIENT_ID],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE',
          canonicalId: INGREDIENT_ID,
          resolution: 'existing_canonical_id',
          review: null,
        },
      ],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'DETERMINISTIC_V1_COUNTERPART',
      confidence: 'DETERMINISTIC',
      mapping: 'UNIQUE',
    });
    expect(result.production[0].authority).toContain('REVIEWED_RECONCILIATION');
    expect(result.target[0].classification).toBe('SATISFIED_DETERMINISTICALLY');
    expectAccounting(result);
  });

  it('does not treat a self-map as cross-ID bridge authority', () => {
    const result = runFixture({
      productionRows: [productionRow()],
      canonicalIngredientIds: [INGREDIENT_ID],
      reconciliation: [
        {
          sourceId: INGREDIENT_ID,
          canonicalId: INGREDIENT_ID,
          resolution: 'existing_canonical_id',
          review: null,
        },
      ],
    });

    expect(result.production[0].classification).toBe('EXACT_V1_MATCH');
    expect(result.production[0].authority).toContain('V1_RELEASE');
    expect(result.production[0].authority).not.toContain('REVIEWED_RECONCILIATION');
    expect(result.target[0].classification).toBe('SATISFIED_EXACT');
    expectAccounting(result);
  });

  it('does not map a reviewed identity bridge when the semantic content differs from V1', () => {
    const result = runFixture({
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE', required_quantity: 3 })],
      canonicalIngredientIds: [INGREDIENT_ID],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE',
          canonicalId: INGREDIENT_ID,
          resolution: 'existing_canonical_id',
          review: null,
        },
      ],
    });

    expect(result.production[0]).toMatchObject({
      mapping: 'UNRESOLVED',
      confidence: 'REVIEW_REQUIRED',
      reviewReason: 'BRIDGE_CONTENT_DOES_NOT_MATCH_V1',
    });
    expect(result.production[0].classification).not.toBe('DETERMINISTIC_V1_COUNTERPART');
    expect(result.production[0].classification).not.toBe('REVIEWED_ID_BRIDGE');
    expect(result.target[0].classification).toBe('AMBIGUOUS');
    expectAccounting(result);
  });

  it('allows a unique reviewed-new bridge only with the exact review contract', () => {
    const targetId = 'ING_ENR_TARGET';
    const result = runFixture({
      targetRecipes: [
        { id: RECIPE_ID, ingredients: [targetIngredient({ ingredientId: targetId })] },
      ],
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE' })],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE',
          canonicalId: targetId,
          resolution: 'reviewed_new_canonical_id',
          review: { basis: 'reviewed dataset', evidenceReference: 'review:item-4' },
        },
      ],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'REVIEWED_ID_BRIDGE',
      confidence: 'DETERMINISTIC',
      mapping: 'UNIQUE',
    });
    expect(result.production[0].authority).toContain('REVIEWED_RECONCILIATION');
    expect(result.target[0].classification).toBe('SATISFIED_DETERMINISTICALLY');
    expectAccounting(result);
  });

  it('does not map a reviewed-new bridge when the semantic content differs from V1', () => {
    const targetId = 'ING_ENR_TARGET';
    const result = runFixture({
      targetRecipes: [
        { id: RECIPE_ID, ingredients: [targetIngredient({ ingredientId: targetId })] },
      ],
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE', required_quantity: 3 })],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE',
          canonicalId: targetId,
          resolution: 'reviewed_new_canonical_id',
          review: { basis: 'reviewed dataset', evidenceReference: 'review:item-4' },
        },
      ],
    });

    expect(result.production[0]).toMatchObject({
      mapping: 'UNRESOLVED',
      confidence: 'REVIEW_REQUIRED',
      reviewReason: 'BRIDGE_CONTENT_DOES_NOT_MATCH_V1',
    });
    expect(result.production[0].classification).not.toBe('REVIEWED_ID_BRIDGE');
    expect(result.target[0].classification).toBe('AMBIGUOUS');
    expectAccounting(result);
  });

  it('rejects provisional, null-source, malformed-review, and otherwise ineligible bridge evidence', () => {
    const invalidEvidence = [
      {
        sourceId: 'ING_SOURCE',
        canonicalId: INGREDIENT_ID,
        resolution: 'existing_canonical_id',
        review: {},
      },
      { sourceId: 'ING_SOURCE', canonicalId: INGREDIENT_ID, resolution: 'existing_canonical_id' },
      {
        sourceId: null,
        canonicalId: INGREDIENT_ID,
        resolution: 'existing_canonical_id',
        review: null,
      },
      {
        sourceId: '',
        canonicalId: INGREDIENT_ID,
        resolution: 'existing_canonical_id',
        review: null,
      },
      {
        sourceId: 'ING_SOURCE',
        canonicalId: '',
        resolution: 'existing_canonical_id',
        review: null,
      },
      {
        sourceId: 'ING_SOURCE',
        canonicalId: INGREDIENT_ID,
        resolution: 'provisional_new_canonical_id',
        review: null,
      },
      {
        sourceId: 'ING_SOURCE',
        canonicalId: 'ING_ENR_TARGET',
        resolution: 'reviewed_new_canonical_id',
        review: { basis: 'reviewed', evidenceReference: 'review:item', extra: 'not allowed' },
      },
      {
        sourceId: 'ING_SOURCE',
        canonicalId: 'ING_ENR_TARGET',
        resolution: 'reviewed_new_canonical_id',
        review: { basis: '', evidenceReference: 'review:item' },
      },
      {
        sourceId: 'ING_SOURCE',
        canonicalId: 'ING_ENR_TARGET',
        resolution: 'reviewed_new_canonical_id',
        review: { basis: 'reviewed', evidenceReference: '' },
      },
      {
        sourceId: 'ING_SOURCE',
        canonicalId: INGREDIENT_ID,
        resolution: 'reviewed_new_canonical_id',
        review: { basis: 'reviewed', evidenceReference: 'review:item' },
      },
    ];

    for (const reconciliation of invalidEvidence) {
      const targetId =
        reconciliation.resolution === 'reviewed_new_canonical_id' &&
        reconciliation.canonicalId === 'ING_ENR_TARGET'
          ? 'ING_ENR_TARGET'
          : INGREDIENT_ID;
      const result = runFixture({
        targetRecipes: [
          { id: RECIPE_ID, ingredients: [targetIngredient({ ingredientId: targetId })] },
        ],
        productionRows: [productionRow({ ingredient_id: 'ING_SOURCE' })],
        canonicalIngredientIds: [INGREDIENT_ID],
        reconciliation: [reconciliation],
      });
      expect(result.production[0].classification).toBe('ID_CONFLICT_REVIEW_REQUIRED');
      expect(result.production[0].mapping).toBe('UNRESOLVED');
      expect(result.target[0].classification).toBe('AMBIGUOUS');
      expectAccounting(result);
    }
  });

  it('rejects competing source-to-canonical bridges', () => {
    const result = runFixture({
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE' })],
      canonicalIngredientIds: [INGREDIENT_ID, 'ING_OTHER'],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE',
          canonicalId: INGREDIENT_ID,
          resolution: 'existing_canonical_id',
          review: null,
        },
        {
          sourceId: 'ING_SOURCE',
          canonicalId: 'ING_OTHER',
          resolution: 'existing_canonical_id',
          review: null,
        },
      ],
    });

    expect(result.production[0].classification).toBe('ID_CONFLICT_REVIEW_REQUIRED');
    expect(result.production[0].mapping).toBe('UNRESOLVED');
    expectAccounting(result);
  });

  it('rejects competing canonical-to-source bridges', () => {
    const result = runFixture({
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE' })],
      canonicalIngredientIds: [INGREDIENT_ID],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE',
          canonicalId: INGREDIENT_ID,
          resolution: 'existing_canonical_id',
          review: null,
        },
        {
          sourceId: 'ING_SOURCE_OTHER',
          canonicalId: INGREDIENT_ID,
          resolution: 'existing_canonical_id',
          review: null,
        },
      ],
    });

    expect(result.production[0].classification).toBe('ID_CONFLICT_REVIEW_REQUIRED');
    expect(result.production[0].mapping).toBe('UNRESOLVED');
    expectAccounting(result);
  });

  it('does not grant a reviewed bridge when target occurrence multiplicity is non-unique', () => {
    const targetId = 'ING_ENR_TARGET';
    const result = runFixture({
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [
            targetIngredient({ ingredientId: targetId }),
            targetIngredient({ ingredientId: targetId }),
          ],
        },
      ],
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE' })],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE',
          canonicalId: targetId,
          resolution: 'reviewed_new_canonical_id',
          review: { basis: 'reviewed dataset', evidenceReference: 'review:item-4' },
        },
      ],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'AMBIGUOUS',
      mapping: 'UNRESOLVED',
    });
    expect(result.production[0].candidateTargetOccurrenceKeys).toHaveLength(2);
    expect(result.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
    expectAccounting(result);

    const excessRows = runFixture({
      targetRecipes: [
        { id: RECIPE_ID, ingredients: [targetIngredient({ ingredientId: targetId })] },
      ],
      productionRows: [
        productionRow({ id: 'source-a', ingredient_id: 'ING_SOURCE' }),
        productionRow({ id: 'source-b', ingredient_id: 'ING_SOURCE' }),
      ],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE',
          canonicalId: targetId,
          resolution: 'reviewed_new_canonical_id',
          review: { basis: 'reviewed dataset', evidenceReference: 'review:item-4' },
        },
      ],
    });
    expect(excessRows.production.map((row) => row.classification)).toEqual([
      'DUPLICATE_SEMANTIC_OCCURRENCE',
      'DUPLICATE_SEMANTIC_OCCURRENCE',
    ]);
    expect(excessRows.target[0].classification).toBe('AMBIGUOUS');
    expectAccounting(excessRows);
  });

  it('marks malformed quantities and taints target absence proof without coercion', () => {
    const invalidQuantities = [0, -1, 1e308, Infinity, NaN, '2', null];
    for (const quantity of invalidQuantities) {
      const result = runFixture({
        productionRows: [productionRow({ required_quantity: quantity })],
      });
      expect(result.production[0].classification).toBe('MALFORMED_OCCURRENCE');
      expect(result.production[0].authority).toContain('SCHEMA_CONTRACT');
      expect(result.target[0].classification).toBe('AMBIGUOUS');
      expectAccounting(result);
    }
  });

  it('rejects units outside the closed StandardUnit schema', () => {
    for (const unit of ['cup', 'tbsp', 'G', '', null]) {
      const result = runFixture({
        productionRows: [productionRow({ unit })],
      });
      expect(result.production[0].classification).toBe('MALFORMED_OCCURRENCE');
      expect(result.production[0].reviewReason).toBe('UNKNOWN_UNIT');
      expect(result.target[0].classification).toBe('AMBIGUOUS');
      expectAccounting(result);
    }
  });

  it('accepts only raw integer optional bits zero and one', () => {
    for (const optional of [null, true, false, '0', '1', 2]) {
      const result = runFixture({
        productionRows: [productionRow({ is_optional: optional })],
      });
      expect(result.production[0].classification).toBe('MALFORMED_OCCURRENCE');
      expect(result.production[0].reviewReason).toBe('INVALID_OPTIONAL_ENCODING');
      expect(result.target[0].classification).toBe('AMBIGUOUS');
      expectAccounting(result);
    }
  });

  it('rejects missing and invalid required occurrence fields and target authority shapes', () => {
    for (const overrides of [
      { id: '' },
      { id: null },
      { recipe_id: '' },
      { recipe_id: 'invalid recipe id' },
      { recipe_id: `r${'x'.repeat(100)}` },
      { ingredient_id: '' },
      { ingredient_id: 'lowercase-id' },
      { ingredient_id: `ING_${'X'.repeat(97)}` },
      { name: '' },
      { name: null },
      { name: '   ' },
      { name: 'x'.repeat(301) },
    ]) {
      const result = runFixture({ productionRows: [productionRow(overrides)] });
      expect(result.production[0].classification).toBe('MALFORMED_OCCURRENCE');
      expectAccounting(result);
    }

    const invalidTargets = [
      { id: 'bad recipe id', ingredients: [] },
      { id: RECIPE_ID, ingredients: 'not-an-array' },
      { id: RECIPE_ID, ingredients: [targetIngredient({ requiredQuantity: 0 })] },
      { id: RECIPE_ID, ingredients: [targetIngredient({ unit: 'cup' })] },
      { id: RECIPE_ID, ingredients: [targetIngredient({ isOptional: 'false' })] },
    ];
    for (const targetRecipe of invalidTargets) {
      expect(() => runFixture({ targetRecipes: [targetRecipe], productionRows: [] })).toThrow(
        'Invalid target authority',
      );
    }
    expect(() => runFixture({ productionRecipeIds: [RECIPE_ID, RECIPE_ID] })).toThrow(
      'Invalid evidence envelope',
    );
    expect(() => runFixture({ canonicalIngredientIds: ['bad id'] })).toThrow(
      'Invalid evidence envelope',
    );
  });

  it('treats physical row IDs as opaque nonempty observations, not catalog identities', () => {
    const physicalId = `opaque / row id:${'x'.repeat(140)}`;
    const result = runFixture({ productionRows: [productionRow({ id: physicalId })] });

    expect(result.production[0].classification).toBe('EXACT_V1_MATCH');
    expect(result.production[0].mapping).toBe('UNIQUE');
    expect(serializeReconciliationManifest(result)).not.toContain(physicalId);
    expectAccounting(result);
  });

  it('marks all rows sharing a duplicate physical ID malformed', () => {
    const result = runFixture({
      productionRows: [
        productionRow({ id: 'duplicated-physical-id' }),
        productionRow({ id: 'duplicated-physical-id', required_quantity: 3 }),
      ],
    });

    expect(result.production).toHaveLength(2);
    expect(result.production.every((row) => row.classification === 'MALFORMED_OCCURRENCE')).toBe(
      true,
    );
    expect(
      result.production.every((row) => row.reviewReason === 'DUPLICATE_PHYSICAL_LINE_ID'),
    ).toBe(true);
    expect(result.target[0].classification).toBe('AMBIGUOUS');
    expect(new Set(result.production.map((row) => row.occurrenceKey)).size).toBe(2);
    expectAccounting(result);
  });

  it('taints valid matching rows when malformed data occurs in their captured recipe', () => {
    const result = runFixture({
      productionRows: [
        productionRow({ id: 'valid-row' }),
        productionRow({ id: 'malformed-row', unit: 'cup' }),
      ],
    });

    expect(result.production.map((row) => row.classification).sort()).toEqual([
      'AMBIGUOUS',
      'MALFORMED_OCCURRENCE',
    ]);
    expect(result.production.find((row) => row.classification === 'AMBIGUOUS').reviewReason).toBe(
      'MALFORMED_INPUT_PREVENTS_MEMBERSHIP_PROOF',
    );
    expect(result.target[0].classification).toBe('AMBIGUOUS');
    expectAccounting(result);
  });

  it('globally taints target absence when a malformed row has an uncaptured parent', () => {
    const result = runFixture({
      targetRecipes: [
        { id: 'recipe-a', ingredients: [targetIngredient()] },
        { id: 'recipe-b', ingredients: [targetIngredient({ ingredientId: 'ING_BETA' })] },
      ],
      productionRows: [productionRow({ recipe_id: 'recipe-outside' })],
      productionRecipeIds: ['recipe-a'],
    });

    expect(result.production[0]).toMatchObject({
      classification: 'MALFORMED_OCCURRENCE',
      reviewReason: 'BROKEN_RECIPE_REFERENCE',
    });
    expect(result.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
    expectAccounting(result);
  });

  it('rejects unrecognized raw row fields while allowing the observation-only position field', () => {
    expect(() =>
      runFixture({
        productionRows: [productionRow({ unexpected: 'not part of the D1 contract' })],
      }),
    ).toThrow('Unexpected production field');

    const positioned = runFixture({
      productionRows: [productionRow({ position: 'untrusted-observation' })],
    });
    expect(positioned.production[0].classification).toBe('EXACT_V1_MATCH');
    expectAccounting(positioned);
  });

  it('is byte-independent of production position values', () => {
    const baseline = serializeReconciliationManifest(runFixture());
    for (const position of [null, 0, -3, 1.5, 'position-only', { observed: true }]) {
      const result = runFixture({ productionRows: [productionRow({ position })] });
      expect(serializeReconciliationManifest(result)).toBe(baseline);
      expectAccounting(result);
    }
  });

  it('is byte-stable under input array permutations', () => {
    const recipeA = {
      id: 'recipe-a',
      ingredients: [
        targetIngredient({ ingredientId: 'ING_ALPHA', name: 'Alpha', requiredQuantity: 1 }),
        targetIngredient({ ingredientId: 'ING_BETA', name: 'Beta', requiredQuantity: 2 }),
      ],
    };
    const recipeB = {
      id: 'recipe-b',
      ingredients: [
        targetIngredient({ ingredientId: 'ING_ENR_TARGET', name: 'New', requiredQuantity: 3 }),
      ],
    };
    const rows = [
      productionRow({
        id: 'row-alpha',
        recipe_id: 'recipe-a',
        ingredient_id: 'ING_ALPHA',
        name: 'Alpha',
        required_quantity: 1,
      }),
      productionRow({
        id: 'row-beta',
        recipe_id: 'recipe-a',
        ingredient_id: 'ING_BETA',
        name: 'Beta',
        required_quantity: 2,
      }),
      productionRow({
        id: 'row-new',
        recipe_id: 'recipe-b',
        ingredient_id: 'ING_SOURCE',
        name: 'New',
        required_quantity: 3,
      }),
    ];
    const reconciliation = [
      {
        sourceId: 'ING_SOURCE',
        canonicalId: 'ING_ENR_TARGET',
        resolution: 'reviewed_new_canonical_id',
        review: { basis: 'reviewed', evidenceReference: 'review:item-9' },
      },
    ];
    const ordered = runFixture({
      targetRecipes: [recipeA, recipeB],
      productionRows: rows,
      productionRecipeIds: ['recipe-a', 'recipe-b'],
      canonicalIngredientIds: ['ING_ALPHA', 'ING_BETA', 'ING_ENR_TARGET'],
      reconciliation,
    });
    const permuted = runFixture({
      targetRecipes: [
        { ...recipeB, ingredients: [...recipeB.ingredients].reverse() },
        { ...recipeA, ingredients: [...recipeA.ingredients].reverse() },
      ],
      productionRows: [...rows].reverse(),
      productionRecipeIds: ['recipe-b', 'recipe-a'],
      canonicalIngredientIds: ['ING_ENR_TARGET', 'ING_BETA', 'ING_ALPHA'],
      reconciliation: [...reconciliation].reverse(),
    });

    expect(serializeReconciliationManifest(permuted)).toBe(
      serializeReconciliationManifest(ordered),
    );
    expectAccounting(ordered);
    expectAccounting(permuted);
  });

  it('does not serialize raw ingredient names, physical IDs, or quantities', () => {
    const sensitiveName = 'Sensitive production ingredient label';
    const sensitiveId = 'private-physical-primary-key-87';
    const sensitiveQuantity = 987654.125;
    const result = runFixture({
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [
            targetIngredient({ name: sensitiveName, requiredQuantity: sensitiveQuantity }),
          ],
        },
      ],
      productionRows: [
        productionRow({
          id: sensitiveId,
          name: sensitiveName,
          required_quantity: sensitiveQuantity,
        }),
      ],
    });
    const serialized = serializeReconciliationManifest(result);

    expect(serialized).not.toContain(sensitiveName);
    expect(serialized).not.toContain(sensitiveId);
    expect(serialized).not.toContain(String(sensitiveQuantity));
    expect(result.production[0]).not.toHaveProperty('name');
    expect(result.production[0]).not.toHaveProperty('quantity');
    expect(result.production[0]).not.toHaveProperty('physicalId');
    expectAccounting(result);
  });

  it('serializes a canonical JSON object with sorted keys and exactly one trailing newline', () => {
    const serialized = serializeReconciliationManifest({
      z: 1,
      b: [{ z: 1, a: 2 }],
      a: { y: 2, x: 3 },
    });

    expect(serialized).toBe('{"a":{"x":3,"y":2},"b":[{"a":2,"z":1}],"z":1}\n');
    expect(JSON.parse(serialized)).toEqual({ z: 1, b: [{ z: 1, a: 2 }], a: { y: 2, x: 3 } });
  });

  it('derives class aggregates across many small synthetic fixtures without live-count constants', () => {
    const expectedProductionCounts = Object.fromEntries(PRODUCTION_CLASSES.map((key) => [key, 0]));
    const expectedTargetCounts = Object.fromEntries(TARGET_CLASSES.map((key) => [key, 0]));
    const results = [];

    for (let index = 0; index < 36; index += 1) {
      const recipeId = `recipe-${index}`;
      const targetRecipes = [{ id: recipeId, ingredients: [targetIngredient()] }];
      let productionRows;
      let canonicalIngredientIds = [];
      let expectedProduction;
      let expectedTarget;
      switch (index % 6) {
        case 0:
          productionRows = [productionRow({ id: `row-${index}`, recipe_id: recipeId })];
          expectedProduction = 'EXACT_V1_MATCH';
          expectedTarget = 'SATISFIED_EXACT';
          break;
        case 1:
          productionRows = [
            productionRow({ id: `row-${index}`, recipe_id: recipeId, required_quantity: 3 }),
          ];
          expectedProduction = 'SAME_ID_CONTENT_DRIFT';
          expectedTarget = 'AMBIGUOUS';
          break;
        case 2:
          productionRows = [
            productionRow({
              id: `row-${index}`,
              recipe_id: recipeId,
              ingredient_id: 'ING_EXTRA',
              name: 'Extra item',
            }),
          ];
          canonicalIngredientIds = ['ING_EXTRA'];
          expectedProduction = 'PRODUCTION_ONLY_KNOWN_ID';
          expectedTarget = 'TARGET_ONLY_MISSING';
          break;
        case 3:
          productionRows = [];
          expectedProduction = null;
          expectedTarget = 'TARGET_ONLY_MISSING';
          break;
        case 4:
          productionRows = [
            productionRow({
              id: `row-${index}`,
              recipe_id: recipeId,
              ingredient_id: 'ING_UNKNOWN',
              name: 'Unknown item',
            }),
          ];
          expectedProduction = 'AMBIGUOUS';
          expectedTarget = 'AMBIGUOUS';
          break;
        default:
          productionRows = [
            productionRow({ id: `row-${index}`, recipe_id: recipeId, unit: 'cup' }),
          ];
          expectedProduction = 'MALFORMED_OCCURRENCE';
          expectedTarget = 'AMBIGUOUS';
      }

      const result = runFixture({
        targetRecipes,
        productionRows,
        productionRecipeIds: [recipeId],
        canonicalIngredientIds,
      });
      expect(result.production.map((row) => row.classification)).toEqual(
        expectedProduction === null ? [] : [expectedProduction],
      );
      expect(result.target.map((row) => row.classification)).toEqual([expectedTarget]);
      for (const row of result.production) expectedProductionCounts[row.classification] += 1;
      for (const row of result.target) expectedTargetCounts[row.classification] += 1;
      results.push(result);
      expectAccounting(result);
    }

    const aggregateProductionCounts = Object.fromEntries(
      PRODUCTION_CLASSES.map((key) => [
        key,
        results.reduce((sum, result) => sum + result.summary.productionClassCounts[key], 0),
      ]),
    );
    const aggregateTargetCounts = Object.fromEntries(
      TARGET_CLASSES.map((key) => [
        key,
        results.reduce((sum, result) => sum + result.summary.targetClassCounts[key], 0),
      ]),
    );
    expect(aggregateProductionCounts).toEqual(expectedProductionCounts);
    expect(aggregateTargetCounts).toEqual(expectedTargetCounts);
    expect(total(aggregateProductionCounts)).toBe(
      results.reduce((sum, result) => sum + result.production.length, 0),
    );
    expect(total(aggregateTargetCounts)).toBe(
      results.reduce((sum, result) => sum + result.target.length, 0),
    );
  });

  it('accounts all 500 recipes and 2702 V1 ingredient occurrences from the approved local catalog', () => {
    const productionRows = realTargetRecipes.flatMap((recipe, recipeIndex) =>
      recipe.ingredients.map((ingredient, lineIndex) => ({
        id: `catalog-row-${recipeIndex}-${lineIndex}`,
        recipe_id: recipe.id,
        ingredient_id: ingredient.ingredientId,
        name: ingredient.name,
        required_quantity: ingredient.requiredQuantity,
        unit: ingredient.unit,
        is_optional: ingredient.isOptional === true ? 1 : 0,
      })),
    );
    const result = reconcileIngredientOccurrences({
      targetRecipes: realTargetRecipes,
      productionRows,
      productionRecipeIds: realTargetRecipes.map((recipe) => recipe.id),
      captureCounts: {
        recipeCount: realTargetRecipes.length,
        ingredientOccurrenceCount: productionRows.length,
      },
    });

    expect(realTargetRecipes).toHaveLength(500);
    expect(productionRows).toHaveLength(2702);
    expect(result.recipes).toHaveLength(500);
    expect(result.summary.productionOccurrenceCount).toBe(2702);
    expect(result.summary.targetOccurrenceCount).toBe(2702);
    expect(result.summary.productionClassCounts.EXACT_V1_MATCH).toBe(2702);
    expect(result.summary.targetClassCounts.SATISFIED_EXACT).toBe(2702);
    expect(result.recipes.every((recipe) => recipe.status === 'EXACT_V1_PARITY')).toBe(true);
    expectAccounting(result);
  });
});
