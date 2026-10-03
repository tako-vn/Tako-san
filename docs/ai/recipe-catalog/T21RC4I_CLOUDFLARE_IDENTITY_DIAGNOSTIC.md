# T21R-C4I — Cloudflare identity metadata diagnostic

Status: independent-review remediation on draft PR #38. Base reviewed head:
`a5966c7fa27b67d16ff02acb753cd2bc82c372fa`. This document describes the
remediated implementation; a new exact head still requires fresh hosted PR CI
and independent review. It does not authorize a production diagnostic, a C2
rerun, an Environment approval, secret/token changes, SQL, repair, merge or deploy.

## Authority and historical failure

The repository is `vn-tak/Tako-san` (ID `1385308553`). Certified main at the
start of this remediation was `7cd58968c3b4c0f7936c75d74b6965d229b57c69`.
C2/C3 independently reviewed SHA remains
`93c4055a42cd2d94f4db296d8ca10d555c2c52c2`. C4I changes do not enter
the C2 73-path review closure.

The historical C2 production run `37084988593`, attempt 1, failed with
`T21RC2_IDENTITY_REJECTED` before any D1 SQL. That attempt had zero production
D1 SQL reads, zero D1 SQL writes and zero production mutations. Cloudflare
metadata commands may already have occurred. The new C4I statuses do not
retroactively identify the failure cause; a future diagnostic can observe only
current credential and provider state.

## Review-bound production workflow

`.github/workflows/production-d1-identity-diagnostic.yml` accepts only manual
`workflow_dispatch` with required `ref`, `reviewed_sha` and an explicit
`confirm_metadata_identity_diagnostic=true`. The operator inputs for a future
separately authorized run are:

```text
ref = <POST_C4I_MERGE_CURRENT_MAIN_SHA>
reviewed_sha = <EXACT_INDEPENDENTLY_REVIEWED_C4I_FEATURE_HEAD>
confirm_metadata_identity_diagnostic = true
```

The credential-free `gate` job requires repository name/ID, main branch,
first attempt, confirmation, `github.sha == ref`, remote current main equal to
`ref`, distinct real commit SHAs and ancestry from `reviewed_sha` to `ref`. It
compares C4I execution bytes at the reviewed and main commits and requires a
successful exact-main `ci.yml` push run for `ref`, attempt 1. PR, synthetic
merge, older-main, failed and missing CI cannot satisfy this gate. The gate
uses GitHub API evidence and repository Git objects; local `origin/main` alone
is insufficient. Safe SHA/CI metadata is passed to the diagnostic job.

The C4I review closure binds these paths, including absent-to-present changes
of optional configuration slots:

```text
.github/workflows/production-d1-identity-diagnostic.yml
.github/workflows/ci.yml
scripts/t21rc4-cloudflare-identity-diagnostic.mjs
scripts/t21rc4-identity-gate.mjs
scripts/t21rc4-identity-approval.mjs
package.json
pnpm-lock.yaml
wrangler.jsonc
.npmrc
.pnpmfile.cjs
pnpm-workspace.yaml
.gitattributes
```

The diagnostic job depends on the gate and waits for the `production` GitHub
Environment. Its checkout uses the gate's exact main SHA. Before receiving any
Cloudflare credential in a step, it verifies gate outputs and checked-out HEAD,
then runs the separate GitHub-only approval validator. The final diagnostic
step alone receives `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
`GH_TOKEN` is not passed to Wrangler. The workflow shares production
concurrency group `frigo-deploy-production` with cancellation disabled. Action
versions are pinned by commit SHA; Node 24 and pnpm 10 use the frozen lockfile.
No artifact upload is configured.

## Independent Environment approval

`scripts/t21rc4-identity-approval.mjs` reads this run's metadata, the current
`production` Environment policy and the complete unambiguous approval history
using GitHub API only. It requires exactly one `approved` record by User
`vn-taphoanhatung` (ID `329713999`), for Environment `production` (ID
`22649920074`). Neither the workflow actor nor triggering actor may be that
reviewer by login or ID. Skipped/rejected/missing/multiple approvals, a wrong
Environment, a wrong reviewer, self review and evidence of actual bypass are
rejected. The run must still be a first-attempt main `workflow_dispatch` for the
expected repository and workflow. The validator rechecks current remote main
after approval validation, so main moving during Environment wait rejects the
run before the Cloudflare step.

The policy is pinned to the observed sole `required_reviewers` rule ID
`66577771`, single User reviewer above, `prevent_self_review=false`,
`wait_timer` absent in the observed API response (a null response is also accepted),
`deployment_branch_policy=null` and
`can_admins_bypass=true`. The last flag means bypass is available; it is not
evidence that bypass was used. The validator rejects actual bypass in approval
history, normalizes and hashes the policy and approval proof, and never changes
the Environment. GitHub API requests require HTTP 200, reject redirects, limit
response size and approval pagination, check response shape, and use an explicit
API version. The token, raw responses and provider exceptions are not logged.
A GitHub API permission failure rejects the run; it cannot authorize use of
Cloudflare credentials.

## Metadata-only diagnostic

The diagnostic can invoke exactly these Wrangler command arrays:

```text
wrangler whoami
wrangler d1 list --json --config wrangler.jsonc
```

There is no D1 SQL execution path, migration, restore, deploy or repair path.
The committed `wrangler.jsonc` must have exactly one `DB` binding to `frigo-db`
with UUID `f975ec39-b2c8-4a2a-80e1-0366054599d3`. Account ID syntax matches
C2: exactly 32 hexadecimal characters, case-insensitive, with no whitespace,
prefix or suffix. The whoami account comparison normalizes both IDs to lower
case. Lowercase, uppercase and mixed-case IDs are accepted; malformed lengths,
non-hex text and whitespace are rejected.

| Stage | Safe status on failure |
| --- | --- |
| Missing token | `T21RC4I_TOKEN_MISSING` |
| Invalid account secret syntax | `T21RC4I_ACCOUNT_ID_SECRET_INVALID_FORMAT` |
| Committed config identity mismatch | `T21RC4I_WRANGLER_CONFIG_MISMATCH` |
| Whoami command did not yield an accepted result | `T21RC4I_WHOAMI_COMMAND_FAILED` |
| Account ID does not match whoami | `T21RC4I_ACCOUNT_ID_SECRET_MISMATCH` |
| D1 list command failed, timed out or exceeded output bound | `T21RC4I_D1_LIST_COMMAND_FAILED` |
| D1 list JSON or shape invalid | `T21RC4I_D1_LIST_RESPONSE_INVALID` |
| Production database name absent or duplicated | `T21RC4I_PRODUCTION_D1_NAME_MISSING` / `T21RC4I_PRODUCTION_D1_NAME_DUPLICATE` |
| Production database UUID mismatch | `T21RC4I_PRODUCTION_D1_UUID_MISMATCH` |

Only all stages passing yields `T21RC4I_CLOUDFLARE_IDENTITY_CERTIFIED`.
Command failure categories do not claim token authentication failure or lack
of D1 scope. They make no inference from raw provider messages. Even identity
success leaves `TOKEN_SCOPE_READ_ONLY_PROVEN=false` and `TOKEN_SCOPE=UNKNOWN`.

The receipt is rebuilt from an explicit allowlist. It never exposes a token,
token hash or length, account ID, email, raw whoami or D1 list, unexpected UUID,
provider headers/request ID or exception text. Wrangler stdout and stderr stay
in memory. A private temporary directory sends Wrangler's debug log to
`/dev/null` and is cleaned in `finally`. The child process receives required
OS fields and the two explicit Cloudflare credentials, without GitHub tokens,
alternate Cloudflare credentials, endpoint overrides or debug settings.

## Future operator sequence

1. Obtain independent delta review of the new exact C4I remediation head and
   fresh successful hosted PR CI for that head. Draft PR #38 remains draft until
   independent review approves it.
2. After a separately authorized protected merge, confirm successful exact-main
   push CI for the post-merge main commit.
3. Dispatch one new attempt-1 run with the exact `ref`, `reviewed_sha` and
   confirmation shown above, under separate production authorization.
4. Obtain normal independent `production` Environment approval. Do not use
   self approval or admin bypass. The validator must pass before the diagnostic
   step receives Cloudflare credentials.
5. Read only the sanitized receipt. A failure stops this diagnostic. A success
   still does not authorize C2, SQL, token changes or repair.

No production C4I diagnostic, C2 rerun, Environment approval, D1 SQL read/write,
secret/token mutation, 0039 apply or deployment occurred during this remediation.
Validation results and exact remediation head belong in the current status and
handoff records after checks complete. The next required decision is independent
review of the new head, not a production dispatch.
