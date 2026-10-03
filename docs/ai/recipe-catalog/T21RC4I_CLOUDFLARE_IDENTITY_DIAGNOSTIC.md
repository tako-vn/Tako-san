# T21R-C4I — Cloudflare identity metadata diagnostic

Status: `T21RC4I_IMPLEMENTATION_READY_FOR_REVIEW`. Local validation is complete;
normal implementation publication is verified. No diagnostic has been dispatched.
This is a separate diagnostic implementation and future operator procedure;
it authorizes no live execution, credential change or C2 rerun.

## Authority and failed attempt

Repository `vn-tak/Tako-san`, stable ID `1385308553`. The initial GitHub API
comparison and fetched `origin/main` both matched certified pre-diagnostic main
`7cd58968c3b4c0f7936c75d74b6965d229b57c69` exactly. Isolated branch:
`codex/t21rc4-cloudflare-identity-diagnostic`. C3 is
`T21RC3_PROTECTED_INTEGRATION_CERTIFIED`; its independently reviewed feature
head is `93c4055a42cd2d94f4db296d8ca10d555c2c52c2`. Main is PR #37's merge.
The older C3 implementation documents below the new status sections remain
historical checkpoints, not current integration claims.

The task identifies failed [run 37084988593](https://github.com/vn-tak/Tako-san/actions/runs/37084988593),
attempt 1, actor `tako-vn1`, workflow head exactly the certified main above:

| Stage | Outcome |
| --- | --- |
| Gate | SUCCESS |
| Normal production Environment approval | SUCCESS, task authority |
| Approval validator | SUCCESS |
| Capture | FAILURE, `T21RC2_IDENTITY_REJECTED`, task-supplied safe error |
| Classify / final recheck / receipt / artifact upload | SKIPPED |
| Artifact | NONE, task authority and skipped upload |
| Cleanup | SUCCESS |

Read-only GitHub job metadata independently confirmed the step outcomes:
gate job `111093283465`, capture job `111093334376`. No raw log was downloaded
and no approval, rerun or dispatch API was invoked by this implementation.

Source order in `runT21RC2CaptureCommand('capture')` calls
`proveT21RC2CloudflareIdentity()` before the first
`executeFixedProductionSelect()`. Given the supplied identity error, the failed
attempt executed **zero D1 SQL reads, zero D1 SQL writes and zero production
mutations**. It does not establish zero Cloudflare operations: `wrangler whoami`
and/or `wrangler d1 list` may already have executed. Their exact progress is
not retrospectively distinguishable from the collapsed error.

The current C2 guard checks token/account syntax and committed config, captures
whoami and D1-list output, then checks account/name/UUID. All failures map to the
same `T21RC2_IDENTITY_REJECTED`. C4I does not change that fail-closed behavior or
claim a cause from the old error. The new path stops at its first known failure;
in particular, it does not list D1 metadata after an account mismatch.

## Separate executable path

- Workflow: `.github/workflows/production-d1-identity-diagnostic.yml`.
- Script: `scripts/t21rc4-cloudflare-identity-diagnostic.mjs`.
- Manual `workflow_dispatch` only; no push/PR/schedule/repository dispatch.
- Main only, attempt 1 only, explicit boolean confirmation defaulting to false.
- `environment: production`, preserving existing GitHub protection; no policy
  edit or programmatic approval. Future operators must use normal independent
  approval, never self-approval or admin bypass.
- Only `contents: read`; no Actions read or write permissions needed.
- Shared lock `frigo-deploy-production`, `cancel-in-progress: false`.
- Checkout immutable `github.sha`, full history, no persisted Git credential.
- Certified pins: checkout `11d5960a326750d5838078e36cf38b85af677262`,
  setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020`, pnpm/action-setup
  `b906affcce14559ad1aafd4ab0e942779e9f58b1`. Node 24, pnpm 10, frozen lockfile.
- Credentials exist only in the final diagnostic step's environment, not the
  installation step or Action inputs. No command-line credential arguments.
- No artifact upload; Actions logs contain only the sanitized diagnostic JSON.

The only two command arrays the script can issue are:

```text
pnpm wrangler whoami
pnpm wrangler d1 list --json --config wrangler.jsonc
```

There is no SQL command, row access, schema/ledger read, resource mutation,
repair, restore, migration or deploy path. Arbitrary CLI arguments are rejected
before any Wrangler command. Each command has a 60-second timeout, a 4 MiB
captured-output limit, ignored stdin and piped stdout/stderr. Command failures,
timeouts, output-limit failures and parsing errors are mapped to safe categories;
underlying exceptions never reach the public receipt.

## Stages and safe statuses

| Stage | Sanitized field | Failure status |
| --- | --- | --- |
| A: token presence | `tokenPresent`: boolean | `T21RC4I_TOKEN_MISSING` |
| B: lowercase 32-hex account secret syntax | `accountIdSecretFormat`: VALID / INVALID | `T21RC4I_ACCOUNT_ID_SECRET_INVALID_FORMAT` |
| C: pinned committed config identity | `wranglerConfigIdentity`: PASS / FAIL | `T21RC4I_WRANGLER_CONFIG_MISMATCH` |
| D: whoami authentication | `wranglerWhoami`: SUCCESS / FAILURE | `T21RC4I_WHOAMI_AUTH_FAILED` |
| E: account comparison | `accountIdMatchesWhoami`: boolean | `T21RC4I_ACCOUNT_ID_SECRET_MISMATCH` |
| F: D1 metadata listing and response shape | `d1List`: SUCCESS / FAILURE | `T21RC4I_D1_LIST_AUTH_OR_SCOPE_FAILED` |
| G: exactly one production name | `frigoDbMatchCount`: 0 / 1 / MULTIPLE | `T21RC4I_PRODUCTION_D1_NAME_MISSING` or `T21RC4I_PRODUCTION_D1_NAME_DUPLICATE` |
| H: exact production UUID | `productionD1UuidMatch`: boolean | `T21RC4I_PRODUCTION_D1_UUID_MISMATCH` |

Unreached enum fields are `NOT_RUN`; unreached comparisons/count are null.
Only all eight stages passing yields `T21RC4I_CLOUDFLARE_IDENTITY_CERTIFIED`.
Internal local setup/cleanup failure yields `T21RC4I_DIAGNOSTIC_INTERNAL_FAILURE`;
extra CLI arguments yield `T21RC4I_INPUT_REJECTED`. Failure exits 1; identity
success exits 0. This distinguishes authenticated identity from D1 metadata
access, while `D1_LIST_AUTH_OR_SCOPE_FAILED` intentionally does not infer a
specific provider permission from an unavailable/raw exception.

Config identity requires one production binding `DB`, name `frigo-db`, UUID
`f975ec39-b2c8-4a2a-80e1-0366054599d3`, valid JSONC and no duplicate keys.
The standalone script uses the existing TypeScript parser dependency and a
small isolated identity verifier. Importing the existing D1 helper would pull
SQL-capable helpers and a forbidden migration-named module into the diagnostic
source. Eight compatibility fixtures compare the isolated verifier against the
unchanged existing verifier, including comments, trailing commas, duplicate
keys and wrong identities. No dependency/package/lockfile change is needed.
Stage B deliberately follows this task's lowercase-only format; the C2 guard's
case-insensitive syntax is unchanged. Stage E uses exactly the existing C2
bounded 32-hex extraction and case-insensitive account comparison.
An uppercase-format rejection alone therefore does not explain the historical
C2 failure. A future diagnostic reports current Environment identity; it does
not prove that credentials or provider state were identical in the old attempt.

## Output and local-file privacy

The formatter reconstructs an explicit allowlist rather than serializing
Wrangler output or a caller-provided object. Unknown strings/extra properties
are discarded. No token value, length or hash; account ID; actual unexpected
UUID; database names/list; email; headers; stdout/stderr; request ID; exception
string or provider path is logged or uploaded. Duplicate matches are represented
as `MULTIPLE`, not an arbitrary count. Even malicious formatter overrides cannot
set `d1SqlExecuted`, `productionMutations` or `tokenScopeReadOnlyProven`.

Whoami and list responses remain in process memory. Wrangler 3 itself writes a
debug log even when normal output is piped. Before either command the script
creates a private 0700 runner-local directory with `wrangler.log` pointing to
`/dev/null`; its fixed `WRANGLER_LOG_PATH` ends in `.log`, as required by the
installed Wrangler implementation. Raw debug output is discarded, not stored.
The private directory and symlink are removed on success and failure. No raw
metadata file or public artifact is created.

The child environment permits required OS/PATH/HOME fields plus the two explicit
Cloudflare credentials; it does not inherit alternative API credentials,
provider endpoint overrides, GitHub tokens or debug/telemetry overrides.
`CI=true`, `WRANGLER_SEND_METRICS=false` and `WRANGLER_LOG=error` are forced.
No credential value, GitHub secret or Cloudflare resource is changed.

## Token permission is separate

```text
TOKEN_SCOPE_READ_ONLY_PROVEN = false
TOKEN_SCOPE = UNKNOWN
```

Whoami authentication and successful D1 metadata listing prove neither a
read-only token nor the absence of write capability. Identity certification
does not authorize SQL capture, repair or a C2 rerun. Independent authorized
permission-metadata evidence would be needed to change that scope claim.

## Review-binding preservation

No existing C2 workflow, capture, approval, receipt, classifier, D1 helper,
configuration, dependency file or member of the 73-path closure is changed.
The diagnostic's workflow/script/tests/docs are outside that closure. The
regression uses real local Git objects for reviewed SHA `93c4055...`, adds actual
diagnostic files to the certified main tree, and proves
`assertReviewedExecutionClosure(reviewed, futureMain)` passes. A subsequent
existing production-workflow byte mutation must reject with
`T21RC2_REVIEW_BINDING_REJECTED`.

Thus `93c4055a42cd2d94f4db296d8ca10d555c2c52c2` remains **eligible**, subject to
the future-main byte-equivalence, ancestry, exact-main CI and all existing C2
gates. No current approval is claimed for the new diagnostic itself. After
eventual protected diagnostic integration, a future separately authorized C2
dispatch must use `ref=<NEW_POST_DIAGNOSTIC_CURRENT_MAIN_SHA>`; preserving the
older reviewed SHA is conditional, not permission to reuse the failed run or
skip a new normal approval.

## Future operator procedure — not executed here

1. Obtain independent review of the final C4I head: command allowlist, stages,
   formatter, raw-output/debug-log suppression and unchanged C2 binding.
2. Integrate through a separately authorized protected PR/merge and confirm
   successful exact post-integration main CI. Record that actual main SHA and
   diagnostic reviewed head; no future SHA/run/approval is invented here.
3. Explicitly authorize one metadata-only diagnostic. Select the workflow on
   `main`, set `confirm_metadata_identity_diagnostic=true`, use a new attempt-1
   run and check the execution SHA. Do not rerun `37084988593` or C2.
4. Obtain normal independent production Environment approval; preserve the
   existing Environment policy and shared production lock. No bypass/self-approval.
5. Inspect only the sanitized receipt. If a stage fails, stop and record that
   category. Do not dump output, change secrets/tokens/account scope, rerun C2
   or execute SQL to investigate. Any corrective action needs separate authority.
6. If identity is certified, retain scope UNKNOWN/read-only-unproven and stop.
   Any later capture still needs its own authorization and all unchanged C2 gates.

## Implementation validation and scope receipt

Focused six-file validation: **308/308 PASS**, 12.56 seconds. New C4I suites:
35 diagnostic/privacy/config/binding cases and 26 workflow/static cases (61).
Unchanged C2 suites: approval 148, capture 70, receipt 8, workflow 21 (247).
Lint/typecheck/local SQLite migration smoke/web-and-Worker build: PASS, exit 0.
The initial completed full run used inherited `TZ=America/Los_Angeles`: 232
files, 5,269 PASS / 2 FAIL of 5,271, zero skips, exit 1, 492.75 seconds. The
unchanged Week serialization weekday assertion and expired-OTP guest-transfer
assertion failed because UTC date-only / SQLite UTC timestamps were interpreted
in that local timezone. No C4I or C2 test failed. Retained the failed receipt.
With test-process `TZ=UTC` (CI-compatible), those same two suites passed 32/32
in 5.00 seconds. No Week/auth source or assertion changed. The fresh UTC full
single-worker run then passed **232 files / 5,271 tests / zero skips**, exit 0,
494.41 seconds. Its source was frozen at local code checkpoint
`dfad66da7706bf315e4b0e27b0e471b9ce71cb83`. Lint 7.66s, typecheck 18.41s,
local migration smoke 0.49s and build 10.55s all exited 0.

All diagnostic whoami/list commands in tests are injected mocks. The real CLI
test supplies extra arguments and no credentials, proving it exits before any
Wrangler execution. Full validation uses outside-repository tooling that blocks
external Node fetch/TCP while allowing loopback/Unix sockets for existing local
D1 tests. Proxy variables are cleared and real local SQLite 3.45.1 is on PATH;
the corrected full run sets `TZ=UTC` in the test process only.
No Cloudflare call is made by C4I tests or this implementation; the result is
restricted local validation, not hosted CI or live identity certification.

Commands use isolated pnpm 10.34.6 with existing frozen-lock dependencies,
Node 24.19.0 and Vitest 3.2.7. The task-local launcher records exact command,
exit code, duration and full default/JSON test results outside the repository:

```sh
pnpm exec vitest run tests/unit/t21rc4-cloudflare-identity-diagnostic.test.mjs tests/unit/t21rc4-identity-workflow.test.mjs tests/unit/t21rc2-production-approval.test.mjs tests/unit/t21rc2-production-capture.test.mjs tests/unit/t21rc2-production-receipt.test.mjs tests/unit/t21rc2-workflow.test.mjs --maxWorkers=1 --reporter=default --reporter=json --outputFile.json=<SCRATCH_FOCUSED_REPORT>
pnpm lint
pnpm typecheck
pnpm check:migrations
pnpm build
pnpm exec vitest run --maxWorkers=1 --reporter=default --reporter=json --outputFile.json=<SCRATCH_FULL_REPORT>
git diff --check
```

The targeted timezone verification command was:

```sh
TZ=UTC pnpm exec vitest run tests/unit/week-route-serialization.test.ts tests/integration/inventory-guest-transfer.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile.json=<SCRATCH_TIMEZONE_REPORT>
```

Initial failures were retained rather than reported as passing: runtime pnpm 11
attempted dependency reinstallation through the new worktree's shared modules
link and refused the outside-root target before testing. Existing modules were
preserved; pnpm 10.34.6 was fetched into task-local tooling and used without
installation or package/lockfile changes. The first direct Vitest run passed
282 tests across five files but the new workflow test suite did not parse due
to a hyphenated property accessed with dot syntax. Correct bracket access and
Node syntax checks resolved it; final focused result is the 308-test result
above. No assertion, timeout, selection or safety control was weakened.

The original checkout contained an unrelated modified tracked T18C ZIP. This
task used a separate worktree and preserved that change. Scope is four new
diagnostic executable/test files, this report and minimal current-state,
task-board, handoff and ADR-040 additions; no T19/T20/application/auth/payment,
production resource, dependency/configuration or migration changes.

Current operations: diagnostic dispatch NOT_RUN, production Environment approval
0, C2 rerun NO, production D1 SQL reads/writes 0/0, production mutations 0,
GitHub secret mutations 0, Cloudflare token mutations 0, Cloudflare metadata
calls by this implementation 0. The failed historical attempt's metadata calls
remain POSSIBLE / NOT FULLY DISTINGUISHABLE. 0039 and deploy remain STOPPED;
T21G_NOT_READY, repair NOT_AUTHORIZED, row delivery UNCONFIGURED.

After local completion and normal branch publication, stop for independent
review. No PR, merge, diagnostic dispatch or production action is authorized.

## Verified implementation publication

Normal GitData feature-ref creation through authenticated owner `vn-tak` published
code checkpoint `81646b0e6389fe61ea04db5892dec8ee597693f9` with parent exactly certified base
`7cd58968c3b4c0f7936c75d74b6965d229b57c69`. Its tree
`00c68d1b21f9dd965a1936632ee479b1320d16f2` equals the frozen local checkpoint
`dfad66da7706bf315e4b0e27b0e471b9ce71cb83` byte for byte; commit metadata
(author, message and timestamp) changes its SHA. The original local source branch is preserved. Completion
documentation follows that code commit with no executable-byte change; final
docs-inclusive local/remote head and tree equality belong in the external final
receipt, not in this document's own commit. No force push, history rewrite or PR.

Each completed full run had one non-loopback transport attempt denied before
network use; two separate fetch/TCP guard probes were also denied. Only categories
were retained, not destinations, request bodies or credentials. The full result
is a restricted local validation receipt, not hosted C4I CI or production evidence.
C4I is not a configured CI push branch and no PR was opened.

All 73 reviewed entries remain byte-identical from C3 through certified base and
this implementation checkpoint. Only the four new code/test files and five
documentation files belong to C4I. Status/historical documents preserve all prior
base bytes. Main remains unchanged; before completion verify the final feature
ref/head/tree and stop for independent review.
