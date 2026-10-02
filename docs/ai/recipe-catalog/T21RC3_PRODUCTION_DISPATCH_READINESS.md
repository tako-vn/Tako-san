# T21R-C3 — Production dispatch readiness and immutable Action dependencies

Status: `T21RC3_IMPLEMENTATION_READY_FOR_REVIEW`. Code, local validation and
approved documentation publication are complete on the feature branch through
`vn-tak`. Independent review, protected merge and post-C3 exact-main CI are pending.
This document is an operator
packet template, not authorization to execute a production capture.

## Repository and historical integration authority

- Repository: `vn-tak/Tako-san`, stable ID `1385308553`. Both the repository API
  and exact-main CI metadata confirm the transferred name; do not use the former
  `vn-tako4/Tako-san` name for a future C2 authorization.
- Base main: `0d4fe89b7ccc72e013aafe53665059d0e62bd3b4`, PR #36 merge.
- Historical C2 reviewed head: `63739c565622c725b02e21af590342d98ed0fa65`.
- Base exact-main CI: [37008867187](https://github.com/vn-tak/Tako-san/actions/runs/37008867187),
  completed/success, push/main, attempt 1, head exactly equal to base main.
- C3 hardening checkpoint: `57edc3ac9c2b3f86d28774c0c26bb1e9a961746e`.
  Credential-free validation fixture checkpoint:
  `a34ec5e3245b5fdc6718c611ae23dcea6f56eb4c`.
  GitData publication code checkpoint:
  `e49c60a176cec80593e8b8644d058341cfeca720`, with executable tree
  `5b20d72eeb4f0077ac17b0d0e8584e4596292fb3` exactly equal to that tested local
  checkpoint. API commit metadata changes the commit SHA, not its executable bytes.
  Completion documentation follows this code checkpoint; this document cannot
  record its own future publication SHA.
- C3 branch: `codex/t21rc3-production-dispatch-readiness`, created from that
  exact base. Main was unchanged at preflight; no automatic rebase is authorized.

Repository code still bound C2's gate and receipt to the former full name. The
executable compatibility change sets both current repository guards to
`vn-tak/Tako-san`; the stable ID,
strict name/ID comparisons, actor checks, exact-main CI, API endpoints' fixed
repository authority and 73-path review closure remain enforced. Former names
and stale run/CI repository metadata are rejected. This does not authorize
other workflow or application changes. The certified target JSON's
`resolvedNameAtReview` intentionally remains `vn-tako4/Tako-san`; the receipt
retains that exact historical check separately from current-run repository
authorization. The target JSON, its bytes/hashes and V1 authority are unchanged.

## Immutable Action pin manifest

Verification: **2026-10-02T18:22:04Z**, official upstream GitHub ref, commit and
published release APIs, independently cross-checked with `git ls-remote --tags`.
Each chosen commit is the observed target of the workflow's existing `@v4`.
No major upgrade or version-selection automation was added.

| Action repository | Upstream version/tag | Immutable commit SHA | Purpose |
| --- | --- | --- | --- |
| `actions/checkout` | `v4.4.0` | `11d5960a326750d5838078e36cf38b85af677262` | Gate/main and capture/exact-SHA checkouts |
| `actions/setup-node` | `v4.4.0` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | Node 24 in both jobs |
| `pnpm/action-setup` | `v4.3.0` | `b906affcce14559ad1aafd4ab0e942779e9f58b1` | Existing pnpm 10 capture-tool installation |
| `actions/upload-artifact` | `v4.6.2` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | Success-only aggregate receipt upload |

Source evidence and resolution:

- Checkout: [version ref](https://api.github.com/repos/actions/checkout/git/ref/tags/v4.4.0),
  [commit](https://api.github.com/repos/actions/checkout/git/commits/11d5960a326750d5838078e36cf38b85af677262),
  [release](https://github.com/actions/checkout/releases/tag/v4.4.0), published
  `2026-07-20T15:36:10Z`. Lightweight version and major refs both target the
  listed commit.
- Setup Node: [version ref](https://api.github.com/repos/actions/setup-node/git/ref/tags/v4.4.0),
  [commit](https://api.github.com/repos/actions/setup-node/git/commits/49933ea5288caeca8642d1e84afbd3f7d6820020),
  [release](https://github.com/actions/setup-node/releases/tag/v4.4.0), published
  `2025-04-14T02:55:06Z`. Lightweight version and major refs target that commit.
- pnpm: [version ref](https://api.github.com/repos/pnpm/action-setup/git/ref/tags/v4.3.0)
  targets annotated tag object `c336a2788d9774dccfdeb4823a5058ccc9f07453`.
  Its [tag object](https://api.github.com/repos/pnpm/action-setup/git/tags/c336a2788d9774dccfdeb4823a5058ccc9f07453)
  peels to the listed [commit](https://api.github.com/repos/pnpm/action-setup/git/commits/b906affcce14559ad1aafd4ab0e942779e9f58b1).
  The `v4` tag object `f40ffcd9367d9f12939873eb1018b921a783ffaa` peels to the
  same commit. [Release](https://github.com/pnpm/action-setup/releases/tag/v4.3.0)
  published `2026-03-11T14:57:44Z`. Pin the peeled commit, not either tag-object
  SHA; do not silently select a newer minor that the observed major ref did not
  yet target.
- Upload artifact: [version ref](https://api.github.com/repos/actions/upload-artifact/git/ref/tags/v4.6.2),
  [commit](https://api.github.com/repos/actions/upload-artifact/git/commits/ea165f8d65b6e75b540449e92b4886f43607fa02),
  [release](https://github.com/actions/upload-artifact/releases/tag/v4.6.2),
  published `2025-03-19T17:47:02Z`. Lightweight version and major refs target
  that commit.

All four release responses are published, non-draft and non-prerelease. All
commit endpoints returned the exact SHA. These observations prove upstream
repository/tag/commit relationships at the verification time; they do not claim
a separate audit of the upstream Actions' implementations.

There are six external `uses:` entries and four distinct Action dependencies.
Only these identities changed in
`.github/workflows/production-d1-t21rc-row-reconciliation.yml`. Checkout options,
Node/pnpm versions, inputs, trigger, permissions, secrets, environment, job order,
artifact conditions/path and concurrency remain equal to the certified base.
`.github/workflows/ci.yml` is unchanged, including `fetch-depth: 0`.

## Review-binding consequence

The production workflow, approval script and receipt script are already in the
immutable 73-entry C2 execution closure. They have new reviewed bytes, so the old C2
reviewed SHA is **invalid for dispatching a post-C3 main**. It remains historical
integration evidence only. No path was removed and no closure entry was added:
the new manifest and dispatch packet are documentation, not executable
authorization helpers.

For a future separately authorized capture, set:

```text
reviewed_sha = <C3_INDEPENDENTLY_REVIEWED_FEATURE_HEAD>
ref = <POST_C3_MERGE_CURRENT_MAIN_SHA>
confirm_t21rc_read_only_capture = true
```

`reviewed_sha` must differ from `ref`, be its ancestor and have byte-identical
bound paths. Use the **final** independently approved feature head, including
completion documentation; do not substitute an earlier implementation checkpoint
or invent a future merge SHA. Obtain successful exact-main push CI for `ref`.

## GitHub production Environment: read-only observation

Observed at `2026-10-02T18:22:04Z` through an unauthenticated, read-only public
[Environment metadata GET](https://api.github.com/repos/vn-tak/Tako-san/environments/production).
The connector's generic fetch rejected this endpoint as unsupported; the public
GitHub API returned it without credentials. No policy mutation or approval call
was made.

| Field | Observed value |
| --- | --- |
| Environment exists/name | YES / `production` |
| Environment ID | `22649920074` |
| Required-reviewer rule ID | `66577771` |
| Required reviewer | User `vn-taphoanhatung`, ID `329713999`; exactly one |
| `prevent_self_review` | `false` |
| `can_admins_bypass` | `true` — `ADMIN_BYPASS_AVAILABLE` |
| Deployment branch/tag policy | `null`, no Environment-level restriction |
| `ADMIN_BYPASS_USED` for a future capture | NOT_ASSESSED; no C3 capture exists |
| Policy changed by C3 | NO |

Metadata governance assumptions for the existing C2 validator match: production
exists and the exact independent User reviewer is configured. Platform
self-review and bypass are available; their availability does **not** prove
their use. C2 already accepts either availability setting, binds the observed
policy digest, and independently rejects self-approval, any skipped/bypass
history, wrong reviewer/ID/Environment, policy drift and rerun reuse. The main-only
workflow gate and exact-main/run checks remain mandatory even though the
Environment itself has no deployment branch restriction.

Governance audit: **PASS for metadata only**. Actual future approval is
**NOT_RUN / UNVERIFIED**, not a present readiness certification. Enabling
prevent-self-review, disabling admin bypass and restricting deployment branches
can be considered by the operator separately; C3 does not change policy or
mislabel these optional controls as requirements of the current validator.
If a future metadata observation lacks the exact reviewer or otherwise violates
C2's accepted policy shape, stop with
`T21RC3_GOVERNANCE_REMEDIATION_REQUIRED`, record the exact mismatch and have an
explicitly authorized operator handle policy remediation.

## Cloudflare credential permissions: independent property

```text
QUERY_PATH_SELECT_ONLY = true
TOKEN_SCOPE_READ_ONLY_PROVEN = false
TOKEN_SCOPE = UNKNOWN
TOKEN_HAS_WRITE_CAPABILITY = UNKNOWN
TOKEN_METADATA_SOURCE = unavailable authorized credential-permission metadata
TOKEN_SCOPE_STATUS = T21RC3_TOKEN_SCOPE_UNRESOLVED
TOKEN_MUTATED = NO
```

No exposed authorized Cloudflare token metadata capability could reliably
inspect the production Environment credential. No secret value was obtained,
no credential was searched for, and no Cloudflare API call or D1 query was made.
SELECT-only code is not proof of a read-only token. Write capability is not
excluded by the available evidence.

Before live capture, the operator must document the unresolved permission
scope/risk decision. If later metadata proves write capability, record
`TOKEN_HAS_WRITE_CAPABILITY = YES` and require an explicit operator risk decision;
do not automatically label the code invalid merely because current infrastructure
cannot provide a narrower token. Prefer a least-privilege D1-read credential if
one can safely be provisioned in a separately authorized task. Do not create,
rotate, edit, broaden or replace a token or secret in C3.

## Future operator packet — credential-free template

Packet generation is **DOCUMENTED**, without an additional executable helper.
Complete this template only after C3 independent review, protected merge and
successful exact-main push CI. Unfilled placeholders mean **DO NOT DISPATCH**.

```text
PACKET_STATUS = BLOCKED_PENDING_REVIEW_MERGE_EXACT_MAIN_CI_AND_OPERATOR_DECISION
REPOSITORY_ID = 1385308553
REPOSITORY = vn-tak/Tako-san
WORKFLOW_PATH = .github/workflows/production-d1-t21rc-row-reconciliation.yml
DISPATCH_WORKFLOW_BRANCH = main
INPUT_ref = <POST_C3_MERGE_CURRENT_MAIN_SHA>
INPUT_reviewed_sha = <C3_INDEPENDENTLY_REVIEWED_FEATURE_HEAD>
INPUT_confirm_t21rc_read_only_capture = true
PACKET_CREATED_AT = <OPERATOR_VERIFIED_TIMESTAMP>
CURRENT_REMOTE_MAIN = <SAME_FULL_SHA_AS_INPUT_ref>
EXACT_MAIN_CI_RUN = <POST_C3_PUSH_CI_RUN_ID>
EXACT_MAIN_CI_HEAD = <SAME_FULL_SHA_AS_INPUT_ref>
EXACT_MAIN_CI_EVENT_BRANCH_CONCLUSION = push / main / success
EXACT_MAIN_CI_WORKFLOW = .github/workflows/ci.yml
REVIEWED_SHA_ANCESTOR_OF_MAIN = <PROVEN_TRUE>
REVIEW_BOUND_BYTES_IDENTICAL = <PROVEN_TRUE_ALL_73_ENTRIES>
ACTION_PINS = <EXACT_FOUR_COMMIT_SHAS_FROM_THE_MANIFEST_ABOVE>
EXPECTED_ENVIRONMENT = production
EXPECTED_REVIEWER = vn-taphoanhatung / 329713999 / User
WORKFLOW_ACTOR = <OPERATOR_LOGIN_DIFFERENT_FROM_REVIEWER>
TRIGGERING_ACTOR = <LOGIN_DIFFERENT_FROM_REVIEWER>
REQUIRED_APPROVAL = approved / production / exact reviewer / no bypass
RUN_ATTEMPT = 1
CONCURRENCY = frigo-deploy-production / cancel-in-progress=false
DATABASE_NAME = frigo-db
DATABASE_ID = f975ec39-b2c8-4a2a-80e1-0366054599d3
CLOUDFLARE_ACCOUNT_IDENTITY = <OPERATOR_VERIFIED_PRODUCTION_ACCOUNT_ID>
LEDGER = exact first 38 repository migration names through 0038_auth_onboarding_completion.sql
0039_PROHIBITED = true
CANONICAL_AUTHORITY = V1
RELEASE = rel-bd00a4f53fcaeee4
RECIPE_COUNT = 500
TARGET_INGREDIENT_OCCURRENCES = 2702
RUNTIME_FINGERPRINT = f8cf8c7ff59df9fe29e246b9e3c9aad0fd155fa8df35bf671ac4d03fa2b5ab37
QUERY_PATH_SELECT_ONLY = true
TOKEN_SCOPE_READ_ONLY_PROVEN = false
TOKEN_SCOPE = UNKNOWN
TOKEN_SCOPE_RISK_DECISION = <EXPLICIT_OPERATOR_DECISION_AND_SAFE_REFERENCE>
ROW_LEVEL_DELIVERY = UNCONFIGURED
RAW_ROWS_AND_FULL_MANIFEST = runner-local only
ACTIONS_UPLOAD = aggregate public-safe receipt only / success only
LIVE_CAPTURE_CERTIFICATION_LIMIT = OBSERVED_STABLE_NON_ATOMIC
```

`DISPATCH_WORKFLOW_BRANCH = main` is GitHub's workflow selection ref; `INPUT_ref`
is the separate full immutable SHA input checked against current main. They are
not interchangeable. This template intentionally contains no runnable dispatch
command and no future workflow run ID, approval, ledger result or row data.
`TARGET_INGREDIENT_OCCURRENCES = 2702` describes the certified V1 target, not an
assertion that production currently has that count. A stable production count
may differ and is classified; counts changing during capture are rejected.

The existing capture independently checks live identity, ledger, roster and
counts **inside** the separately approved run. C3 does not query production to
fill these fields or rehearse those checks.

## Abort conditions and unchanged capture boundary

Stop without credential use when pre-dispatch evidence shows:

1. Remote main changed after packet creation; expected exact-main CI is absent,
   failed, stale or for the wrong repository/event/branch/workflow/head.
2. Reviewed SHA is missing, equal to main, not its ancestor, not independently
   approved, or any of the 73 bound entries differ. An Action pin changing also
   invalidates review binding, even if the replacement is another full SHA.
3. Production Environment disappeared, its exact independent reviewer changed,
   actor/triggering actor equals reviewer, or policy violates the existing
   validator. Actual skipped, bypass, self, wrong-Environment or wrong-reviewer
   approval is rejected. Availability of bypass alone is not evidence of use.
4. Run attempt is not 1. A failed live attempt requires a **new dispatch and new
   Environment approval**; never rerun using the former approval.
5. Row privacy cannot be maintained, row-level delivery becomes enabled, or any
   raw/full-manifest/public-log upload would occur.
6. The unresolved token-scope or proven write-capability operator risk decision
   is missing; independent review, protected merge or post-C3 exact-main CI is
   still pending.

During the separately authorized capture, stop and publish no success artifact
if the existing guards observe:

7. Cloudflare account identity does not match the configured production account
   and its identity/list metadata, or the database differs from reviewed
   `wrangler.jsonc` / `frigo-db` / `f975ec39-b2c8-4a2a-80e1-0366054599d3`.
8. The live ledger differs from the exact first 38 names or includes 0039.
9. The roster differs from certified V1's 500 recipes, independent counts change,
   coverage is incomplete, or A/B snapshots differ.
10. Main, review-bound bytes, approval history or Environment policy changes on
    reauthorization/final recheck; the private path or receipt allowlist fails.

The workflow remains dispatch-only, production-locked with
`cancel-in-progress: false`, attempt-1-only and aggregate-upload-only. Its fixed
SQL allowlist is unchanged: recipe IDs; specified ingredient occurrence fields;
independent recipe/ingredient counts; ordered migration names. No extra SQL,
retry policy, row delivery, storage backend, repair, 0039 apply or deployment.
Raw rows and full manifest remain restrictive runner-local files only.

Preserved program states: T21R-A/B/C COMPLETE, historical C2
PROTECTED_INTEGRATION_CERTIFIED; LIVE_T21RC2_CAPTURE NOT_RUN, T21G_NOT_READY,
REPAIR NOT_AUTHORIZED, 0039 STOPPED, PRODUCTION_DEPLOY STOPPED,
ROW_LEVEL_EVIDENCE_DELIVERY UNCONFIGURED.

## Validation and publication receipt

Executed local validation on the implementation:

| Check | Result |
| --- | --- |
| Focused C3/C2/C/B/release regressions, 8 files | PASS, 556/556 tests, 15.26 seconds |
| C2 approval / capture / receipt / workflow suites | PASS, 148 / 70 / 8 / 21 tests (247 total) |
| New C3 cases within those suites | PASS, 18 cases: 13 pin/workflow cases plus 5 repository/binding cases |
| Existing C/B/release-check suites | PASS, 57 / 16 / 236 tests (309 total) |
| ESLint | PASS, exit 0 |
| Typecheck (web/source and Worker) | PASS, exit 0 |
| Local SQLite migration smoke | PASS, `migration-smoke=ok`, exit 0 |
| Web/Worker build | PASS, exit 0 |
| Node syntax / working diff checks | PASS |
| Separate local D1 environment diagnosis, 2 files | PASS, 66/66 tests, 10.00 seconds with proxy variables removed |
| AI recovery/provider/governance/scan and local D1, 6 files | PASS, 128/128 tests, 10.57 seconds with loopback-only Node transport |
| Full single-worker Vitest | PASS, 230 files / 5,210 tests / zero skips, 509.91 seconds, exit 0 |
| Recheck on exact published code checkpoint `e49c60a176cec80593e8b8644d058341cfeca720` | PASS, C2 4 files / 247 tests, 11.39 seconds; external Node transport blocked |

Commands below use pnpm **10.34.6** via the local package's `pnpm.cjs`, matching
the workflow's pnpm major. The runtime default was pnpm 11; no dependency,
package/lockfile, repository configuration or build approval policy was changed.
For the full/local-D1 checks only, clear `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
their lowercase forms and `npm_config_{http_proxy,https_proxy,proxy}` in the
test process. Wrangler 3's global `ProxyAgent` otherwise routes localhost D1
traffic through the proxy despite `NO_PROXY`. Add the extracted SQLite 3.45.1
CLI directory to the test command's PATH; no production binding is used.

```sh
pnpm exec vitest run tests/unit/t21rc2-workflow.test.mjs tests/unit/t21rc2-production-approval.test.mjs tests/unit/t21rc2-production-capture.test.mjs tests/unit/t21rc2-production-receipt.test.mjs tests/unit/t21rc-row-reconciliation.test.mjs tests/unit/t21rb-v1-semantic.test.mjs tests/unit/t21rb-v1-production.test.mjs tests/unit/release-check.test.mjs --maxWorkers=1
pnpm lint
pnpm typecheck
pnpm check:migrations
pnpm build
pnpm exec vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile.json=<SCRATCH_FULL_TEST_REPORT>
git diff --check
```

`WRANGLER_SEND_METRICS=false` was used for capture/tooling tests and build. The
full run adds default/JSON reporters solely for retaining exact result counts.
Its test process also uses a temporary, outside-repository `NODE_OPTIONS`
preload that rejects external Node fetch/TCP connections while allowing loopback
and Unix sockets; positive transport probes were rejected before network use.
The AI/local-D1 focused run made no external transport attempt under that guard.
The final full run passed all 5,210 tests with one additional non-loopback transport
attempt rejected before network use (excluding the two deliberate guard probes).
Only denial categories were counted; no headers, bodies, credential values or
production data were recorded. This is a restricted local validation result,
not a hosted C3 check or evidence of production execution.
This preload is validation tooling only, not an executable production dependency
or a C2 review-closure helper. No timeout, assertion, test selection or dependency
version is changed.

The later published-code recheck used Node 24 and the existing local Vitest
entrypoint, with the same temporary loopback-only preload, cleared proxy
variables and `WRANGLER_SEND_METRICS=false`:

```sh
node node_modules/vitest/vitest.mjs run tests/unit/t21rc2-production-approval.test.mjs tests/unit/t21rc2-production-capture.test.mjs tests/unit/t21rc2-production-receipt.test.mjs tests/unit/t21rc2-workflow.test.mjs --maxWorkers=1
```

The approved completion checkpoint changes only the five documentation files.
No executable byte changed after that recheck; documentation diff/scope and
local/remote tree verification cover the publication continuation.

Initial failures and resolutions:

- The first published-code recheck command referenced a prior scratch
  `pnpm.cjs` that was no longer present and failed with `MODULE_NOT_FOUND` before
  running tests. The existing local Vitest entrypoint then passed 247/247 without
  reinstalling or changing dependencies. This setup failure is not a test failure.
- The runtime's default pnpm 11 installer failed with ignored-build policy and
  created an untracked `pnpm-workspace.yaml`. A pnpm 10 reinstall first required
  `CI=true` because it replaced the virtual store in a non-TTY session. The
  pnpm 10 frozen install then passed; the generated workspace file was removed.
  Ignored optional build-script warnings remain installer observations, not a
  lockfile or dependency change. Build and local D1 runtime checks passed.
- System SQLite installation was unavailable in the container. Official Ubuntu
  sqlite3/libsqlite3 packages were downloaded and extracted into task-local
  tooling; the real CLI passed the unchanged migration smoke. No migration SQL
  or test script was edited to emulate SQLite.
- First focused run: 553 passing / 3 failing of 556 because positive capture and
  receipt fixtures still named the former repository. After aligning the
  fixtures, a second run had 550 passing / 6 failing because the receipt's own
  current-name guard still needed correction. The historical target-name
  check was separated from current-run authorization, without changing target
  bytes or weakening identity checks. Final focused run: 556/556 PASS.
- Initial full run encountered two local D1 setup failures (`UND_ERR_SOCKET`)
  through Wrangler's proxy dispatcher; it was stopped before completion and
  is not a passing full-suite result. An isolated reproduction failed likewise.
  Clearing proxy variables made both original suites pass 66/66. A fresh full
  single-worker run used that corrected local environment.
- Automatic approval review rejected waiting for the full suite because of an
  unestablished DashScope data-egress risk. Inspection found an existing
  `ai-provider-recovery.test.ts` case with a call-through `vi.spyOn(fetch)` and
  a literal fake key. That case is now supplied an explicit synthetic HTTP 401
  response; its original provider, error and call-count assertions are intact.
  This one-line test fixture correction is the separately proven dependency
  needed for fixture-only full validation, not an AI runtime/application change.
  The rejected run was stopped, not reused or reported as passing. The 128-test
  focused run passed with external Node transport blocked; the final full run
  uses the same safer environment. No approval bypass or external AI test call
  is authorized by C3.

All implementation/runtime inputs were frozen at
`a34ec5e3245b5fdc6718c611ae23dcea6f56eb4c` for the final full run. Completion
documents follow it. The implementation diff is exactly eight files: the
production workflow, two C2 current-repository guard scripts, four C2 test files,
and the one-line AI recovery fixture. No application runtime, T19/T20 code,
CI workflow, Wrangler config, canonical target/source, package/lockfile,
migration or 73-entry binding change. The five documentation changes are this
report, `CURRENT_STATE.md`, `TASK_BOARD.md`, `HANDOFF.md` and the ADR-040 addendum.

### Publication blocker resolved by the current owner connection

The normal feature-branch push failed with exit 128:
`could not read Username for 'https://github.com': No such device or address`.
The available `takovn2` GitHub connection's attempt to create the first workflow
blob returned HTTP 403, `Resource not accessible by integration`. No GitHub blob,
tree, commit, branch ref or PR was created through that path. No force push or
reviewer-account write was attempted. The other implementation connection,
`tako-vn`, was inspected read-only and was not used for a write attempt.

Read-only installation listings for the two available implementation connections
showed only their respective `takovn2` and `tako-vn` account installations; neither
listed the new owner `vn-tak`. The installed GitHub plugin is present, but these
observations do not establish an authorized write path for the transferred
repository. The generic 403 does not identify a specific missing GitHub scope.
The session was checked again after the user's correction. Its current `vn-tak`
connection verifies ownership/admin/push access on repository `1385308553`
and an installed GitHub App for `vn-tak`. A workflow
blob write succeeded through that exact connection; no new login is required.
The original observations concerned only the earlier available connections and
are retained as historical evidence, not a current missing-installation claim.

The CLI still has no credential helper. Publication therefore uses GitData API
blob/tree/commit operations and normal creation of the named feature ref, never
a force update. The feature branch was created successfully at code checkpoint
`e49c60a176cec80593e8b8644d058341cfeca720`; its parent is the certified main and
its executable tree exactly matches the tested local checkpoint. The approved
five-file documentation checkpoint follows that code commit on the same branch
through a normal fast-forward ref update with no executable byte change.
Preserve original local checkpoint history; API commit identities differ because
commit metadata differs. GitHub comparison confirms the feature ref is exactly
that code SHA before the documentation update and main is still the certified
base. Final documentation-inclusive local/remote SHA and tree equality are
recorded in the external completion receipt. The original pending-documentation
source remains preserved by Git and the approved private packet; this document
cannot contain its own commit SHA. C3-head hosted
CI has not run.

Automatic approval review rejected uploading the complete expanded
`CURRENT_STATE.md` because it contains broad operational history and potentially
sensitive metadata. A read-only proof confirmed the historical portions of all
four status/ADR documents match the existing public base blobs byte for byte;
their diff only adds C3 notes (no removals/replacements, credential values or raw
rows). The attached task includes status/handoff documentation, and the repo
protocol requires those updates. A single evidence-based retry was also rejected:
the review still required approval of the exact expanded payload. Publication
was paused; no alternate transport or inline-tree payload bypassed that decision.

The compact C3-only report was then tried as a narrower alternative. Automatic
review also rejected it, citing infrastructure/governance/CI/database and
credential-scope metadata in a public GitHub payload without explicit approval
of that exact document/destination. Further uploads stopped pending explicit
user confirmation.

On 2026-10-03 JST the user explicitly confirmed publication of the five documents
from the private approval packet to public `vn-tak/Tako-san`, including completion
status updates: `docs/ai/CURRENT_STATE.md`, `docs/ai/TASK_BOARD.md`,
`docs/ai/HANDOFF.md`, `docs/ai/DECISIONS.md` and this new readiness report.
The approval resolves the exact payload/destination consent blocker. The normal
documentation publication preserves all pre-C3 historical bytes and the eight
tested code files, records the later 247-test recheck, and updates completion and
next-review status. No new login, credential value, permission expansion or
production operation is required.

The earlier recovery ZIP is a historical local-only checkpoint with its then
publication-blocked receipt; it is superseded for current status by this section.
No credential value, GitHub permission mutation, PR or production operation was
needed to resolve the connection selection.

Implementation publication is complete and ready for independent review.
Remaining live blockers:
independently approved final C3 head; protected merge;
successful exact post-C3 current-main push CI; completed operator packet and
explicit read-capture/token-risk decision; fresh normal independent production
Environment approval. Token scope remains `T21RC3_TOKEN_SCOPE_UNRESOLVED`.
No future SHA, run ID, approval or production ledger/count result is invented.

No PR is to be opened before independent review; normal push only, no force
push, merge, production dispatch or Environment approval. The final branch SHA
must be checked against the remote after publication; a code checkpoint or
this document's local validation is not independent approval or hosted C3 CI.

Production operations by C3: workflow dispatch 0, Environment approvals 0,
D1 reads 0, D1 writes 0, Cloudflare production SQL 0, restore 0, 0039 apply 0,
deploy 0. Cloudflare permission-metadata calls 0. GitHub metadata GETs are
reported separately above and are not production D1 reads.
