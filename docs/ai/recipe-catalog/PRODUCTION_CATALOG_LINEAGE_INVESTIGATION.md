# Production catalog lineage investigation — 2026-09-29

Status: `PRODUCTION_DIAGNOSTIC_FAILED` (workflow_dispatch HTTP 403). Catalog conclusion: `CATALOG_LINEAGE_UNRESOLVED`. No production mutation, migration, restore, or deploy.

## Verified repository and main

- Canonical repository: `vn-tako4/Tako-san` (id `1385308553`; former name `takovn2/Tako-san` is the same id).
- `origin/main` = `252096cccf602d07d6e33067024c5df2d6ba8a3e` = merge of PR #28 (`feat(d1): add read-only catalog lineage diagnostic`).
- Exact-main CI run `36640577701` = SUCCESS on that SHA (workflow `CI`, event `push`).
- Local HEAD matched `origin/main`. Main did not move.

## Staging vs current main

- Last certified staging runtime SHA: `8072e0fea9f8f3588426969007dda06cadbbfbb7` (public `/api/v1/health/ready` commit `8072e0fea9f8f3588426969007dda06cadbbfbb7`, status `ok`, `configuredMode=d1`, `canaryPercent=0`, `cutoverEnabled=true`, `globalSource=d1`, `fallbackReason=null`, `expectedRecipeCount=500`, `releaseId=rel-bd00a4f53fcaeee4`).
- Full D1 staging deploy `36495580095` and readiness `36494932501` remain the last staging certification; T19/T20 were not re-run.
- Delta `8072e0fea9f8f3588426969007dda06cadbbfbb7` → `252096cccf602d07d6e33067024c5df2d6ba8a3e` is 13 files / +1141 / −1: diagnostics workflow, migrate workflow one-line change, docs, `scripts/production-d1-diagnostics.mjs`, `scripts/production-catalog-lineage.mjs`, and unit tests. **No** `src/worker/*`, `src/web/*`, or `packages/*` application runtime changes.

## Production public readiness (fresh, anonymous)

`GET https://frigo.tungjpstore.net/api/v1/health/ready` HTTP 200:

- `status=degraded`
- `environment=production`
- `commit=136cb6ff3d2921eac237c7b106b37ab5ee12a13f` (not current main; Worker has not been redeployed since the 2026-09-25 certification candidate)
- `recipeAuthority.configuredMode=d1`
- `cutoverEnabled=true`
- `canaryPercent=0`
- `globalSource=static`
- `fallbackReason=CATALOG_DIAGNOSTICS`
- `releaseId=rel-bd00a4f53fcaeee4`
- `expectedRecipeCount=500`
- `config.issues[0].code=CONFIG_RECIPE_CATALOG_D1_AUTHORITY` (warning)

This proves fail-closed static fallback. It does **not** re-prove live ingredient/order counts.

## Last protected D1 diagnostic (not on current main)

Run `36577380500` on `d0c670289534c33187181b2eb7192c05a2962e22` (PR #26), workflow SUCCESS, receipt `status=BLOCKED`, `certification=NOT_A_RELEASE_CERTIFICATION`, `productionMutations=[]`:

- database `frigo-db` / id matched the reviewed script constant
- ledger count 38, tip `0038_auth_onboarding_completion.sql`, missing only `0039_meal_composition_v2.sql`
- physical recipes 500
- ingredient rows 6720
- order rows 0
- ingredients without matching order 6720
- recipes affected 500
- orphan order rows 0
- hydrated 0/500, failure code `missing_ingredient_position` × 500

That run **did not** include PR #28 lineage comparison. Counts since then are unverified. Production D1 Migration workflow has **zero** runs.

## 2026-09-25 hydrated baseline (independent of 6720)

Production Read-Only Certification `36150184637` on `136cb6ff3d2921eac237c7b106b37ab5ee12a13f`: `certification.result=PASS`, `runtimeCatalog.hydrationFailureCount=0`, `actualRecipes=500`, fingerprint matched T14F V1 `rel-bd00a4f53fcaeee4` / batches `t14f-pilot-30-v1` + `t14f-scale-399-v1`. T15B pre-static receipt recorded `recipe_ingredients=2702` and `runtime_ingredient_order=2702` for that release. The Sep 25 artifact does not itself print ingredient-row counts.

## Local immutable 0038 replay (current main)

`replayHistoricalIngredientSource` on current migrations (unit tests 15/15 PASS):

- 500 recipes
- 2702 ingredient lines
- 2702 explicit contiguous positions
- Historical V1 is proven as a **source**, not as live production identity.

## Content Refresh V2 (PR #11 `8687ff9f3e8f6b6cbf466ee61968bb5f3469498c`, in main)

Committed package `data/recipe-refresh/v2`:

- `sourceStatus=RECIPE_REFRESH_V2_RESEARCH_CANONICALIZED`
- 500 recipes, 4938 steps, **6766** canonical ingredient rows with explicit JSON `position` (contiguous per recipe)
- `productionReleaseReady=false`
- blockers: `RUNTIME_PROJECTION_LOSS`, `INGREDIENT_RECONCILIATION_INCOMPLETE`, `SOURCE_CONTENT_VERIFICATION_INCOMPLETE`, `NUTRITION_EVIDENCE_INCOMPLETE`
- provisional runtime projection: **3770** lines, **no** position field, `projectionStatus=provisional`
- 2996 source rows excluded from runtime projection

Count comparison (identity is **not** proven by proximity):

- live last-known 6720
- V1 historical 2702 (delta +4018)
- V2 canonical 6766 (live is 46 below V2; V2−V1 = +4064)
- V2 projected 3770 (not 6720)

Same 500 recipe IDs as historical V1 (intersection 500). A hypothetical `{recipe}_ing_{1-based}` ID scheme would overlap all 2702 historical line IDs and add 4064 V2-only IDs. That is **not** live proof, not position authority, and not V2 lineage proof.

`researchV2LineageProven` remains **false**. V2 must not be used as order authority.

## Dispatch attempt (required first action)

Workflow: `Production D1 Read-Only Diagnostics`  
Inputs from `.github/workflows/production-d1-diagnostics.yml`:

- `ref` = `252096cccf602d07d6e33067024c5df2d6ba8a3e`
- `hardened_sha` = `136cb6ff3d2921eac237c7b106b37ab5ee12a13f` (last reviewed diagnostic/production Worker SHA; ancestor of current main; descendant of reviewed floor `af661af467ba8620ba6b2919ee958195d179380c`)
- `confirm_read_only_diagnostics` = `true`
- `--ref main` so `github.ref == refs/heads/main`

Result: `gh workflow run` HTTP **403** `Resource not accessible by integration`.

Local `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` = MISSING. No substitute production SELECT was possible. Previous successful dispatches were by user `vn-tako4`, not the GitHub App.

## What is not authorized

- Do not apply `0039_meal_composition_v2.sql` (does not restore ingredient order; production still fail-closed).
- Do not Time Travel restore, replay 0033–0038, edit `d1_migrations`, or guess positions (id/name/rowid/time/static/V2 projection).
- PR #20 is obsolete (`docs(t19): staging canary-1 observation…`); current staging is already full D1. Do not merge it into this release train.

## Recovery design

`possible=false`. Per-line live vs 0038 comparison has not run on current main. Even if 6720 still holds, CASE A (exact V1) is impossible by count. CASE C (canonical V2) is unproven. CASE B (2702 exact + live-only) is unproven without the lineage receipt.

Next required action: a human with Actions write and production Environment approval dispatches the read-only diagnostic on exact current main, then review `production-catalog-lineage-<run>-<attempt>` (counts/digests only) before any repair proposal.

```text
gh workflow run "Production D1 Read-Only Diagnostics" --ref main \
  -f ref=252096cccf602d07d6e33067024c5df2d6ba8a3e \
  -f hardened_sha=136cb6ff3d2921eac237c7b106b37ab5ee12a13f \
  -f confirm_read_only_diagnostics=true
```

`FINAL_RELEASE_SHA=UNSET`
