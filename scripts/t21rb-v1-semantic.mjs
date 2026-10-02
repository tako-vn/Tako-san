import { createHash } from 'node:crypto';

const RELEASE_ID = 'rel-bd00a4f53fcaeee4';
const RELEASE_FINGERPRINT = 'f8cf8c7ff59df9fe29e246b9e3c9aad0fd155fa8df35bf671ac4d03fa2b5ab37';
const RELEASE_COUNT = 500;
const UNITS = new Set(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']);
const RUNTIME_FIELDS = [
  'id', 'slug', 'title', 'description', 'cuisine', 'category', 'region',
  'cookTimeMinutes', 'servings', 'difficulty', 'imageUrl', 'nutrition',
  'ingredients', 'steps', 'tags',
];

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(recipes) {
  const projection = recipes.map((recipe) => Object.fromEntries(
    RUNTIME_FIELDS.filter((field) => recipe[field] !== undefined).map((field) => [field, recipe[field]]),
  ));
  return createHash('sha256').update(stable(projection)).digest('hex');
}

function verifyRelease(targetRecipes, releaseManifest) {
  if (!Array.isArray(targetRecipes) || targetRecipes.length !== RELEASE_COUNT
      || !releaseManifest || releaseManifest.releaseId !== RELEASE_ID
      || releaseManifest.expectedRecipeCount !== RELEASE_COUNT
      || releaseManifest.expectedRuntimeFingerprint !== RELEASE_FINGERPRINT
      || !Array.isArray(releaseManifest.orderedRecipeIds)
      || releaseManifest.orderedRecipeIds.length !== RELEASE_COUNT
      || targetRecipes.some((recipe, index) => recipe?.id !== releaseManifest.orderedRecipeIds[index])
      || new Set(releaseManifest.orderedRecipeIds).size !== RELEASE_COUNT
      || fingerprint(targetRecipes) !== RELEASE_FINGERPRINT) {
    throw new Error('Certified V1 release proof does not match the target recipes');
  }
}

function rowsOf(statement) {
  if (!statement || statement.success !== true || !Array.isArray(statement.results)) {
    throw new Error('Five-statement runtime snapshot is incomplete');
  }
  return statement.results;
}

function optionalBit(value) {
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

function parseLine(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || !['id', 'recipe_id', 'ingredient_id', 'name'].every((field) => isNonempty(row[field]))
      || !UNITS.has(row.unit)
      || typeof row.required_quantity !== 'number' || !Number.isFinite(row.required_quantity)
      || row.required_quantity <= 0) return null;
  const optional = optionalBit(row.is_optional);
  if (optional === null) return null;
  return {
    physicalId: row.id, recipeId: row.recipe_id, ingredientId: row.ingredient_id,
    name: row.name, quantity: row.required_quantity, unit: row.unit, optional,
  };
}

function exactKey(line) {
  return JSON.stringify([line.recipeId, line.ingredientId, line.name, line.quantity, line.unit, line.optional]);
}

function contentKey(line) {
  return JSON.stringify([line.recipeId, line.name, line.quantity, line.unit, line.optional]);
}

function isNonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function bridgePair(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || !isNonempty(row.sourceId) || !isNonempty(row.canonicalId)
      || row.sourceId === row.canonicalId) return null;
  if (row.resolution === 'existing_canonical_id' && row.review === null) {
    return [row.sourceId, row.canonicalId];
  }
  if (row.resolution === 'reviewed_new_canonical_id' && row.canonicalId.startsWith('ING_ENR_')
      && row.review && typeof row.review === 'object' && !Array.isArray(row.review)
      && Object.keys(row.review).sort().join(',') === 'basis,evidenceReference'
      && isNonempty(row.review.basis) && isNonempty(row.review.evidenceReference)) {
    return [row.sourceId, row.canonicalId];
  }
  return null;
}

export { bridgePair as reviewedIngredientBridgePair };

function uniqueBridges(reconciliation) {
  if (!Array.isArray(reconciliation)) throw new Error('Reconciliation input must be an array');
  const forward = new Map();
  const backward = new Map();
  for (const row of reconciliation) {
    const pair = bridgePair(row);
    if (!pair) continue;
    const [source, target] = pair;
    if (!forward.has(source)) forward.set(source, new Set());
    if (!backward.has(target)) backward.set(target, new Set());
    forward.get(source).add(target);
    backward.get(target).add(source);
  }
  return (source, target) => forward.get(source)?.size === 1
    && forward.get(source).has(target)
    && backward.get(target)?.size === 1;
}

function targetLinesOf(recipes) {
  const lines = [];
  for (const recipe of recipes) {
    for (const ingredient of recipe.ingredients) {
      lines.push({
        recipeId: recipe.id, ingredientId: ingredient.ingredientId, name: ingredient.name,
        quantity: ingredient.requiredQuantity, unit: ingredient.unit,
        optional: ingredient.isOptional === true,
      });
    }
  }
  return lines;
}

/**
 * Offline, aggregate-only V1 ingredient comparison. The five statements use the
 * prepareRecipeContentRead order. Positions are observed but never reconstructed.
 */
export function compareV1IngredientSemantics({
  targetRecipes, runtimeResults, releaseManifest, reconciliation = [],
}) {
  verifyRelease(targetRecipes, releaseManifest);
  if (!Array.isArray(runtimeResults) || runtimeResults.length !== 5) {
    throw new Error('Five-statement runtime snapshot is incomplete');
  }
  const [rawRecipes, rawLines] = runtimeResults.map(rowsOf);
  const targetLines = targetLinesOf(targetRecipes);
  const targetRecipeIds = new Set(releaseManifest.orderedRecipeIds);
  const recipeIds = new Set();
  let malformedRecipeRows = 0;
  for (const row of rawRecipes) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || !isNonempty(row.id) || recipeIds.has(row.id)) {
      malformedRecipeRows += 1;
    } else {
      recipeIds.add(row.id);
    }
  }
  const recipeIdSetMatch = malformedRecipeRows === 0 && recipeIds.size === RELEASE_COUNT
    && [...recipeIds].every((id) => targetRecipeIds.has(id));

  const physicalCounts = new Map();
  for (const row of rawLines) {
    if (isNonempty(row?.id)) physicalCounts.set(row.id, (physicalCounts.get(row.id) ?? 0) + 1);
  }
  const duplicatePhysicalLineIds = [...physicalCounts.values()].filter((count) => count > 1).length;
  let malformedIngredientRows = 0;
  let unknownParentLines = 0;
  let missingIngredientPositions = 0;
  let invalidIngredientPositions = 0;
  const liveLines = [];
  for (const row of rawLines) {
    if (row?.position === null || row?.position === undefined) missingIngredientPositions += 1;
    else if (!Number.isInteger(row.position) || row.position < 0) invalidIngredientPositions += 1;
    const line = parseLine(row);
    if (!line || physicalCounts.get(line.physicalId) !== 1) {
      malformedIngredientRows += 1;
      continue;
    }
    if (!recipeIds.has(line.recipeId) || !targetRecipeIds.has(line.recipeId)) {
      unknownParentLines += 1;
      continue;
    }
    liveLines.push(line);
  }

  const targetBags = new Map();
  for (const line of targetLines) {
    const key = exactKey(line);
    if (!targetBags.has(key)) targetBags.set(key, []);
    targetBags.get(key).push(line);
  }
  const liveBags = new Map();
  for (const line of liveLines) {
    const key = exactKey(line);
    if (!liveBags.has(key)) liveBags.set(key, []);
    liveBags.get(key).push(line);
  }
  const duplicateTupleOccurrences = [...liveBags.values()]
    .filter((bag) => bag.length > 1).reduce((sum, bag) => sum + bag.length, 0);
  const unmatchedLive = [];
  const unmatchedTarget = [];
  let exactTupleMatches = 0;
  for (const [key, live] of liveBags) {
    const target = targetBags.get(key) ?? [];
    const count = Math.min(live.length, target.length);
    exactTupleMatches += count;
    unmatchedLive.push(...live.slice(count));
    targetBags.set(key, target.slice(count));
  }
  for (const target of targetBags.values()) unmatchedTarget.push(...target);

  const canBridge = uniqueBridges(reconciliation);
  const targetByContent = new Map();
  for (const line of unmatchedTarget) {
    const key = contentKey(line);
    if (!targetByContent.has(key)) targetByContent.set(key, []);
    targetByContent.get(key).push(line);
  }
  const bridgeCandidates = new Map();
  for (const live of unmatchedLive) {
    bridgeCandidates.set(live, (targetByContent.get(contentKey(live)) ?? [])
      .filter((target) => canBridge(live.ingredientId, target.ingredientId)));
  }
  const reverseCounts = new Map();
  for (const candidates of bridgeCandidates.values()) {
    for (const candidate of candidates) reverseCounts.set(candidate, (reverseCounts.get(candidate) ?? 0) + 1);
  }
  const bridgedLive = new Set();
  const bridgedTarget = new Set();
  let ambiguousBridgeCandidates = 0;
  for (const [live, candidates] of bridgeCandidates) {
    if (candidates.length === 1 && reverseCounts.get(candidates[0]) === 1) {
      bridgedLive.add(live);
      bridgedTarget.add(candidates[0]);
    } else if (candidates.length > 0) {
      ambiguousBridgeCandidates += 1;
    }
  }
  const remainingLive = unmatchedLive.filter((line) => !bridgedLive.has(line));
  const remainingTarget = unmatchedTarget.filter((line) => !bridgedTarget.has(line));
  const targetByIdentity = new Set(targetLines.map((line) => JSON.stringify([line.recipeId, line.ingredientId])));
  const targetByContentAll = new Map();
  for (const line of targetLines) {
    const key = contentKey(line);
    if (!targetByContentAll.has(key)) targetByContentAll.set(key, new Set());
    targetByContentAll.get(key).add(line.ingredientId);
  }
  let sameIdContentDrift = 0;
  let idConflictReviewRequired = 0;
  for (const line of remainingLive) {
    if (targetByIdentity.has(JSON.stringify([line.recipeId, line.ingredientId]))
        && !targetLines.some((target) => exactKey(target) === exactKey(line))) {
      sameIdContentDrift += 1;
    } else if ([...(targetByContentAll.get(contentKey(line)) ?? [])]
      .some((targetId) => targetId !== line.ingredientId && !canBridge(line.ingredientId, targetId))) {
      idConflictReviewRequired += 1;
    }
  }
  const bridgedTupleMatches = bridgedLive.size;
  const unmatchedProductionLines = remainingLive.length + malformedIngredientRows + unknownParentLines;
  const unmatchedTargetLines = remainingTarget.length;
  const semanticParity = recipeIdSetMatch && bridgedTupleMatches === 0
    && unmatchedProductionLines === 0 && unmatchedTargetLines === 0;
  const manualReviewRequired = !semanticParity || missingIngredientPositions > 0
    || invalidIngredientPositions > 0
    || duplicateTupleOccurrences > 0 || duplicatePhysicalLineIds > 0;
  return {
    status: semanticParity ? 'V1_INGREDIENT_SEMANTICS_MATCH' : 'V1_INGREDIENT_SEMANTICS_UNRESOLVED',
    release: {
      releaseId: RELEASE_ID, targetRecipeCount: RELEASE_COUNT,
      targetIngredientLines: targetLines.length, fingerprintVerified: true,
    },
    snapshot: {
      recipeRows: rawRecipes.length, ingredientRows: rawLines.length,
      malformedRecipeRows, malformedIngredientRows, duplicatePhysicalLineIds,
      unknownParentLines, missingIngredientPositions, invalidIngredientPositions, recipeIdSetMatch,
    },
    comparison: {
      exactTupleMatches, bridgedTupleMatches, unmatchedProductionLines, unmatchedTargetLines,
      sameIdContentDrift, idConflictReviewRequired, ambiguousBridgeCandidates,
      duplicateTupleOccurrences,
    },
    semanticParity, manualReviewRequired, runtimePositionAuthority: false, repairAuthorized: false,
  };
}
