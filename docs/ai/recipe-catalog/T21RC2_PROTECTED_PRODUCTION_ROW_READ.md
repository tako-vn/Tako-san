# T21R-C2 — Protected production row-read implementation

Status: PR #36 CI-history remediation; renewed exact-head review required. Code and
tests only. Production dispatch, production reads and Cloudflare production
calls are **not authorized** by this task. `T21G_NOT_READY`; repair, 0039 and
production deployment remain stopped. Row-level delivery is `UNCONFIGURED` /
`DELIVERY_NOT_AUTHORIZED`.

## PR #36 hosted CI history remediation — 2026-10-02 UTC

This checkpoint repairs only `HOSTED_CI_GIT_HISTORY_FIX` after independent review
of `3e1bb60b7afa9706fca6bfed41252bfd4d421cdd`. PR #36 remains open and unmerged on
`codex/t21rc2-protected-production-row-read`; certified main remains
`518818458a354c5e180da52ae9bb73c9d3c1af78`. No production authorization follows from
this change or a passing PR check.

### Verified failure and cause

Original CI run `37002486858`, validate job `110823126447`: ESLint/typecheck
PASS; Vitest FAIL during `t21rc2-production-capture.test.mjs` module setup;
migration smoke/build SKIPPED. Hosted Vitest reported 229 passing suites, one
failed suite, and 5,121 passing collected tests. The safe failure was
`T21RC2_LEDGER_CHANGED` from `reviewedLedgerNames` at capture line 110 and test
line 20, not an observed change to production.

Inspected the actual Actions checkout log, not just workflow defaults:

```text
RUN_37002486858_CHECKOUT_FETCH_DEPTH = 1
RUN_37002486858_FETCHED_REF = db7728d0203089e8f35897f2fff2f2e35437e026
git fetch ... --depth=1 origin +db7728d0203089e8f35897f2fff2f2e35437e026:refs/remotes/pull/36/merge
HEAD is now at db7728d Merge 3e1bb60b... into 51881845...
ROOT_CAUSE = SHALLOW_CHECKOUT_MISSING_HISTORICAL_COMMIT
ACTUAL_LEDGER_DRIFT_FOUND = NO
```

Local `git show 51881845:migrations/0038_auth_onboarding_completion.sql` and
`git ls-tree -r 51881845 -- migrations` resolve the certified historical tree:
exactly 39 repository migrations, index 37 is 0038, index 38 is
`0039_meal_composition_v2.sql`. Real
`reviewedLedgerNames(cwd, 51881845)` returns exactly the first 38 names,
ending at `0038_auth_onboarding_completion.sql`, with 0039 absent.

An offline throwaway `git clone --no-local --no-checkout --depth=1 file://...`
also reproduced missing certified-main object (Git exit 128), followed by the
same `T21RC2_LEDGER_CHANGED` from the existing helper. The full-history checkout
succeeded without modifying that helper. The first direct-path clone attempt
was unsuitable: Git ignores depth for local clones and the sandbox refused its
hardlink. The corrected file-transport clone used no network and was removed.

### Minimal remediation and review consequence

Only CI `actions/checkout@v4` configuration gains `fetch-depth: 0`. The existing
T21R-C2 workflow static suite now parses `ci.yml` and requires full history on
the Actions checkout, so exact historical ledger/review objects cannot silently
disappear again. No unit-test network fetch, authority fallback or HEAD substitution.
No Action version/pinning, Node/pnpm version, permission, secret, other CI step,
production workflow or Cloudflare configuration change.

`schema.count !== 39`, the 0038/0039 repository expectations,
`schema.migrations.slice(0, 38)`, exact live-ledger name comparison, and all
fixed-query/approval/identity/stability/privacy guards are unchanged. No applied
migration or classifier/schema/target is edited. `T21RC2_REVIEW_BOUND_PATHS`
remains the same 73-entry constant.

CI workflow bytes **are** review-bound, so old independent review of `3e1bb60b`
is not sufficient for this new head. Obtain independent delta review of
`3e1bb60b` to the one normally pushed remediation commit and renewed PR approval
before any merge. Do not remove CI from the closure to preserve stale approval.

### Checkpoint evidence and handoff

Local capture suite PASS (70 tests); approval 143, receipt 8, workflow 8, C2
total 229. Executed:

```sh
pnpm exec vitest run tests/unit/t21rc2-production-capture.test.mjs tests/unit/t21rc2-production-approval.test.mjs tests/unit/t21rc2-production-receipt.test.mjs tests/unit/t21rc2-workflow.test.mjs --maxWorkers=1
pnpm exec vitest run tests/unit/t21rc2-*.test.mjs tests/unit/t21rc-row-reconciliation.test.mjs tests/unit/t21rb-v1-semantic.test.mjs tests/unit/t21rb-v1-production.test.mjs tests/unit/release-check.test.mjs --maxWorkers=1
pnpm lint
pnpm typecheck
pnpm check:migrations
pnpm build
pnpm exec vitest run --maxWorkers=1
git diff --check
```

C2 run PASS: 4 files / 229 tests, 25.67 seconds. Focused regressions PASS:
8 files / 538 tests, 31.43 seconds; T21R-C 57, T21R-B 16 and release-check 236
unchanged. Lint/typecheck/local migration smoke/build PASS, exit 0 each.
Full `pnpm exec vitest run --maxWorkers=1` PASS: 230 files / 5,192 tests,
701.72 seconds, exit 0. Syntax and working/staged diff checks PASS.
No timeout/assertion was relaxed. Build does not deploy; migration smoke uses
disposable local SQLite, not production D1.

This is a pre-publication repository checkpoint, not hosted-success evidence.
After the one normal push, verify PR #36's exact new head and its automatically
triggered **new** pull-request CI run/job; do not rerun the old head as evidence.
Require ESLint/typecheck/Vitest/migration smoke/build all PASS. If that hosted
run fails, stop with `T21RC2_PR36_CI_REMEDIATION_INCOMPLETE` and its run/job/failure,
rather than piling new fixes onto this narrowly authorized branch.

Per-head hosted results and final receipt are retained in
`.hoplite/artifacts/t21rc2-pr36-ci/` and GitHub's PR checks; the same commit's
report cannot embed its own new hash or its future CI run ID. Historical raw
CI logs remain private and are not published. The PR check subscription is
enabled, but any subsequent failure remains subject to this packet's stop rule.

Production dispatch/Environment approval/Cloudflare call/D1 read/mutation/
restore/migration/0039 apply/deploy remain zero. `T21G_NOT_READY`, repair
`NOT_AUTHORIZED`, 0039/deploy STOPPED; row delivery `UNCONFIGURED` /
`DELIVERY_NOT_AUTHORIZED`. Green PR CI is neither exact-main push CI nor
production approval.

## Review-binding remediation — 2026-10-02 UTC

Independent review of head `8d8028f3e3358655b19fa2dd02ba883e57c52204` identified one
blocking P1: ancestry plus green exact-main CI does not bind a later main's
execution bytes to the independently reviewed implementation. The reviewed
implementation checkpoint remains `ad7b3012`; this is a narrow additive delta
on `codex/t21rc2-protected-production-row-read`, not a workflow/classifier redesign.
Neither prior agent review nor this remediation is human approval or permission
to open a PR, merge, prepare a production dispatch or access Cloudflare.

### REVIEWED_SHA is an exact implementation snapshot, not an ancestry marker

Future authorization requires **all** of:

- Full lowercase immutable SHAs, existing hardened ancestry/repository/run/main/
  exact-main push CI/normal independent approval guards, unchanged.
- `reviewedSha !== ref`. The reviewed feature head `R` is expected to be an
  ancestor of the later protected main merge `M`, not `M` itself.
- Byte-identical repository-owned execution closure at `R` and dispatched main
  `M`. The gate calls `assertReviewedExecutionClosure` before the production job
  can obtain useful candidate output. Capture's independent authorization and
  final recheck call the same gate, so both repeat the closure proof before
  Cloudflare use and aggregate publication respectively.

An unrelated later docs/application commit `D` is allowed if the bound closure
is unchanged, `R` is an ancestor of `D`, exact-main push CI for `D` succeeds and
all original guards pass. There is no reviewed-parent/first-parent or whole-repo
freeze requirement. A changed bound file needs a newly independently reviewed
implementation checkpoint; choosing `reviewed_sha=ref` cannot bypass the guard.

The constant `T21RC2_REVIEW_BOUND_PATHS` is repository-owned, never taken from
workflow/env/JSON/CLI input. The helper resolves both commit objects, requires
reviewed executable files to be regular Git blobs, then uses argument-array
`git diff --quiet --no-ext-diff --no-textconv R M -- <bound paths>`.
No fuzzy text, timestamp, label, approval comment or commit-message comparison.
Changed/missing/unsafe binding yields only `T21RC2_REVIEW_BINDING_REJECTED`,
including its redacted failure receipt; no changed contents are printed.

### Traced security/execution closure — 73 path entries

The proposed 14 paths are all retained. Direct JavaScript imports and runtime
file loads were inspected, then the V1 loader's same three Vite SSR roots were
loaded and both approved batches compiled/composed **offline**. The resulting
local module graph contained 36 repository TypeScript modules. This is the actual
execution closure, not a blanket application-tree restriction.

| Added group | Exact dependency reason |
| --- | --- |
| `scripts/t21rb-v1-semantic.mjs` | Both classifier and authority loader call its reviewed bridge predicate |
| `.github/workflows/ci.yml` | The gate's trusted exact-main push CI is selected by this workflow path; changing its validation authority requires review |
| `vite.config.ts`, `tsconfig.json` | `createServer` loads repository plugins/aliases and TypeScript transform configuration |
| Approved-batch registry, two JSONL sources, release manifest, reconciliation JSON | The loader reads/recompiles the current V1 source and reviewed reconciliation data; neither V2 proximity nor an unbound registry can change authority |
| 36 explicit TypeScript paths below | Actual loaded data/import/fingerprint/runtime/domain modules, including modules evaluated through the domain/import barrels. This includes particular Week files because they are loaded, not because the whole Week/application tree is frozen |
| `migrations` | `migrationManifest` enumerates/hashes the committed migration tree and the loader checks compiled 0036/0037 bytes. Bind the tree, including later additions/deletions, instead of enumerating only today's 39 filenames. No migration is applied |
| 13 optional configuration slots below | pnpm install hooks/configuration, Git checkout attributes, Vite's installed auto-config filename list, and development dotenv inputs. All are absent at the reviewed head; their later introduction must not evade binding |

The helper requires existing reviewed files to be regular blobs and the
`migrations` tree to contain reviewed regular files. Optional config slots may
be absent; if present they must be regular files, and Git still compares their
addition/removal/content/mode. Installed Vite's `DEFAULT_CONFIG_FILES` confirms
the five alternate config names; source loading uses the default development
mode. No path list comes from an operator or environment input.

`tsconfig.worker.json`, uncalled D1 hydration/deployment exports, unrelated
application/payment/authentication/composition trees, test files, generated
artifacts and ordinary handoff/report docs are not executed by this capture and
are not added merely for convenience. Installed third-party/runtime versions
remain governed by unchanged package/lockfile/workflow bytes, not vendored
`node_modules`. Closure membership does **not** authorize editing any protected
dependency: workflow, classifier, schemas, target, T19/T20, migrations and
dependency source remain unchanged in this remediation.

Complete repository-owned constant, in execution order:

```text
.github/workflows/production-d1-t21rc-row-reconciliation.yml
scripts/t21rc2-production-approval.mjs
scripts/t21rc2-production-capture.mjs
scripts/t21rc2-production-files.mjs
scripts/t21rc2-production-receipt.mjs
scripts/t21rc-row-reconciliation.mjs
scripts/t21r-v1-authority.mjs
scripts/release-check.mjs
scripts/d1-migration-check.mjs
docs/ai/recipe-catalog/T21RC_ROW_RECONCILIATION_SCHEMA.json
docs/ai/recipe-catalog/T21RA_RUNTIME_CANONICAL_TARGET.json
wrangler.jsonc
package.json
pnpm-lock.yaml
.github/workflows/ci.yml
scripts/t21rb-v1-semantic.mjs
vite.config.ts
tsconfig.json
data/recipe-import/approved-batches.json
data/recipe-import/t14f/pilot-30.jsonl
data/recipe-import/t14f/scale-399.jsonl
data/recipe-refresh/v2/ingredient-reconciliation.json
packages/recipes/src/import/catalog-release.current.json
migrations
packages/domain/src/availability.ts
packages/domain/src/foundation.ts
packages/domain/src/index.ts
packages/domain/src/inventory-read-authority.ts
packages/domain/src/inventory-truth.ts
packages/domain/src/meal-planning-api.ts
packages/domain/src/meal-shopping-api.ts
packages/domain/src/quantity.ts
packages/domain/src/units.ts
packages/domain/src/week/index.ts
packages/domain/src/week/leftover.ts
packages/domain/src/week/packages.ts
packages/domain/src/week/planner.ts
packages/domain/src/week/portion.ts
packages/domain/src/week/pricing.ts
packages/domain/src/week/score.ts
packages/domain/src/week/shopping.ts
packages/domain/src/week/types.ts
packages/domain/src/week/utilization.ts
packages/recipes/src/catalog-fingerprint.ts
packages/recipes/src/data.ts
packages/recipes/src/import/compiler.ts
packages/recipes/src/import/duplicates.ts
packages/recipes/src/import/identity.ts
packages/recipes/src/import/ingredients.ts
packages/recipes/src/import/index.ts
packages/recipes/src/import/normalize.ts
packages/recipes/src/import/parse.ts
packages/recipes/src/import/release-manifest.ts
packages/recipes/src/import/schema.ts
packages/recipes/src/import/sql-render.ts
packages/recipes/src/import/types.ts
packages/recipes/src/runtime-recipe.ts
packages/recipes/src/seed-render.ts
packages/recipes/src/vietnamese-bank.ts
packages/recipes/src/vietnamese-images.ts
.npmrc
.pnpmfile.cjs
pnpm-workspace.yaml
.gitattributes
vite.config.js
vite.config.mjs
vite.config.cjs
vite.config.mts
vite.config.cts
.env
.env.local
.env.development
.env.development.local
```

### P2 — SELECT-only path is not a read-only credential certificate

The success receipt now explicitly contains:

```json
{"queryPathSelectOnly":true,"tokenScopeReadOnlyProven":false}
```

The first field attests the reviewed executable's fixed SELECT allowlist; the
second states that Cloudflare token permission scope is **not proven**. Neither
zero observed writes nor this path restriction proves write-impossible credentials
or a read-only database. Input-supplied claims cannot override either field.
No production token was used, introspected or changed.

The fixed failure receipt deliberately omits both fields: failure can precede
review-binding/authorization/execution, so it must not look like a successful
reviewed-query-path attestation. Its existing safe status/code/privacy and zero
mutation/apply/deploy fields remain unchanged. Raw names/quantities/IDs/keys,
approval comments and response bodies remain excluded from public output.

### Delta verification and authorization boundary

New regressions use temporary real Git commits, a genuine two-parent merge,
`rev-parse`, `merge-base` and `diff`, not a mocked closure calculation. They cover
unrelated-doc advancement, each bound-file change, equal SHAs/non-ancestry,
missing required files, gate output rejection, pre-Cloudflare capture rejection
and final publication recheck. Existing assertions/timeouts remain intact.

Final executed checks (Node `24.21.0`, pnpm `10.31.0`, Vitest `3.2.7`):

| Exact command/check | Result |
| --- | --- |
| `pnpm exec vitest run tests/unit/t21rc2-*.test.mjs tests/unit/t21rc-row-reconciliation.test.mjs tests/unit/t21rb-v1-semantic.test.mjs tests/unit/t21rb-v1-production.test.mjs tests/unit/release-check.test.mjs --maxWorkers=1` | PASS: 8 files / 537 tests, 27.27 seconds |
| C2 suites in that command | PASS: approval 143, capture/privacy 70, receipt 8, workflow static 7; 228 total |
| Predecessor/release suites in that command | PASS: T21R-C 57, T21R-B 11 + 5, release-check 236 |
| `pnpm exec vitest run --maxWorkers=1` | PASS: 230 files / 5,191 tests, 608.00 seconds, exit 0 |
| `pnpm lint`, `pnpm typecheck` | PASS, exit 0 each |
| `pnpm check:migrations` | PASS: `migration-smoke=ok`, local in-memory SQLite only |
| `pnpm build` | PASS: Web and Worker compilation, exit 0 |
| `node --check` for the three modified C2 scripts | PASS |
| `git diff --check`, staged check and full scoped diff/protected-path review | PASS |
| `assertReviewedExecutionClosure(ad7b3012, 8d8028f3)` on the existing immutable commits | PASS, local Git only; implementation-to-doc-head bytes unchanged |

All A–L regressions PASS: unrelated-doc advancement, workflow/capture/approval/
receipt/classifier/schema/target/release/D1 helper/package/lockfile changes,
same SHA and existing non-ancestor rejection. Every one of the 73 bound entries
has a real-Git change regression; additions in the migration tree and introduction
of previously absent auto-configs also fail. Gate, capture pre-credential and
final recheck rejection tests call the real authorization path with mocked
GitHub responses and assert no Cloudflare subprocess or publication output.

Initial new-test failures were missing test-helper imports/scope: the safe
failure-receipt import and shared approved fixture were corrected. No production
experiment, assertion removal or timeout adjustment was used. The final focused
and full suites passed without retries of their test failures. Raw local logs
remain ignored under `.hoplite/artifacts/t21rc2-review-binding/`; dependencies
and lockfile are unchanged and no audit was rerun.

A bounded independent agent delta review found no material issue and passed
the approval/receipt suites (151 tests). It did not independently retrace the
entire dependency list; the execution trace above was completed locally by the
primary agent. This is not independent human re-approval of the remediation.

Verified reviewed parent: `8d8028f3` (`8d8028f3e3358655b19fa2dd02ba883e57c52204`),
containing implementation `ad7b3012`. The one logical remediation commit follows
that exact parent without rebase/squash; its own hash is resolved by Git/provider
verification rather than embedded in the same commit's handoff. Next is independent
**delta** review from that reviewed parent to the normally published remediation
HEAD, before opening any PR. Existing main CI is not hosted CI for this delta.

Only normal publication of one logical remediation commit after the reviewed
head is authorized after all local checks pass. No PR, merge, workflow dispatch,
Environment approval, production read/mutation/Cloudflare call, restore,
migration/0039 apply, deployment or delivery configuration is authorized.
`ROW_LEVEL_EVIDENCE_DELIVERY=UNCONFIGURED`, `T21G_NOT_READY`; repair/0039/deploy STOPPED.

## Exact starting authority and scope

- Repository ID `1385308553`, `vn-tako4/Tako-san`.
- Certified starting/main SHA `518818458a354c5e180da52ae9bb73c9d3c1af78`, exact-main
  push CI `36972970904` SUCCESS; T21R-C already merged through PR #35.
- `git fetch origin --prune` and exact-main equality checks preceded detaching
  and creating `codex/t21rc2-protected-production-row-read` at that SHA.
  Starting tree clean, ahead/behind `0/0`, one worktree. A moved main must stop
  this task, not trigger an unreviewed rebase.
- Wrong-direction documentation checkpoint `9542e112` remains on the old local
  `codex/t21rc-row-level-reconciliation` branch. It is not an ancestor of this
  task, is not being merged, and must not be published as T21R-C2.
- V1 release `rel-bd00a4f53fcaeee4`, 500 recipes / 2,702 target occurrences remains
  certified authority. Neither V2 proximity nor production-only observations
  authorize identity changes, removal, enrichment replay or physical order.

## Executable entry points

| File | Responsibility |
| --- | --- |
| `.github/workflows/production-d1-t21rc-row-reconciliation.yml` | Dedicated `Production D1 T21R-C Row Reconciliation`; manual dispatch only, confirmation false by default, production Environment job and success-only aggregate upload |
| `scripts/t21rc2-production-approval.mjs` | Credential-free-of-Cloudflare main/repository/CI/reviewed-ancestor gate, normal approval validation, final recheck |
| `scripts/t21rc2-production-capture.mjs` | Pinned account/database/config, fixed SELECT executor, independent counts/rosters/ledgers, two-read stability, credential-free reuse of merged classifier |
| `scripts/t21rc2-production-receipt.mjs` | Closed existing-schema validation, accounting/proof binding and explicit aggregate receipt projection |
| `scripts/t21rc2-production-files.mjs` | Runner-temp private paths, restrictive exclusive files, fixed error codes/failure receipts and cleanup |

No existing production workflow or classifier is rewritten. There is no
operator SQL, table, WHERE, file-path or delivery input. No repair SQL,
migration apply, deployment, flag toggle, order insertion or restore path exists.

## Gate and normal approval

The dispatch takes full lowercase immutable `ref` and `reviewed_sha`, and
`confirm_t21rc_read_only_capture=true`. It must originate from `main` at exactly
the requested current-main SHA in repository `1385308553`. The gate reuses
`validateReleaseSource` and `requireSuccessfulCi` from `release-check.mjs`,
including the existing security baseline, ancestry and latest successful
exact-SHA **push** CI policy. PR CI or an older main success cannot substitute.
GitHub permissions remain `contents: read`, `actions: read`; Cloudflare secrets
are absent from the gate and approval/classification/publication steps.

Before the only credential-bearing capture step, validate current production
Environment policy and the current run's approval history. Require configured
independent User reviewer `vn-taphoanhatung`, `state=approved`, the matching
production Environment identity and reviewer distinct from both workflow actor
and triggering actor. Missing history, `skipped`, bypass, wrong reviewer,
wrong environment, self-approval, changed required-reviewer policy or a stale
run/SHA fails before Cloudflare access. A normal approval does not rely on the
environment's current administrator-bypass availability.

GitHub's review-history response has no run-attempt field. Reruns are therefore
rejected rather than recycling an earlier attempt's approval: use a new,
separately approved dispatch if a future authorized capture must be retried.
The capture script repeats authorization before any Cloudflare command; final
recheck repeats current-main, exact CI, run and approval-policy/history binding
before generating the uploadable aggregate receipt. This task does not change
Environment settings or approve any job.

Authority references: [GitHub workflow-run review history](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run)
and [deployment environments](https://docs.github.com/en/rest/deployments/environments#get-an-environment).
Approval API failures or unavailable permissions stop; no alternate credential
or admin bypass is a fallback.
The documented GitHub approval record contains `state`, `user`, `environments`
and `comment`, not an approval-record ID. Fixtures follow that API shape; user
and Environment IDs still must match the configured policy. Availability of
`can_admins_bypass=true` does not prove a bypass was used: normal approval can
pass under the current policy, but `skipped`/bypass history cannot. Availability
is included in the policy digest so a policy change invalidates an existing
authorization. No governance settings were changed.

## Database identity and fixed SELECT path

Require the configured Cloudflare account to be proven by captured `whoami`
output and require `d1 list` to identify exactly `frigo-db` /
`f975ec39-b2c8-4a2a-80e1-0366054599d3`. Both outputs are captured privately, never printed.
Verify the committed production Wrangler binding before identity access and
before each query; same name/wrong UUID and correct UUID/wrong account fail.

Installed Wrangler `3.114.0` resolves `d1 execute` by name/binding, not UUID.
Use `frigo-db` with the explicitly verified `wrangler.jsonc` binding rather than
an unsupported UUID selector. The executor uses argument arrays, captures
stdout/stderr, and rejects malformed/failed/paged/write-reporting responses.
There is no shell SQL interpolation. Only these immutable statements can reach
the executor:

```sql
SELECT id FROM recipes ORDER BY id;

SELECT id, recipe_id, ingredient_id, name, required_quantity, unit, is_optional
FROM recipe_ingredients ORDER BY recipe_id, id;

SELECT (SELECT COUNT(*) FROM recipes) AS recipe_count,
       (SELECT COUNT(*) FROM recipe_ingredients) AS ingredient_occurrence_count;

SELECT name FROM d1_migrations ORDER BY name;
```

An exact allowlist plus SELECT/mutation-keyword guard blocks INSERT, UPDATE,
DELETE, REPLACE, CREATE, DROP, ALTER, ATTACH, DETACH, PRAGMA and other unsupported
SQL. Tests exercise the same subprocess path using mocks; no live CLI read is
used to validate it. SELECT-only code does not prove that an underlying token
lacks write scope; least-privilege production credentials still need operator
review before any authorization.

## Complete capture and classification sequence

`L0 → C0 → R0 → A → C1 → L1 → C2 → R1 → B → C3 → L2`:

1. Every ledger must exactly equal the reviewed 38-name migration sequence
   ending `0038_auth_onboarding_completion.sql`, not merely share its count/tip.
   Derive names from the exact candidate's validated migration manifest.
   A 0039 entry, missing/extra name, duplicate, altered sequence or unexpected
   committed migration assumptions stops. Migration files are inspected, never
   executed by this capture.
2. Four independently queried counts must agree and equal both complete recipe
   rosters and both occurrence arrays. No production 6,720 constant is used.
3. Check both rosters against the source loader's certified 500 V1 recipe IDs
   before the corresponding name-bearing read. Unexpected/missing/duplicate IDs
   stop instead of broadening catalog privacy scope. Foreign-parent occurrence
   rows and fields outside the fixed SELECT contract also stop privately.
4. Compare canonical sorted complete capture digests, including physical
   observations, raw semantic values and roster/count context. Any A/B change
   is `T21RC2_PRODUCTION_SNAPSHOT_UNSTABLE`. Equality permits only
   `OBSERVED_STABLE_NON_ATOMIC`: intervening writers, ABA changes and transaction
   coherence remain unproven.
5. Without Cloudflare/GitHub credentials, revalidate captured input digest and
   byte-pinned V1 authority; call the existing `reconcileIngredientOccurrences`
   from `t21rc-row-reconciliation.mjs`. Validate the entire manifest against
   `T21RC_ROW_RECONCILIATION_SCHEMA.json` using installed Ajv. Preserve occurrence
   multiplicity, malformed/ambiguous evidence and position exclusion.
6. Bind the public-safe receipt to exact authorization, source proof, counts,
   ledger and capture/classification digests. Validate partitions against actual
   manifest records; do not copy per-recipe structures or raw record fields.

## Privacy, failure behavior and upload

`$RUNNER_TEMP/t21rc2/` must be outside the checkout, mode `0700`; private files
use exclusive creation and mode `0600`. Reject unsafe/symlinked paths and
unexpected filenames. Raw captures, names, quantities, physical IDs, rosters,
private authorization proof and full row manifest stay there. Always-run
cleanup deletes the private directory; it is not an upload step.
Wrangler diagnostics are also redirected to that private directory; subprocesses
capture both output streams and do not receive the GitHub read token. The capture
CLI uses a restrictive umask for subprocess-created files.

Only `$RUNNER_TEMP/t21rc2-public-receipt.json` can be uploaded, on workflow
success, with an exact filename and no wildcard. It contains allowlisted
repository/run/database/approval proof, counts, class/drift/ambiguity totals,
accounting and digests, with zero mutation/apply/deploy/repair flags. It contains
no production recipe/ingredient/occurrence identities, names, quantities, raw
history/comments or per-recipe lists. No raw output is added to job summaries.

Failures print a fixed allowlisted code only. A failure receipt has fixed
safe fields and no exception message/stdout/stderr/response body. Failure
receipts are not automatically uploaded; the success-only artifact step cannot
publish partial evidence. Privacy tests use `PRIVATE_PHYSICAL_ID_123`,
`SECRET_PRODUCTION_NAME_ABC` and `987654.125` in synthetic raw data and hostile
errors. They must not appear in the public/failure receipt or CLI error output.

### Delivery options — none configured or authorized

| Future option | Benefits | Required separate decision / tradeoffs |
| --- | --- | --- |
| Encrypted artifact | Confidential payload can cross an artifact transport without plaintext exposure | Independently managed recipient keys, encryption/authentication, metadata leakage review, retention and key recovery; public Actions is not a private audience |
| Restricted private storage | Explicit identity/access policy and auditing for a review group | Authorized existing/private storage, least-privilege upload/retrieval, lifecycle and residency controls; no bucket or provider is created here |
| Operator-local secure retrieval | Avoids persistent public/shared storage | Separately authenticated operator, encrypted transport, secure local handling and runner-lifetime limits; no remote-shell access or retrieval mechanism is configured here |

`ROW_LEVEL_EVIDENCE_DELIVERY=UNCONFIGURED`, `DELIVERY_NOT_AUTHORIZED`.
No R2/S3 bucket, Drive, webhook, email, private repository or encryption/key
infrastructure is provisioned. Publishing this implementation branch is not
publishing a row manifest or authorizing a production capture.

## Original implementation verification, limitations and next action (historical)

All finalized local gates passed on Node `24.21.0`, pnpm `10.31.0`, Vitest `3.2.7`:

| Exact command/check | Result |
| --- | --- |
| `pnpm exec vitest run tests/unit/t21rc2-*.test.mjs tests/unit/t21rc-row-reconciliation.test.mjs tests/unit/t21rb-v1-semantic.test.mjs tests/unit/t21rb-v1-production.test.mjs tests/unit/release-check.test.mjs --maxWorkers=1` | PASS: 8 files / 455 tests, 13.35 seconds |
| New C2 suites within that command | PASS: approval 62, capture/privacy 70, receipt 7, workflow static 7; 146 total |
| Predecessor/release suites within that command | PASS: T21R-C 57, T21R-B semantic 11 + production wrapper 5, release-check 236 |
| `pnpm exec vitest run --maxWorkers=1` | PASS: 230 files / 5,109 tests, 525.17 seconds |
| `pnpm lint` | PASS, exit 0 |
| `pnpm typecheck` | PASS, exit 0 |
| `pnpm check:migrations` | PASS: `migration-smoke=ok`, throwaway in-memory SQLite only |
| `pnpm build` | PASS: Web build and Worker type compilation, exit 0 |
| `node --check` for each `scripts/t21rc2-*.mjs` | PASS |
| `git diff --check`, staged diff check and protected-path review | PASS; no legacy classifier/schema/runtime/migration/dependency edits |

The capture test also exercises the executable capture/classify/receipt
sequence with real certified-source **synthetic** 500/2,702 inputs and mocked
Cloudflare responses. Source preparation runs once in fixture setup; all
behavior, accounting, raw-leak and pre-credential rejection assertions remain.
No test performs live GitHub/Cloudflare authorization or D1 queries.

Initial checks exposed a workflow test's undefined-env access and an unfinished
receipt-module dependency; these were corrected before the final suite.
A delegated/review run hit the unchanged 5-second budget while preparing and
executing the new full synthetic pipeline. Moving certified fixture preparation
to `beforeAll` resolved that setup cost without changing any timeout/assertion;
final focused and full one-worker runs passed. Earlier failure evidence is not
being called a pass. Installed Wrangler inspection corrected an unsupported
UUID selector; authoritative API inspection corrected an undocumented approval
ID requirement and separated bypass availability from bypass use. Review also
added fresh remote-main checks beyond cached `origin/main`. These were all
offline implementation corrections, not production experiments.

Independent agent review of the complete executable workflow, approval,
capture/private files, receipt, tests and existing-helper integration found no
material defect. Its finalized C2 run passed 4 files / 146 tests. This is not
independent human review or Environment/production authorization. Raw test logs
stay ignored under `.hoplite/artifacts/t21rc2-validation/`; earlier parent-only
logs are also local. Dependencies/lockfile are unchanged; no new audit was run.

Normal publication of `codex/t21rc2-protected-production-row-read` is authorized
after these checks. No PR is opened, and neither merge nor any workflow
dispatch is authorized. This new branch is not covered by the base main's CI;
the CI workflow does not run on this branch's push without a PR. Local success
does not establish hosted implementation-head CI or a live capture receipt.

### Verified checkpoint and publication

- Executable implementation checkpoint: `ad7b3012`
  (`ad7b3012fc13c53948cdf7cbac4362df2662dee5`), containing the dedicated workflow,
  four scripts, four test files, this report and proposed ADR-040. Verified normal
  push to `codex/t21rc2-protected-production-row-read`; GitHub branch GET exactly
  matched that local implementation HEAD. No force push or PR creation.
- Live main GET remained exactly `518818458a354c5e180da52ae9bb73c9d3c1af78` after
  publication. Old wrong-task `9542e112` is not an ancestor of C2 and was not
  pushed. No history was reset or silently rebased.
- Current-state/task-board/handoff updates are a later documentation checkpoint;
  its own hash cannot be embedded here. Final Git/provider verification identifies
  the published completion head. The implementation and all checks above remain
  unchanged; no new production capability is introduced by that documentation.
- `PRODUCTION_READS=0`, `CLOUDFLARE_PRODUCTION_CALLS=0`,
  `PRODUCTION_DISPATCH=NO`, `ENVIRONMENT_APPROVALS=0`, production mutations /
  operational SQL writes / restores / migrations / 0039 applies / deploys = 0.
  Local SQLite fixture replay is not a production migration.

No live row receipt exists; current production counts/ledger/flags were not
re-read. T19/T20 planner, cooking, shopping, roles, hard restrictions, inventory,
household isolation and Week compatibility are untouched. Local SQLite test
fixtures are distinct from production migrations; 0039 remains stopped.

**Next:** Independent review of the actual executable C2 workflow, approval,
SQL path, privacy/failure behavior and receipts before any production
authorization. This task permits normal publication of the new implementation
branch after checks, not PR creation, merge, dispatch, approval or repair.
