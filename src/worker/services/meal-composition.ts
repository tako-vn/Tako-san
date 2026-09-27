import type { z } from 'zod';
import type { D1DatabaseBinding } from '../../../packages/db/src/index';
import { getGeneratedMealPlan, type GeneratedMealPlanRecord } from '../../../packages/db/src/meal-planning';
import { loadRankingContext } from '../../../packages/db/src/personalization';
import {
  readPlanCompositions,
  readRoleAssignments,
  writePlanCompositions,
  type CompositionSlotWrite,
} from '../../../packages/db/src/meal-composition';
import {
  AssistProposalDtoSchema,
  AutoOptionsDtoSchema,
  PickerPageDtoSchema,
  PICKER_PAGE_LIMIT,
  PlanCompositionsDtoSchema,
  SlotCompositionDtoSchema,
  type AddComponentSchema,
  type AssistApplySchema,
  type AssistRequestSchema,
  type AutoApplySchema,
  type AutoRequestSchema,
  type ComponentTarget,
  type CompositionMode,
  type MealCompositionDto,
  type MealRole,
  type PickerItemDto,
  type ReplaceCompositionSchema,
  type SwapComponentSchema,
  type UpdateComponentSchema,
} from '../../../packages/domain/src/meal-composition-api';
import type { MealPlanningIntent } from '../../../packages/domain/src/meal-planning-api';
import {
  addComponent,
  applyGenerated,
  CompositionDomainError,
  normalizeComponents,
  projectV1Composition,
  removeComponent,
  replaceComponents,
  swapComponent,
  targetKey,
  updateComponent,
  type CompositionContext,
  type MealComponent,
  type MealComposition,
} from '../../../packages/recipes/src/composition/model';
import {
  buildRoleIndex,
  normalizeText,
  type PersistedRoleAssignment,
  type RoleIndex,
} from '../../../packages/recipes/src/composition/roles';
import { getSimpleFood, SIMPLE_FOODS } from '../../../packages/recipes/src/composition/simple-foods';
import {
  compatibilityIssues,
  missingRoles,
  type ComposableItem,
  type MealType,
} from '../../../packages/recipes/src/composition/profiles';
import {
  compositionShoppingSnapshot,
  evaluateDefinition,
  evaluationScope,
  projectCompositions,
  simpleFoodDefinition,
  type ComponentEvaluation,
  type CompositionProjection,
  type ProjectionComponent,
  type ProjectionSlot,
} from '../../../packages/recipes/src/composition/projection';
import { legacyFamilyRestrictions, recipeRestrictions, simpleFoodRestrictions } from '../../../packages/recipes/src/composition/restrictions';
import { composeMeal, type ComposedOption, type ComposerFixed } from '../../../packages/recipes/src/composition/composer';
import { evaluationFromCandidate, prepareComposerCandidates } from '../../../packages/recipes/src/composition/candidates';
import { canonicalJson, readPlanningContext } from '../../../packages/recipes/src/planner-context';
import { resolveRankingPreferences } from '../../../packages/recipes/src/personalization';
import { contextForSlot } from '../../../packages/recipes/src/weekly-planner';
import type { RecipeAuthoritySnapshot } from '../../../packages/recipes/src/recipe-authority';
import type { Recipe } from '../../../packages/recipes/src/types';
import { MealPlanningError } from './meal-planning-error';
import { sha256Hex } from '../utils/session';
import type { MealPlanningApplicationService } from './meal-planning';

type Scope = { householdId: string; userId: string };
type Planner = MealPlanningApplicationService;
type Loaded = Awaited<ReturnType<MealCompositionService['load']>>;

interface SlotInfo {
  slotId: string; date: string; instant: string; mealType: MealType; servings: number;
  hardMaxTimeMinutes?: number; preferredTimeMinutes?: number;
}

/** Privacy-safe structured events: counts, modes, codes and durations only. */
function logEvent(event: string, fields: Record<string, string | number | boolean>) {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

// Rule classification depends only on the authority's recipe content, so it is memoized by fingerprint.
let roleMemo: { fingerprint: string; persisted: string; index: RoleIndex } | null = null;
export function roleIndexFor(authority: RecipeAuthoritySnapshot, persisted: readonly PersistedRoleAssignment[]): RoleIndex {
  const persistedKey = canonicalJson(persisted);
  if (roleMemo?.fingerprint === authority.fingerprint && roleMemo.persisted === persistedKey) return roleMemo.index;
  const index = buildRoleIndex(authority.list(), persisted);
  roleMemo = { fingerprint: authority.fingerprint, persisted: persistedKey, index };
  return index;
}
export function resetRoleIndexMemoForTests() { roleMemo = null; }

async function persistedRoles(db: D1DatabaseBinding, authority: RecipeAuthoritySnapshot): Promise<PersistedRoleAssignment[]> {
  // Mirrors T19: static/shadow/canary-outside authority reads no D1 planner rows.
  if (authority.source !== 'd1') return [];
  try {
    return await readRoleAssignments(db, new Set(authority.list().map((recipe) => recipe.id)));
  } catch {
    logEvent('composition_role_enrichment_unavailable', { source: authority.source });
    return [];
  }
}

function domainError(error: unknown): never {
  if (error instanceof CompositionDomainError) {
    throw new MealPlanningError(error.code, error.code === 'COMPONENT_NOT_FOUND' ? 404 : 422, error.message);
  }
  throw error;
}

function componentItem(component: MealComponent, roles: RoleIndex): ComposableItem {
  const profile = component.recipeId ? roles.get(component.recipeId) : undefined;
  return { key: targetKey(component), kind: component.kind, id: (component.recipeId ?? component.simpleFoodId)!,
    role: component.role, traits: profile?.traits ?? [], dominantIngredientId: profile?.dominantIngredientId ?? null };
}

function safetyProjectionKey(evaluation: ComponentEvaluation, evidenceSensitive: boolean): string {
  if (evidenceSensitive) return canonicalJson({ status: evaluation.status, requirements: evaluation.requirements });
  const ingredients = evaluation.requirements.flatMap((line) =>
    [line.ingredientId, ...(line.substitutions ?? []).map((use) => use.rule.toIngredientId)]);
  return canonicalJson({ unavailable: evaluation.status === 'unavailable', ingredients: [...new Set(ingredients)].sort() });
}

export class MealCompositionService {
  constructor(private readonly db: D1DatabaseBinding, private readonly planner: Planner,
    private readonly recipeAuthority: (scope: Scope) => Promise<RecipeAuthoritySnapshot>) {}

  // ------------------------------------------------------------------------ context
  async load(scope: Scope, planId: string) {
    const row = await getGeneratedMealPlan(this.db, scope, planId);
    const stored = this.planner.decode(row);
    const now = this.planner.nowIso();
    const { snapshot, authority } = await this.planner.snapshotWithAuthority(scope, now);
    const roles = roleIndexFor(authority, await persistedRoles(this.db, authority));
    const compositions = await readPlanCompositions(this.db, scope, planId);
    const slots = this.slots(stored);
    const referenceInstant = this.planner.reference(now, stored.intent.utcOffsetMinutes);
    // One trusted T04 context per request: Auto candidates, Manual restrictions and the shopping
    // projection all read the same catalog, substitution policy and evidence provider from it.
    const context = this.planner.planningContext(snapshot, referenceInstant);
    return { row, stored, now, snapshot, authority, roles, compositions, slots, referenceInstant,
      referenceDate: referenceInstant.slice(0, 10), context, evaluation: evaluationScope(context) };
  }

  private slots(stored: ReturnType<Planner['decode']>): SlotInfo[] {
    const timeBySlot = new Map<string, { hardMaxTimeMinutes?: number; preferredTimeMinutes?: number }>(stored.intent.slots.map((slot) =>
      [`${slot.date}:${slot.mealType}:${slot.sequence}`, {
        hardMaxTimeMinutes: slot.hardMaxTimeMinutes, preferredTimeMinutes: slot.preferredTimeMinutes,
      }] as const));
    const infos: SlotInfo[] = stored.result.meals.map((meal) => ({
      slotId: meal.slotId, date: meal.date, instant: meal.instant,
      mealType: meal.mealType, servings: meal.servings, ...timeBySlot.get(meal.slotId),
    }));
    for (const slot of stored.shoppingPlan.unplannedSlots) {
      if (!infos.some((info) => info.slotId === slot.id)) {
        infos.push({ slotId: slot.id, date: slot.date, instant: slot.instant,
          mealType: slot.mealType, servings: slot.servings, ...timeBySlot.get(slot.id) });
      }
    }
    return infos.sort((a, b) => (a.instant < b.instant ? -1 : a.instant > b.instant ? 1 : a.slotId < b.slotId ? -1 : 1));
  }

  private scopedContext(loaded: Loaded, slot: SlotInfo) {
    if (slot.hardMaxTimeMinutes === undefined && slot.preferredTimeMinutes === undefined) return loaded.context;
    return this.planner.planningContext(loaded.snapshot, loaded.referenceInstant,
      contextForSlot(loaded.snapshot.rankingContext, slot));
  }

  private compositionFor(loaded: Pick<Loaded, 'stored' | 'compositions' | 'row'>, slotId: string): MealComposition {
    const stored = loaded.compositions.get(slotId);
    if (stored) return { slotId, source: 'v2', mode: stored.mode, components: stored.components };
    const meal = loaded.stored.result.meals.find((item) => item.slotId === slotId) ?? null;
    return projectV1Composition({ slotId, meal, locked: loaded.stored.locks.some((lock) => lock.slotId === slotId),
      revision: loaded.row.revision });
  }

  private visible(loaded: Pick<Loaded, 'snapshot'>, recipeId: string | null) {
    return recipeId !== null && loaded.snapshot.visibleRecipeIds.has(recipeId);
  }

  private permittedRoles(loaded: Pick<Loaded, 'roles' | 'snapshot'>, target: ComponentTarget): MealRole[] | null {
    if (target.kind === 'simple_food') return getSimpleFood(target.simpleFoodId)?.roles ?? null;
    if (!this.visible(loaded, target.recipeId)) return null;
    return loaded.roles.get(target.recipeId)?.roles ?? null;
  }

  /** A V1 family-variant meal is not composable, but it still consumes inventory and needs shopping. */
  private legacyFamily(loaded: Pick<Loaded, 'stored'>, composition: MealComposition): ProjectionComponent | null {
    if (composition.source !== 'v1_projection') return null;
    const meal = loaded.stored.result.meals.find((entry) => entry.slotId === composition.slotId);
    if (meal?.source.kind !== 'family' || meal.source.variantId === null) return null;
    return { id: `v1.${composition.slotId}`, kind: 'legacy_family', recipeId: null, simpleFoodId: null,
      family: { id: meal.source.id, version: meal.source.version, variantId: meal.source.variantId } };
  }

  private projectionSlots(loaded: Loaded, compositions: ReadonlyMap<string, MealComposition>): ProjectionSlot[] {
    return loaded.slots.map((slot) => {
      const composition = compositions.get(slot.slotId);
      const family = composition ? this.legacyFamily(loaded, composition) : null;
      return { slotId: slot.slotId, date: slot.date, instant: slot.instant, servings: slot.servings,
        components: family ? [family] : composition?.components ?? [] };
    });
  }

  private projection(loaded: Loaded, compositions: ReadonlyMap<string, MealComposition>, untilSlotId?: string,
    inventoryCheckpointComponentIds?: ReadonlySet<string>): CompositionProjection {
    return projectCompositions({ scope: loaded.evaluation, referenceDate: loaded.referenceDate, inventory: loaded.snapshot.inventory,
      slots: this.projectionSlots(loaded, compositions), untilSlotId, inventoryCheckpointComponentIds });
  }

  private allCompositions(loaded: Loaded, override?: MealComposition): Map<string, MealComposition> {
    const map = new Map(loaded.slots.map((slot) => [slot.slotId, this.compositionFor(loaded, slot.slotId)]));
    if (override) map.set(override.slotId, override);
    return map;
  }

  private title(loaded: Pick<Loaded, 'authority'>, component: MealComponent): string {
    if (component.kind === 'simple_food') return getSimpleFood(component.simpleFoodId!)?.title.vi ?? component.simpleFoodId!;
    return loaded.authority.findById(component.recipeId!)?.title ?? component.recipeId!;
  }

  private dto(loaded: Loaded, slot: SlotInfo, composition: MealComposition, projection: CompositionProjection | null): MealCompositionDto {
    const items = composition.components.map((component) => componentItem(component, loaded.roles));
    const required = missingRoles(slot.mealType, items, 'required');
    const warnings = new Set<string>(compatibilityIssues(items));
    const meal = loaded.stored.result.meals.find((entry) => entry.slotId === slot.slotId);
    if (composition.source === 'v1_projection' && meal?.source.kind === 'family') warnings.add('LEGACY_FAMILY_MEAL');
    const components = composition.components.map((component) => {
      const resolvable = component.kind === 'simple_food' ? getSimpleFood(component.simpleFoodId!) !== undefined
        : this.visible(loaded, component.recipeId);
      if (!resolvable) warnings.add('COMPONENT_UNAVAILABLE');
      const evaluation = projection?.components.get(component.id);
      const recipe: Recipe | null = component.recipeId ? loaded.authority.findById(component.recipeId) : null;
      return {
        id: component.id, kind: component.kind, role: component.role, ordinal: component.ordinal, locked: component.locked,
        provenance: component.provenance, recipeId: component.recipeId, simpleFoodId: component.simpleFoodId,
        title: this.title(loaded, component),
        permittedRoles: (component.kind === 'recipe' ? loaded.roles.get(component.recipeId!)?.roles
          : getSimpleFood(component.simpleFoodId!)?.roles) ?? [],
        cookable: component.kind === 'recipe' && resolvable, resolvable,
        cookTimeMinutes: component.kind === 'recipe' ? recipe?.cookTimeMinutes ?? null : getSimpleFood(component.simpleFoodId!)?.prepMinutes ?? null,
        createdRevision: component.createdRevision, updatedRevision: component.updatedRevision,
        projection: evaluation ? { status: evaluation.status, missingCount: evaluation.missingCount,
          inventoryLineCount: evaluation.inventoryLineCount } : null,
      };
    });
    return {
      slotId: slot.slotId, date: slot.date, mealType: slot.mealType, servings: slot.servings, source: composition.source,
      mode: composition.mode, components, missingRoles: required,
      recommendedRoles: missingRoles(slot.mealType, items, 'recommended').filter((role) => !required.includes(role)),
      warnings: [...warnings].sort(),
    };
  }

  private slotInfo(loaded: Loaded, slotId: string): SlotInfo {
    const slot = loaded.slots.find((entry) => entry.slotId === slotId);
    if (!slot) throw new MealPlanningError('SLOT_NOT_FOUND', 404, 'Meal slot is not part of this plan');
    return slot;
  }

  private async checkedSlot(loaded: Loaded, scope: Scope, planId: string, slotId: string, revision: number): Promise<SlotInfo> {
    const current = await getGeneratedMealPlan(this.db, scope, planId);
    const slot = loaded.slots.find((entry) => entry.slotId === slotId);
    if (!slot) {
      // A slot added between the two plan reads is a stale request, not a permanently missing slot.
      if (this.slots(this.planner.decode(current)).some((entry) => entry.slotId === slotId)) {
        this.planner.assertRevision(current, revision);
      }
      return this.slotInfo(loaded, slotId);
    }
    this.planner.assertRevision(current, revision);
    return slot;
  }

  private assertEditable(loaded: Loaded, slot: SlotInfo) {
    if (this.planner.authorityChanged(loaded.stored, loaded.snapshot)) {
      throw new MealPlanningError('CATALOG_AUTHORITY_CHANGED', 409,
        'Recipe catalog authority changed since this plan was generated; regenerate the plan');
    }
    if (Date.parse(slot.instant) < Date.parse(loaded.now)) {
      throw new MealPlanningError('SLOT_ELAPSED', 409, 'Past meals cannot be changed');
    }
  }

  // ------------------------------------------------------------------------ reads
  async compositions(scope: Scope, planId: string) {
    const loaded = await this.load(scope, planId);
    const all = this.allCompositions(loaded);
    const projection = this.projection(loaded, all);
    return PlanCompositionsDtoSchema.parse({ schemaVersion: 1, planId, planRevision: loaded.row.revision,
      compositions: loaded.slots.map((slot) => this.dto(loaded, slot, all.get(slot.slotId)!, projection)) });
  }

  async composition(scope: Scope, planId: string, slotId: string) {
    const loaded = await this.load(scope, planId);
    const slot = this.slotInfo(loaded, slotId);
    const all = this.allCompositions(loaded);
    return this.slotDto(loaded, slot, all, loaded.row.revision);
  }

  private slotDto(loaded: Loaded, slot: SlotInfo, all: Map<string, MealComposition>, revision: number) {
    const projection = this.projection(loaded, all);
    return SlotCompositionDtoSchema.parse({ schemaVersion: 1, planId: loaded.row.id, planRevision: revision,
      composition: this.dto(loaded, slot, all.get(slot.slotId)!, projection) });
  }

  // ------------------------------------------------------------------------ manual mutations
  /**
   * T03 hard restrictions for a component entering this slot, judged exactly as Auto judges it
   * (same T02 candidate at the slot's projected inventory, same evidence and policies). Unknown
   * safety, time or hard nutrition is a rejection; there is no manual override.
   */
  private restrictionReasons(loaded: Loaded, slot: SlotInfo, target: ComponentTarget,
    inventory: CompositionProjection['inventoryAtStop']): string[] {
    const scoped = this.scopedContext(loaded, slot);
    const hard = resolveRankingPreferences(readPlanningContext(scoped).rankingContext).hard;
    if (target.kind === 'simple_food') {
      const food = getSimpleFood(target.simpleFoodId);
      return food ? simpleFoodRestrictions(food, hard).reasons : ['INVALID_CANDIDATE'];
    }
    const recipe = loaded.evaluation.catalog.recipes.find((entry) => entry.id === target.recipeId);
    if (!recipe) return ['INVALID_CANDIDATE'];
    return recipeRestrictions({ context: scoped, recipe, slot, inventory: inventory ?? [] }).reasons;
  }

  private assertComposable(loaded: Loaded, slotId: string, current: MealComposition) {
    if (this.legacyFamily(loaded, current) || (current.source === 'v1_projection'
      && loaded.stored.result.meals.find((meal) => meal.slotId === slotId)?.source.kind === 'family')) {
      throw new MealPlanningError('LEGACY_FAMILY_COMPOSITION_UNSUPPORTED', 422, 'Family-variant meals cannot be composed');
    }
  }

  private async mutate(scope: Scope, planId: string, slotId: string, revision: number, mode: CompositionMode,
    event: string, operation: (composition: MealComposition, context: CompositionContext, loaded: Loaded) => MealComponent[]) {
    const started = Date.now();
    const loaded = await this.load(scope, planId);
    const slot = await this.checkedSlot(loaded, scope, planId, slotId, revision);
    this.assertEditable(loaded, slot);
    const current = this.compositionFor(loaded, slotId);
    this.assertComposable(loaded, slotId, current);
    const context: CompositionContext = {
      resolve: (target) => {
        const roles = this.permittedRoles(loaded, target);
        return roles ? { permittedRoles: roles } : null;
      },
      newId: () => crypto.randomUUID(),
      revision: revision + 1,
    };
    let components: MealComponent[];
    try { components = operation(current, context, loaded); } catch (error) { domainError(error); }
    const affectedIndex = components.findIndex((component, index) => {
      const previous = current.components[index];
      return !previous || previous.id !== component.id || targetKey(previous) !== targetKey(component)
        || previous.role !== component.role;
    });
    const firstAffected = affectedIndex < 0 ? current.components.length : affectedIndex;
    const affected = components.slice(firstAffected);
    const following = loaded.slots.slice(loaded.slots.findIndex((entry) => entry.slotId === slotId) + 1)
      .flatMap((entry) => {
        const composition = this.compositionFor(loaded, entry.slotId);
        const family = this.legacyFamily(loaded, composition);
        const later: Array<MealComponent | ProjectionComponent> = family ? [family] : composition.components;
        return later.map((component) => ({ slot: entry, component }));
      });
    const changed = affectedIndex >= 0 || current.components.length !== components.length;
    if (affected.length || (changed && following.length)) {
      const proposed = { ...current, mode, components };
      const projected = this.projection(loaded, this.allCompositions(loaded, proposed), undefined,
        new Set([...affected.map((component) => component.id), ...following.map(({ component }) => component.id)]));
      const checks: Array<{ slot: SlotInfo; component: MealComponent | ProjectionComponent }> =
        affected.map((component) => ({ slot, component }));
      if (changed && following.length) {
        const previous = this.projection(loaded, this.allCompositions(loaded));
        const hard = resolveRankingPreferences(loaded.snapshot.rankingContext).hard;
        const evidenceSensitive = hard.some((policy) => policy.allergens.length > 0 || policy.requiredDietaryTags.length > 0
          || policy.mealNutritionTargets.some((target) => target.hard));
        for (const entry of following) {
          const before = previous.components.get(entry.component.id);
          const after = projected.components.get(entry.component.id);
          if (!before || !after) throw new Error('Missing T02 evaluation for later component');
          // Reviewed safety/nutrition evidence is keyed to the entire T02 witness, including lot allocations.
          if (safetyProjectionKey(before, evidenceSensitive) !== safetyProjectionKey(after, evidenceSensitive)) {
            checks.push(entry);
          }
        }
      }
      for (const { slot: checkedSlot, component } of checks) {
        const inventory = projected.inventoryBeforeComponents.get(component.id);
        if (!inventory) throw new Error('Missing T02 inventory checkpoint for affected component');
        let reasons: string[];
        if (component.kind === 'legacy_family') {
          const verdict = component.family && legacyFamilyRestrictions({ context: this.scopedContext(loaded, checkedSlot),
            family: component.family, slot: checkedSlot, inventory });
          if (!verdict) throw new MealPlanningError('COMPOSITION_REVALIDATION_REQUIRED', 409, 'Family variant is no longer available');
          reasons = verdict.reasons;
        } else {
          const target: ComponentTarget = component.kind === 'recipe' ? { kind: 'recipe', recipeId: component.recipeId! }
            : { kind: 'simple_food', simpleFoodId: component.simpleFoodId! };
          reasons = this.restrictionReasons(loaded, checkedSlot, target, inventory);
        }
        if (reasons.length) {
          logEvent('composition_hard_restriction_rejected', { mode, reasons: reasons.join(',') });
          throw new MealPlanningError('HARD_CONSTRAINT_CONFLICT', 422, 'This dish conflicts with a household restriction');
        }
      }
    }
    const existing = loaded.compositions.get(slotId);
    const write: CompositionSlotWrite = { slotId, mode, createdRevision: existing?.createdRevision ?? revision + 1,
      createdAt: existing?.createdAt ?? null, components };
    const row = await writePlanCompositions(this.db, scope, { planId, expectedRevision: revision, slots: [write] });
    logEvent(event, { mode, component_count: components.length, duration_ms: Date.now() - started });
    const next: MealComposition = { slotId, source: 'v2', mode, components };
    return this.slotDto({ ...loaded, row }, slot, this.allCompositions(loaded, next), row.revision);
  }

  add(scope: Scope, planId: string, slotId: string, input: z.infer<typeof AddComponentSchema>) {
    return this.mutate(scope, planId, slotId, input.revision, 'manual', 'composition_manual_update',
      (composition, context) => addComponent(composition, input, context));
  }

  swap(scope: Scope, planId: string, slotId: string, componentId: string, input: z.infer<typeof SwapComponentSchema>) {
    return this.mutate(scope, planId, slotId, input.revision, 'manual', 'composition_manual_update',
      (composition, context) => swapComponent(composition, componentId, input, context));
  }

  update(scope: Scope, planId: string, slotId: string, componentId: string, input: z.infer<typeof UpdateComponentSchema>) {
    return this.mutate(scope, planId, slotId, input.revision, 'manual', 'composition_manual_update',
      (composition, context) => updateComponent(composition, componentId, input, context));
  }

  remove(scope: Scope, planId: string, slotId: string, componentId: string, revision: number) {
    return this.mutate(scope, planId, slotId, revision, 'manual', 'composition_manual_update',
      (composition) => removeComponent(composition, componentId));
  }

  replace(scope: Scope, planId: string, slotId: string, input: z.infer<typeof ReplaceCompositionSchema>) {
    return this.mutate(scope, planId, slotId, input.revision, 'manual', 'composition_manual_update',
      (composition, context) => replaceComponents(composition, input.components, context));
  }

  // ------------------------------------------------------------------------ assisted / auto
  private fixedFor(loaded: Loaded, slot: SlotInfo, components: readonly MealComponent[], inventory: CompositionProjection['inventoryAtStop']): ComposerFixed[] {
    const rows = inventory ?? [];
    const scope = loaded.evaluation;
    return components.map((component) => {
      const item = componentItem(component, loaded.roles);
      const food = component.simpleFoodId ? getSimpleFood(component.simpleFoodId) : undefined;
      const definition = component.kind === 'recipe'
        ? scope.catalog.recipes.find((recipe) => recipe.id === component.recipeId) ?? null
        : food ? simpleFoodDefinition(food) : null;
      const candidate = definition ? evaluateDefinition(scope, definition, rows, slot.date, slot.servings) : null;
      const minutes = component.kind === 'recipe' ? loaded.authority.findById(component.recipeId!)?.cookTimeMinutes ?? null
        : food?.prepMinutes ?? null;
      return { ...evaluationFromCandidate(candidate, minutes), componentId: component.id, key: item.key, kind: component.kind,
        id: item.id, title: this.title(loaded, component), role: component.role, traits: item.traits,
        dominantIngredientId: item.dominantIngredientId, locked: component.locked };
    });
  }

  private async generate(loaded: Loaded, slot: SlotInfo, kind: 'assist' | 'auto', action: 'complete' | 'regenerate_unlocked', variant: number) {
    const current = this.compositionFor(loaded, slot.slotId);
    const kept = action === 'complete' ? current.components : current.components.filter((item) => item.locked);
    const removed = current.components.filter((item) => !kept.includes(item)).map((item) => item.id);
    const all = this.allCompositions(loaded);
    const projection = this.projection(loaded, all, slot.slotId);
    const fixed = this.fixedFor(loaded, slot, kept, projection.inventoryAtStop);
    const rolesToFill = missingRoles(slot.mealType, fixed.map((item) => ({ key: item.key, kind: item.kind, id: item.id,
      role: item.role, traits: item.traits, dominantIngredientId: item.dominantIngredientId })), 'recommended');
    const usedElsewhere = new Set([...all.values()].filter((entry) => entry.slotId !== slot.slotId)
      .flatMap((entry) => entry.components.map((item) => targetKey(item))));
    const candidates = rolesToFill.length ? prepareComposerCandidates({ context: this.scopedContext(loaded, slot), roleIndex: loaded.roles,
      slot: { date: slot.date, instant: slot.instant, servings: slot.servings, mealType: slot.mealType },
      inventory: projection.inventoryAtStop ?? [], roles: rolesToFill, mode: loaded.stored.intent.mode,
      excludeKeys: new Set(fixed.map((item) => item.key)), usedElsewhere }) : [];
    const result = composeMeal({ mealType: slot.mealType, fixed, rolesToFill, candidates, variant,
      maxOptions: kind === 'auto' ? 3 : 1 });
    const options = await Promise.all(result.options.map(async (option) => ({ option,
      optionId: await this.optionId(loaded, slot.slotId, kind, action, variant, option) })));
    if (result.budget.exhausted) {
      logEvent('composition_budget_exhausted', { mode: kind === 'auto' ? 'auto' : 'assisted',
        candidate_count: result.budget.candidatesConsidered, partials: result.budget.partialsExplored });
    }
    return { options, removed, budget: result.budget };
  }

  private async optionId(loaded: Loaded, slotId: string, kind: string, action: string, variant: number, option: ComposedOption) {
    return (await sha256Hex(canonicalJson({ planId: loaded.row.id, revision: loaded.row.revision, slotId, kind, action, variant,
      items: option.items.map((item) => ({ key: (item.fixed ?? item.candidate)!.key, role: item.role,
        componentId: item.fixed?.componentId ?? null })) }))).slice(0, 32);
  }

  private optionDto(option: ComposedOption, optionId: string, removed: readonly string[]) {
    return {
      optionId, removedComponentIds: [...removed], unfilledRoles: option.unfilledRoles, score: option.score,
      explanations: option.explanations.map((entry) => ({ code: entry.code, count: entry.count, role: entry.role })),
      components: option.items.map((item) => {
        const source = (item.fixed ?? item.candidate)!;
        return { kind: source.kind, role: item.role, recipeId: source.kind === 'recipe' ? source.id : null,
          simpleFoodId: source.kind === 'simple_food' ? source.id : null, title: source.title,
          locked: item.fixed?.locked ?? false, existingComponentId: item.fixed?.componentId ?? null };
      }),
    };
  }

  private async prepareGeneration(scope: Scope, planId: string, slotId: string, revision: number) {
    const loaded = await this.load(scope, planId);
    const slot = await this.checkedSlot(loaded, scope, planId, slotId, revision);
    this.assertEditable(loaded, slot);
    this.assertComposable(loaded, slotId, this.compositionFor(loaded, slotId));
    return { loaded, slot };
  }

  private failure(mode: string, error: unknown): never {
    const code = error instanceof MealPlanningError ? error.code : 'UNEXPECTED';
    logEvent('composition_generation_failed', { mode, failure_code: code });
    throw error;
  }

  async assist(scope: Scope, planId: string, slotId: string, input: z.infer<typeof AssistRequestSchema>) {
    const started = Date.now();
    try {
      const { loaded, slot } = await this.prepareGeneration(scope, planId, slotId, input.revision);
      const generated = await this.generate(loaded, slot, 'assist', input.action, input.variant);
      const best = generated.options[0];
      logEvent('composition_generated', { mode: 'assisted', component_count: best?.option.items.length ?? 0,
        candidate_count: generated.budget.candidatesConsidered, duration_ms: Date.now() - started });
      return AssistProposalDtoSchema.parse({ schemaVersion: 1, planId, planRevision: loaded.row.revision, slotId,
        action: input.action, variant: input.variant, budget: generated.budget,
        proposal: best ? this.optionDto(best.option, best.optionId, generated.removed) : null });
    } catch (error) { return this.failure('assisted', error); }
  }

  async auto(scope: Scope, planId: string, slotId: string, input: z.infer<typeof AutoRequestSchema>) {
    const started = Date.now();
    try {
      const { loaded, slot } = await this.prepareGeneration(scope, planId, slotId, input.revision);
      const generated = await this.generate(loaded, slot, 'auto', 'regenerate_unlocked', input.variant);
      logEvent('composition_generated', { mode: 'auto', component_count: generated.options[0]?.option.items.length ?? 0,
        candidate_count: generated.budget.candidatesConsidered, duration_ms: Date.now() - started });
      return AutoOptionsDtoSchema.parse({ schemaVersion: 1, planId, planRevision: loaded.row.revision, slotId,
        variant: input.variant, budget: generated.budget,
        options: generated.options.map((entry) => this.optionDto(entry.option, entry.optionId, generated.removed)) });
    } catch (error) { return this.failure('auto', error); }
  }

  private async applyGeneratedOption(scope: Scope, planId: string, slotId: string, revision: number, kind: 'assist' | 'auto',
    action: 'complete' | 'regenerate_unlocked', variant: number, optionId: string) {
    const mode = kind === 'auto' ? 'auto' : 'assisted';
    // The option is recomputed from current trusted inputs; the client only names which one it accepted.
    const { loaded, slot } = await this.prepareGeneration(scope, planId, slotId, revision);
    const generated = await this.generate(loaded, slot, kind, action, variant);
    this.planner.assertRevision(await getGeneratedMealPlan(this.db, scope, planId), revision);
    const chosen = generated.options.find((entry) => entry.optionId === optionId);
    if (!chosen) throw new MealPlanningError('PROPOSAL_STALE', 409, 'The suggestion is no longer current; request a new one');
    return this.mutate(scope, planId, slotId, revision, mode, kind === 'auto' ? 'composition_auto_generated' : 'composition_assisted_update',
      (composition, context) => applyGenerated(composition, { removeIds: generated.removed, provenance: mode,
        additions: chosen.option.items.filter((item) => item.candidate).map((item) => ({ role: item.role,
          target: item.candidate!.kind === 'recipe' ? { kind: 'recipe' as const, recipeId: item.candidate!.id }
            : { kind: 'simple_food' as const, simpleFoodId: item.candidate!.id } })) }, context));
  }

  async assistApply(scope: Scope, planId: string, slotId: string, input: z.infer<typeof AssistApplySchema>) {
    try {
      return await this.applyGeneratedOption(scope, planId, slotId, input.revision, 'assist', input.action, input.variant, input.proposalId);
    } catch (error) { return this.failure('assisted', error); }
  }

  async autoApply(scope: Scope, planId: string, slotId: string, input: z.infer<typeof AutoApplySchema>) {
    try {
      return await this.applyGeneratedOption(scope, planId, slotId, input.revision, 'auto', 'regenerate_unlocked', input.variant, input.optionId);
    } catch (error) { return this.failure('auto', error); }
  }

  // ------------------------------------------------------------------------ picker
  async picker(scope: Scope, query: { role?: MealRole; cuisine?: string; q?: string; cursor?: string; limit?: string;
    kind?: 'recipe' | 'simple_food' }) {
    const authority = await this.recipeAuthority(scope);
    const context = await loadRankingContext(this.db, scope, this.planner.nowIso());
    const roles = roleIndexFor(authority, await persistedRoles(this.db, authority));
    const hard = resolveRankingPreferences(context).hard;
    const safetyRequested = hard.some((policy) => policy.allergens.length > 0 || policy.requiredDietaryTags.length > 0);
    const needle = query.q ? normalizeText(query.q) : '';
    const matches = (title: string) => !needle || normalizeText(title).includes(needle);
    const constraintState = safetyRequested ? 'unknown' as const : 'none_requested' as const;
    const items: PickerItemDto[] = [];
    if (query.kind !== 'simple_food') {
      for (const recipe of authority.list()) {
        const profile = roles.get(recipe.id);
        if (!profile || (query.role && !profile.roles.includes(query.role)) || !matches(recipe.title)) continue;
        if (query.cuisine && recipe.cuisine !== query.cuisine) continue;
        if (hard.some((policy) => policy.neverRecommendRecipeIds.includes(recipe.id)
          || policy.forbiddenIngredientIds.some((id) => recipe.ingredients.some((line) => line.ingredientId === id)))) continue;
        items.push({ kind: 'recipe', id: recipe.id, title: recipe.title, roles: profile.roles, cuisine: recipe.cuisine,
          cookTimeMinutes: recipe.cookTimeMinutes, difficulty: recipe.difficulty, constraintState });
      }
    }
    // Simple foods carry no cuisine metadata, so a cuisine filter excludes them rather than guessing one.
    if (query.kind !== 'recipe' && !query.cuisine) {
      for (const food of SIMPLE_FOODS) {
        if ((query.role && !food.roles.includes(query.role)) || !(matches(food.title.vi) || matches(food.title.en))) continue;
        if (!simpleFoodRestrictions(food, hard).allowed) continue;
        items.push({ kind: 'simple_food', id: food.id, title: food.title.vi, roles: food.roles, cuisine: null,
          cookTimeMinutes: food.prepMinutes, difficulty: null, constraintState });
      }
    }
    items.sort((a, b) => {
      const left = normalizeText(a.title); const right = normalizeText(b.title);
      return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const offset = Number(query.cursor ?? 0);
    const limit = Math.min(Number(query.limit ?? 20), PICKER_PAGE_LIMIT);
    const page = items.slice(offset, offset + limit);
    const next = offset + limit < items.length ? String(offset + limit) : null;
    return PickerPageDtoSchema.parse({ schemaVersion: 1, items: page, nextCursor: next, total: items.length });
  }

  // ------------------------------------------------------------------------ V1 integration
  /** V1 shopping for a plan with canonical V2 slots: one projection over all components, then unchanged T05. */
  async shoppingPlanFor(scope: Scope, row: GeneratedMealPlanRecord) {
    const loaded = await this.load(scope, row.id);
    const all = this.allCompositions(loaded);
    for (const composition of all.values()) {
      for (const component of composition.components) {
        const ok = component.kind === 'recipe' ? this.visible(loaded, component.recipeId) : getSimpleFood(component.simpleFoodId!) !== undefined;
        if (!ok) throw new MealPlanningError('COMPOSITION_REVALIDATION_REQUIRED', 409, 'A dish in this plan is no longer available; edit the meal');
      }
    }
    const projection = this.projection(loaded, all);
    const slots = this.projectionSlots(loaded, all);
    for (const slot of slots) {
      for (const component of slot.components) {
        if (component.kind === 'legacy_family' && projection.components.get(component.id)?.status === 'unavailable') {
          throw new MealPlanningError('COMPOSITION_REVALIDATION_REQUIRED', 409, 'A dish in this plan is no longer available; edit the meal');
        }
      }
    }
    return compositionShoppingSnapshot(loaded.stored.shoppingPlan, projection, slots);
  }

  /**
   * V1 regenerate on a plan with canonical V2 slots: locked V2 mains become V1 locks, the T04 plan is
   * regenerated, and each composed slot keeps every locked component; unlocked components are
   * replaced by the new V1 anchor. One atomic write updates the plan and the compositions.
   */
  async regenerateComposed(scope: Scope, input: { row: GeneratedMealPlanRecord; intent: MealPlanningIntent;
    locks: Array<{ slotId: string; lock: { kind: 'recipe' | 'family'; id: string; version: number; variantId?: string } }>;
    snapshot: Awaited<ReturnType<Planner['snapshotWithAuthority']>>['snapshot']; now: string }) {
    const compositions = await readPlanCompositions(this.db, scope, input.row.id);
    const versions = new Map(input.snapshot.catalog.recipes.map((recipe) => [recipe.id, recipe.provenance.version]));
    const slotIds = new Set(input.intent.slots.map((slot) => `${slot.date}:${slot.mealType}:${slot.sequence}`));
    const locks = input.locks.filter((entry) => !compositions.has(entry.slotId));
    for (const [slotId, composition] of compositions) {
      const main = composition.components.find((item) => item.locked && item.role === 'main' && item.kind === 'recipe'
        && versions.has(item.recipeId!));
      if (main && slotIds.has(slotId)) locks.push({ slotId, lock: { kind: 'recipe', id: main.recipeId!, version: versions.get(main.recipeId!)! } });
    }
    const result = this.planner.run(scope, input.row.id, input.intent, locks, input.snapshot, input.now);
    const next = input.row.revision + 1;
    const writes: CompositionSlotWrite[] = [];
    const deleted: string[] = [];
    for (const [slotId, composition] of compositions) {
      if (!slotIds.has(slotId)) { deleted.push(slotId); continue; }
      const kept = composition.components.filter((item) => item.locked);
      const meal = result.result.meals.find((entry) => entry.slotId === slotId);
      const anchor: MealComponent[] = meal?.source.kind === 'recipe' && !kept.some((item) => item.recipeId === meal.source.id)
        && !kept.some((item) => item.role === 'main')
        ? [{ id: `v1.${slotId}.r${next}`, kind: 'recipe', role: 'main', ordinal: 0, locked: false, provenance: 'legacy_v1',
          recipeId: meal.source.id, simpleFoodId: null, createdRevision: next, updatedRevision: next }] : [];
      writes.push({ slotId, mode: composition.mode, createdRevision: composition.createdRevision, createdAt: composition.createdAt,
        components: normalizeComponents([...anchor, ...kept]) });
    }
    return { result, locks, writes, deleted };
  }
}
