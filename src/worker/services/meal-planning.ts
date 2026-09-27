import { z } from 'zod';
import type { D1DatabaseBinding } from '../../../packages/db/src/index';
import {
  createGeneratedMealPlan,
  getGeneratedMealPlan,
  findGeneratedMealPlanByRequest,
  findCurrentGeneratedMealPlan,
  updateGeneratedMealPlan,
  recordCookedGeneratedMealPlanAnnotation,
  type GeneratedMealPlanRecord,
} from '../../../packages/db/src/meal-planning';
import { loadMealPlanningSnapshot } from '../../../packages/db/src/meal-planning-snapshot';
import type { RecipeAuthoritySnapshot } from '../../../packages/recipes/src/recipe-authority';
import {
  MealPlanningIntentSchema,
  MealPlanDtoSchema,
  PlanResultDtoSchema,
  PlanSourceIdentitySchema,
  PlanFeedbackDtoSchema,
  PlanShoppingDtoSchema,
  type MealPlanningIntent,
  type MealPlanDto,
  type RegenerateMealPlanSchema,
  type SwapMealSchema,
  type OptimizePlanShoppingSchema,
  type PlanFeedbackSchema,
} from '../../../packages/domain/src/meal-planning-api';
import {
  createPlanningContext,
  canonicalJson,
  planningReference,
} from '../../../packages/recipes/src/planner-context';
import {
  normalizePlannerRequest,
  PlannerLockSchema,
} from '../../../packages/recipes/src/planner-request';
import { planWeeklyMeals } from '../../../packages/recipes/src/weekly-planner';
import {
  createShoppingContext,
  type PurchaseOption,
} from '../../../packages/recipes/src/shopping-catalog';
import { optimizeShopping } from '../../../packages/recipes/src/shopping-optimizer';
import {
  projectShoppingMealPlan,
  ShoppingMealPlanSnapshotSchema,
} from '../../../packages/recipes/src/shopping-plan-snapshot';
import { mapPlanResultDto } from './meal-planning-dto';
import { toShoppingResultDto } from './meal-shopping-dto';
import { recordPlanningTaste } from './meal-planning-feedback';
import { MealPlanningError } from './meal-planning-error';
import { sha256Hex } from '../utils/session';
import {
  CurrentMealPlanDtoSchema,
  PlanAlternativesDtoSchema,
  PLAN_ALTERNATIVES_LIMIT,
  type PlanExplanationRequest,
} from '../../../packages/domain/src/meal-planning-presentation';
import { explainMealReasons, type ExplanationTransport } from './meal-planning-explanation';
import {
  planHasCompositions,
  readPlanCompositions,
  writePlanCompositions,
} from '../../../packages/db/src/meal-composition';
import { MealCompositionService } from './meal-composition';

type Scope = { householdId: string; userId: string };
type Snapshot = Awaited<ReturnType<typeof loadMealPlanningSnapshot>>;
const LockEntrySchema = z.object({ slotId: z.string(), lock: PlannerLockSchema }).strict();
const StoredIntentSchema = z
  .object({ intent: MealPlanningIntentSchema, locks: z.array(LockEntrySchema) })
  .strict();
const StoredResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    result: PlanResultDtoSchema,
    shoppingPlan: ShoppingMealPlanSnapshotSchema,
    lastSwap: z
      .object({
        slotId: z.string(),
        previous: PlanSourceIdentitySchema,
        replacement: PlanSourceIdentitySchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
const StoredAuthoritySchema = z
  .object({
    source: z.enum(['static', 'd1']),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    recipeCount: z.number().int().nonnegative(),
  })
  .strict();
// `authority` is absent on plans persisted before T19; those revalidate through the catalog fingerprint alone.
const FingerprintsSchema = z
  .object({
    inventory: z.string(),
    preferences: z.string(),
    catalog: z.string(),
    history: z.string(),
    authority: StoredAuthoritySchema.optional(),
  })
  .strict();
const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ version: z.literal(1), data }).strict();
const serialize = (data: object) => JSON.stringify({ version: 1, data });

export interface MealPlanningServiceOptions {
  now?: () => Date;
  explanationTransport?: ExplanationTransport;
  purchaseCatalog?: (
    scope: Scope,
    asOf: string,
  ) => Promise<{
    snapshotId: string;
    options: readonly PurchaseOption[];
    status: 'available' | 'reviewed_catalog_unavailable';
  }>;
  /**
   * T19 (ADR-026): the household's EFFECTIVE recipe authority, resolved once per operation by
   * server composition from deployment config + deterministic canary — never from request input.
   * The planner universe is exactly this snapshot, so Recipe API, Planner, Shopping and Cooking agree.
   */
  recipeAuthority: (scope: Scope) => Promise<RecipeAuthoritySnapshot>;
  /**
   * T20 (ADR-031): server flag `MEAL_COMPOSITION_V2_ENABLED`. When false every V1 operation is
   * byte-for-byte the pre-T20 behaviour and no composition table is read.
   */
  compositionV2Enabled?: boolean;
}

export class MealPlanningApplicationService {
  constructor(
    private readonly db: D1DatabaseBinding,
    private readonly options: MealPlanningServiceOptions,
  ) {
    if (typeof options?.recipeAuthority !== 'function')
      throw new Error('Meal planning requires a server-owned recipe authority resolver');
  }

  /** @internal */
  compositions() {
    return new MealCompositionService(this.db, this, this.options.recipeAuthority);
  }

  private now() {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private async snapshot(scope: Scope, referenceTime: string) {
    return (await this.snapshotWithAuthority(scope, referenceTime)).snapshot;
  }

  /** @internal T20: one authority resolution shared by the planner snapshot and role enrichment. */
  async snapshotWithAuthority(scope: Scope, referenceTime: string) {
    const authority = await this.options.recipeAuthority(scope);
    return {
      authority,
      snapshot: await loadMealPlanningSnapshot(this.db, scope, referenceTime, authority),
    };
  }

  /** Persisted source identity: planner fingerprints + the recipe authority the plan was fenced to. */
  /** @internal */
  sourceIdentity(snapshot: Snapshot) {
    return { ...snapshot.fingerprint.parts, authority: snapshot.authority };
  }

  /** @internal */
  authorityChanged(
    stored: {
      fingerprints: { authority?: { source: string; fingerprint: string; recipeCount: number } };
    },
    snapshot: Snapshot,
  ) {
    const previous = stored.fingerprints.authority;
    return (
      previous !== undefined &&
      (previous.source !== snapshot.authority.source ||
        previous.fingerprint !== snapshot.authority.fingerprint ||
        previous.recipeCount !== snapshot.authority.recipeCount)
    );
  }

  /** @internal */
  decode(row: GeneratedMealPlanRecord) {
    const intent = envelope(StoredIntentSchema).parse(JSON.parse(row.intentJson)).data;
    const result = envelope(StoredResultSchema).parse(JSON.parse(row.resultJson)).data;
    const fingerprints = envelope(FingerprintsSchema).parse(JSON.parse(row.sourceJson)).data;
    if (
      result.shoppingPlan.householdId !== row.householdId ||
      result.shoppingPlan.userId !== row.creatorUserId ||
      result.shoppingPlan.id !== row.id
    )
      throw new Error('Stored plan ownership mismatch');
    return { ...intent, ...result, fingerprints };
  }

  /** @internal */
  async freshness(row: GeneratedMealPlanRecord, snapshot?: Snapshot) {
    const stored = this.decode(row);
    const checkedAt = this.now();
    const current =
      snapshot ??
      (await this.snapshot({ householdId: row.householdId, userId: row.creatorUserId }, checkedAt));
    const reasons: MealPlanDto['freshness']['reasons'] = [];
    const labels = {
      inventory: 'stale_inventory',
      preferences: 'stale_preferences',
      catalog: 'stale_catalog',
      history: 'stale_history',
    } as const;
    for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
      if (stored.fingerprints[key] !== current.fingerprint.parts[key]) reasons.push(labels[key]);
    }
    if (this.authorityChanged(stored, current)) reasons.push('catalog_authority_changed');
    if (stored.result.meals.some((meal) => Date.parse(meal.instant) < Date.parse(checkedAt)))
      reasons.push('planning_time_elapsed');
    return {
      status: reasons.length ? ('requires_revalidation' as const) : ('fresh' as const),
      reasons,
      checkedAt,
      requiresRevalidationBeforeConsumption: true as const,
    };
  }

  private async dto(row: GeneratedMealPlanRecord, snapshot?: Snapshot): Promise<MealPlanDto> {
    const stored = this.decode(row);
    return MealPlanDtoSchema.parse({
      schemaVersion: 1,
      id: row.id,
      householdId: row.householdId,
      revision: row.revision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      intent: stored.intent,
      result: stored.result,
      freshness: await this.freshness(row, snapshot),
    });
  }

  /** @internal */
  assertRevision(row: GeneratedMealPlanRecord, revision: number) {
    if (row.revision !== revision)
      throw new MealPlanningError(
        'PLAN_REVISION_CONFLICT',
        409,
        'Plan revision changed; retrieve the current plan',
      );
  }

  /** @internal */
  nowIso() {
    return this.now();
  }

  /** @internal */
  reference(now: string, offset: number) {
    const local = new Date(Date.parse(now) + offset * 60_000).toISOString().slice(0, -1);
    const suffix = `${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
    return `${local}${suffix}`;
  }

  /** @internal T20: the same trusted T04 context the V1 planner builds, for Assisted/Auto candidates. */
  planningContext(snapshot: Snapshot, referenceInstant: string,
    rankingContext: Snapshot['rankingContext'] = snapshot.rankingContext) {
    return createPlanningContext(() => ({
      snapshotId: crypto.randomUUID(),
      referenceInstant,
      catalog: snapshot.catalog,
      inventory: snapshot.inventory,
      rankingContext,
      evidenceProvider: snapshot.evidenceProvider,
      substitutions: [],
      approvedSubstitutionIds: [],
    }));
  }

  /** @internal */
  run(
    scope: Scope,
    id: string,
    intent: MealPlanningIntent,
    locks: z.infer<typeof LockEntrySchema>[],
    snapshot: Snapshot,
    now: string,
  ) {
    const referenceInstant = this.reference(now, intent.utcOffsetMinutes);
    const request = {
      startDate: intent.startDate,
      horizonDays: intent.horizonDays,
      defaultServings: intent.defaultServings,
      mode: intent.mode,
      slots: intent.slots,
    };
    const input = {
      ...request,
      slots: request.slots.map((slot) => ({
        ...slot,
        lock: locks.find(
          (entry) => entry.slotId === `${slot.date}:${slot.mealType}:${slot.sequence}`,
        )?.lock,
      })),
    };
    try {
      normalizePlannerRequest(input, planningReference(referenceInstant));
    } catch {
      throw new MealPlanningError(
        'INVALID_PLANNING_HORIZON',
        422,
        'Slots must be unique, future and inside the planning horizon',
      );
    }
    const context = this.planningContext(snapshot, referenceInstant);
    const plan = { ...planWeeklyMeals({ context, request: input }), id };
    if (plan.householdId !== scope.householdId || plan.userId !== scope.userId)
      throw new Error('Generated scope mismatch');
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'meal_planning_result',
        status: plan.status,
        conclusion: plan.conclusion,
        truncated: plan.search.truncated,
        states: plan.search.statesExplored,
      }),
    );
    const instructions = new Map<string, string[]>();
    for (const step of snapshot.recipeSteps) {
      const list = instructions.get(step.recipeId) ?? [];
      list.push(step.instruction);
      instructions.set(step.recipeId, list);
    }
    return {
      schemaVersion: 1 as const,
      result: mapPlanResultDto(plan, instructions),
      shoppingPlan: projectShoppingMealPlan(plan),
      lastSwap: null,
    };
  }

  async generate(scope: Scope, intent: MealPlanningIntent, key: string) {
    const requestFingerprint = await sha256Hex(canonicalJson(intent));
    const prior = await findGeneratedMealPlanByRequest(this.db, scope, key);
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint)
        throw new MealPlanningError(
          'IDEMPOTENCY_CONFLICT',
          409,
          'Request key was used with different intent',
        );
      return this.dto(prior);
    }
    const now = this.now();
    const snapshot = await this.snapshot(scope, now);
    const id = crypto.randomUUID();
    const result = this.run(scope, id, intent, [], snapshot, now);
    const { plan: row } = await createGeneratedMealPlan(this.db, scope, {
      id,
      requestKey: key,
      requestFingerprint,
      intentJson: serialize({ intent, locks: [] }),
      resultJson: serialize(result),
      sourceJson: serialize(this.sourceIdentity(snapshot)),
    });
    return this.dto(row, snapshot);
  }

  async get(scope: Scope, id: string) {
    return this.dto(await getGeneratedMealPlan(this.db, scope, id));
  }

  async current(scope: Scope) {
    const row = await findCurrentGeneratedMealPlan(this.db, scope);
    return CurrentMealPlanDtoSchema.parse({ plan: row ? await this.dto(row) : null });
  }

  async alternatives(scope: Scope, id: string, revision: number) {
    const row = await getGeneratedMealPlan(this.db, scope, id);
    this.assertRevision(row, revision);
    const snapshot = await this.snapshot(scope, this.now());
    // Alternatives come from the authority-fenced planner catalog only: never a D1-only recipe under static authority.
    const recipes = [...snapshot.catalog.recipes].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    this.assertRevision(await getGeneratedMealPlan(this.db, scope, id), revision);
    return PlanAlternativesDtoSchema.parse({
      planId: id,
      planRevision: row.revision,
      alternatives: recipes
        .slice(0, PLAN_ALTERNATIVES_LIMIT)
        .map((recipe) => ({ kind: 'recipe', id: recipe.id, title: recipe.title })),
      truncated: recipes.length > PLAN_ALTERNATIVES_LIMIT,
    });
  }

  async explanation(scope: Scope, id: string, input: PlanExplanationRequest, enabled: boolean) {
    const row = await getGeneratedMealPlan(this.db, scope, id);
    this.assertRevision(row, input.revision);
    const meal = this.decode(row).result.meals.find((entry) => entry.slotId === input.slotId);
    if (!meal)
      throw new MealPlanningError(
        'SLOT_NOT_FOUND',
        422,
        'Explanation requires a selected meal slot',
      );
    const result = await explainMealReasons({
      planId: id,
      planRevision: row.revision,
      slotId: meal.slotId,
      locale: input.locale,
      reasonCodes: meal.reasons,
      enabled,
      transport: this.options.explanationTransport,
    });
    this.assertRevision(await getGeneratedMealPlan(this.db, scope, id), input.revision);
    return result;
  }

  async regenerate(scope: Scope, id: string, input: z.infer<typeof RegenerateMealPlanSchema>) {
    const row = await getGeneratedMealPlan(this.db, scope, id);
    this.assertRevision(row, input.revision);
    const stored = this.decode(row);
    const intent = input.intent ?? stored.intent;
    const now = this.now();
    const snapshot = await this.snapshot(scope, now);
    const currentVersions = new Map<string, number | undefined>([
      ...snapshot.catalog.recipes.map(
        (recipe) => [`recipe:${recipe.id}`, recipe.provenance.version] as const,
      ),
      ...snapshot.catalog.families.map(
        (family) => [`family:${family.id}`, family.provenance.version] as const,
      ),
    ]);
    // Regenerate is the revalidation path: stale locks are dropped, never silently redirected.
    const locks = stored.locks
      .filter((entry) =>
        intent.slots.some(
          (slot) => `${slot.date}:${slot.mealType}:${slot.sequence}` === entry.slotId,
        ),
      )
      .filter(
        (entry) =>
          currentVersions.get(`${entry.lock.kind}:${entry.lock.id}`) === entry.lock.version,
      );
    if (this.options.compositionV2Enabled && (await planHasCompositions(this.db, scope, id))) {
      const composed = await this.compositions().regenerateComposed(scope, { row, intent, locks, snapshot, now });
      return this.dto(
        await writePlanCompositions(this.db, scope, {
          planId: id,
          expectedRevision: input.revision,
          planUpdate: {
            intentJson: serialize({ intent, locks: composed.locks }),
            resultJson: serialize(composed.result),
            sourceJson: serialize(this.sourceIdentity(snapshot)),
          },
          slots: composed.writes,
          deleteSlotIds: composed.deleted,
        }),
        snapshot,
      );
    }
    const result = this.run(scope, id, intent, locks, snapshot, now);
    return this.dto(
      await updateGeneratedMealPlan(this.db, scope, {
        id,
        expectedRevision: input.revision,
        intentJson: serialize({ intent, locks }),
        resultJson: serialize(result),
        sourceJson: serialize(this.sourceIdentity(snapshot)),
      }),
      snapshot,
    );
  }

  async swap(scope: Scope, id: string, input: z.infer<typeof SwapMealSchema>) {
    const row = await getGeneratedMealPlan(this.db, scope, id);
    this.assertRevision(row, input.revision);
    const stored = this.decode(row);
    const original = stored.result.meals.find((meal) => meal.slotId === input.slotId);
    if (!original)
      throw new MealPlanningError('SLOT_NOT_FOUND', 422, 'Swap requires a selected meal slot');
    if (
      this.options.compositionV2Enabled &&
      (await readPlanCompositions(this.db, scope, id)).has(input.slotId)
    ) {
      throw new MealPlanningError(
        'COMPOSITION_MANAGED_SLOT',
        409,
        'This meal is edited as a composition; change its dishes through the meal editor',
      );
    }
    const now = this.now();
    const snapshot = await this.snapshot(scope, now);
    if (this.authorityChanged(stored, snapshot)) {
      throw new MealPlanningError(
        'CATALOG_AUTHORITY_CHANGED',
        409,
        'Recipe catalog authority changed since this plan was generated; regenerate the plan',
      );
    }
    if (stored.fingerprints.catalog !== snapshot.fingerprint.parts.catalog) {
      throw new MealPlanningError(
        'PLAN_REVALIDATION_REQUIRED',
        409,
        'Regenerate the plan before changing meals',
      );
    }
    // The replacement must be in the authority-fenced catalog: a D1-only recipe under static authority is a typed rejection.
    const source =
      input.replacement.kind === 'recipe'
        ? snapshot.catalog.recipes.find((recipe) => recipe.id === input.replacement.id)
        : snapshot.catalog.families.find((family) => family.id === input.replacement.id);
    if (!source)
      throw new MealPlanningError(
        'REPLACEMENT_NOT_FOUND',
        422,
        'Replacement is not in the trusted recipe catalog',
      );
    const lock = PlannerLockSchema.parse({
      ...input.replacement,
      version: source.provenance.version,
    });
    const locks = [
      ...stored.locks.filter((entry) => entry.slotId !== input.slotId),
      { slotId: input.slotId, lock },
    ];
    const generated = this.run(scope, id, stored.intent, locks, snapshot, now);
    const selected = generated.result.meals.find((meal) => meal.slotId === input.slotId);
    if (!selected || generated.result.status !== 'feasible') {
      throw new MealPlanningError(
        'SWAP_NOT_FEASIBLE',
        422,
        'Replacement cannot produce a complete plan under current constraints',
      );
    }
    const result = {
      ...generated,
      lastSwap: { slotId: input.slotId, previous: original.source, replacement: selected.source },
    };
    return this.dto(
      await updateGeneratedMealPlan(this.db, scope, {
        id,
        expectedRevision: input.revision,
        intentJson: serialize({ intent: stored.intent, locks }),
        resultJson: serialize(result),
        sourceJson: serialize(this.sourceIdentity(snapshot)),
      }),
      snapshot,
    );
  }

  async shopping(scope: Scope, id: string, input: z.infer<typeof OptimizePlanShoppingSchema>) {
    const row = await getGeneratedMealPlan(this.db, scope, id);
    this.assertRevision(row, input.revision);
    const stored = this.decode(row);
    const freshness = await this.freshness(row);
    if (freshness.reasons.includes('catalog_authority_changed')) {
      throw new MealPlanningError(
        'CATALOG_AUTHORITY_CHANGED',
        409,
        'Recipe catalog authority changed since this plan was generated; regenerate the plan',
      );
    }
    if (freshness.status !== 'fresh')
      throw new MealPlanningError(
        'PLAN_REVALIDATION_REQUIRED',
        409,
        'Regenerate the plan before optimizing shopping',
      );
    const asOf = this.now();
    const catalog = this.options.purchaseCatalog
      ? await this.options.purchaseCatalog(scope, asOf)
      : {
          snapshotId: 'no-reviewed-catalog',
          options: [],
          status: 'reviewed_catalog_unavailable' as const,
        };
    const budget = input.budget
      ? {
          householdId: scope.householdId,
          revision: `${id}:${row.revision}`,
          mode: input.budget.mode,
          currency: input.currency,
          amountMinor: Number(input.budget.money.minorAmount),
        }
      : null;
    // T20: a plan with canonical composed slots is projected over every component, then handed to
    // the unchanged T05 optimizer; plans without compositions keep the stored V1 projection.
    const mealPlan =
      this.options.compositionV2Enabled && (await planHasCompositions(this.db, scope, id))
        ? await this.compositions().shoppingPlanFor(scope, row)
        : stored.shoppingPlan;
    const context = createShoppingContext(() => ({
      ...scope,
      currency: input.currency,
      mealPlan,
      budget,
      catalog: { snapshotId: catalog.snapshotId, asOf, options: catalog.options },
    }));
    const result = optimizeShopping({ context });
    this.assertRevision(await getGeneratedMealPlan(this.db, scope, id), input.revision);
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'meal_shopping_result',
        catalogStatus: catalog.status,
      }),
    );
    return PlanShoppingDtoSchema.parse({
      schemaVersion: 1,
      planId: id,
      planRevision: row.revision,
      priceAsOf: asOf,
      requiresPriceRevalidation: true,
      catalogStatus: catalog.status,
      result: toShoppingResultDto(result),
    });
  }

  async feedback(scope: Scope, id: string, input: z.infer<typeof PlanFeedbackSchema>, key: string) {
    const row = await getGeneratedMealPlan(this.db, scope, id);
    this.assertRevision(row, input.revision);
    const stored = this.decode(row);
    const meal = stored.result.meals.find((item) => item.slotId === input.slotId);
    if (!meal)
      throw new MealPlanningError('SLOT_NOT_FOUND', 422, 'Feedback requires a selected meal slot');
    const now = this.now();
    let event: { id: string; occurredAt: string };
    if (input.type === 'cooked') {
      const { annotation } = await recordCookedGeneratedMealPlanAnnotation(this.db, scope, {
        id: crypto.randomUUID(),
        planId: id,
        expectedRevision: input.revision,
        slotId: input.slotId,
        requestKey: key,
      });
      event = { id: annotation.id, occurredAt: annotation.createdAt };
    } else {
      const swap = stored.lastSwap;
      if (input.type === 'swapped' && (!swap || swap.slotId !== input.slotId)) {
        throw new MealPlanningError(
          'SWAP_FEEDBACK_INVALID',
          422,
          'Swapped feedback requires a server-applied swap in this revision',
        );
      }
      const target = input.type === 'swapped' ? swap!.previous : meal.source;
      const replacement = input.type === 'swapped' ? swap!.replacement : undefined;
      event = await recordPlanningTaste(this.db, scope, {
        planId: id,
        revision: input.revision,
        slotId: input.slotId,
        key,
        type: input.type,
        occurredAt: now,
        target: { kind: target.kind, id: target.id },
        replacement: replacement ? { kind: replacement.kind, id: replacement.id } : undefined,
      });
    }
    return PlanFeedbackDtoSchema.parse({
      schemaVersion: 1,
      ...event,
      planId: id,
      planRevision: input.revision,
      slotId: input.slotId,
      type: input.type,
      inventoryMutated: false,
    });
  }
}
