# T19 staging canary-1 observation / canary-5 promotion receipt (2026-09-28)

**FINAL_STATUS: `T19_CANARY_5_BLOCKED_WORKFLOW_DISPATCH_FORBIDDEN`.**
Staging was **not** promoted. It still serves `canary / 1 / true` on main
`85660fa497f3`. No D1, migration, secret, production or Worker change was made.

Blocker: the agent workspace's GitHub App installation has `actions: read` only.
`gh workflow run staging-d1-runtime-readiness.yml` returned
`HTTP 403 Resource not accessible by integration`, before and after credential
rotation (`X-Accepted-Github-Permissions: actions=read`). That means the fresh
readiness run (Phase 2) and the 5% Deploy (Phase 7) could not be dispatched.
Fresh inside-cohort evidence is also missing (see below). Either gap alone means
canary-5 cannot be certified.

## Receipt

```text
repository_full_name=takovn2/Tako-san
repository_id=1385308553
starting_main_sha=85660fa497f3   (merge of PR #19)
ending_main_sha=85660fa497f3     (re-fetched at 11:04Z; unchanged)

1pct_source_run_id=36385014725   (Deploy, workflow_dispatch, main, attempt 1)
  release=success staging=success production=skipped conclusion=success
1pct_source_artifact=release-staging-36385014725-1 (id 10954715165)
  previousRecipeAuthority: same commit, shadow/0/false, served 500, fingerprint match, d1 ready
  recipeAuthority: canary/1/true, globalSource=mixed, actualSource=d1, served 500,
  servedFingerprint == expectedRuntimeFingerprint, d1Readiness=ready, fallback=null,
  releaseId=rel-bd00a4f53fcaeee4, mealCompositionV2Enabled=true

fresh_readiness_run_id=NOT_DISPATCHED (HTTP 403, actions:write unavailable)
fresh_readiness_artifact=NONE
fresh_readiness_result=NOT_RUN
  latest prior (NOT fresh, before shadow/canary deploys): run 36364583331,
  01:05Z, STAGING_D1_RUNTIME_READINESS_CERTIFIED (500 recipes, ledger 0039,
  FK PASS, quick_check PASS, fingerprint match, provenance match)

1pct_current_authority (fresh, public GET /api/v1/health/ready at 10:52Z, 11:02Z, 11:04Z):
  commit=85660fa497f3 PASS
  mode=canary PASS
  percent=1 PASS
  cutover=true PASS
  global_source=mixed PASS
  release=rel-bd00a4f53fcaeee4 (expectedRecipeCount 500) PASS
  fallback=null PASS (public canary probe forces the D1 path)
  served_count=UNVERIFIED_FRESH (protected endpoint only; last protected proof 06:10Z = 500)
  readiness=UNVERIFIED_FRESH (last protected proof 06:10Z = ready)
  fingerprint=UNVERIFIED_FRESH (last protected proof 06:10Z = match)
  selected/actual source=UNVERIFIED_FRESH (last protected proof 06:10Z = d1/d1)

1pct_live_smoke (fresh, 11:00-11:04Z, 85 requests, sanitized):
  inside_cohort=NOT_RUN
  outside_cohort=PASS (3 new registered test accounts; all computed outside 1% and 5%; 71 recipes each)
  planner=PASS outside (7/7 planned recipes in catalog, detail 200, cook start 200; 0 D1-only)
  recipe_detail=PASS outside (every planned/composed/applied recipe 200)
  cooking=cook start PASS outside (18/18); cook complete NOT_RUN
  shopping=PASS outside (200 twice; catalogStatus=reviewed_catalog_unavailable is the
    purchase/price catalog, not recipe authority)
  T20_manual=PASS outside (add/lock/swap/remove/reread 200; D1-only swap 422 TARGET_NOT_FOUND)
  T20_assisted=PASS outside (proposal 3 components, apply 200, reload revision matches)
  T20_auto=PASS outside (3 options, apply 200, reload revision matches)
  hard_restrictions=time PASS outside (20 min slot cap: long recipe and rice 422
    HARD_CONSTRAINT_CONFLICT, composition unchanged, all auto options <= 20 min);
    dietary/allergen/nutrition NOT_RUN
  revision_conflict=PASS (stale swap 409 PLAN_REVISION_CONFLICT)
  ownership_isolation=PASS (B read/swap/compositions on A's plan all 404; A intact)
  d1_only_fence_outside=PASS (plan swap 422 REPLACEMENT_NOT_FOUND; detail 404; cook start 404)
  unexpected_500=0
  unexpected_404=0 (only expected 404s: D1-only recipe outside cohort, cross-household access)
  authority_split_outside=0 (planner == catalog == detail == cooking == shopping == T20, all static)

promotion_gate=BLOCKED
  transition map in scripts/release-check.mjs matches the reviewed state machine
  (static->shadow->canary-1->{canary-2,canary-5}; canary-2->canary-5; canary-5->canary-25; canary-25->d1)
  local: pnpm exec vitest run tests/unit/release-check.test.mjs = 236/236 PASS
  fresh validateRecipeCatalogTransition() against live protected evidence: NOT_RUN (token not available)

5pct_deploy_run_id=NONE
5pct_staging_job=NOT_RUN
production_job=NOT_RUN (no Deploy dispatched)
5pct_authority=NOT_APPLICABLE

mutation:
  d1_catalog_mutation=NO
  migration=NO
  production_mutation=NO
  secret_change=NO
  staging_worker_change=NO
  staging_user_test_data=YES: 3 registered test accounts created through the public
    staging register flow, each with its own plan and compositions. Sessions were kept
    in memory only and discarded. No IDs, emails, OTPs or cookies were recorded.
    Not cleaned up.

FINAL_STATUS=T19_CANARY_5_BLOCKED_WORKFLOW_DISPATCH_FORBIDDEN
```

## Why inside-cohort was not run

Canary membership is `fnv1a32("recipe-catalog-canary:" + householdId) % 10000 < 100`
at 1%. Household IDs are generated server-side, so a fresh account lands in the
cohort about 1% of the time. The only override is the operator test cohort
(`RECIPE_CATALOG_TEST_*` Worker secrets), and this task forbids secret changes. The
agent did not mass-register accounts (about 100 expected) to find a cohort member.
That needs an explicit operator decision.

## Observation for review

The staging job in `.github/workflows/deploy.yml` checks the live pre-deploy authority
with `release-check.mjs previous-authority`. That runs
`verifyPreviousRecipeAuthority` / `verifyRecipeAuthorityEvidence`, but staging never
calls `validateRecipeCatalogTransition()`. Only the production job runs `transition`.
On staging, the forward-only map is therefore enforced by operator discipline, not by
the workflow. This task did not change it.

## Next action (operator)

1. Give the agent GitHub App `actions: write`, or dispatch manually.
2. Dispatch **Staging D1 Runtime Readiness** on the current main SHA with
   `confirm_staging_readiness=true`, and require `STAGING_D1_RUNTIME_READINESS_CERTIFIED`.
3. Decide how to get inside-cohort evidence: authorize staging test cohort secrets
   in a separate task, or authorize bounded brute-force registration. Then run the
   inside matrix, including cook complete and dietary/allergen checks.
4. Only then dispatch Deploy: `environment=staging`, `ref=<main>`,
   `hardened_sha=<same as run 36385014725>`, `recipe_catalog_mode=canary`,
   `recipe_catalog_d1_canary_percent=5`, `meal_composition_v2_enabled=true`,
   `confirm_production=false`, `confirm_recipe_catalog_rollback=false`. Then verify
   the 5% receipt and confirm production was skipped.
