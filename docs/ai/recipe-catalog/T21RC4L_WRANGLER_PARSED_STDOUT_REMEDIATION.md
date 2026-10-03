# T21R-C4L — Wrangler parsed-stdout log suppression remediation

**Status:** `T21RC4L_REMEDIATION_READY_FOR_REVIEW` once fresh hosted PR CI on the
exact remediation head succeeds. Code remediation only; nothing here authorizes
a production run. Finding: `T21RC4_WRANGLER_LOG_SUPPRESSION_BUG_CONFIRMED`.

Repository `vn-tak/Tako-san` (ID `1385308553`); branch
`codex/t21rc4l-wrangler-parsed-output-fix` from certified main `0e6342f`
(PR #38 merge). The exact head is recorded in the PR and publication receipt,
not self-referenced here.

## Runtime authority

| Item | Value |
| --- | --- |
| `package.json` wrangler spec | `^3.114.0` (unchanged) |
| `pnpm-lock.yaml` resolution | `3.114.17` (unchanged) |
| Workflow install | `pnpm install --frozen-lockfile`, then `pnpm wrangler ...` |

External Wrangler 4.147.0 source inspection only suggested the pattern. The confirmed,
project-specific finding comes from the installed `wrangler@3.114.17` bundle
(`node_modules/wrangler/wrangler-dist/cli.js`):

- `LOGGER_LEVELS = { none: -1, error: 0, warn: 1, info: 2, log: 3, debug: 4 }`;
  `doLog` writes to the console only when
  `LOGGER_LEVELS[loggerLevel] >= LOGGER_LEVELS[messageLevel]`. An unset or
  unrecognised `WRANGLER_LOG` defaults to `log`.
- `logger.table(...)` calls `doLog("log", ...)`.
- `wrangler whoami` prints its account list through `printAccountList` →
  `logger.table` ("Account Name" / "Account ID").
- `wrangler d1 list --json` prints `logger.log(JSON.stringify(dbs, null, 2))`.
- `wrangler d1 execute --json` forces the level to `error` while executing, then
  restores the prior (environment) level immediately before
  `logger.log(JSON.stringify(response, null, 2))`.
- The debug log file (`WRANGLER_LOG_PATH`) is appended for every message
  regardless of console level, so containment depends on the path, not the level.

With `WRANGLER_LOG=error` (`0 >= 3` is false) all three payloads that Tako-san
parses were suppressed:

1. C4I/C2 `whoami` → empty account table → the bounded 32-hex membership check
   failed → `T21RC4I_ACCOUNT_ID_SECRET_MISMATCH` / `T21RC2_IDENTITY_REJECTED`.
2. Had whoami been fixed alone, `d1 list --json` stdout would be empty →
   `JSON.parse` failure.
3. Had identity been fixed alone, C2 `d1 execute --json` would run the SELECT
   but print nothing → `JSON.parse` failure → `T21RC2_QUERY_FAILED`.

## Remediation

Only the logger level of Wrangler invocations whose stdout is parsed changes:

- `scripts/t21rc4-cloudflare-identity-diagnostic.mjs`: child env now sets
  `WRANGLER_LOG='log'` (was `'error'`). Allowlisted child env, explicit
  credentials, `CI=true`, `WRANGLER_SEND_METRICS=false`, 0700 private temp dir
  and `/dev/null` debug-log sink with `finally` cleanup are unchanged.
- `scripts/t21rc2-production-capture.mjs`: `captureExecutionEnvironment` is
  renamed `parsedWranglerStdoutEnvironment` (every caller parses stdout:
  `proveT21RC2CloudflareIdentity` and `executeFixedProductionSelect`) and sets
  `WRANGLER_LOG='log'`. It still strips `GH_TOKEN`/`GITHUB_TOKEN`, forces
  `WRANGLER_SEND_METRICS=false` and keeps the runner-local private
  `RUNNER_TEMP/t21rc2/wrangler.log` path and cleanup semantics. Because the
  override follows the env spread, an inherited `WRANGLER_LOG=error` cannot win.

Unchanged: command arrays (C4I exactly `whoami` and
`d1 list --json --config wrangler.jsonc`; C2 the same identity pair and the four
fixed SELECTs via `d1 execute ... --remote --yes --json --command`), the SQL
allowlist, `stdio: ['ignore', 'pipe', 'pipe']`, buffers/timeouts, JSON and
result-shape validation (`success`, `results`, truncation/paging, `changes`,
`rows_written`), 32-hex secret syntax, bounded case-insensitive whoami
membership, exact `frigo-db` name and UUID checks, receipts and workflows. No
dependency, lockfile, workflow, migration or application runtime change.

`wrangler whoami --json` is not used (not part of the 3.114.17 contract) and
Wrangler is not upgraded.

## Regression coverage

A logger-sensitive executor models 3.114.17: output is returned only when the
effective `WRANGLER_LOG` level is `>= log`, otherwise `""`. Realistic whoami
fixtures include the banner, greeting with a synthetic email, account-name
table, 32-hex account ID, an unrelated account and a 64-hex run that must not
match.

| Regression | File |
| --- | --- |
| C4I whoami suppression (effective `log`, `accountIdMatchesWhoami=true`) | `tests/unit/t21rc4-cloudflare-identity-diagnostic.test.mjs` |
| C4I d1 list suppression (`D1_LIST=SUCCESS`, exact UUID comparison runs, mismatch detected) | same |
| C4I inherited `WRANGLER_LOG=error` cannot suppress | same |
| C2 whoami suppression | `tests/unit/t21rc2-production-capture.test.mjs` |
| C2 d1 list suppression with inherited `error` | same |
| C2 d1 execute `--json` suppression for all four fixed SELECTs | same |
| Raw-output leakage (fake token, account ID, email, account name, unexpected UUID, provider text) absent from C4I receipt, C2 failure receipt and all console/stdout/stderr | both |

All nine suppression regressions plus the updated child-env assertion fail when
both scripts are temporarily reverted to `WRANGLER_LOG='error'` (10 failures,
recorded locally), and pass with the fix.

## Local verification (Node 24.21.0, pnpm 10)

| Check | Result |
| --- | --- |
| Focused C4I (diagnostic, workflow, gate, approval) | 4 files / 103 PASS |
| Focused C2 (capture, approval, receipt, workflow) | 4 files / 256 PASS |
| Regressions against reverted `WRANGLER_LOG='error'` | 10 FAIL as expected |
| `pnpm lint` / `pnpm typecheck` / `pnpm check:migrations` / `pnpm build` | PASS |
| `TZ=UTC pnpm exec vitest run --maxWorkers=1` | 234 files / 5,322 PASS |
| `git diff --check` | PASS |

Hosted PR CI on the exact head is recorded in the PR, not here.

## Review-binding consequence

Both scripts are review-bound, so the old authorities are intentionally void:

- C4I reviewed SHA `a0c1cfd` → remediation head: `assertC4IReviewBinding`
  rejects with `T21RC4I_REVIEW_BINDING_REJECTED`.
- C2 reviewed SHA `93c4055` → remediation head:
  `assertReviewedExecutionClosure` rejects with `T21RC2_REVIEW_BINDING_REJECTED`.

Both still accept certified main `0e6342f`, so rejection is caused only by
the remediated bytes. Neither closure was narrowed (C2 still 73 entries; C4I
bound list unchanged). New unit tests reproduce both rejections with real Git
objects. `T21RC2_OLD_REVIEW_BINDING=INVALIDATED_BY_INTENTIONAL_REMEDIATION`.

One exact reviewed remediation head may become the new authority for both
surfaces only if independent review explicitly approves C4I production
diagnostic execution and C2 production row capture execution.

## Historical production evidence correction

Operator-reported runs (logs are not rewritten):

| Run | Workflow | Recorded classification | Corrected interpretation |
| --- | --- | --- | --- |
| 37084988593 | C2 row reconciliation | `T21RC2_IDENTITY_REJECTED` | identity/account conclusion `INVALIDATED_BY_WRANGLER_LOG_SUPPRESSION_BUG` |
| 37124563415 | C4I identity diagnostic | `T21RC4I_ACCOUNT_ID_SECRET_MISMATCH` | same |
| 37128183771 | C4I identity diagnostic | `T21RC4I_ACCOUNT_ID_SECRET_MISMATCH` | same |

These runs cannot prove an account secret mismatch. Facts that remain valid:
the runs occurred; gate/approval facts stand; whoami itself returned success
where recorded; C4I never reached D1 SQL; no production mutation occurred.

A production `CLOUDFLARE_ACCOUNT_ID` update was performed (operator-reported)
before run 37128183771. That update occurring is not proof that the value is
correct. `CLOUDFLARE_ACCOUNT_ID correctness = UNVERIFIED_PENDING_FIXED_C4I`.
Token scope remains `UNKNOWN`.

## Independent review scope

The reviewer must inspect: (A) Wrangler 3.114.17 logger/command source;
(B) C4I whoami stdout path; (C) C4I d1 list `--json` path; (D) C2 whoami path;
(E) C2 d1 list `--json` path; (F) C2 d1 execute `--json` path; (G) raw-output
privacy (piped stdio, receipts, debug-log sink/path); (H) no SQL or command
authority expansion; (I) C4I old binding correctly invalidated; (J) C2 old
binding correctly invalidated.

## Release sequence (documented only, not executed)

implementation → independent review → protected PR approval → merge →
exact-main CI → fresh C4I dispatch → fresh production Environment approval →
C4I identity verification. Only `T21RC4I_CLOUDFLARE_IDENTITY_CERTIFIED` permits
preparing a separately authorized C2 capture; C4I success never auto-authorizes
C2. Until review, merge and exact-main CI: `SAFE_TO_RUN_C4I=NO`,
`SAFE_TO_RUN_C2=NO`.

Production counters for this task: C4I runs 0, C2 runs 0, D1 SQL reads/writes
0/0, mutations 0, secret/token mutations 0/0, migrations 0, 0039 applies 0,
deploys 0. T21G_NOT_READY; 0039 and deploy STOPPED.
