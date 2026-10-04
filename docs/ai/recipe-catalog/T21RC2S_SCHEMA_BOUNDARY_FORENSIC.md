# T21R-C2S — Offline schema-boundary forensic and safe diagnostic

Repository `vn-tak/Tako-san` / `1385308553`. Branch
`codex/t21rc2s-schema-forensic` starts at fetched, verified certified main
`b9bc66acfe660329103c08be1f5cff90ed175aba`. No unrelated concurrent work was merged or rebased.
Verified implementation checkpoint: `946a7be`. Draft
[PR #41](https://github.com/vn-tak/Tako-san/pull/41) records the final
docs-inclusive head and its fresh exact-head CI receipt; this packet cannot
self-reference its own commit hash.

## Source evidence and authorization boundary

The task packet supplies independently verified production run `37158525748`,
attempt 1, head `b9bc66acfe660329103c08be1f5cff90ed175aba`, actor `vn-tako4`:
gate, normal approval, identity, capture and cleanup PASS;
snapshot `OBSERVED_STABLE_NON_ATOMIC`; classification
`T21RC2_CLASSIFICATION_SCHEMA_REJECTED`; artifacts 0.
No production log, row, manifest or artifact was fetched in this task.

This establishes completed reconciliation followed by failed schema validation,
not production/V1 divergence. The older generic rejection in run `37135187427`
does not supersede the newer schema-stage evidence.
`PRODUCTION_DATA_RELATION_TO_V1=UNKNOWN` and
`PRODUCTION_REPAIR_NEEDED=UNDETERMINED` remain unchanged.
The exact historical production condition is not independently established by
the synthetic reproducer below.

## Confirmed offline classifier/schema defect

Category: `T21RC2S_ROOT_CAUSE_CLASSIFIER_SHAPE_BUG`.
Contract code: `T21RC2S_TARGET_UNIQUE_CANDIDATE_CARDINALITY`.

Minimal synthetic case: one captured recipe, one target occurrence, one exact
production counterpart and one valid same-recipe unknown-ID occurrence.
The engine retains the unresolved occurrence in the target candidate graph but
previously copied the exact witness's `SATISFIED_EXACT` / `UNIQUE` assignment.
The resulting target has two candidate keys. The unchanged schema requires
exactly one candidate whenever target mapping is `UNIQUE`.

The same defect occurs with an exact witness plus an unapproved cross-ID content
conflict. A balanced exact tuple beside a different same-ID drift tuple also
previously inherited broad identity links into its unique target witness.
These are candidate-publication variants of one contract defect, not aggregate
or digest failures.

### Certified-main proof before the fix

A credential-free Node process loaded the original classifier, receipt and
private-file modules directly from `git show origin/main:<path>` through a
process-local native module hook. The schema bytes were still identical to main.
Only synthetic rows and proof values were used; no checkout or production
execution was performed.

| Synthetic case | Schema | Aggregate | Digest |
| --- | --- | --- | --- |
| Exact counterpart alone | PASS | PASS | PASS |
| Exact counterpart plus unknown identity | `T21RC2_CLASSIFICATION_SCHEMA_REJECTED` | PASS | PASS |
| Exact counterpart plus cross-ID content conflict | `T21RC2_CLASSIFICATION_SCHEMA_REJECTED` | PASS | PASS |

`BASE_MAIN=b9bc66acfe660329103c08be1f5cff90ed175aba` and
`REPRODUCER_ON_BASE=FAIL` are thus demonstrated against original module bytes,
not inferred from a generic classification error.

### Minimal correction

The closed schema is unchanged. A target cannot retain a unique satisfied
assignment when unresolved identity or explicit content-conflict candidates
compete: it becomes `AMBIGUOUS` / `UNRESOLVED` / `REVIEW_REQUIRED` and keeps all
candidate keys. Production classifications and occurrence accounting remain
intact.

Broad same-ID drift links are not matching exact-tuple witnesses. For an otherwise
valid unique assignment, target publication contains only the satisfying exact
or reviewed-bridge witness. The broader relationships remain in production
evidence, and unmatched/ambiguous targets retain their candidates. This preserves
the existing P1 A3 contract: one balanced exact tuple remains satisfied while a
different unmatched tuple remains ambiguous. No existing regression was weakened.

## Static shape and reachability audit

All generated properties were compared with required/optional status, types,
nullability, enums, patterns, numeric/array bounds, uniqueness and closed-object
rules, including `allOf`/`if`/`then` and reviewed-authority `contains` rules.

| Generated section | Closed contract examined |
| --- | --- |
| Root | 13 required properties; evidence-only constants; no extra fields |
| `captureEvidence` | Three required fields; completeness enum; nullable safe-integer counts |
| `production[]` | 14 fields; nullable IDs/reasons/drift/hash; occurrence-key pattern; all ten classes; comparison flags; authority enum/uniqueness; unique-candidate and bridge/drift conditionals |
| `target[]` | Nine fields; four classes; non-null IDs; candidate-key uniqueness; unique-candidate and reviewed-authority conditionals |
| `recipes[]` | 15 fields; status enum; nonnegative counts; closed class-count objects |
| `summary` | 14 fields; nonnegative counts; boolean roster comparison; nested closed summaries |
| `summary.accounting` | Four class-sum/accounting properties |
| Production/target class counts | Ten/four fixed nonnegative count properties |
| Populations/identity populations | Three/six fixed nonnegative count properties |
| Drift breakdown | 12 fixed nonnegative count properties |
| Largest drift recipes | Catalog ID and count; at most ten records |
| Conflict occurrence keys | Production-key pattern and unique items |
| Baseline comparison | Six fixed nonnegative count properties |
| `authorityProof` | Eight properties; catalog release ID, hashes, nonnegative bridge count; null only in pure classifier fixtures |
| `digests` | Three SHA-256-pattern properties |

No other generated-shape mismatch was confirmed. Static enum equality alone is
not the reachability proof: the deterministic corpus separately validates
supported combinations across exact/drift/bridge/production-only/duplicate/
malformed/conflict/ambiguous states and all target classes.

## Safe schema diagnostic

The runtime implementation stays inside existing review-bound files. The receipt
module preserves `validateT21RC2ManifestSchema(...)`; its closed-schema boundary
and private error-category creation share a lazy validator in
`scripts/t21rc2-production-files.mjs`. Ajv remains the lockfile's ESLint-owned
6.15.0 with `allErrors:false` and `jsonPointers:true`; no dependency changed.

Only a real validator failure can brand an error. Caller-provided section, field,
keyword, code, message, path or diagnostic objects cannot create that category.
The private mapper snapshots each inspected Ajv property once. It never copies
message, data, params, parent schema, exception/cause, stdout or stderr.

Known schema locations, including Ajv's relative referenced-definition paths,
are matched against fixed static property paths and numeric array slots. Indices
are used only internally and are never emitted. Conditional and `contains`
locations are included. The first returned Ajv error determines the fingerprint;
an invalid nullable value may therefore identify the first null-branch type rule.
Validation pass/fail and short-circuit behavior are unchanged.

Public fields are exactly `section`, `field`, `keyword`, `code`. Section vocabulary:
`root`, `captureEvidence`, `production`, `target`, `recipes`, `summary`,
`authorityProof`, `digests`, `unknown`. The explicit field vocabulary contains the
118 static manifest property names in `T21RC2_SCHEMA_DIAGNOSTIC_FIELDS`;
`unknown` is also a real populations property. The keyword vocabulary is:
`type`, `required`, `enum`, `pattern`, `minimum`, `maximum`, `minLength`,
`maxLength`, `minItems`, `maxItems`, `uniqueItems`, `additionalProperties`,
`const`, `oneOf`, `anyOf`, `allOf`, `if`, `contains`, `unknown`.

Codes are generated only from those known static schema locations. For example,
the reproduced cardinality violation maps to:

```json
{
  "section": "target",
  "field": "candidateProductionOccurrenceKeys",
  "keyword": "maxItems",
  "code": "TARGET_CANDIDATE_PRODUCTION_OCCURRENCE_KEYS_MAX_ITEMS"
}
```

An unmapped rule produces `section:unknown`, `field:unknown`, a known keyword or
`unknown`, and `code:UNKNOWN_SCHEMA_CONTRACT`. Unbranded caller errors yield the
fully unknown fingerprint, regardless of forged metadata.

The existing failure receipt embeds the fingerprint only at stage `schema`.
The existing error-recording surface logs `t21rc2_schema=<safe JSON>`; the CLI's
fixed `t21rc2=T21RC2_CLASSIFICATION_SCHEMA_REJECTED` line remains. No raw path,
index, ID, name, quantity, unit, optional value, occurrence key or manifest
fragment is exposed. No failure upload or new artifact is introduced.

## Preserved authority and limitations

Capture execution, the SQL allowlist and 11-read sequence, identity/stability/
ledger/roster/write guards, Wrangler parsed stdout, production workflows and C4I
execution files are unchanged. Schema, certified V1 authority, package/lock,
frontend, auth, payments, T19/T20 runtime and migrations are unchanged.

All 73 C2 review-bound entries remain. Changes to the classifier and diagnostic
bytes intentionally invalidate old reviewed head
`95b1746819c4690d267985ce55cb0ba673373a95`; renewed exact-head review is required.
Nothing is removed from or exempted from the closure.

A separate offline finding is recorded, not repaired here: aggregate validation
does not rederive the six `baselineComparison` counts. A schema-valid synthetic
mutation with refreshed digest can therefore pass those validators. This is not
a schema-only rejection and cannot explain the current production-stage failure.
It requires separate scoped aggregate-hardening review.

Production C2/C4I runs, D1 SQL reads/writes, mutations, secret/token changes,
migrations and deploys in this task are all zero. Required migration smoke is
in-memory SQLite only, not a D1 or production migration.
`0039_APPLIED=NO`, `TOKEN_SCOPE_READ_ONLY_PROVEN=false`, `TOKEN_SCOPE=UNKNOWN`,
`REPAIR=NOT_AUTHORIZED`, `T21G=T21G_NOT_READY`, `0039=STOPPED`, `DEPLOY=STOPPED`.

## Verification checkpoint

Certified-main baseline: the six required C2 suites passed 6 files / 375 tests.
The final focused command is:

```sh
TZ=UTC pnpm exec vitest run --maxWorkers=1 \
  tests/unit/t21rc-row-reconciliation.test.mjs \
  tests/unit/t21rc2-classification-diagnostics.test.mjs \
  tests/unit/t21rc2-production-capture.test.mjs \
  tests/unit/t21rc2-production-receipt.test.mjs \
  tests/unit/t21rc2-production-approval.test.mjs \
  tests/unit/t21rc2-workflow.test.mjs \
  tests/unit/t21rc2-schema-boundary.test.mjs \
  tests/unit/t21rc2-schema-diagnostic.test.mjs
```

Result: **8 files / 420 PASS** (57, 63, 79, 8, 148, 21, 9, 35 respectively).
The corpus has 25 explicit classification scenarios and nine malformed-row
cases, all ten production/four target classes, mixed scale structures and
exact/bridge competitor plus retained A3 regressions. Diagnostic tests verify
118 field names, 19 keywords, actual first-error mappings, unknown fallback,
private-context/accessor redaction, repeated-byte determinism and the real CLI.

| Exact final local check | Result |
| --- | --- |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS |
| `pnpm check:migrations` | PASS, in-memory SQLite |
| `pnpm build` | PASS |
| `TZ=UTC pnpm exec vitest run --maxWorkers=1` | PASS, 237 files / 5429 tests, exit 0, 676.74 seconds |
| `git diff --check` | PASS |

Environment: Node 24.21.0, pnpm 10.31.0, Vitest 3.2.7, ESLint-owned Ajv 6.15.0.
No dependency version was changed. Initial code-head PR CI run `37162475111`,
job `111318594830`, event `pull_request`, attempt 1 succeeded at `946a7be`.
It is not reused as the final documentation-head CI authority: that fresh
receipt belongs in PR #41 after publication of the final head.

Interim failures are retained: initial corpus `.ts` imports caused TS7016;
conversion to existing `.mjs` conventions removed the problem without declaration
suppression. An overbroad ambiguity guard failed retained P1 A3; distinguishing
matching witnesses from broad drift links fixed it without changing the assertion.
The test-only native loader's newline escaping caused a pre-CLI SyntaxError and
was corrected; the real CLI regression now passes. One auxiliary C2D stress
timeout under concurrent load recovered in standalone/final focused runs, without
timeout-threshold changes. The first full-suite invocation hit the shell's
600-second deadline (exit 124, 166 completed files, no overall success claim);
the unchanged UTC one-worker command completed with an 1800-second budget.

Runtime bytes and schema/compiler validation order were reviewed; no unresolved
internal implementation finding remains. The separately documented aggregate
gap is unchanged and does not explain a schema rejection. Source workflows,
SQL/capture/V1/C4I/protected application paths were diff-checked unchanged.
Old C2 binding to `946a7be` rejects as expected with all 73 entries retained.

Auto-fix subscription is enabled for PR #41 and can modify the branch; no
auto-merge request exists and the PR remains draft. Independent review must pin
the exact immutable final head after its attempt-1 CI succeeds. A later automated
commit voids review authority on the earlier head and requires another freeze.
Do not merge, rerun C2/C4I, repair production, use Cloudflare credentials, apply
0039 or deploy.
