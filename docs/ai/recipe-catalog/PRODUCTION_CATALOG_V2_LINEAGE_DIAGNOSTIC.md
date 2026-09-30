# Production catalog V2 semantic lineage diagnostic

Status: `READ_ONLY_TOOLING_READY_FOR_REVIEW`. No production recovery, 0039 apply, restore or deploy is authorized.

## Why this comparison exists

Protected production run `36653466481` on main `252096cccf602d07d6e33067024c5df2d6ba8a3e` proved:

- ledger 38 / `0038_auth_onboarding_completion.sql` (0039 missing)
- 500 recipes, 6720 ingredient rows, 0 order rows, 0/500 hydrated (`missing_ingredient_position`)
- historical V1 identity is rejected: `exact_historical_lines=0`, `live_only_lines=6720`, `historical_missing_from_live=2702`, recipe IDs still match
- all 500 production recipes report `version=2`

Canonical Recipe Refresh V2 (`data/recipe-refresh/v2`) is 500 recipes / 6766 ingredient lines / `productionReleaseReady=false`. Count proximity (6720 vs 6766, gap 46) is not identity proof.

## Reviewed read-only surface

The existing `Production D1 Read-Only Diagnostics` workflow keeps its exact-main CI gate, production Environment approval, Cloudflare/D1 identity check and five guarded catalog SELECTs. An additive runner-local step compares those already-read ingredient rows to the committed V2 package. It makes **no additional production query** and has no Cloudflare secret in its environment.

`semanticLineKey`:

- exact: `recipe_id`, `ingredient_id`, `name`, `required_quantity`, `unit`, `is_optional` vs V2 `identity.id`, `canonicalIngredientId`, `sourceName`, `quantity.amount`, `quantity.unit`, `optional`
- runtime exact: production quantity/unit vs V2 `quantity.runtime.amount` / `quantity.runtime.unit`
- normalized: NFKC, trim, collapse whitespace, casefold name/unit; ingredient IDs may be omitted only after exact matching fails
- multiplicity-preserving bags; identical semantic duplicates match as a multiset but are position-ambiguous
- mixed exact keys that collapse to one normalized key are `AMBIGUOUS`, never a forced assignment

The `production-catalog-v2-lineage-<run>-<attempt>` artifact contains only counts, SHA-256 digests, classification totals and boolean proof flags. Raw names, line IDs and recipe IDs stay on the runner.

`researchV2LineageProven` remains false until ingestion/transformation provenance is independently proven. This diagnostic never writes positions. `positionAuthority` may be `NONE`, `PARTIAL`, or `CANONICAL_V2_ORDER_CANDIDATE` only.

## What this cannot establish

It cannot prove the writer that produced 6720 live rows. No repository D1 ingest path from V2 canonical JSON was found. The official V2 runtime projection is 3770 lines, not 6720. V2 is not production-release-ready. Historical V1 positions remain rejected.

Do not apply 0039, restore D1, replay migrations, or invent positions from this tooling.
