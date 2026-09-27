import { z } from 'zod';
import { compareIds } from '../../domain/src/availability';
import { generateRecipeCandidates, type RecipeCandidate } from './candidates';
import type { RecipeCatalogSnapshot } from './catalog';
import { RankingContextSchema, RankingPreferencesSchema } from './personalization';
import { createRankingEvidenceSnapshot } from './ranking-evidence';
import { rankRecipeCandidates } from './ranking';
import { freezePlanningValue, planningFingerprint, readPlanningContext } from './planner-context';
import { applyProjectedConsumption, InventoryProjectionNumericError, projectInventoryRows, type ProjectedInventory } from './planner-inventory';
import { summarizePlanNutrition, type PlanNutritionSummary } from './planner-nutrition';
import { DEFAULT_PLANNER_POLICY, PlannerPolicySchema, type PlannerPolicy } from './planner-policy';
import { normalizePlannerRequest, type NormalizedPlannerSlot, type PlannerLock } from './planner-request';
import { aggregatePlanShortages, emptyPlanUtility, futureMealUtility, totalPlanUtility } from './planner-utility';
import type { PlannedMeal, PlannerDiagnostic, PlannerIncompleteReason, PlannerSearchMetadata, PlanUtilityComponents, WeeklyMealPlan, WeeklyPlanningInput } from './planner-types';

interface SearchState {
  inventory: ProjectedInventory;
  meals: PlannedMeal[];
  components: PlanUtilityComponents;
  nutrition: PlanNutritionSummary;
  score: number;
  path: string;
}
const compareStates = (a: SearchState, b: SearchState) => b.meals.length - a.meals.length || b.score - a.score || compareIds(a.path, b.path);

function matchesLock(candidate: RecipeCandidate, lock: PlannerLock): boolean {
  return candidate.source.kind === lock.kind && candidate.source.sourceId === lock.id &&
    candidate.source.version === lock.version && (lock.kind === 'recipe' || candidate.variant?.id === lock.variantId);
}

function boundedCatalog(catalog: RecipeCatalogSnapshot, slots: readonly NormalizedPlannerSlot[], policy: PlannerPolicy) {
  const select = <T extends { id: string }>(items: T[], kind: 'recipe' | 'family', limit: number): T[] => {
    const locks = new Set(slots.flatMap((slot) => slot.lock?.kind === kind ? [slot.lock.id] : []));
    const locked = items.filter((item) => locks.has(item.id));
    if (locked.length > limit) throw new Error(`Planner ${kind} limit cannot contain all locked sources`);
    return [...locked, ...items.filter((item) => !locks.has(item.id)).slice(0, limit - locked.length)]
      .sort((a, b) => compareIds(a.id, b.id));
  };
  const recipes = select(catalog.recipes, 'recipe', policy.recipeLimit);
  const families = select(catalog.families, 'family', policy.familyLimit);
  // Family definitions referenced only by concrete recipes retain their identity in candidates.
  return { catalog: { ...catalog, recipes, families },
    recipesCapped: recipes.length < catalog.recipes.length, familiesCapped: families.length < catalog.families.length };
}

export function contextForSlot(context: z.infer<typeof RankingContextSchema>, slot: Pick<NormalizedPlannerSlot, 'hardMaxTimeMinutes' | 'preferredTimeMinutes'>) {
  if (slot.hardMaxTimeMinutes === undefined && slot.preferredTimeMinutes === undefined) return context;
  const copy = structuredClone(context);
  const personal = copy.preferences.find((row) => row.userId === copy.userId);
  const household = copy.preferences.find((row) => row.userId === null);
  const values = RankingPreferencesSchema.parse(personal?.values ?? household?.values ?? {});
  if (slot.preferredTimeMinutes !== undefined) values.preferredTimeMinutes = slot.preferredTimeMinutes;
  if (slot.hardMaxTimeMinutes !== undefined) {
    values.hardMaxTimeMinutes = Math.min(values.hardMaxTimeMinutes ?? slot.hardMaxTimeMinutes, slot.hardMaxTimeMinutes);
  }
  if (personal) personal.values = values;
  else copy.preferences.push({ householdId: copy.householdId, userId: copy.userId, values });
  return RankingContextSchema.parse(copy);
}

/** Pure generated plan: no database calls, real-stock mutation, purchases, or Week cutover. */
export function planWeeklyMeals(input: WeeklyPlanningInput): WeeklyMealPlan {
  const source = readPlanningContext(input.context);
  const request = normalizePlannerRequest(input.request, source.reference);
  const policy = PlannerPolicySchema.parse(input.policy ?? DEFAULT_PLANNER_POLICY);
  const selectedCatalog = boundedCatalog(source.catalog, request.slots, policy);
  const diagnostics = new Map<string, PlannerDiagnostic>();
  const branchRejections = new WeakMap<SearchState, Set<string>>();
  let currentBranchRejections: Set<string> | undefined;
  const report = (slotId: string | null, code: string, count = 1) => {
    if (!count) return;
    if (slotId !== null) currentBranchRejections?.add(code);
    const key = JSON.stringify([slotId, code]);
    const existing = diagnostics.get(key);
    diagnostics.set(key, { slotId, code, count: (existing?.count ?? 0) + count });
  };
  const limits = new Set<string>();
  const incompleteReasons = new Map<string, PlannerIncompleteReason>();
  const search: PlannerSearchMetadata = {
    searchExhaustive: true, plannerSearchExhaustive: true, recipeSearchExhaustive: true, truncated: false,
    statesExplored: 1, generationCalls: 0, candidatesEvaluated: 0, maxCandidatesGenerated: 0,
    maxCandidatesConsidered: 0, maxFrontierSize: 1, limits: policy, limitReasons: [], incompleteReasons: [], familySearches: [], rejections: [],
    proofScope: 'supplied_catalog_constraints_and_fixed_allocation_policy',
  };
  const markIncomplete = (source: PlannerIncompleteReason['source'], code: string) => {
    incompleteReasons.set(JSON.stringify([source, code]), { source, code });
    if (source === 'planner_search') search.plannerSearchExhaustive = false;
    else search.recipeSearchExhaustive = false;
  };
  const markLimit = (reason: string, scope: 'planner' | 'recipe') => {
    limits.add(reason);
    search.truncated = true;
    markIncomplete(scope === 'planner' ? 'planner_search' : 'recipe_search', reason);
  };
  if (selectedCatalog.recipesCapped) markLimit('CATALOG_RECIPE_LIMIT', 'recipe');
  if (selectedCatalog.familiesCapped) markLimit('CATALOG_FAMILY_LIMIT', 'recipe');
  if (source.catalog.diagnostics.some((issue) => !issue.code.startsWith('legacy_alias_'))) {
    markIncomplete('catalog', 'CATALOG_DATA_INCOMPLETE');
    report(null, 'CATALOG_DATA_INCOMPLETE');
  }
  const pendingDates = (nextIndex: number) => [...new Set(request.slots.slice(nextIndex).map((slot) => slot.date))];
  const initial: SearchState = { inventory: source.inventory, meals: [], components: emptyPlanUtility(),
    nutrition: summarizePlanNutrition([], request.nutritionTargets, pendingDates(0)), score: 0, path: '' };
  let frontier: SearchState[] = [initial];
  let bestPartial = initial;
  let bestComplete: SearchState | undefined;
  let stop = false;

  for (let slotIndex = 0; slotIndex < request.slots.length && !stop; slotIndex++) {
    const slot = request.slots[slotIndex];
    const next: SearchState[] = [];
    for (const state of frontier) {
      currentBranchRejections = new Set();
      branchRejections.set(state, currentBranchRejections);
      if (search.statesExplored >= policy.maxSearchStates) {
        markLimit('MAX_SEARCH_STATES', 'planner'); report(slot.id, 'SEARCH_LIMIT_REACHED'); stop = true; break;
      }
      const generation = generateRecipeCandidates({
        catalog: selectedCatalog.catalog,
        inventory: projectInventoryRows(state.inventory).map((row) => ({ ...row, freshness: row.freshness ?? undefined })),
        householdId: source.rankingContext.householdId, asOfDate: slot.date, requestedServings: slot.servings,
        mode: request.mode, allocationPolicy: 'expiry_first', substitutions: source.substitutions,
        approvedSubstitutionIds: source.approvedSubstitutionIds, activeConstraints: source.activeConstraints,
        maxVariantCandidatesPerFamily: policy.variantCandidatesPerFamily,
        maxVariantSearchStatesPerFamily: policy.variantSearchStatesPerFamily,
      });
      search.generationCalls++;
      search.maxCandidatesGenerated = Math.max(search.maxCandidatesGenerated, generation.candidates.length);
      search.candidatesEvaluated += generation.candidates.length;
      for (const family of generation.familySearches) {
        let summary = search.familySearches.find((item) => item.familyId === family.familyId);
        if (!summary) {
          summary = { familyId: family.familyId, calls: 0, searchStates: 0, maxStatesPerCall: 0,
            candidateCount: 0, truncated: false, exhaustive: true };
          search.familySearches.push(summary);
        }
        summary.calls++;
        summary.searchStates += family.searchStates;
        summary.maxStatesPerCall = Math.max(summary.maxStatesPerCall, family.searchStates);
        summary.candidateCount += family.candidateCount;
        summary.truncated ||= family.truncated;
        summary.exhaustive &&= family.exhaustive;
        if (family.truncated) markLimit(`T02_${family.truncationReason?.toUpperCase()}`, 'recipe');
        else if (!family.exhaustive) markIncomplete('recipe_search', 'T02_FAMILY_SEARCH_INCOMPLETE');
      }
      for (const issue of generation.inventoryDiagnostics) {
        report(slot.id, `INVENTORY_${issue.code.toUpperCase()}`);
        if (issue.code === 'numeric_range') markIncomplete('inventory', 'INVENTORY_NUMERIC_RANGE');
      }
      for (const issue of generation.substitutionDiagnostics) {
        const code = `SUBSTITUTION_${issue.reason.toUpperCase()}`;
        report(slot.id, code);
        markIncomplete('substitution', code);
      }
      for (const excluded of generation.exclusions) {
        report(slot.id, `T02_${excluded.reason.toUpperCase()}`);
        if (['numeric_range', 'invalid_recipe', 'invalid_family', 'unknown_canonical'].includes(excluded.reason)) {
          markIncomplete('candidate', `T02_${excluded.reason.toUpperCase()}`);
        }
      }
      const evidence = source.evidenceProvider === undefined ? undefined : createRankingEvidenceSnapshot(generation, source.evidenceProvider);
      const ranking = rankRecipeCandidates({ generation, context: contextForSlot(source.rankingContext, slot),
        referenceDate: slot.date, referenceTime: slot.instant, profile: source.rankingProfile, evidence });
      for (const excluded of ranking.excluded) for (const reason of excluded.reasons) report(slot.id, reason);
      const eligible = ranking.ranked.filter((ranked) => {
        const candidate = ranked.candidate;
        if (slot.lock && !matchesLock(candidate, slot.lock)) return false;
        if (candidate.coverage.unresolvedRequiredCount > 0) { report(slot.id, 'UNRESOLVED_QUANTITY'); return false; }
        const mealTypes = candidate.classifications.filter((fact) => fact.kind === 'meal_type').map((fact) => fact.tag);
        if (mealTypes.length && !mealTypes.includes(slot.mealType)) { report(slot.id, 'MEAL_TYPE_CONSTRAINT'); return false; }
        if (!mealTypes.length && policy.unknownMealType === 'exclude') { report(slot.id, 'MEAL_TYPE_UNKNOWN'); return false; }
        if (!futureMealUtility(candidate, state.meals, policy).repeatAllowed) { report(slot.id, 'REPEAT_CONSTRAINT'); return false; }
        return true;
      });
      if (!eligible.length) {
        report(slot.id, 'NO_CANDIDATES_FOR_SLOT');
        if (slot.lock) report(slot.id, 'LOCK_UNAVAILABLE');
      }
      if (eligible.length > policy.candidateLimitPerSlot) markLimit('CANDIDATE_LIMIT_PER_SLOT', 'planner');
      const choices = eligible.slice(0, policy.candidateLimitPerSlot);
      search.maxCandidatesConsidered = Math.max(search.maxCandidatesConsidered, choices.length);
      for (const ranked of choices) {
        if (search.statesExplored >= policy.maxSearchStates) {
          markLimit('MAX_SEARCH_STATES', 'planner'); report(slot.id, 'SEARCH_LIMIT_REACHED'); stop = true; break;
        }
        search.statesExplored++;
        let projected: ReturnType<typeof applyProjectedConsumption>;
        try { projected = applyProjectedConsumption(state.inventory, ranked.candidate, slot.date); }
        catch (error) {
          if (!(error instanceof InventoryProjectionNumericError)) throw error;
          markIncomplete('projection', 'PROJECTION_NUMERIC_RANGE'); report(slot.id, 'PROJECTION_NUMERIC_RANGE'); continue;
        }
        const future = futureMealUtility(ranked.candidate, state.meals, policy);
        const meal: PlannedMeal = { ...slot, ranked, projectedConsumption: projected.deltas,
          shortages: ranked.candidate.requirements.filter((requirement) => requirement.missingQuantity !== 0),
          utility: { ...future.components, ranking: ranked.finalScore },
          reasons: [...future.reasons],
          generation: { truncated: generation.truncated, familySearches: generation.familySearches },
        };
        if (ranked.rank === 1) meal.reasons.push('HIGH_T03_UTILITY');
        if (!ranked.candidate.classifications.some((fact) => fact.kind === 'meal_type')) meal.reasons.push('MEAL_TYPE_UNKNOWN');
        if (!ranked.candidate.canCookWithoutBuying) meal.reasons.push('REQUIRES_SHOPPING');
        if (slot.lock) meal.reasons.push('LOCK_PRESERVED');
        const meals = [...state.meals, meal];
        const nutrition = summarizePlanNutrition(meals, request.nutritionTargets, pendingDates(slotIndex + 1));
        if (nutrition.hardPruning.shouldPrune) {
          for (const assessment of nutrition.hardPruning.assessments) report(slot.id, assessment.code ?? 'NUTRITION_CONSTRAINT');
          continue;
        }
        const components = { ...state.components };
        for (const key of Object.keys(components) as Array<keyof PlanUtilityComponents>) components[key] += meal.utility[key];
        components.nutritionBalance = nutrition.softFit.requestedTargets ? policy.nutritionBalanceWeight * nutrition.softFit.score : 0;
        meal.utility.nutritionBalance = components.nutritionBalance - state.components.nutritionBalance;
        if (meal.utility.nutritionBalance > 0 && nutrition.softFit.score > 0.5 && nutrition.assessments.some(({ target, confidence, fit }) =>
          !target.hard && (target.period === 'horizon' || target.date === meal.date) && confidence.complete && fit > 0.5)) {
          meal.reasons.push('NUTRITION_BALANCE_SUPPORT');
        }
        meal.reasons.sort(compareIds);
        const child: SearchState = { inventory: projected.state, meals, components, nutrition,
          score: totalPlanUtility(components), path: JSON.stringify(meals.map((item) => [item.id, item.ranked.candidate.id])) };
        if (compareStates(child, bestPartial) < 0) bestPartial = child;
        if (meals.length === request.slots.length && (!bestComplete || compareStates(child, bestComplete) < 0)) bestComplete = child;
        next.push(child);
        next.sort(compareStates);
        if (next.length > policy.beamWidth) {
          next.pop();
          if (slotIndex + 1 < request.slots.length) markLimit('BEAM_WIDTH', 'planner');
        }
        search.maxFrontierSize = Math.max(search.maxFrontierSize, next.length);
      }
      if (stop) break;
    }
    frontier = next;
    if (!frontier.length) break;
  }

  currentBranchRejections = undefined;
  search.searchExhaustive = search.plannerSearchExhaustive && search.recipeSearchExhaustive;
  search.limitReasons = [...limits].sort(compareIds);
  search.incompleteReasons = [...incompleteReasons.values()]
    .sort((a, b) => compareIds(a.source, b.source) || compareIds(a.code, b.code));
  search.familySearches.sort((a, b) => compareIds(a.familyId, b.familyId));
  search.rejections = [...diagnostics.values()].filter((item) => item.slotId !== null)
    .sort((a, b) => compareIds(a.slotId ?? '', b.slotId ?? '') || compareIds(a.code, b.code));
  const chosen = bestComplete ?? bestPartial;
  const conclusion: WeeklyMealPlan['conclusion'] = bestComplete ? 'feasible' : search.searchExhaustive
    ? 'proven_infeasible' : 'no_plan_found_without_proof';
  if (!bestComplete) report(null, conclusion === 'proven_infeasible' ? 'PROVEN_INFEASIBLE' : 'NO_PLAN_FOUND_WITHOUT_PROOF');
  const unplannedSlots = request.slots.slice(chosen.meals.length).map((slot, index) => ({ ...slot,
    reasons: index === 0 ? [...new Set([...(branchRejections.get(chosen) ?? []),
      conclusion === 'proven_infeasible' ? 'NO_FEASIBLE_TRANSITION' : 'PLAN_INCOMPLETE'])].sort(compareIds) : ['BLOCKED_BY_EARLIER_SLOT'],
  }));
  const plan: WeeklyMealPlan = {
    schemaVersion: 1,
    id: `t04-${planningFingerprint({ source: source.fingerprint, request, policy,
      choices: chosen.meals.map((meal) => ({ candidate: meal.ranked.candidate.id, consumption: meal.projectedConsumption,
        utility: meal.utility, nutrition: meal.ranked.facts.nutrition })), conclusion })}`,
    householdId: source.rankingContext.householdId, userId: source.rankingContext.userId,
    planningReference: source.reference,
    sourceSnapshot: { id: source.snapshotId, capturedAt: source.reference.instant, fingerprint: source.fingerprint,
      catalogSource: source.catalog.source,
      recipes: source.catalog.recipes.map(({ id, provenance }) => ({ id, version: provenance.version })),
      families: source.catalog.families.map(({ id, provenance }) => ({ id, version: provenance.version })),
      requiresRevalidationBeforeAcceptance: true },
    request, status: bestComplete ? 'feasible' : chosen.meals.length ? 'partial' : search.searchExhaustive
      ? 'infeasible' : search.truncated ? 'search_limited' : 'incomplete',
    conclusion, slots: chosen.meals, unplannedSlots,
    initialInventorySnapshot: projectInventoryRows(source.inventory), projectedFinalInventory: projectInventoryRows(chosen.inventory),
    shortages: aggregatePlanShortages(chosen.meals), nutrition: chosen.nutrition,
    leftovers: { policy: 'disabled', items: [] }, utility: { total: chosen.score, components: chosen.components },
    diagnostics: [...diagnostics.values()].filter((item) => item.slotId === null)
      .concat(search.limitReasons.map((code) => ({ slotId: null, code, count: 1 })))
      .concat(unplannedSlots.flatMap((slot) => slot.reasons.map((code) => ({ slotId: slot.id, code, count: 1 }))))
      .sort((a, b) => compareIds(a.slotId ?? '', b.slotId ?? '') || compareIds(a.code, b.code)),
    catalogDiagnostics: source.catalog.diagnostics, search, persistence: 'generated_only',
  };
  return freezePlanningValue(plan);
}
