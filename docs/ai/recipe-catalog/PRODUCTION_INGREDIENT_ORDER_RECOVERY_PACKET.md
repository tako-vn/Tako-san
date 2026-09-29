# Production recipe ingredient order: diagnostic receipt and recovery STOP

Status: `CATALOG_ORDER_RECOVERY_DESIGN_REQUIRED`. This is a read-only evidence packet, not an authorization or executable repair. D1 recipe-authority promotion, migration 0039, deployment and T20 promotion remain stopped; the existing static fallback remains in service.

## Verified receipt (2026-09-29 UTC)

- PR #26 merged as main `d0c670289534c33187181b2eb7192c05a2962e22`; exact-main CI run `36576510231` succeeded.
- Production Environment-approved, read-only workflow run `36577380500` succeeded on that SHA. The sanitized `production-d1-diagnostics-36577380500-1` artifact has `status=BLOCKED` and `certification=NOT_A_RELEASE_CERTIFICATION`. It identifies `frigo-db` / `f975ec39-b2c8-4a2a-80e1-0366054599d3`; `productionMutations=[]`.
- Ledger: 38 entries, tip `0038_auth_onboarding_completion.sql`; only `0039_meal_composition_v2.sql` is missing from the current repository manifest.
- Catalog: 500 physical recipes, 6,720 recipe ingredient rows, **zero** `recipe_runtime_ingredient_order` rows. All 6,720 ingredient rows have no matching order; all 500 recipes are affected. Orphan order rows: zero. Runtime hydration: 0/500, with 500 `missing_ingredient_position` failures.
- The earlier run `36150184637` reported 500 hydrated recipes on 2026-09-25. It does not establish when or why order rows disappeared. The last observed public fallback was `CATALOG_DIAGNOSTICS`; this receipt itself is not a fresh public-readiness proof.

## Contract and interpretation

`0034_global_recipe_catalog_parity.sql`, `0036_recipe_catalog_pilot.sql` and `0037_recipe_catalog_scale.sql` contain explicit ingredient-position inserts. `packages/recipes/src/runtime-hydration.ts` requires one explicit, unique, contiguous position per ingredient line and fails closed when any are absent. The aggregate proves the current failure is an empty mapping table, not merely a mismatched join. It does **not** prove which writer removed rows or that the 6,720 live ingredient lines still equal the immutable historical V1 catalog. Count alone is not identity or ordering evidence.

Do not derive positions from lexical ingredient IDs, source-name sorting, row insertion order, the static 71, or the provisional Content Refresh V2 projection. Do not replay historical migrations, edit `d1_migrations`, restore D1 Time Travel, or insert order rows based only on these counts. Migration 0039 adds separate T20 tables and cannot repair this catalog failure.

## Required before a recovery implementation can be reviewed

1. Add a separately reviewed, Environment-gated **read-only** comparison that proves the live per-recipe ingredient IDs and semantic line content against a named immutable, reviewed source. Retain only safe aggregates/digests in artifacts. Determine whether production lines are historical V1, later enrichment, or mixed; do not assume the reported 6,720 lines are a complete release.
2. Identify a trustworthy explicit position for **each live ingredient line**. Record the source/version and all unmatched or ambiguous rows; any unresolved line blocks an order repair. Investigate available audit/Time Travel evidence for the regression window without treating a bookmark as permission to restore.
3. Design a separate reviewed repair with exact D1 identity, exact-main/CI, current-ledger/content preflight, fresh bookmark, bounded atomic write, post-write FK/quick checks, 500/500 hydration, release fingerprint and authority/readiness proof. Define a rollback decision that protects writes made after the bookmark. No production write is authorized by this packet.
4. Certify catalog recovery independently before considering the 0039 migration packet. Keep T20 flags and production rollout off until their own gates pass.

`FINAL_RELEASE_SHA=UNSET`; no 0040 or Content Refresh V2 data is part of this recovery packet.
