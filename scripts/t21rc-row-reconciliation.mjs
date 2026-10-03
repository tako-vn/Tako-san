#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedIngredientBridgePair } from './t21rb-v1-semantic.mjs';

export const PRODUCTION_CLASSES = Object.freeze([
  'EXACT_V1_MATCH', 'SAME_ID_CONTENT_DRIFT', 'DETERMINISTIC_V1_COUNTERPART',
  'REVIEWED_ID_BRIDGE', 'PRODUCTION_ONLY_KNOWN_ID', 'PRODUCTION_ONLY_NEW_ID',
  'DUPLICATE_SEMANTIC_OCCURRENCE', 'MALFORMED_OCCURRENCE',
  'ID_CONFLICT_REVIEW_REQUIRED', 'AMBIGUOUS',
]);
export const TARGET_CLASSES = Object.freeze([
  'SATISFIED_EXACT', 'SATISFIED_DETERMINISTICALLY', 'TARGET_ONLY_MISSING', 'AMBIGUOUS',
]);
const IDENTITY_POPULATIONS = [
  'V1_ID', 'NON_V1_CANONICAL_ID', 'REVIEWED_NEW_ID', 'UNREVIEWED_ING_ENR', 'UNKNOWN_ID', 'MALFORMED',
];
const DRIFT_KINDS = [
  'quantity_only', 'unit_only', 'optional_only', 'quantity_unit', 'quantity_optional',
  'unit_optional', 'multi_field', 'membership_only', 'membership_plus_content',
  'name_only', 'name_plus_semantics', 'indeterminate',
];
const FIELDS = ['id', 'recipe_id', 'ingredient_id', 'name', 'required_quantity', 'unit', 'is_optional'];
const UNITS = new Set(['g', 'kg', 'ml', 'l', 'piece', 'pack', 'bunch', 'slice']);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const recipeIdValid = (value) => nonempty(value) && value.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const ingredientIdValid = (value) => nonempty(value) && value.length <= 100 && /^[A-Z][A-Z0-9_]*$/.test(value);
const quantityValid = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e308;
const textValid = (value) => nonempty(value) && value.trim().length <= 300;
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const zeros = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const digest = (value) => createHash('sha256').update(stable(value)).digest('hex');
export const serializeReconciliationManifest = (manifest) => `${stable(manifest)}\n`;
const identityKey = (line) => stable([line.recipeId, line.canonicalId ?? line.ingredientId]);
const tupleKey = (line, canonical = false) => stable([
  line.recipeId, canonical ? line.canonicalId : line.ingredientId,
  line.name, line.quantity, line.unit, line.optional,
]);
const contentKey = (line) => stable([line.recipeId, line.name, line.quantity, line.unit, line.optional]);

function group(lines, key) {
  const index = new Map();
  for (const line of lines) {
    const value = key(line);
    if (!index.has(value)) index.set(value, []);
    index.get(value).push(line);
  }
  return index;
}

function bridgeAuthority(rows, knownIds) {
  const eligible = rows.filter((row) => reviewedIngredientBridgePair(row) !== null
    && ingredientIdValid(row.canonicalId)
    && (row.resolution !== 'existing_canonical_id' || knownIds.has(row.canonicalId)));
  const forward = group(eligible, (row) => row.sourceId);
  const backward = group(eligible, (row) => row.canonicalId);
  const bridges = new Map();
  for (const [sourceId, candidates] of forward) {
    const ids = new Set(candidates.map((row) => row.canonicalId));
    const resolutions = new Set(candidates.map((row) => row.resolution));
    const canonicalId = candidates[0].canonicalId;
    if (ids.size !== 1 || resolutions.size !== 1
        || new Set(backward.get(canonicalId).map((row) => row.sourceId)).size !== 1) continue;
    bridges.set(sourceId, {
      canonicalId, resolution: candidates[0].resolution,
      evidenceSha256: digest(candidates.map((row) => ({
        sourceId: row.sourceId, canonicalId: row.canonicalId, resolution: row.resolution, review: row.review,
      })).sort((a, b) => order(stable(a), stable(b)))),
    });
  }
  return bridges;
}

function rowError(row, recipeIds, physicalCounts) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
      || !nonempty(row.id) || !textValid(row.name)) return 'INVALID_REQUIRED_FIELD';
  if (!recipeIdValid(row.recipe_id)) return 'INVALID_RECIPE_ID';
  if (!ingredientIdValid(row.ingredient_id)) return 'INVALID_INGREDIENT_ID';
  if (!quantityValid(row.required_quantity)) return 'INVALID_QUANTITY';
  if (!UNITS.has(row.unit)) return 'UNKNOWN_UNIT';
  if (row.is_optional !== 0 && row.is_optional !== 1) return 'INVALID_OPTIONAL_ENCODING';
  if (!recipeIds.has(row.recipe_id)) return 'BROKEN_RECIPE_REFERENCE';
  if (physicalCounts.get(row.id) !== 1) return 'DUPLICATE_PHYSICAL_LINE_ID';
  return null;
}

function comparisons(line, candidates, membership) {
  const consensus = (predicate) => {
    const values = new Set(candidates.map(predicate));
    return values.size === 1 ? [...values][0] : null;
  };
  return {
    recipe: consensus((target) => line.recipeId === target.recipeId),
    ingredientId: consensus((target) => line.ingredientId === target.ingredientId),
    canonicalIdentity: consensus((target) => line.canonicalId === target.ingredientId),
    name: consensus((target) => line.name === target.name),
    quantity: consensus((target) => line.quantity === target.quantity),
    unit: consensus((target) => line.unit === target.unit),
    optional: consensus((target) => line.optional === target.optional), membership,
  };
}

function driftKind(comparison) {
  const fields = ['name', 'quantity', 'unit', 'optional', 'membership'];
  if (fields.some((field) => comparison[field] === null)) return 'indeterminate';
  const changed = fields.filter((field) => comparison[field] === false);
  if (changed.includes('name')) return changed.length === 1 ? 'name_only' : 'name_plus_semantics';
  if (changed.includes('membership')) return changed.length === 1 ? 'membership_only' : 'membership_plus_content';
  if (changed.length > 2) return 'multi_field';
  return changed.length === 1 ? `${changed[0]}_only` : changed.join('_');
}

export function reconcileIngredientOccurrences({
  targetRecipes, productionRows, productionRecipeIds, canonicalIngredientIds = [], reconciliation = [],
  captureCounts = null,
}) {
  if (![targetRecipes, productionRows, productionRecipeIds, canonicalIngredientIds, reconciliation].every(Array.isArray)
      || productionRecipeIds.some((id) => !recipeIdValid(id))
      || new Set(productionRecipeIds).size !== productionRecipeIds.length
      || canonicalIngredientIds.some((id) => !ingredientIdValid(id))) throw new Error('Invalid evidence envelope');
  if (captureCounts !== null && (!captureCounts || typeof captureCounts !== 'object'
      || Object.keys(captureCounts).sort().join(',') !== 'ingredientOccurrenceCount,recipeCount'
      || !Number.isSafeInteger(captureCounts.recipeCount) || captureCounts.recipeCount < 0
      || !Number.isSafeInteger(captureCounts.ingredientOccurrenceCount) || captureCounts.ingredientOccurrenceCount < 0
      || captureCounts.recipeCount !== productionRecipeIds.length
      || captureCounts.ingredientOccurrenceCount !== productionRows.length)) {
    throw new Error('Incomplete or invalid capture counts');
  }
  // Count equality detects truncation, not live provenance or authenticity.
  const captureComplete = captureCounts !== null;
  const captureEvidence = {
    completeness: captureComplete ? 'COUNT_CONSISTENT_OFFLINE_INPUT' : 'UNVERIFIED',
    recipeCount: captureCounts?.recipeCount ?? null,
    ingredientOccurrenceCount: captureCounts?.ingredientOccurrenceCount ?? null,
  };
  const targetIds = new Set();
  const targetLines = [];
  for (const recipe of targetRecipes) {
    if (!recipeIdValid(recipe?.id) || targetIds.has(recipe.id) || !Array.isArray(recipe.ingredients)) {
      throw new Error('Invalid target authority');
    }
    targetIds.add(recipe.id);
    for (const ingredient of recipe.ingredients) {
      if (!ingredientIdValid(ingredient?.ingredientId) || !textValid(ingredient.name)
          || !quantityValid(ingredient.requiredQuantity) || !UNITS.has(ingredient.unit)
          || (ingredient.isOptional !== undefined && typeof ingredient.isOptional !== 'boolean')) {
        throw new Error('Invalid target authority');
      }
      targetLines.push({
        recipeId: recipe.id, ingredientId: ingredient.ingredientId, canonicalId: ingredient.ingredientId,
        name: ingredient.name, quantity: ingredient.requiredQuantity, unit: ingredient.unit,
        optional: ingredient.isOptional === true,
      });
    }
  }
  targetLines.sort((a, b) => order(tupleKey(a), tupleKey(b)));
  const targetOrdinals = new Map();
  for (const line of targetLines) {
    const key = tupleKey(line);
    const ordinal = (targetOrdinals.get(key) ?? 0) + 1;
    targetOrdinals.set(key, ordinal);
    line.occurrenceKey = `t:${digest(['T21RC_TARGET', key, ordinal])}`;
  }
  const v1Ids = new Set(targetLines.map((line) => line.ingredientId));
  const knownIds = new Set([...v1Ids, ...canonicalIngredientIds]);
  const bridges = bridgeAuthority(reconciliation, knownIds);
  const reviewedNewIds = new Set([...bridges.values()]
    .filter((bridge) => bridge.resolution === 'reviewed_new_canonical_id').map((bridge) => bridge.canonicalId));
  const capturedIds = new Set(productionRecipeIds);
  const physicalCounts = new Map();
  const rows = productionRows.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      if (Object.keys(row).some((field) => !FIELDS.includes(field) && field !== 'position')) {
        throw new Error('Unexpected production field');
      }
      if (nonempty(row.id)) physicalCounts.set(row.id, (physicalCounts.get(row.id) ?? 0) + 1);
      return Object.fromEntries(FIELDS.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]));
    }
    return row;
  }).sort((a, b) => order(stable(a), stable(b)));
  const physicalOrdinals = new Map();
  const taintedRecipes = new Set();
  let globalTaint = false;
  const lines = rows.map((row) => {
    const error = rowError(row, capturedIds, physicalCounts);
    const recipeId = recipeIdValid(row?.recipe_id) ? row.recipe_id : null;
    const ingredientId = ingredientIdValid(row?.ingredient_id) ? row.ingredient_id : null;
    const discriminator = nonempty(row?.id) ? [recipeId, row.id] : ['MALFORMED', row];
    const base = digest(['T21RC_PRODUCTION', discriminator]);
    const ordinal = (physicalOrdinals.get(base) ?? 0) + 1;
    physicalOrdinals.set(base, ordinal);
    if (error) {
      if (recipeId !== null && capturedIds.has(recipeId)) taintedRecipes.add(recipeId);
      else globalTaint = true;
    }
    const bridge = v1Ids.has(ingredientId) ? undefined : bridges.get(ingredientId);
    return {
      recipeId, ingredientId, canonicalId: bridge?.canonicalId ?? ingredientId,
      name: row?.name, quantity: row?.required_quantity, unit: row?.unit,
      optional: row?.is_optional === 1, error, bridge,
      occurrenceKey: `p:${base}:${ordinal}`,
    };
  });
  const valid = lines.filter((line) => !line.error);
  const targetByIdentity = group(targetLines, identityKey);
  const liveByIdentity = group(valid, identityKey);
  const targetByTuple = group(targetLines, (line) => tupleKey(line, true));
  const liveByTuple = group(valid, (line) => tupleKey(line, true));
  const targetByContent = group(targetLines, contentKey);
  const satisfied = new Map();
  const production = lines.map((line) => {
    const sameIdentity = targetByIdentity.get(identityKey(line)) ?? [];
    const exactContent = targetByTuple.get(tupleKey(line, true)) ?? [];
    const liveTuple = liveByTuple.get(tupleKey(line, true)) ?? [];
    const membership = sameIdentity.length === (liveByIdentity.get(identityKey(line))?.length ?? 0);
    const population = line.error ? 'MALFORMED'
      : v1Ids.has(line.canonicalId) ? 'V1_ID'
        : knownIds.has(line.canonicalId) ? 'NON_V1_CANONICAL_ID'
          : reviewedNewIds.has(line.canonicalId) ? 'REVIEWED_NEW_ID'
            : line.ingredientId.startsWith('ING_ENR_') ? 'UNREVIEWED_ING_ENR' : 'UNKNOWN_ID';
    const evidence = {
      // An uncaptured parent is malformed evidence, not an additional captured recipe.
      occurrenceKey: line.occurrenceKey, recipeId: capturedIds.has(line.recipeId) ? line.recipeId : null,
      productionIngredientId: line.ingredientId, targetIngredientId: null,
      candidateTargetOccurrenceKeys: [], classification: 'AMBIGUOUS', confidence: 'UNKNOWN',
      authority: ['V1_RELEASE'], mapping: 'UNRESOLVED',
      comparison: comparisons(line, [], null), identityPopulation: population,
      driftKind: null, reviewReason: 'UNRESOLVED_PRODUCTION_IDENTITY',
      bridgeEvidenceSha256: line.bridge?.evidenceSha256 ?? null,
    };
    const compare = (candidates, member) => {
      evidence.candidateTargetOccurrenceKeys = candidates.map((target) => target.occurrenceKey).sort();
      const ids = new Set(candidates.map((target) => target.ingredientId));
      evidence.targetIngredientId = ids.size === 1 ? [...ids][0] : null;
      evidence.comparison = comparisons(line, candidates, member);
    };
    if (line.error) {
      evidence.classification = 'MALFORMED_OCCURRENCE';
      evidence.confidence = 'REVIEW_REQUIRED'; evidence.authority = ['SCHEMA_CONTRACT'];
      evidence.reviewReason = line.error;
    } else if (!captureComplete) {
      compare(sameIdentity, null);
      evidence.authority.push('SCHEMA_CONTRACT');
      evidence.reviewReason = 'CAPTURE_COMPLETENESS_UNVERIFIED';
    } else if (globalTaint || taintedRecipes.has(line.recipeId)) {
      compare(sameIdentity, null);
      evidence.confidence = 'REVIEW_REQUIRED'; evidence.authority = ['V1_RELEASE', 'SCHEMA_CONTRACT'];
      evidence.reviewReason = 'MALFORMED_INPUT_PREVENTS_MEMBERSHIP_PROOF';
    } else if (exactContent.length > 0) {
      const exactTupleMultiplicityMatch = liveTuple.length === exactContent.length;
      compare(exactContent, membership && exactTupleMultiplicityMatch);
      const nonuniqueBridge = liveTuple.some((candidate) => candidate.bridge)
        && (liveTuple.length !== 1 || exactContent.length !== 1);
      if (liveTuple.length > exactContent.length) {
        compare(sameIdentity, false);
        evidence.classification = 'DUPLICATE_SEMANTIC_OCCURRENCE';
        evidence.confidence = 'REVIEW_REQUIRED'; evidence.reviewReason = 'EXCESS_SEMANTIC_MULTIPLICITY';
      } else if (nonuniqueBridge || (line.bridge && !evidence.comparison.membership)) {
        compare(sameIdentity, evidence.comparison.membership);
        evidence.confidence = 'REVIEW_REQUIRED'; evidence.authority.push('REVIEWED_RECONCILIATION');
        evidence.reviewReason = 'NON_UNIQUE_REVIEWED_COUNTERPART';
      } else if (!membership || !exactTupleMultiplicityMatch) {
        compare(sameIdentity, false);
        evidence.classification = 'SAME_ID_CONTENT_DRIFT'; evidence.confidence = 'REVIEW_REQUIRED';
        evidence.driftKind = driftKind(evidence.comparison);
        evidence.reviewReason = 'CONTENT_OR_MEMBERSHIP_DRIFT';
      } else {
        evidence.classification = line.bridge
          ? line.bridge.resolution === 'existing_canonical_id' ? 'DETERMINISTIC_V1_COUNTERPART' : 'REVIEWED_ID_BRIDGE'
          : 'EXACT_V1_MATCH';
        evidence.mapping = exactContent.length === 1 ? 'UNIQUE' : 'MULTISET_ONLY';
        evidence.confidence = exactContent.length === 1 ? 'DETERMINISTIC' : 'REVIEW_REQUIRED';
        evidence.reviewReason = exactContent.length === 1 ? null : 'PHYSICAL_MAPPING_UNKNOWN_FOR_DUPLICATES';
        if (line.bridge) evidence.authority.push('REVIEWED_RECONCILIATION');
        for (const target of exactContent) satisfied.set(target.occurrenceKey, {
          classification: line.bridge ? 'SATISFIED_DETERMINISTICALLY' : 'SATISFIED_EXACT',
          confidence: evidence.confidence, mapping: evidence.mapping, authority: evidence.authority,
          reviewReason: evidence.reviewReason,
        });
      }
    } else if (sameIdentity.length > 0) {
      compare(sameIdentity, membership);
      evidence.reviewReason = 'CONTENT_OR_MEMBERSHIP_DRIFT';
      if (line.bridge) {
        evidence.authority.push('REVIEWED_RECONCILIATION'); evidence.confidence = 'REVIEW_REQUIRED';
        evidence.reviewReason = 'BRIDGE_CONTENT_DOES_NOT_MATCH_V1';
      } else {
        evidence.classification = 'SAME_ID_CONTENT_DRIFT'; evidence.driftKind = driftKind(evidence.comparison);
        const unique = sameIdentity.length === 1 && liveByIdentity.get(identityKey(line)).length === 1;
        evidence.confidence = unique ? 'DETERMINISTIC' : 'REVIEW_REQUIRED';
        evidence.mapping = unique ? 'UNIQUE' : 'UNRESOLVED';
      }
    } else {
      const conflicts = (targetByContent.get(contentKey(line)) ?? [])
        .filter((target) => target.ingredientId !== line.ingredientId);
      if (conflicts.length > 0) {
        compare(conflicts, false); evidence.classification = 'ID_CONFLICT_REVIEW_REQUIRED';
        evidence.confidence = 'REVIEW_REQUIRED'; evidence.authority.push('REVIEWED_RECONCILIATION');
        evidence.reviewReason = 'NO_UNIQUE_APPROVED_ID_BRIDGE';
      } else if (knownIds.has(line.canonicalId) || reviewedNewIds.has(line.canonicalId)) {
        evidence.classification = knownIds.has(line.canonicalId) ? 'PRODUCTION_ONLY_KNOWN_ID' : 'PRODUCTION_ONLY_NEW_ID';
        evidence.confidence = 'DETERMINISTIC'; evidence.mapping = 'NONE'; evidence.reviewReason = null;
        evidence.comparison.membership = false;
        evidence.authority.push(reviewedNewIds.has(line.canonicalId) || line.bridge ? 'REVIEWED_RECONCILIATION' : 'CANONICAL_REGISTRY');
      }
    }
    return evidence;
  }).sort((a, b) => order(a.recipeId ?? '', b.recipeId ?? '') || order(a.occurrenceKey, b.occurrenceKey));

  const lineByOccurrence = new Map(valid.map((line) => [line.occurrenceKey, line]));
  const targetByOccurrence = new Map(targetLines.map((line) => [line.occurrenceKey, line]));
  for (const evidence of production) {
    if (!captureComplete || globalTaint || taintedRecipes.has(evidence.recipeId)
        || !['SAME_ID_CONTENT_DRIFT', 'DUPLICATE_SEMANTIC_OCCURRENCE', 'AMBIGUOUS'].includes(evidence.classification)) continue;
    const line = lineByOccurrence.get(evidence.occurrenceKey);
    const alternatives = (targetByContent.get(contentKey(line)) ?? [])
      .filter((candidate) => candidate.ingredientId !== line.canonicalId);
    if (alternatives.length === 0) continue;
    // Primary drift evidence must not hide an alternate cross-ID content conflict.
    const keys = [...new Set([...evidence.candidateTargetOccurrenceKeys,
      ...alternatives.map((candidate) => candidate.occurrenceKey)])].sort();
    const candidates = keys.map((key) => targetByOccurrence.get(key));
    const ids = new Set(candidates.map((candidate) => candidate.ingredientId));
    evidence.candidateTargetOccurrenceKeys = keys;
    evidence.targetIngredientId = ids.size === 1 ? [...ids][0] : null;
    evidence.comparison = comparisons(line, candidates, null);
    evidence.confidence = 'REVIEW_REQUIRED'; evidence.mapping = 'UNRESOLVED';
    evidence.authority = [...new Set([...evidence.authority, 'REVIEWED_RECONCILIATION'])];
    evidence.reviewReason = 'ALTERNATE_IDENTITY_CONTENT_CONFLICT';
    if (evidence.classification === 'SAME_ID_CONTENT_DRIFT') evidence.driftKind = 'indeterminate';
  }

  const target = targetLines.map((line) => {
    const explicitCandidates = production.filter((row) => row.candidateTargetOccurrenceKeys.includes(line.occurrenceKey));
    const unresolved = production.filter((row) => row.recipeId === line.recipeId
      && (row.classification === 'MALFORMED_OCCURRENCE'
        || ['UNKNOWN_ID', 'UNREVIEWED_ING_ENR'].includes(row.identityPopulation)));
    const candidates = [...new Set([...explicitCandidates, ...unresolved].map((row) => row.occurrenceKey))].sort();
    const tainted = !captureComplete || globalTaint || taintedRecipes.has(line.recipeId);
    const assigned = satisfied.get(line.occurrenceKey);
    return {
      occurrenceKey: line.occurrenceKey, recipeId: line.recipeId, targetIngredientId: line.ingredientId,
      candidateProductionOccurrenceKeys: candidates,
      classification: assigned?.classification ?? (tainted || candidates.length > 0 ? 'AMBIGUOUS' : 'TARGET_ONLY_MISSING'),
      confidence: assigned?.confidence ?? (tainted || candidates.length > 0 ? 'REVIEW_REQUIRED' : 'DETERMINISTIC'),
      authority: assigned?.authority ?? (tainted ? ['V1_RELEASE', 'SCHEMA_CONTRACT'] : ['V1_RELEASE']),
      mapping: assigned?.mapping ?? (tainted || candidates.length > 0 ? 'UNRESOLVED' : 'NONE'),
      reviewReason: assigned ? assigned.reviewReason : (!captureComplete ? 'CAPTURE_COMPLETENESS_UNVERIFIED'
        : tainted ? 'MALFORMED_INPUT_PREVENTS_ABSENCE_PROOF'
        : explicitCandidates.length > 0 ? 'UNSATISFIED_COUNTERPART_REQUIRES_REVIEW'
          : unresolved.length > 0 ? 'UNRESOLVED_PRODUCTION_IDENTITY' : null),
    };
  }).sort((a, b) => order(a.recipeId, b.recipeId) || order(a.occurrenceKey, b.occurrenceKey));

  const countClasses = (records, classes) => {
    const counts = zeros(classes);
    for (const row of records) counts[row.classification] += 1;
    return counts;
  };
  const productionClassCounts = countClasses(production, PRODUCTION_CLASSES);
  const targetClassCounts = countClasses(target, TARGET_CLASSES);
  const recipeIds = [...new Set([...targetIds, ...capturedIds, ...production.map((row) => row.recipeId).filter(Boolean)])].sort();
  const recipes = recipeIds.map((recipeId) => {
    const live = production.filter((row) => row.recipeId === recipeId);
    const expected = target.filter((row) => row.recipeId === recipeId);
    const p = countClasses(live, PRODUCTION_CLASSES), t = countClasses(expected, TARGET_CLASSES);
    const allSatisfied = t.TARGET_ONLY_MISSING === 0 && t.AMBIGUOUS === 0;
    const allMapped = live.every((row) => ['EXACT_V1_MATCH', 'DETERMINISTIC_V1_COUNTERPART', 'REVIEWED_ID_BRIDGE'].includes(row.classification));
    const uncertain = t.AMBIGUOUS + p.AMBIGUOUS + p.MALFORMED_OCCURRENCE
      + p.ID_CONFLICT_REVIEW_REQUIRED + p.DUPLICATE_SEMANTIC_OCCURRENCE;
    const status = !captureComplete ? 'AMBIGUOUS' : allSatisfied && allMapped
      ? p.DETERMINISTIC_V1_COUNTERPART + p.REVIEWED_ID_BRIDGE > 0 ? 'DETERMINISTICALLY_RECONCILABLE' : 'EXACT_V1_PARITY'
      : uncertain > 0 ? 'AMBIGUOUS'
        : t.SATISFIED_EXACT + t.SATISFIED_DETERMINISTICALLY > 0 ? 'PARTIALLY_RECONCILABLE' : 'SEVERELY_DIVERGED';
    return {
      recipeId, status, productionOccurrenceCount: live.length, targetOccurrenceCount: expected.length,
      exactMatchCount: p.EXACT_V1_MATCH, deterministicCounterpartCount: p.DETERMINISTIC_V1_COUNTERPART,
      reviewedBridgeCount: p.REVIEWED_ID_BRIDGE, sameIdDriftCount: p.SAME_ID_CONTENT_DRIFT,
      productionOnlyCount: p.PRODUCTION_ONLY_KNOWN_ID + p.PRODUCTION_ONLY_NEW_ID,
      targetOnlyCount: t.TARGET_ONLY_MISSING, ambiguousProductionCount: p.AMBIGUOUS,
      ambiguousTargetCount: t.AMBIGUOUS, reviewRequiredCount: live.filter((row) => row.confidence === 'REVIEW_REQUIRED').length,
      productionClassCounts: p, targetClassCounts: t,
    };
  });
  const driftBreakdown = zeros(DRIFT_KINDS), identityPopulations = zeros(IDENTITY_POPULATIONS);
  const populations = { deterministic: 0, reviewRequired: 0, unknown: 0 };
  for (const row of production) {
    identityPopulations[row.identityPopulation] += 1;
    populations[row.confidence === 'DETERMINISTIC' ? 'deterministic' : row.confidence === 'REVIEW_REQUIRED' ? 'reviewRequired' : 'unknown'] += 1;
    if (row.driftKind !== null) driftBreakdown[row.driftKind] += 1;
  }
  const rawTargetBags = group(targetLines, tupleKey), rawLiveBags = group(valid, tupleKey);
  const exactTupleMatches = [...rawLiveBags].reduce((sum, [key, bag]) => sum + Math.min(bag.length, rawTargetBags.get(key)?.length ?? 0), 0);
  const bridgedTupleMatches = productionClassCounts.DETERMINISTIC_V1_COUNTERPART + productionClassCounts.REVIEWED_ID_BRIDGE;
  const rawIdentity = group(targetLines, (line) => stable([line.recipeId, line.ingredientId]));
  const sameIdContentDrift = valid.filter((line) => rawIdentity.has(stable([line.recipeId, line.ingredientId]))
    && !rawTargetBags.has(tupleKey(line))).length;
  const idConflictReviewRequired = valid.filter((line) => !rawTargetBags.has(tupleKey(line))
    && !rawIdentity.has(stable([line.recipeId, line.ingredientId]))
    && (targetByContent.get(contentKey(line)) ?? []).some((candidate) => candidate.ingredientId !== line.ingredientId
      && line.bridge?.canonicalId !== candidate.ingredientId)).length;
  const summary = {
    productionOccurrenceCount: productionRows.length, targetOccurrenceCount: targetLines.length,
    productionClassCounts, targetClassCounts,
    accounting: {
      productionClassSum: Object.values(productionClassCounts).reduce((sum, count) => sum + count, 0),
      targetClassSum: Object.values(targetClassCounts).reduce((sum, count) => sum + count, 0),
      productionAccounted: production.length === productionRows.length,
      targetAccounted: target.length === targetLines.length,
    },
    recipeIdSetMatch: targetIds.size === capturedIds.size && [...targetIds].every((id) => capturedIds.has(id)),
    unattributedProductionOccurrences: production.filter((row) => row.recipeId === null).length,
    populations, identityPopulations, driftBreakdown,
    driftRecipeCount: recipes.filter((recipe) => recipe.sameIdDriftCount > 0).length,
    largestDriftRecipes: recipes.filter((recipe) => recipe.sameIdDriftCount > 0)
      .sort((a, b) => b.sameIdDriftCount - a.sameIdDriftCount || order(a.recipeId, b.recipeId))
      .slice(0, 10).map((recipe) => ({ recipeId: recipe.recipeId, count: recipe.sameIdDriftCount })),
    idConflictOccurrenceKeys: production.filter((row) => row.classification === 'ID_CONFLICT_REVIEW_REQUIRED'
      || row.reviewReason === 'ALTERNATE_IDENTITY_CONTENT_CONFLICT').map((row) => row.occurrenceKey),
    baselineComparison: {
      exactTupleMatches, bridgedTupleMatches, sameIdContentDrift, idConflictReviewRequired,
      unmatchedProductionLines: productionRows.length - exactTupleMatches - bridgedTupleMatches,
      unmatchedTargetLines: targetLines.length - exactTupleMatches - bridgedTupleMatches,
    },
  };
  if (!summary.accounting.productionAccounted || !summary.accounting.targetAccounted
      || summary.accounting.productionClassSum !== productionRows.length
      || summary.accounting.targetClassSum !== targetLines.length
      || new Set(production.map((row) => row.occurrenceKey)).size !== production.length
      || new Set(target.map((row) => row.occurrenceKey)).size !== target.length) throw new Error('Occurrence accounting failed');
  return {
    schemaVersion: 1, mode: 'OFFLINE_EVIDENCE_ONLY', certification: 'NOT_A_RELEASE_CERTIFICATION',
    runtimePositionAuthority: false, repairAuthorized: false, t21gStatus: 'T21G_NOT_READY',
    authorityProof: null, captureEvidence, production, target, recipes, summary,
    digests: {
      occurrenceSha256: digest({ recipeIds: [...capturedIds].sort(), rows, captureEvidence }),
      semanticSha256: digest(valid.map((line) => tupleKey(line)).sort()),
      classificationSha256: digest({ captureEvidence, production, target, recipes, summary }),
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--input' || !args[1]) {
    console.error('usage: node scripts/t21rc-row-reconciliation.mjs --input <saved-minimal-occurrences.json>');
    process.exitCode = 2;
  } else {
    try {
      const input = JSON.parse(readFileSync(args[1], 'utf8'));
      if (!input || !['occurrences,recipeIds', 'captureCounts,occurrences,recipeIds']
        .includes(Object.keys(input).sort().join(','))) throw new Error('Invalid evidence envelope');
      const { loadCertifiedV1Authority } = await import('./t21r-v1-authority.mjs');
      const authority = await loadCertifiedV1Authority();
      const manifest = reconcileIngredientOccurrences({
        ...authority, productionRows: input.occurrences, productionRecipeIds: input.recipeIds,
        captureCounts: input.captureCounts ?? null,
      });
      manifest.authorityProof = authority.authorityProof;
      process.stdout.write(serializeReconciliationManifest(manifest));
    } catch (error) {
      console.error(error?.message === 'T21RC_AUTHORITY_CONTRADICTION'
        ? 't21rc=T21RC_AUTHORITY_CONTRADICTION' : 't21rc=BLOCKED_OFFLINE_INPUT_OR_AUTHORITY');
      process.exitCode = 1;
    }
  }
}
