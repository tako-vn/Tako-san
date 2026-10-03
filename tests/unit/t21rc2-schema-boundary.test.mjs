import { describe, expect, it } from 'vitest';
import * as reconciliationModule from '../../scripts/t21rc-row-reconciliation.mjs';
import { validateT21RC2ManifestSchema } from '../../scripts/t21rc2-production-receipt.mjs';

const { PRODUCTION_CLASSES, TARGET_CLASSES, reconcileIngredientOccurrences } = reconciliationModule;

const RECIPE_ID = 'recipe-synthetic-000';
const INGREDIENT_ID = 'ING_SYNTH_ALPHA';
const UNIT = 'g';

function targetIngredient(overrides = {}) {
  return {
    ingredientId: INGREDIENT_ID,
    name: 'Synthetic alpha',
    requiredQuantity: 2,
    unit: UNIT,
    ...overrides,
  };
}

function productionRow(overrides = {}) {
  return {
    id: 'physical-synthetic-1',
    recipe_id: RECIPE_ID,
    ingredient_id: INGREDIENT_ID,
    name: 'Synthetic alpha',
    required_quantity: 2,
    unit: UNIT,
    is_optional: 0,
    ...overrides,
  };
}

function productionFromTarget(target, id, overrides = {}) {
  return productionRow({
    id,
    recipe_id: target.recipeId,
    ingredient_id: target.ingredient.ingredientId,
    name: target.ingredient.name,
    required_quantity: target.ingredient.requiredQuantity,
    unit: target.ingredient.unit,
    is_optional: target.ingredient.isOptional === true ? 1 : 0,
    ...overrides,
  });
}

function reviewedNewBridge(sourceId, canonicalId, suffix) {
  return {
    sourceId,
    canonicalId,
    resolution: 'reviewed_new_canonical_id',
    review: { basis: 'synthetic offline review', evidenceReference: `review:synthetic-${suffix}` },
  };
}

function manifestFor(input = {}) {
  const targetRecipes = input.targetRecipes ?? [
    { id: RECIPE_ID, ingredients: [targetIngredient()] },
  ];
  const productionRows = input.productionRows ?? [productionRow()];
  const productionRecipeIds = input.productionRecipeIds ?? [RECIPE_ID];
  const captureCounts =
    input.captureCounts === undefined
      ? {
          recipeCount: productionRecipeIds.length,
          ingredientOccurrenceCount: productionRows.length,
        }
      : input.captureCounts;

  return reconcileIngredientOccurrences({
    targetRecipes,
    productionRows,
    productionRecipeIds,
    canonicalIngredientIds: input.canonicalIngredientIds ?? [],
    reconciliation: input.reconciliation ?? [],
    captureCounts,
  });
}

function assertSchemaAccepted(name, input) {
  const manifest = manifestFor(input);
  try {
    expect(validateT21RC2ManifestSchema(manifest)).toBe(true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}: ${detail}`);
  }
  return manifest;
}

const classificationCorpus = [
  {
    name: 'exact V1 occurrence',
    input: {},
    expected: {
      productionClass: 'EXACT_V1_MATCH',
      targetClass: 'SATISFIED_EXACT',
      identityPopulation: 'V1_ID',
      candidateTargetCount: 1,
      candidateProductionCount: 1,
    },
  },
  {
    name: 'quantity-only drift',
    input: { productionRows: [productionRow({ required_quantity: 3 })] },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'quantity_only',
    },
  },
  {
    name: 'unit-only drift',
    input: { productionRows: [productionRow({ unit: 'ml' })] },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'unit_only',
    },
  },
  {
    name: 'optional-only drift',
    input: { productionRows: [productionRow({ is_optional: 1 })] },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'optional_only',
    },
  },
  {
    name: 'name-only drift',
    input: { productionRows: [productionRow({ name: 'Synthetic alpha renamed' })] },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'name_only',
    },
  },
  {
    name: 'multiple semantic fields drift',
    input: {
      productionRows: [productionRow({ required_quantity: 3, unit: 'ml', is_optional: 1 })],
    },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'multi_field',
    },
  },
  {
    name: 'name and semantic fields drift',
    input: {
      productionRows: [productionRow({ name: 'Renamed synthetic alpha', required_quantity: 3 })],
    },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'name_plus_semantics',
    },
  },
  {
    name: 'membership-only drift in a deficient duplicate bag',
    input: {
      targetRecipes: [{ id: RECIPE_ID, ingredients: [targetIngredient(), targetIngredient()] }],
      productionRows: [productionRow()],
    },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'membership_only',
      candidateTargetCount: 2,
    },
  },
  {
    name: 'membership plus content drift',
    input: {
      productionRows: [
        productionRow({ id: 'physical-membership-exact' }),
        productionRow({ id: 'physical-membership-drift', required_quantity: 3 }),
      ],
    },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'membership_plus_content',
    },
  },
  {
    name: 'candidate disagreement is indeterminate',
    input: {
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [
            targetIngredient({ requiredQuantity: 1 }),
            targetIngredient({ requiredQuantity: 4 }),
          ],
        },
      ],
      productionRows: [productionRow({ required_quantity: 1 })],
    },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'indeterminate',
      candidateTargetCount: 2,
    },
  },
  {
    name: 'registry-known non-V1 canonical identity',
    input: {
      productionRows: [
        productionRow({ ingredient_id: 'ING_CANONICAL_KNOWN', name: 'Known synthetic item' }),
      ],
      canonicalIngredientIds: ['ING_CANONICAL_KNOWN'],
    },
    expected: {
      productionClass: 'PRODUCTION_ONLY_KNOWN_ID',
      targetClass: 'TARGET_ONLY_MISSING',
      identityPopulation: 'NON_V1_CANONICAL_ID',
      candidateTargetCount: 0,
      candidateProductionCount: 0,
    },
  },
  {
    name: 'reviewed new production-only identity',
    input: {
      productionRows: [
        productionRow({ ingredient_id: 'SOURCE_NEW', name: 'Reviewed synthetic item' }),
      ],
      reconciliation: [reviewedNewBridge('SOURCE_NEW', 'ING_ENR_NEW_SYNTHETIC', 'production-only')],
    },
    expected: {
      productionClass: 'PRODUCTION_ONLY_NEW_ID',
      targetClass: 'TARGET_ONLY_MISSING',
      identityPopulation: 'REVIEWED_NEW_ID',
    },
  },
  {
    name: 'unreviewed ING_ENR identity',
    input: {
      productionRows: [
        productionRow({ ingredient_id: 'ING_ENR_UNREVIEWED', name: 'Unreviewed item' }),
      ],
    },
    expected: {
      productionClass: 'AMBIGUOUS',
      targetClass: 'AMBIGUOUS',
      identityPopulation: 'UNREVIEWED_ING_ENR',
      candidateTargetCount: 0,
      candidateProductionCount: 1,
    },
  },
  {
    name: 'unknown ingredient identity',
    input: {
      productionRows: [
        productionRow({ ingredient_id: 'ING_UNKNOWN_SYNTHETIC', name: 'Unknown item' }),
      ],
    },
    expected: {
      productionClass: 'AMBIGUOUS',
      targetClass: 'AMBIGUOUS',
      identityPopulation: 'UNKNOWN_ID',
      candidateTargetCount: 0,
    },
  },
  {
    name: 'approved existing-canonical bridge',
    input: {
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE_EXISTING' })],
      canonicalIngredientIds: [INGREDIENT_ID],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE_EXISTING',
          canonicalId: INGREDIENT_ID,
          resolution: 'existing_canonical_id',
          review: null,
        },
      ],
    },
    expected: {
      productionClass: 'DETERMINISTIC_V1_COUNTERPART',
      targetClass: 'SATISFIED_DETERMINISTICALLY',
      identityPopulation: 'V1_ID',
      candidateTargetCount: 1,
      candidateProductionCount: 1,
    },
  },
  {
    name: 'approved reviewed-new bridge',
    input: {
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [targetIngredient({ ingredientId: 'ING_ENR_TARGET' })],
        },
      ],
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE_REVIEWED' })],
      reconciliation: [reviewedNewBridge('ING_SOURCE_REVIEWED', 'ING_ENR_TARGET', 'bridge')],
    },
    expected: {
      productionClass: 'REVIEWED_ID_BRIDGE',
      targetClass: 'SATISFIED_DETERMINISTICALLY',
      candidateTargetCount: 1,
      candidateProductionCount: 1,
    },
  },
  {
    name: 'approved bridge with content mismatch',
    input: {
      productionRows: [
        productionRow({ ingredient_id: 'ING_SOURCE_MISMATCH', required_quantity: 3 }),
      ],
      canonicalIngredientIds: [INGREDIENT_ID],
      reconciliation: [
        {
          sourceId: 'ING_SOURCE_MISMATCH',
          canonicalId: INGREDIENT_ID,
          resolution: 'existing_canonical_id',
          review: null,
        },
      ],
    },
    expected: {
      productionClass: 'AMBIGUOUS',
      targetClass: 'AMBIGUOUS',
      reviewReason: 'BRIDGE_CONTENT_DOES_NOT_MATCH_V1',
      candidateTargetCount: 1,
    },
  },
  {
    name: 'approved bridge with multiple target candidates',
    input: {
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [
            targetIngredient({ ingredientId: 'ING_ENR_TARGET' }),
            targetIngredient({ ingredientId: 'ING_ENR_TARGET' }),
          ],
        },
      ],
      productionRows: [productionRow({ ingredient_id: 'ING_SOURCE_MULTIPLE' })],
      reconciliation: [reviewedNewBridge('ING_SOURCE_MULTIPLE', 'ING_ENR_TARGET', 'multiple')],
    },
    expected: {
      productionClass: 'AMBIGUOUS',
      targetClass: 'AMBIGUOUS',
      reviewReason: 'NON_UNIQUE_REVIEWED_COUNTERPART',
      candidateTargetCount: 2,
    },
  },
  {
    name: 'alternate identity conflict alongside same-ID drift',
    input: {
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: [
            targetIngredient({
              name: 'Different synthetic content',
              requiredQuantity: 3,
              unit: 'ml',
            }),
            targetIngredient({ ingredientId: 'ING_BETA' }),
          ],
        },
      ],
      productionRows: [productionRow()],
    },
    expected: {
      productionClass: 'SAME_ID_CONTENT_DRIFT',
      targetClass: 'AMBIGUOUS',
      driftKind: 'indeterminate',
      reviewReason: 'ALTERNATE_IDENTITY_CONTENT_CONFLICT',
      candidateTargetCount: 2,
    },
  },
  {
    name: 'cross-ID exact-content conflict without an approved bridge',
    input: {
      targetRecipes: [
        { id: RECIPE_ID, ingredients: [targetIngredient({ ingredientId: 'ING_BETA' })] },
      ],
      productionRows: [productionRow()],
    },
    expected: {
      productionClass: 'ID_CONFLICT_REVIEW_REQUIRED',
      targetClass: 'AMBIGUOUS',
      reviewReason: 'NO_UNIQUE_APPROVED_ID_BRIDGE',
      candidateTargetCount: 1,
    },
  },
  {
    name: 'excess semantic duplicates',
    input: {
      productionRows: [
        productionRow({ id: 'physical-semantic-duplicate-a' }),
        productionRow({ id: 'physical-semantic-duplicate-b' }),
      ],
    },
    expected: {
      productionClass: 'DUPLICATE_SEMANTIC_OCCURRENCE',
      targetClass: 'AMBIGUOUS',
      reviewReason: 'EXCESS_SEMANTIC_MULTIPLICITY',
      candidateTargetCount: 1,
      candidateProductionCount: 2,
    },
  },
  {
    name: 'balanced semantic duplicates remain multiset-only',
    input: {
      targetRecipes: [{ id: RECIPE_ID, ingredients: [targetIngredient(), targetIngredient()] }],
      productionRows: [
        productionRow({ id: 'physical-balanced-a' }),
        productionRow({ id: 'physical-balanced-b' }),
      ],
    },
    expected: {
      productionClass: 'EXACT_V1_MATCH',
      targetClass: 'SATISFIED_EXACT',
      reviewReason: 'PHYSICAL_MAPPING_UNKNOWN_FOR_DUPLICATES',
      candidateTargetCount: 2,
      candidateProductionCount: 2,
    },
  },
  {
    name: 'duplicate physical IDs are malformed evidence',
    input: {
      productionRows: [
        productionRow({ id: 'physical-duplicate-id' }),
        productionRow({ id: 'physical-duplicate-id', required_quantity: 3 }),
      ],
    },
    expected: {
      productionClass: 'MALFORMED_OCCURRENCE',
      targetClass: 'AMBIGUOUS',
      reviewReason: 'DUPLICATE_PHYSICAL_LINE_ID',
      candidateProductionCount: 2,
    },
  },
  {
    name: 'target-only occurrence has no production candidates',
    input: { productionRows: [] },
    expected: { targetClass: 'TARGET_ONLY_MISSING', candidateProductionCount: 0 },
  },
  {
    name: 'unverified capture leaves matching evidence ambiguous',
    input: { captureCounts: null },
    expected: {
      productionClass: 'AMBIGUOUS',
      targetClass: 'AMBIGUOUS',
      reviewReason: 'CAPTURE_COMPLETENESS_UNVERIFIED',
      candidateTargetCount: 1,
    },
  },
];

const malformedRows = [
  { name: 'unknown unit', overrides: { unit: 'cup' }, reason: 'UNKNOWN_UNIT' },
  { name: 'zero quantity', overrides: { required_quantity: 0 }, reason: 'INVALID_QUANTITY' },
  { name: 'negative quantity', overrides: { required_quantity: -1 }, reason: 'INVALID_QUANTITY' },
  {
    name: 'quantity at the exclusive upper bound',
    overrides: { required_quantity: 1e308 },
    reason: 'INVALID_QUANTITY',
  },
  {
    name: 'invalid optional encoding',
    overrides: { is_optional: true },
    reason: 'INVALID_OPTIONAL_ENCODING',
  },
  {
    name: 'invalid ingredient ID',
    overrides: { ingredient_id: 'lowercase_id' },
    reason: 'INVALID_INGREDIENT_ID',
  },
  {
    name: 'invalid recipe parent',
    overrides: { recipe_id: 'invalid recipe id' },
    reason: 'INVALID_RECIPE_ID',
  },
  { name: 'missing recipe parent', overrides: { recipe_id: null }, reason: 'INVALID_RECIPE_ID' },
  {
    name: 'uncaptured recipe parent',
    overrides: { recipe_id: 'recipe-uncaptured' },
    reason: 'BROKEN_RECIPE_REFERENCE',
  },
];

function scaleFixture() {
  const recipeIds = Array.from(
    { length: 500 },
    (_, index) => `recipe-scale-${String(index).padStart(3, '0')}`,
  );
  const targetRecipes = recipeIds.map((id) => ({
    id,
    ingredients: [],
  }));
  const locations = [];
  const productionRows = [];
  const units = ['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice'];

  for (let index = 0; index < 2702; index += 1) {
    const recipeIndex = index % recipeIds.length;
    const recipeId = recipeIds[recipeIndex];
    const ingredient = targetIngredient({
      ingredientId: `ING_SCALE_${String(index).padStart(5, '0')}`,
      name: `Synthetic scale ingredient ${index}`,
      requiredQuantity: (index % 50) + 1,
      unit: units[index % units.length],
      isOptional: index % 7 === 0,
    });
    const location = { recipeId, ingredient };
    targetRecipes[recipeIndex].ingredients.push(ingredient);
    locations.push(location);
    productionRows.push(productionFromTarget(location, `physical-scale-${index}`));
  }

  return { recipeIds, targetRecipes, productionRows, locations };
}

describe('T21RC2 offline reconciliation schema boundary', () => {
  it('accepts the deterministic reachable-classification corpus under the closed schema', () => {
    const seenProduction = new Set();
    const seenTarget = new Set();

    for (const scenario of classificationCorpus) {
      const manifest = assertSchemaAccepted(scenario.name, scenario.input);
      for (const row of manifest.production) seenProduction.add(row.classification);
      for (const row of manifest.target) seenTarget.add(row.classification);

      const production =
        scenario.expected.productionClass === undefined
          ? undefined
          : manifest.production.find(
              (row) => row.classification === scenario.expected.productionClass,
            );
      const target =
        scenario.expected.targetClass === undefined
          ? undefined
          : manifest.target.find((row) => row.classification === scenario.expected.targetClass);

      if (scenario.expected.productionClass !== undefined && production === undefined) {
        throw new Error(
          `${scenario.name}: missing production class ${scenario.expected.productionClass}`,
        );
      }
      if (scenario.expected.targetClass !== undefined && target === undefined) {
        throw new Error(`${scenario.name}: missing target class ${scenario.expected.targetClass}`);
      }
      if (scenario.expected.identityPopulation !== undefined) {
        expect(production?.identityPopulation, scenario.name).toBe(
          scenario.expected.identityPopulation,
        );
      }
      if (scenario.expected.driftKind !== undefined) {
        expect(
          manifest.production.some(
            (row) =>
              row.classification === 'SAME_ID_CONTENT_DRIFT' &&
              row.driftKind === scenario.expected.driftKind,
          ),
          scenario.name,
        ).toBe(true);
      }
      if (scenario.expected.reviewReason !== undefined) {
        expect(
          manifest.production.some((row) => row.reviewReason === scenario.expected.reviewReason),
          scenario.name,
        ).toBe(true);
      }
      if (scenario.expected.candidateTargetCount !== undefined) {
        expect(production?.candidateTargetOccurrenceKeys).toHaveLength(
          scenario.expected.candidateTargetCount,
        );
      }
      if (scenario.expected.candidateProductionCount !== undefined) {
        expect(target?.candidateProductionOccurrenceKeys).toHaveLength(
          scenario.expected.candidateProductionCount,
        );
      }
    }

    expect([...seenProduction].sort()).toEqual([...PRODUCTION_CLASSES].sort());
    expect([...seenTarget].sort()).toEqual([...TARGET_CLASSES].sort());
  });

  it('accepts malformed rows and local/global taint without emitting out-of-schema values', () => {
    for (const scenario of malformedRows) {
      const manifest = assertSchemaAccepted(scenario.name, {
        productionRows: [productionRow(scenario.overrides)],
      });
      expect(manifest.production[0].classification, scenario.name).toBe('MALFORMED_OCCURRENCE');
      expect(manifest.production[0].identityPopulation, scenario.name).toBe('MALFORMED');
      expect(manifest.production[0].reviewReason, scenario.name).toBe(scenario.reason);
      if (scenario.reason === 'BROKEN_RECIPE_REFERENCE') {
        expect(manifest.production[0].recipeId, scenario.name).toBeNull();
        expect(manifest.summary.unattributedProductionOccurrences).toBe(1);
      }
    }

    const local = assertSchemaAccepted('recipe-local malformed taint', {
      productionRows: [
        productionRow({ id: 'physical-local-valid' }),
        productionRow({ id: 'physical-local-malformed', unit: 'cup' }),
      ],
    });
    expect(
      local.production.some(
        (row) =>
          row.classification === 'AMBIGUOUS' &&
          row.reviewReason === 'MALFORMED_INPUT_PREVENTS_MEMBERSHIP_PROOF',
      ),
    ).toBe(true);
    expect(
      local.production.some(
        (row) =>
          row.classification === 'MALFORMED_OCCURRENCE' && row.reviewReason === 'UNKNOWN_UNIT',
      ),
    ).toBe(true);
    expect(local.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);

    const global = assertSchemaAccepted('global malformed taint from uncaptured parent', {
      targetRecipes: [
        { id: RECIPE_ID, ingredients: [targetIngredient()] },
        {
          id: 'recipe-synthetic-other',
          ingredients: [targetIngredient({ ingredientId: 'ING_BETA' })],
        },
      ],
      productionRecipeIds: [RECIPE_ID, 'recipe-synthetic-other'],
      productionRows: [productionRow({ recipe_id: 'recipe-outside-capture' })],
    });
    expect(global.production[0]).toMatchObject({
      classification: 'MALFORMED_OCCURRENCE',
      reviewReason: 'BROKEN_RECIPE_REFERENCE',
      recipeId: null,
    });
    expect(global.summary.unattributedProductionOccurrences).toBe(1);
    expect(global.target).toHaveLength(2);
    expect(global.target.every((row) => row.classification === 'AMBIGUOUS')).toBe(true);
  });

  it('covers 500 synthetic captured recipes and production counts at, above, and 3x the 2702 target size', () => {
    const scale = scaleFixture();
    const baseInput = {
      targetRecipes: scale.targetRecipes,
      productionRecipeIds: scale.recipeIds,
    };

    const equal = assertSchemaAccepted('500 recipes / 2702 production / 2702 target', {
      ...baseInput,
      productionRows: scale.productionRows,
    });
    expect(equal.recipes).toHaveLength(500);
    expect(equal.summary.productionOccurrenceCount).toBe(2702);
    expect(equal.summary.targetOccurrenceCount).toBe(2702);
    expect(equal.summary.productionClassCounts.EXACT_V1_MATCH).toBe(2702);
    expect(equal.summary.targetClassCounts.SATISFIED_EXACT).toBe(2702);

    const moderateIds = Array.from({ length: 300 }, (_, index) => `ING_CANON_SCALE_${index}`);
    const moderateExtras = moderateIds.map((ingredientId, index) =>
      productionRow({
        id: `physical-canonical-extra-${index}`,
        recipe_id: scale.recipeIds[index % scale.recipeIds.length],
        ingredient_id: ingredientId,
        name: `Canonical-only synthetic ${index}`,
      }),
    );
    const above = assertSchemaAccepted('500 recipes / 3002 production / 2702 target', {
      ...baseInput,
      productionRows: [...scale.productionRows, ...moderateExtras],
      canonicalIngredientIds: moderateIds,
    });
    expect(above.summary.productionOccurrenceCount).toBe(3002);
    expect(above.summary.targetOccurrenceCount).toBe(2702);
    expect(above.summary.productionClassCounts.PRODUCTION_ONLY_KNOWN_ID).toBe(300);
  });

  it('validates a mixed synthetic production corpus at 3x the 2702 target size', () => {
    const scale = scaleFixture();
    const baseInput = {
      targetRecipes: scale.targetRecipes,
      productionRecipeIds: scale.recipeIds,
    };
    expect(scale.recipeIds).toHaveLength(500);
    expect(scale.locations).toHaveLength(2702);

    const cleanLocations = scale.locations.filter(
      (location) => location.recipeId !== scale.recipeIds[0],
    );
    const driftRows = cleanLocations.slice(0, 900).map((location, index) =>
      productionFromTarget(location, `physical-stress-drift-${index}`, {
        required_quantity: location.ingredient.requiredQuantity + 0.5,
      }),
    );
    const unknownRows = Array.from({ length: 900 }, (_, index) => {
      const location = cleanLocations[(index * 3) % cleanLocations.length];
      return productionRow({
        id: `physical-stress-unknown-${index}`,
        recipe_id: location.recipeId,
        ingredient_id: `ING_UNKNOWN_STRESS_${index}`,
        name: `Unknown synthetic identity ${index}`,
      });
    });
    const malformedRowsInOneRecipe = Array.from({ length: 900 }, (_, index) =>
      productionRow({
        id: `physical-stress-malformed-${index}`,
        recipe_id: scale.recipeIds[0],
        ingredient_id: `ING_MALFORMED_STRESS_${index}`,
        name: `Malformed synthetic occurrence ${index}`,
        unit: 'cup',
      }),
    );
    const duplicateRows = cleanLocations
      .slice(900, 1800)
      .map((location, index) =>
        productionFromTarget(location, `physical-stress-semantic-duplicate-${index}`),
      );
    const physicalDuplicateRows = Array.from({ length: 150 }, (_, index) => [
      productionRow({
        id: `physical-stress-duplicate-id-${index}`,
        recipe_id: scale.recipeIds[0],
        ingredient_id: `ING_PHYSICAL_DUPLICATE_${index}`,
        name: `Physical duplicate ${index}`,
        required_quantity: 1,
      }),
      productionRow({
        id: `physical-stress-duplicate-id-${index}`,
        recipe_id: scale.recipeIds[0],
        ingredient_id: `ING_PHYSICAL_DUPLICATE_${index}`,
        name: `Physical duplicate ${index}`,
        required_quantity: 2,
      }),
    ]).flat();

    const knownIds = Array.from({ length: 1200 }, (_, index) => `ING_CANON_STRESS_${index}`);
    const knownRows = knownIds.map((ingredientId, index) =>
      productionRow({
        id: `physical-stress-known-${index}`,
        recipe_id: scale.recipeIds[25 + (index % (scale.recipeIds.length - 25))],
        ingredient_id: ingredientId,
        name: `Known canonical synthetic ${index}`,
      }),
    );
    const newBridges = Array.from({ length: 304 }, (_, index) =>
      reviewedNewBridge(
        `SOURCE_SCALE_NEW_${index}`,
        `ING_ENR_SCALE_NEW_${index}`,
        `scale-${index}`,
      ),
    );
    const newRows = newBridges.map((bridge, index) =>
      productionRow({
        id: `physical-stress-reviewed-new-${index}`,
        recipe_id: scale.recipeIds[25 + (index % (scale.recipeIds.length - 25))],
        ingredient_id: bridge.sourceId,
        name: `Reviewed new synthetic ${index}`,
      }),
    );
    const stressRows = [
      ...scale.productionRows,
      ...driftRows,
      ...unknownRows,
      ...malformedRowsInOneRecipe,
      ...duplicateRows,
      ...physicalDuplicateRows,
      ...knownRows,
      ...newRows,
    ];
    expect(stressRows).toHaveLength(8106);

    const stress = assertSchemaAccepted('500 recipes / 8106 production / 2702 target', {
      ...baseInput,
      productionRows: stressRows,
      canonicalIngredientIds: knownIds,
      reconciliation: newBridges,
    });
    expect(stress.recipes).toHaveLength(500);
    expect(stress.summary.productionOccurrenceCount).toBe(8106);
    expect(stress.summary.targetOccurrenceCount).toBe(2702);
    expect(stress.summary.productionClassCounts.SAME_ID_CONTENT_DRIFT).toBeGreaterThan(0);
    expect(stress.summary.productionClassCounts.DUPLICATE_SEMANTIC_OCCURRENCE).toBeGreaterThan(0);
    expect(stress.summary.productionClassCounts.MALFORMED_OCCURRENCE).toBe(1200);
    expect(stress.summary.productionClassCounts.PRODUCTION_ONLY_KNOWN_ID).toBe(1200);
    expect(stress.summary.productionClassCounts.PRODUCTION_ONLY_NEW_ID).toBe(304);
    expect(stress.summary.productionClassCounts.AMBIGUOUS).toBeGreaterThan(0);
  });

  it('accepts a target-only synthetic corpus of 500 recipes and 2702 occurrences', () => {
    const scale = scaleFixture();
    const baseInput = {
      targetRecipes: scale.targetRecipes,
      productionRecipeIds: scale.recipeIds,
    };
    const targetOnly = assertSchemaAccepted('500 recipes / 0 production / 2702 target', {
      ...baseInput,
      productionRows: [],
    });
    expect(targetOnly.summary.productionOccurrenceCount).toBe(0);
    expect(targetOnly.summary.targetOccurrenceCount).toBe(2702);
    expect(targetOnly.summary.targetClassCounts.TARGET_ONLY_MISSING).toBe(2702);
  });

  it('keeps target mapping unresolved when an unrelated unknown identity is also present', () => {
    const manifest = assertSchemaAccepted('one exact and one unrelated unknown occurrence', {
      targetRecipes: [{
        id: RECIPE_ID,
        ingredients: [targetIngredient({ name: 'Alpha', requiredQuantity: 1 })],
      }],
      productionRows: [
        productionRow({ id: 'physical-minimal-exact', name: 'Alpha', required_quantity: 1 }),
        productionRow({
          id: 'physical-minimal-unknown',
          ingredient_id: 'ING_SYNTH_UNKNOWN',
          name: 'Other',
          required_quantity: 2,
        }),
      ],
      canonicalIngredientIds: [INGREDIENT_ID],
    });
    expect(manifest.target).toHaveLength(1);
    expect(manifest.target[0]).toMatchObject({
      classification: 'AMBIGUOUS',
      confidence: 'REVIEW_REQUIRED',
      mapping: 'UNRESOLVED',
    });
    expect(manifest.target[0].candidateProductionOccurrenceKeys).toHaveLength(2);
  });

  it('keeps exact and bridged witnesses ambiguous with unresolved or cross-ID competitors', () => {
    const targetRecipes = [{
      id: RECIPE_ID,
      ingredients: [targetIngredient({ name: 'Alpha', requiredQuantity: 1 })],
    }];
    const exactWitness = productionRow({
      id: 'physical-exact-witness',
      name: 'Alpha',
      required_quantity: 1,
    });
    const bridgedWitness = productionRow({
      id: 'physical-bridged-witness',
      ingredient_id: 'ING_SOURCE_EXISTING',
      name: 'Alpha',
      required_quantity: 1,
    });
    const existingBridge = {
      sourceId: 'ING_SOURCE_EXISTING',
      canonicalId: INGREDIENT_ID,
      resolution: 'existing_canonical_id',
      review: null,
    };
    const competingRows = [
      {
        name: 'unknown identity',
        row: productionRow({
          id: 'physical-unknown-competitor',
          ingredient_id: 'ING_SYNTH_UNKNOWN',
          name: 'Other',
          required_quantity: 2,
        }),
        classification: 'AMBIGUOUS',
        identityPopulation: 'UNKNOWN_ID',
      },
      {
        name: 'unreviewed ING_ENR identity',
        row: productionRow({
          id: 'physical-unreviewed-competitor',
          ingredient_id: 'ING_ENR_UNREVIEWED',
          name: 'Other',
          required_quantity: 2,
        }),
        classification: 'AMBIGUOUS',
        identityPopulation: 'UNREVIEWED_ING_ENR',
      },
      {
        name: 'cross-ID content conflict',
        row: productionRow({
          id: 'physical-conflict-competitor',
          ingredient_id: 'ING_SYNTH_BETA',
          name: 'Alpha',
          required_quantity: 1,
        }),
        classification: 'ID_CONFLICT_REVIEW_REQUIRED',
      },
    ];

    for (const [witnessName, witness, witnessClass] of [
      ['exact', exactWitness, 'EXACT_V1_MATCH'],
      ['existing-canonical bridge', bridgedWitness, 'DETERMINISTIC_V1_COUNTERPART'],
    ]) {
      for (const competitor of competingRows) {
        const manifest = assertSchemaAccepted(`${witnessName} plus ${competitor.name}`, {
          targetRecipes,
          productionRows: [witness, competitor.row],
          canonicalIngredientIds: [INGREDIENT_ID],
          reconciliation: witness === bridgedWitness ? [existingBridge] : [],
        });
        const target = manifest.target[0];
        expect(manifest.production.map((row) => row.classification)).toContain(witnessClass);
        expect(manifest.production.map((row) => row.classification)).toContain(competitor.classification);
        if (competitor.identityPopulation) {
          expect(manifest.production.map((row) => row.identityPopulation)).toContain(
            competitor.identityPopulation,
          );
        }
        expect(target).toMatchObject({
          classification: 'AMBIGUOUS',
          confidence: 'REVIEW_REQUIRED',
          mapping: 'UNRESOLVED',
        });
        expect(target.candidateProductionOccurrenceKeys).toHaveLength(2);
      }
    }
  });

  it('preserves a unique exact target witness alongside same-ID quantity drift', () => {
    const manifest = assertSchemaAccepted('exact target with another same-ID quantity drift', {
      targetRecipes: [{
        id: RECIPE_ID,
        ingredients: [
          targetIngredient({ name: 'Alpha', requiredQuantity: 1 }),
          targetIngredient({ name: 'Alpha', requiredQuantity: 2 }),
        ],
      }],
      productionRows: [
        productionRow({ id: 'physical-a3-exact', name: 'Alpha', required_quantity: 1 }),
        productionRow({ id: 'physical-a3-drift', name: 'Alpha', required_quantity: 3 }),
      ],
    });
    const exactTarget = manifest.target.find((row) => row.classification === 'SATISFIED_EXACT');
    const ambiguousTarget = manifest.target.find((row) => row.classification === 'AMBIGUOUS');

    expect(manifest.target).toHaveLength(2);
    expect(exactTarget?.mapping).toBe('UNIQUE');
    expect(exactTarget?.candidateProductionOccurrenceKeys).toHaveLength(1);
    expect(ambiguousTarget?.mapping).toBe('UNRESOLVED');
    expect(manifest.production.some((row) => row.classification === 'SAME_ID_CONTENT_DRIFT')).toBe(true);
  });

  it('accepts a 2702-entry candidate array without truncating candidate evidence', () => {
    const repeatedTarget = targetIngredient();
    const manifest = assertSchemaAccepted('2702 target candidates for one production occurrence', {
      targetRecipes: [
        {
          id: RECIPE_ID,
          ingredients: Array.from({ length: 2702 }, () => ({ ...repeatedTarget })),
        },
      ],
      productionRows: [productionRow()],
    });

    expect(manifest.production).toHaveLength(1);
    expect(manifest.production[0].classification).toBe('SAME_ID_CONTENT_DRIFT');
    expect(manifest.production[0].candidateTargetOccurrenceKeys).toHaveLength(2702);
    expect(manifest.target).toHaveLength(2702);
    expect(manifest.target[0].candidateProductionOccurrenceKeys).toHaveLength(1);
  });
});
