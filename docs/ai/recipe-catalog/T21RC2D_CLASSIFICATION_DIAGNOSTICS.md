# T21R-C2D — Classification failure decomposition and offline diagnostics

Repository `vn-tak/Tako-san` / `1385308553`. Branch
`codex/t21rc2d-classification-diagnostics` starts at certified main
`78313abff2d2e65746b4d177a6988c1e571b5424`. Implementation checkpoints:
`fbce4a1` (stages and malformed-parent fix), `3054b4a` (binding boundaries),
`4be7e18` (audited aggregate checks). The final docs-inclusive head and hosted
CI receipt are recorded in the draft PR, not self-referenced here.

## Historical production evidence, not authorization

Metadata-only `gh run view 37135187427 --json databaseId,attempt,headSha,event,conclusion,jobs`
confirmed attempt 1 on the certified base: gate PASS, normal approval PASS,
capture PASS, classification FAIL, cleanup PASS and artifact upload SKIPPED.
The operator-provided safe failure code is `T21RC2_CLASSIFICATION_REJECTED`;
no raw production log, row, manifest or artifact was retrieved.

`PRODUCTION_SNAPSHOT=CAPTURED_STABLE_NON_ATOMIC`.
`PRODUCTION_V1_RELATION=UNKNOWN_BECAUSE_CLASSIFIER_DID_NOT_COMPLETE`.
Capture success retains the identity/database/ledger/roster/fixed-SELECT,
count/stability and write-guard evidence. It does not prove production/V1
divergence, a wrong V1 target, repair readiness or atomicity.

## Confirmed observability defect and stage contract

`GENERIC_CLASSIFICATION_REJECTION_COLLAPSES_MULTIPLE_STAGES`: previously,
binding checks and a catch around reconciliation plus all manifest validation
collapsed into one rejection. The authority loader in the classify command
also ran outside that categorization boundary.

| Stage | Fixed safe failure code | Boundary |
| --- | --- | --- |
| Capture binding | `T21RC2_CLASSIFICATION_CAPTURE_BINDING_REJECTED` | Stable status, authorization digest, authority-proof equality, counts and snapshot digest |
| Authority | `T21RC2_CLASSIFICATION_AUTHORITY_REJECTED` | Offline authority-loader failure/contradiction, missing loader result and pinned-target contradiction |
| Reconciliation | `T21RC2_CLASSIFICATION_RECONCILIATION_REJECTED` | Engine exception; no original message or cause escapes |
| Schema | `T21RC2_CLASSIFICATION_SCHEMA_REJECTED` | Closed JSON schema validation, isolated from aggregate checks |
| Aggregate | `T21RC2_CLASSIFICATION_AGGREGATE_REJECTED` | Structural proof, accounting, recipe membership/counts/status, populations/drift, unique keys and recipe-local candidate references |
| Digest | `T21RC2_CLASSIFICATION_DIGEST_REJECTED` | Exact SHA syntax/length, recomputed classification digest and capture/manifest occurrence/semantic digest binding |

`classifyT21RC2Snapshot` now owns the classify-time authority load; capture-time
loading and the capture pipeline are unchanged. A surfaced
`T21RC_AUTHORITY_CONTRADICTION` remains an authority failure, not reconciliation.
`validateT21RC2ManifestSchema`, `validateT21RC2ManifestAggregate` and
`validateT21RC2ManifestDigests` separate the validators. The existing
`validateT21RC2Manifest` entry point still invokes all three. The legacy umbrella
stays in the compatibility error registry; no classification producer emits it.

### Private diagnostics

The existing runner-local failure receipt gains only this reconstructed object:

```json
{
  "schemaVersion": 1,
  "status": "T21RC2_CLASSIFICATION_SCHEMA_REJECTED",
  "stage": "schema"
}
```

It appears under `classificationDiagnostic`; its code/stage are chosen from a
static allowlist. Caller-supplied metadata is ignored. Ajv `keyword`, paths,
`params`, `data`, `parentSchema`, raw exception/context and manifest fragments
are not copied at all. CLI output is only `t21rc2=<fixed subcode>`.

No failure upload is added: the unchanged workflow uploads only on success and
cleans private files with `always()`. Existing 0700 directories, 0600 exclusive
files, runner-temp paths and cleanup remain intact. No new evidence artifact,
raw console passthrough, credential, command or SQL authority is introduced.

## Deterministic contract bugs reproduced and fixed

### Uncaptured parent — reconciliation/aggregate contradiction

A synthetic row with a valid-looking but uncaptured `recipe_id` correctly became
`MALFORMED_OCCURRENCE` / `BROKEN_RECIPE_REFERENCE`, but its orphan ID was added to
recipe summaries. One captured recipe thus produced two summaries, failing the
strict aggregate recipe-count check. The schema itself accepted the output.

The evidence now projects an uncaptured parent to `recipeId:null`, records it as
unattributed and does not invent a captured recipe. The observed raw parent still
contributes to the private occurrence digest. Malformed classification and global
membership/absence taint are unchanged. No schema or count guard is relaxed.
The regression failed on certified-main code and now passes.

This bug cannot establish the historical production cause: the unchanged C2
capture rejects broken recipe references before classification.

### Aggregate validator gaps

Five schema-valid mutations, with classification digests deliberately
recomputed, were incorrectly accepted before remediation:

1. Production candidate points to a target occurrence in another recipe.
2. Target candidate points to a production occurrence in another recipe.
3. An exact-parity recipe is assigned `SEVERELY_DIVERGED`.
4. `largestDriftRecipes` contains false derived data.
5. `idConflictOccurrenceKeys` contains a nonexistent occurrence.

The validator now requires referenced keys to exist in the same recipe,
derives recipe status from the unchanged classifier rules and checks the two
summary indexes against evidence. All five repros fail before the fix and pass
after it. These are explicit aggregate validation corrections, not classifier
meaning changes or evidence of any particular production row.

Code-level findings: `T21RC2D_ROOT_CAUSE_CONFIRMED_RECONCILIATION_ENGINE_BUG`
and `T21RC2D_ROOT_CAUSE_CONFIRMED_AGGREGATE_VALIDATOR_BUG`.
The rejecting stage/cause of run 37135187427 remains **UNRESOLVED**.
`T21RC2D_DIAGNOSTIC_INSTRUMENTATION_READY` describes the new safe stage visibility.

## Static contract audit

`CLASSIFIER_SCHEMA_ENUM_DRIFT=NONE` across production/target classifications,
confidence, authority source, mapping, identity population, drift kind, review
reason and recipe status. `DUPLICATE_PHYSICAL_LINE_ID` was already allowed;
its generated malformed manifest passed even before this task.

Production evidence (14 required keys), target evidence (9), recipe summaries,
summary (14), authority proof (8), digests (3) and capture evidence (3) retain
their closed shapes. Required fields, nullable evidence, integer counts, key
formats, uniqueness/min-items constraints and `additionalProperties:false`
are unchanged. The engine's initial `authorityProof:null` is an offline contract;
C2 attaches the loaded proof, and aggregate validation still rejects a null proof.
The structural/accounting contradiction and validation omissions above are fixed.
The schema file and certified authority files have no changes.

### Numeric and authority contract

SQLite defines quantity as REAL and optional as INTEGER. The mocked Wrangler
3.114.17 `--json` boundary uses ordinary JSON numbers and preserves them through
`JSON.parse`; the classifier requires finite positive numeric quantity below
`1e308` and exactly numeric optional bits `0`/`1`. Strings, booleans and invalid
values remain malformed without silent coercion. This is an offline contract
check, not an inspection of live D1 values.

Offline `loadCertifiedV1Authority()` matches the operator packet: 500 recipes,
2702 target occurrences, release `rel-bd00a4f53fcaeee4`, and the certified
`expectedRuntimeFingerprint` in `T21RA_RUNTIME_CANONICAL_TARGET.json`.
No target construction contradiction or authority modification occurred.

## Verification

All fixtures are synthetic or constructed from repository-certified target data,
never production rows. Coverage includes the six error stages; all binding guards;
schema mutations; aggregate/digest separation; raw/Ajv leakage; real credential-free
CLI failure; divergent, extreme-divergence, malformed and duplicate-ID manifests;
and occurrence/candidate format, uniqueness and referential integrity.

- Initial certified-main diagnostic run: 7 expected FAIL / 5 PASS (six missing
  stage codes plus the malformed-parent contract bug).
- Audited aggregate mutation repro: 5 expected FAIL / 57 PASS before its fix.
- Final focused command: `TZ=UTC pnpm exec vitest run --maxWorkers=1` with the
  reconciliation, capture, receipt, approval, workflow and diagnostics files:
  6 files / 375 PASS (57, 79, 8, 148, 21, 62 respectively).
- Final `pnpm lint`, `pnpm typecheck`, `pnpm check:migrations`, `pnpm build`
  and `git diff --check`: PASS on implementation checkpoint `4be7e18`.
- Final `TZ=UTC pnpm exec vitest run --maxWorkers=1`: 235 files / 5384 PASS,
  exit 0 (502.38 seconds), Node 24.21.0 / pnpm 10.31.0.
- Earlier full run on `3054b4a`: 235 files / 5379 PASS. One intermediate
  receipt assertion expected a digest code for a padded digest rejected earlier
  by the closed schema; corrected to the schema-stage contract, without weakening
  that rejection.
- Fresh exact-head attempt-1 hosted PR CI is pending at this documentation
  checkpoint. Its run/job IDs, test count and final head go in the PR receipt.

Local migration smoke uses ephemeral SQLite only, not Cloudflare D1. No production
SQL, migration, 0039 application or credential was needed.

## Review binding and handoff

Four C2-bound scripts changed. Old reviewed C4L head `a0d4bf9` still binds to
certified main `78313ab` but rejects the implementation head with
`T21RC2_REVIEW_BINDING_REJECTED`. The 73-entry closure and its validator are
unchanged. A new independently reviewed exact head is required for future C2.
C4I bound bytes are unchanged and its old binding continues to pass.

Independent review must inspect all six stage boundaries, schema/aggregate/digest
separation, fixed-metadata diagnostics and CLI privacy, each proven contract fix,
all synthetic divergence/malformed/key fixtures, unchanged V1/SELECT/capture
authority and the healthy old-C2 rejection. Hosted attempt-1 pull-request CI must
succeed on the final head before calling this ready for independent review.

No merge or C2/C4I rerun is authorized. Production C2/C4I runs, D1 SQL reads/writes,
mutations, secret/token changes, migrations, 0039 applies and deploys for this task
are all zero. Repair NOT_AUTHORIZED; 0039/deploy STOPPED; T21G_NOT_READY.
