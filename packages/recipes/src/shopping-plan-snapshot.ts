import { z } from 'zod';
import { CanonicalIngredientIdSchema, StandardUnitSchema } from '../../domain/src/foundation';
import type { WeeklyMealPlan } from './planner-types';

const IdentitySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim() && !value.includes('\0'));
const InstantSchema = z.string().datetime({ offset: true });
const QuantitySchema = z.number().finite().nonnegative();
const PlannerStatusSchema = z.enum(['feasible', 'partial', 'infeasible', 'search_limited', 'incomplete']);
const PlannerConclusionSchema = z.enum([
  'feasible',
  'proven_infeasible',
  'no_plan_found_without_proof',
]);

/** The persisted subset T05 needs; ranking evidence and planner branches never cross this boundary. */
export const ShoppingMealPlanSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentitySchema,
    householdId: IdentitySchema,
    userId: IdentitySchema,
    planningReference: z
      .object({
        instant: InstantSchema,
        localDate: z.string().date(),
        utcOffsetMinutes: z.number().int().min(-840).max(840),
      })
      .strict(),
    sourceSnapshot: z
      .object({
        id: IdentitySchema,
        capturedAt: InstantSchema,
        fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
        catalogSource: z.enum(['provided', 'static', 'd1']),
        recipes: z.array(z.object({ id: IdentitySchema, version: z.number().int().positive() }).strict()),
        families: z.array(z.object({ id: IdentitySchema, version: z.number().int().positive() }).strict()),
        requiresRevalidationBeforeAcceptance: z.literal(true),
      })
      .strict(),
    request: z
      .object({
        startDate: z.string().date(),
        horizonDays: z.number().int().min(1).max(14),
      })
      .strict(),
    status: PlannerStatusSchema,
    conclusion: PlannerConclusionSchema,
    slots: z.array(
      z
        .object({
          id: IdentitySchema,
          date: z.string().date(),
          instant: InstantSchema,
          ranked: z.object({ candidate: z.object({ id: IdentitySchema }).strict() }).strict(),
          projectedConsumption: z.array(z.object({ householdId: IdentitySchema }).strict()),
          shortages: z.array(
            z
              .object({
                ingredientId: CanonicalIngredientIdSchema,
                unit: StandardUnitSchema,
                isOptional: z.boolean(),
                status: z.enum(['satisfied', 'partial', 'missing', 'unresolved']),
                missingQuantity: QuantitySchema.nullable(),
                sourceLineIndices: z.array(z.number().int().nonnegative()),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    unplannedSlots: z.array(
      z
        .object({
          id: IdentitySchema,
          date: z.string().date(),
          mealType: z.enum(['breakfast', 'lunch', 'dinner']),
          sequence: z.number().int().nonnegative(),
          time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
          instant: InstantSchema,
          servings: z.number().int().positive(),
          lock: z
            .object({
              kind: z.enum(['recipe', 'family']),
              id: IdentitySchema,
              version: z.number().int().positive(),
              variantId: IdentitySchema.optional(),
            })
            .strict()
            .optional(),
          reasons: z.array(IdentitySchema),
        })
        .strict(),
    ),
    initialInventorySnapshot: z.array(z.object({ householdId: IdentitySchema }).strict()),
    projectedFinalInventory: z.array(
      z
        .object({
          id: IdentitySchema,
          householdId: IdentitySchema,
          version: z.number().int().safe().positive(),
          ingredientId: z.union([CanonicalIngredientIdSchema, z.literal('')]),
          quantity: QuantitySchema,
          initialQuantity: QuantitySchema,
          consumedQuantity: QuantitySchema,
          unit: StandardUnitSchema,
          freshness: z.enum(['fresh', 'use_soon', 'expiring', 'out_of_stock']).nullable(),
          expiryDate: z.string().date().nullable(),
          expiryKind: z.enum(['unknown', 'best_before', 'use_by', 'estimated']),
          storage: z.enum(['fridge', 'freezer', 'pantry']).optional(),
          openedAt: InstantSchema.nullish(),
          expirySource: z.enum(['unknown', 'user', 'ocr', 'imported', 'estimated']).optional(),
          addedDate: z.string().min(1).max(40).optional(),
          updatedAt: z.string().min(1).max(40).optional(),
        })
        .strict(),
    ),
    diagnostics: z.array(
      z.object({ slotId: IdentitySchema.nullable(), code: IdentitySchema, count: z.number().int().nonnegative() }).strict(),
    ),
    catalogDiagnostics: z.array(z.unknown()),
    search: z
      .object({
        searchExhaustive: z.boolean(),
        plannerSearchExhaustive: z.boolean(),
        recipeSearchExhaustive: z.boolean(),
        truncated: z.boolean(),
        statesExplored: z.number().int().nonnegative(),
        generationCalls: z.number().int().nonnegative(),
        candidatesEvaluated: z.number().int().nonnegative(),
        maxCandidatesGenerated: z.number().int().nonnegative(),
        maxCandidatesConsidered: z.number().int().nonnegative(),
        maxFrontierSize: z.number().int().positive(),
        limits: z.unknown(),
        familySearches: z.array(z.unknown()),
        rejections: z.array(z.unknown()),
        limitReasons: z.array(IdentitySchema),
        incompleteReasons: z.array(
          z.object({ source: IdentitySchema, code: IdentitySchema }).strict(),
        ),
        proofScope: z.literal('supplied_catalog_constraints_and_fixed_allocation_policy'),
      })
      .strict(),
    persistence: z.literal('generated_only'),
  })
  .strict();

export type ShoppingMealPlanSnapshot = z.infer<typeof ShoppingMealPlanSnapshotSchema>;

export function isWeeklyMealPlan(value: ShoppingMealPlanSnapshot | WeeklyMealPlan): value is WeeklyMealPlan {
  return 'nutrition' in value && 'utility' in value && 'leftovers' in value;
}

export function normalizeShoppingMealPlan(
  plan: ShoppingMealPlanSnapshot | WeeklyMealPlan,
): ShoppingMealPlanSnapshot {
  return isWeeklyMealPlan(plan) ? projectShoppingMealPlan(plan) : ShoppingMealPlanSnapshotSchema.parse(plan);
}

/** Project a trusted T04 result before persistence; this intentionally omits ranking and evidence internals. */
export function projectShoppingMealPlan(plan: WeeklyMealPlan): ShoppingMealPlanSnapshot {
  return ShoppingMealPlanSnapshotSchema.parse({
    schemaVersion: plan.schemaVersion,
    id: plan.id,
    householdId: plan.householdId,
    userId: plan.userId,
    planningReference: plan.planningReference,
    sourceSnapshot: plan.sourceSnapshot,
    request: { startDate: plan.request.startDate, horizonDays: plan.request.horizonDays },
    status: plan.status,
    conclusion: plan.conclusion,
    slots: plan.slots.map((slot) => ({
      id: slot.id,
      date: slot.date,
      instant: slot.instant,
      ranked: { candidate: { id: slot.ranked.candidate.id } },
      projectedConsumption: slot.projectedConsumption.map(({ householdId }) => ({ householdId })),
      shortages: slot.shortages.map((shortage) => ({
        ingredientId: shortage.ingredientId,
        unit: shortage.unit,
        isOptional: shortage.isOptional,
        status: shortage.status,
        missingQuantity: shortage.missingQuantity,
        sourceLineIndices: shortage.sourceLineIndices,
      })),
    })),
    unplannedSlots: plan.unplannedSlots.map((slot) => ({
      id: slot.id, date: slot.date, mealType: slot.mealType, sequence: slot.sequence,
      time: slot.time, instant: slot.instant, servings: slot.servings,
      ...(slot.lock ? { lock: slot.lock } : {}), reasons: slot.reasons,
    })),
    initialInventorySnapshot: plan.initialInventorySnapshot.map(({ householdId }) => ({ householdId })),
    projectedFinalInventory: plan.projectedFinalInventory,
    diagnostics: plan.diagnostics,
    catalogDiagnostics: plan.catalogDiagnostics,
    search: {
      searchExhaustive: plan.search.searchExhaustive,
      plannerSearchExhaustive: plan.search.plannerSearchExhaustive,
      recipeSearchExhaustive: plan.search.recipeSearchExhaustive,
      truncated: plan.search.truncated,
      statesExplored: plan.search.statesExplored,
      generationCalls: plan.search.generationCalls,
      candidatesEvaluated: plan.search.candidatesEvaluated,
      maxCandidatesGenerated: plan.search.maxCandidatesGenerated,
      maxCandidatesConsidered: plan.search.maxCandidatesConsidered,
      maxFrontierSize: plan.search.maxFrontierSize,
      limits: plan.search.limits,
      familySearches: plan.search.familySearches,
      rejections: plan.search.rejections,
      limitReasons: plan.search.limitReasons,
      incompleteReasons: plan.search.incompleteReasons,
      proofScope: plan.search.proofScope,
    },
    persistence: plan.persistence,
  });
}

/** Decode only the narrow persisted projection, never a client-provided T04 domain plan. */
export function parseShoppingMealPlanJson(json: unknown): ShoppingMealPlanSnapshot {
  return ShoppingMealPlanSnapshotSchema.parse(json);
}

export function serializeShoppingMealPlan(snapshot: ShoppingMealPlanSnapshot): string {
  return JSON.stringify(ShoppingMealPlanSnapshotSchema.parse(snapshot));
}
