import {
  candidateRestrictionFacts,
  evaluateHardRestrictions,
  nutritionFacts,
  resolveRankingPreferences,
  type Recipe,
  type RecipeAuthoritySource,
  type RecipeCandidate,
} from '@frigo/recipes';
import {
  createRankingEvidenceProviderFromNutritionRows,
  loadRankingContext,
  type D1DatabaseBinding,
  type RankingNutritionRow,
} from '@frigo/db';

export interface CookingHardRestrictionResult {
  /** True when the cook must be rejected before any success response or mutation. */
  blocked: boolean;
  /** Canonical hard-restriction reason codes (safe to log; contains no PII). */
  reasons: string[];
}

/**
 * T19 cooking-boundary hard restrictions.
 *
 * The planner and T20 Manual/Assisted/Auto evaluate household hard restrictions
 * through the canonical T03 `evaluateHardRestrictions` (fail-closed). The
 * cooking endpoints used to skip that check entirely, so a recipe the planner
 * refuses (allergen / dietary / time / nutrition / forbidden / never-recommend)
 * could still be cooked by calling the endpoint directly.
 *
 * This reuses the canonical evaluator at the cooking boundary. Facts are built
 * with the same `candidateRestrictionFacts` the planner uses, from a minimal
 * candidate shim over the already-resolved authority recipe:
 * - static authority: the served recipe only — no D1 planner facts are
 *   consumed, prep time stays unknown (exactly like the planner's static path);
 * - D1 authority: the served recipe plus the D1 row's `prep_time_minutes`
 *   (NULL maps to unknown, like the planner's enrichment), the D1
 *   `recipe_classifications`, and the canonical nutrition evidence provider
 *   (which deliberately supplies no reviewed safety verdicts, so requested
 *   allergen/dietary tags without evidence fail closed as SAFETY_UNKNOWN).
 *
 * The shim only carries the fields the canonical functions read
 * (`candidateRestrictionFacts`: requirements/source/classifications/times;
 * nutrition evidence provider: source catalog+kind+id+version/variant/
 * requirements). Cooking never substitutes ingredients, so the shim carries no
 * substitutions — the cooked dish is judged on its actual ingredient lines.
 *
 * Any failure while loading policies or facts blocks the cook (fail-closed).
 * Callers must invoke this before returning success from `cook/start` and
 * before any durable mutation in `cook/complete`.
 */
export async function evaluateCookingHardRestrictions(
  db: D1DatabaseBinding,
  auth: { householdId: string; userId: string },
  authoritySource: RecipeAuthoritySource,
  recipe: Recipe,
): Promise<CookingHardRestrictionResult> {
  try {
    const context = await loadRankingContext(db, {
      householdId: auth.householdId,
      userId: auth.userId,
    }, new Date().toISOString());
    const policies = resolveRankingPreferences(context).hard;
    if (policies.length === 0) return { blocked: false, reasons: [] };

    // D1 planner facts for this recipe. Static/shadow/canary-outside must never
    // consume them.
    let prepTimeMinutes: number | undefined;
    let version = 0;
    let classifications: Array<{ kind: string; tag: string }> = [];
    let nutritionRows: RankingNutritionRow[] = [];
    if (authoritySource === 'd1') {
      const [recipeRow, classificationRows, nutritionResult] = await db.batch([
        db.prepare('SELECT prep_time_minutes, version FROM recipes WHERE id = ? LIMIT 1').bind(recipe.id),
        db.prepare('SELECT kind, tag FROM recipe_classifications WHERE recipe_id = ? ORDER BY kind, tag').bind(recipe.id),
        db.prepare(
          `SELECT r.id AS recipe_id, r.version AS recipe_version,
              p.id AS profile_id, p.basis_quantity, p.basis_unit, p.source_type,
              p.source_reference, p.energy_kcal, p.protein_g, p.carbohydrate_g,
              p.fat_g, p.fiber_g, p.sugar_g, p.sodium_mg
            FROM recipes r
            LEFT JOIN recipe_nutrition rn
              ON rn.recipe_id = r.id AND rn.recipe_version = r.version
            LEFT JOIN nutrition_profiles p ON p.id = rn.nutrition_profile_id
            WHERE r.id = ?`,
        ).bind(recipe.id),
      ]);
      const row = (recipeRow.results?.[0] ?? null) as
        | { prep_time_minutes?: unknown; version?: unknown }
        | null;
      // The planner maps NULL prep to undefined (unknown total time).
      prepTimeMinutes = typeof row?.prep_time_minutes === 'number' ? row.prep_time_minutes : undefined;
      version = typeof row?.version === 'number' ? row.version : 0;
      classifications = ((classificationRows.results ?? []) as Array<{ kind: unknown; tag: unknown }>)
        .filter((item) => typeof item.kind === 'string' && typeof item.tag === 'string')
        .map((item) => ({ kind: item.kind as string, tag: item.tag as string }));
      nutritionRows = (nutritionResult.results ?? []) as RankingNutritionRow[];
    }

    const candidate = {
      id: `cooking:${recipe.id}`,
      source: { catalog: authoritySource === 'd1' ? 'd1' : 'static', kind: 'recipe', sourceId: recipe.id, version },
      variant: undefined,
      requirements: recipe.ingredients.map((line) => ({ ingredientId: line.ingredientId, substitutions: [] })),
      classifications: classifications.map((item) => ({ recipeId: recipe.id, kind: item.kind, tag: item.tag })),
      cookTimeMinutes: recipe.cookTimeMinutes,
      ...(prepTimeMinutes === undefined ? {} : { prepTimeMinutes }),
    } as unknown as RecipeCandidate;

    const evidence = authoritySource === 'd1'
      ? createRankingEvidenceProviderFromNutritionRows(nutritionRows)([candidate])[0]
      : undefined;
    const facts = candidateRestrictionFacts(candidate, evidence, nutritionFacts(evidence));
    const reasons = [...evaluateHardRestrictions(facts, policies).reasons];
    return { blocked: reasons.length > 0, reasons };
  } catch {
    return { blocked: true, reasons: ['RESTRICTION_CHECK_UNAVAILABLE'] };
  }
}
