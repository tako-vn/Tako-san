# T21R-C — Protected row-level reconciliation evidence

Status: `T21RC_REMEDIATION_READY_FOR_REVIEW`. This is an offline evidence contract,
not repair, a release certification, or authorization for another production read.
`T21G_NOT_READY`; repair, 0039 and production deployment remain stopped.

## P1 remediation delta — 2026-10-02 UTC

Reviewed head: `32ab51d35976e5174f73a544729f8bd7fd20e02c`; repository
`1385308553` / `vn-tako4/Tako-san`. Only the two requested P1s are addressed.

- **A:** Exact target satisfaction now explicitly gates on
  `exactTupleMultiplicityMatch = liveTuple.length === exactContent.length`
  **and** identity membership. A deficient identical target bag stays wholly
  ambiguous; balanced duplicates remain `MULTISET_ONLY` / `REVIEW_REQUIRED`,
  with no physical pairing. Pre-edit A1/A2 already returned all target members
  ambiguous, and A3 left the 4 g target ambiguous on this exact reviewed head;
  the delta makes that existing gate explicit and adds dedicated regressions,
  rather than claiming an observed false-satisfaction repro.
- **B:** Raw certified V1 IDs take precedence over reconciliation rewriting.
  Before editing, B1/B3 reproduced `PRODUCTION_ONLY_KNOWN_ID` plus
  `TARGET_ONLY_MISSING`. Bridge lookup is now skipped only for `v1Ids`;
  registry-known non-V1 sources still bridge normally. Existing strict
  existing-canonical/reviewed-new predicates remain unchanged.

Executed remediation checks:

- `pnpm exec vitest run tests/unit/t21rc-row-reconciliation.test.mjs --maxWorkers=1`:
  PASS, 57/57, including all six A1–A3/B1–B3 cases.
- `pnpm exec vitest run tests/unit/t21rb-v1-semantic.test.mjs tests/unit/t21rb-v1-production.test.mjs tests/unit/t21rc-row-reconciliation.test.mjs --maxWorkers=1`:
  PASS, 3 files / 73 tests; balanced/deficient duplicates and strict bridges retained.
- `pnpm lint`, `pnpm typecheck`, `pnpm check:migrations`, `pnpm build`,
  `git diff --check`: PASS; migration smoke is throwaway in-memory SQLite only.
- `pnpm exec vitest run --maxWorkers=1`: PASS, 226 files / 4,963 tests,
  678.21 seconds. Syntax and focused-test formatting also PASS.

Taxonomy, schema, name authority, position exclusion, privacy and repair
boundaries are unchanged. Historical evidence and earlier checks below are
preserved. Independent delta review is still required: no merge or production
dispatch preparation approval; `T21G_NOT_READY`, 0039/deploy/repair STOPPED.
Existing two-worker timeout and dependency advisories remain separate and
unchanged; no retry/tuning, upgrade or re-audit in this remediation. One appended
remediation commit and a normal push of this branch are authorized by this
packet; its exact commit/publication SHA is verified through Git, not embedded
in its own report. No PR, workflow dispatch or production operation is authorized.

## Repository and source authority

- Stable repository ID: `1385308553`; resolved repository: `vn-tako4/Tako-san`
  (public). Source diagnostic main and starting workspace HEAD:
  `a828b6354e29d89268a3d11c874158eb5ecb997c`.
- `git fetch origin --prune` completed before implementation. HEAD and
  `origin/main` were identical, ahead/behind `0/0`, on the managed thread branch
  `hoplite/kos-e295af59`. There were no tracked changes; existing untracked
  `.context/` was preserved. One worktree; no reset or forensic-workspace change.
- Implementation branch: `codex/t21rc-row-level-reconciliation`, created directly
  from verified `origin/main`. No main changes needed compatibility inspection.
  No push, PR, merge, workflow dispatch, production query or infrastructure change.
- [T21R-A target](T21RA_RUNTIME_CANONICAL_TARGET.json) and
  [certification](T21RA_RUNTIME_CANONICAL_AUTHORITY_CERTIFICATION.md) remain
  unchanged: V1 release `rel-bd00a4f53fcaeee4`, ordered 500 recipes, 2,702 ingredient
  occurrences, runtime fingerprint `f8cf8c7ff59df9fe29e246b9e3c9aad0fd155fa8df35bf671ac4d03fa2b5ab37`.
  V2 research content is **not** a production release authority.

The shared `scripts/t21r-v1-authority.mjs` recomposes the 71 static recipes and
reviewed 30/399 batches, checks registry/manifest hashes against T21R-A, verifies
immutable migration bytes without executing them, and requires byte-equal release
composition/fingerprint and target occurrence count. Contradiction stops with
`T21RC_AUTHORITY_CONTRADICTION`. It also preserves the T21R-B offline CLI's
existing output contract. It never reads a database.

## Accepted T21R-B live aggregate evidence

GitHub GETs and the four already-sanitized artifacts confirm run
[`36943692146`](https://github.com/vn-tako4/Tako-san/actions/runs/36943692146),
attempt 1: `gate=SUCCESS`, `diagnose=SUCCESS`, `head_branch=main`, repository ID
`1385308553`, source SHA above. Exact-main CI
[`36933387793`](https://github.com/vn-tako4/Tako-san/actions/runs/36933387793)
also succeeded at that SHA. These facts supersede the earlier repository
handoff's pre-dispatch state; they do not invalidate its safety boundaries.

| Artifact | ID | GitHub archive SHA-256 |
| --- | --- | --- |
| `production-t21rb-v1-36943692146-1` | `11201426994` | `8eb2e33994288d69940a25bd301c7ade19bb5ea5244ffc91e111c7309fe076cd` |
| `production-d1-diagnostics-36943692146-1` | `11201461916` | `c213160a601de48e153ff5e64d6367793788ac7b638f8475403c9b53b4c43eba` |
| `production-catalog-v2-lineage-36943692146-1` | `11200524989` | `4e3176a16e7e534389e044b845a0f37edf44d452c1e9da95baeee459fad6221b` |
| `production-catalog-lineage-36943692146-1` | `11201660706` | `d4e689782dc9132165bee29ee5250d2a4102b5fd6f3e50c7d63330a4c3f527fb` |

Artifact IDs, names, digests and unexpired status were checked against GitHub
metadata and the attached task. The downloaded JSON receipts were inspected;
archive bytes were not separately hashed. Archive digests are not hashes of the
extracted JSON files. Downloads remain ignored and local under
`.hoplite/artifacts/t21rc-source/`; nothing was republished.

| Observation at that run | Value |
| --- | --- |
| Database | `frigo-db` / `f975ec39-b2c8-4a2a-80e1-0366054599d3` |
| Recipes / ingredient occurrences | 500 / 6,720 |
| Order rows / hydrated recipes | 0 / 0 of 500 |
| Ledger | 38 entries through `0038_auth_onboarding_completion.sql`; 0039 absent |
| V1 exact semantic multiset matches / bridged matches | 26 / 0 |
| Unmatched production / V1 target occurrences | 6,694 / 2,676 |
| Same-ID content drift / ID-conflict review | 1,793 / 20 |
| Capture consistency | `OBSERVED_STABLE_NON_ATOMIC`, **not atomic** |
| V2-relative matches / content conflicts / production-only | 596 / 1,475 / 4,649 |

The 6,694 unmatched occurrences are not 6,694 bad rows. Production-only does
not mean removal, and same ID does not mean equal semantics. V2-relative counts
cannot become V1 classifications. The sanitized source artifacts contain no
complete occurrence snapshot: **no live T21R-C row population has been classified**.
The 1,793 drift cases, 20 conflicts and per-recipe live breakdowns remain pending
a separately authorized stable capture; no fixture can stand in for that receipt.

### Separate governance exception

`DATA_EVIDENCE=ACCEPTABLE_FOR_REVIEW`,
`ENVIRONMENT_APPROVAL_PATH=ADMIN_BYPASS`, `GOVERNANCE_EXCEPTION=YES`.
The attached task records actor/browser `vn-tako4` using **Start all waiting jobs**
and **I understand the consequences**, instead of approval by required reviewer
`vn-taphoanhatung`. The run's GitHub review-history GET corroborates reviewer
`vn-tako4`, state `skipped`, environment `production`, no comment. This was not
normal required-reviewer approval. The exact browser interaction remains
user-provided, not independently reproduced.
Do not discard the read-only data because of this documented exception.

Current repository-scoped GETs report reviewer `vn-taphoanhatung` (write access),
`prevent_self_review=false`, `can_admins_bypass=true`, and repository administrator
`vn-tako4`. Recommend a separately approved operator policy enabling self-review
prevention, disabling admin bypass, and retaining a genuinely independent trusted
reviewer with backup availability. Do not substitute self-approval merely to make
the real operator's run proceed. No settings were changed. See
[GitHub environment policy](https://docs.github.com/en/actions/deployment/targeting-different-environments/managing-environments-for-deployment).

Normal required-reviewer approval is mandatory for any future T21G repair,
migration or production deployment; admin bypass is forbidden. A read-only
emergency exception can only be separately documented, not presumed here.
The future protected T21R-C path must use normal independent approval and must
not rely on the previous exception.

## Offline row-evidence contract

Implementation: `scripts/t21rc-row-reconciliation.mjs`. The pure function accepts
trusted target/registry/reconciliation inputs and untrusted captured occurrences.
The file-only CLI pins the trusted side through the shared V1 loader:

```sh
node scripts/t21rc-row-reconciliation.mjs --input <saved-minimal-occurrences.json>
```

The input envelope contains `recipeIds`, `occurrences` and optional
`captureCounts: {recipeCount, ingredientOccurrenceCount}`. It cannot
select V2 as the target or supply operator-written SQL. Unknown input fields are
rejected, rather than silently copied into evidence. Counts must be nonnegative
safe integers matching both complete arrays; mismatch stops classification.
Missing/null count metadata yields `UNVERIFIED`, ambiguous membership/absence,
and no exact-class certificate. Count equality is only
`COUNT_CONSISTENT_OFFLINE_INPUT`, not evidence of live origin, stability or
authenticity. The future producer must obtain independent server-side counts
and verify the complete reads; an operator-written number is not a live receipt.
Invalid occurrence values are classified without coercion. Text bounds follow
`CatalogTextSchema` after trimming for validation only; semantic spelling is
never trimmed or normalized. The normative contracts are positive finite
quantity below `1e308`, canonical ingredient ID and catalog recipe-ID vocabulary,
closed standard units and raw D1 optional bit 0/1. Basis: foundation schemas,
import normalization, runtime hydration and the existing forensic comparator;
the looser finite-only presentation schema is not the only runtime contract.

| Runner-local field | Necessity |
| --- | --- |
| Captured recipe ID set | Recipe membership, parent validation and T19 identity invariants |
| Independent captured recipe/occurrence counts | Detect omitted rows/parents and support complete-snapshot membership/absence; aggregate metadata, not an extra row field |
| `id` | Physical occurrence discriminator and duplicate-PK observation; never runtime authority |
| `recipe_id` | Restrict every counterpart to its own recipe |
| `ingredient_id` | Canonical identity, registry membership and strict bridge lookup |
| `name` | Exact released semantic label is certified by T21R-A; label drift and conflict comparison |
| `required_quantity` | Exact quantity comparison; no conversion or rounding |
| `unit` | Closed-unit validation and exact unit comparison |
| `is_optional` | Required raw 0/1 observation; null/strings/booleans do not become false |

No provenance/version, timestamps, recipe titles, steps, nutrition rows, user,
household, authentication, inventory, shopping or meal-plan data are needed.
Position is excluded from the minimum capture. An existing saved fixture may
include `position`; the classifier ignores it, including in digests.
`runtimePositionAuthority=false`; no missing or different position is a repair
defect, and target array order cannot authorize a physical-row order.

Names remain runner-local because exact V1 equality includes their released
spelling. The manifest exposes `name` comparison flags, never name text, quantities
or raw physical IDs. Import alias suggestions/normalized labels do not authorize
a live cross-ID bridge or substitute a new spelling for the V1 release.

## Exact classification model

All comparisons are recipe-local. Authoritative dimensions are recipe ID,
canonical ingredient ID, released name, quantity, unit, optional and membership/
multiplicity. Raw ID equality is reported separately from canonical identity
equality after an approved bridge. Position and physical PK are never dimensions.

| Production primary class | Necessary evidence and limits |
| --- | --- |
| `EXACT_V1_MATCH` | Raw ID and every content dimension equal; identity-group and exact-tuple multiplicities equal. Balanced identical bags establish semantic multiset parity only, not a unique physical pairing. |
| `SAME_ID_CONTENT_DRIFT` | Same recipe/raw canonical ID with content or membership/multiplicity divergence. Every dimension is a boolean or null if candidates disagree; drift is not proof of corruption. A unique comparison is evidence, not authority to overwrite. |
| `DETERMINISTIC_V1_COUNTERPART` | Unique mutual `existing_canonical_id` bridge, exact content tuple, equal membership and exactly one production/target tuple occurrence. Existing contract requires distinct nonempty source/canonical IDs and `review=null`. |
| `REVIEWED_ID_BRIDGE` | Same unique occurrence/content requirements, using `reviewed_new_canonical_id`, `ING_ENR_` canonical ID and exact nonempty `{basis,evidenceReference}` review object. |
| `PRODUCTION_ONLY_KNOWN_ID` | Valid occurrence; identity is in V1 or the approved canonical registry, with no supported V1 occurrence/content counterpart in this recipe. Legitimate enrichment remains possible. |
| `PRODUCTION_ONLY_NEW_ID` | No supported V1 occurrence; genuinely admitted new identity proved by the strict reviewed-new contract. A prefix or provisional V2 entry is insufficient. |
| `DUPLICATE_SEMANTIC_OCCURRENCE` | More production occurrences of one authorized semantic tuple than target multiplicity. All indistinguishable members receive this evidence class; no physical member is arbitrarily chosen as excess. |
| `MALFORMED_OCCURRENCE` | Specific schema/forensic contract violation, including invalid required fields, quantity/unit/optional, broken captured parent or duplicate physical IDs. It is not a removal instruction. |
| `ID_CONFLICT_REVIEW_REQUIRED` | Same-recipe exact content tuple under another target ID without a unique authorized bridge. Emit candidate keys/IDs, all comparison flags, examined authority sources and a reason; text resemblance alone never resolves identity. |
| `AMBIGUOUS` | Unknown/unreviewed identity, competing reviewed occurrences, bridge/content disagreement or malformed-context contamination prevents an authorized classification/mapping. Never guess. |

Current reconciliation has 2,515 entries: 505 existing, 1,642 provisional and
368 duplicate aliases; every `sourceId=null`, reviewed-new count zero. It grants
**zero current bridges**. The two bridge classes exercise existing strict
contracts with synthetic tests; they do not manufacture a production mapping.

| Target class | Meaning |
| --- | --- |
| `SATISFIED_EXACT` | Balanced exact semantic occurrence/bag accounted for by exact production evidence. Duplicate physical mapping remains unknown. |
| `SATISFIED_DETERMINISTICALLY` | One unique production counterpart satisfying an approved bridge and all V1 content dimensions. |
| `TARGET_ONLY_MISSING` | No supported counterpart under the complete current approved rules, and no unresolved/malformed occurrence prevents absence proof. Not permission to insert. |
| `AMBIGUOUS` | Content/identity/multiplicity divergence, candidate competition or unknown/malformed evidence prevents satisfaction or absence proof. Present-but-divergent is not silently called missing. |

Unknown or malformed ingredient identity can conceal a counterpart. Malformed
data taints its recipe; an unlocatable/broken parent taints the whole capture's
membership proof. Those rows are retained and counted, but no false absence or
exact membership certificate is issued. Exact, balanced duplicate bags are
`MULTISET_ONLY` with `REVIEW_REQUIRED`; deficits and excesses do not choose a
target/production member by physical ID. No action class or repair SQL exists.

## Accounting, deterministic evidence and ambiguity budget

- Every production input occurrence has exactly one primary class and unique
  opaque handle. Class sum must equal the observed input count (last live count
  6,720); every target occurrence is accounted once (certified count 2,702).
  Failure stops output. Per-recipe class maps retain all classes; unlocatable
  production rows have a separate counted population.
- Canonical serialization uses code-point key ordering, recipe ID then opaque
  occurrence key; no natural SQLite order, locale-dependent comparison, clock,
  random salt, AI or network affects semantic classification. Physical handles
  use domain-separated SHA-256 of recipe/physical ID plus a deterministic copy
  ordinal for invalid duplicate IDs. Target handles hash semantic tuples and
  multiset ordinals, not physical target positions. These are pseudonyms, not
  encryption or authority.
- `occurrenceSha256` covers sorted selected raw fields and recipe IDs, including
  physical observations. `semanticSha256` covers valid raw V1-shaped tuples as
  a multiset, excluding physical IDs/position. `classificationSha256` covers
  capture completeness, sanitized production/target records, recipe summaries and accounting. Source
  proof digests are separate; none certifies a live or atomic snapshot.
- Row confidence is categorical only: `DETERMINISTIC`, `REVIEW_REQUIRED`,
  `UNKNOWN`; certified release proof is separate. Production confidence population totals are
  disjoint; target review population is explicit in target classes. Even a
  deterministic difference is not an approved repair.
- Identity populations separate V1 IDs, approved non-V1 IDs, reviewed new IDs,
  unreviewed `ING_ENR_` observations, unknown IDs and malformed occurrences.
  No population is hidden inside a single unmatched total.
- Drift separates `quantity_only`, `unit_only`, `optional_only`, `quantity_unit`,
  `quantity_optional`, `unit_optional`, `multi_field`, `membership_only`,
  `membership_plus_content`, plus certified `name_only`, `name_plus_semantics`
  and indeterminate comparisons. Report affected recipe count and largest ten
  recipes by drift count, with stable ID tie-breaks.
- `baselineComparison` preserves a separate raw semantic-multiset comparison
  for aggregate interpretation. Its exact count can exceed the stricter primary
  exact class when identity multiplicity differs. Do not assign the old 26
  aggregate matches to particular physical rows or hardcode any live count.
- Each conflict record carries recipe ID, production ID, candidate target
  ID/keys, comparison flags, `V1_RELEASE`/`REVIEWED_RECONCILIATION` authority and
  the failed unique-bridge reason. No name upload is necessary for this first
  manual-review packet. The eventual 20 live records cannot be fabricated now.
- A non-satisfied same-ID drift/duplicate can also have a different-ID exact
  content candidate. Retain both in the candidate graph with
  `ALTERNATE_IDENTITY_CONTENT_CONFLICT`; no bridge or unique pairing is granted.
  `idConflictOccurrenceKeys` is a non-exclusive review index including these
  secondary conflicts. Primary class counts and the old raw aggregate remain
  separate, so this index must not be assumed to equal the source run's 20.

Recipe statuses use evidence, not percentages: `EXACT_V1_PARITY` means all
production/target semantics satisfied exactly; `DETERMINISTICALLY_RECONCILABLE`
means all accounted by exact/approved unique bridges with at least one bridge;
`AMBIGUOUS` means an unresolved target, identity, malformed context or duplicate
mapping remains; `PARTIALLY_RECONCILABLE` has a satisfied subset and only explicit
known/new production-only or target-only populations remaining;
`SEVERELY_DIVERGED` has no satisfied subset and no unresolved classification.
These labels do not predict an operation or enable T21G.

## Protected production read design — not implemented or dispatched

The offline tests passed before preparing this section. Reuse the **Production
D1 Read-Only Diagnostics** exact-main/CI/Environment/account/database guards,
but introduce a separately reviewed, explicit opt-in T21R-C capture path; do
not automatically expose row evidence on every existing diagnostic run.
`.github/workflows/production-d1-diagnostics.yml` is unchanged in this task.
There is no new production-executable wrapper or dispatch flag here.

The proposed allowlist is the following fixed statements, reviewed together
with their field contract; no arbitrary operator SQL/file/WHERE input:

```sql
SELECT id FROM recipes ORDER BY id;

SELECT id, recipe_id, ingredient_id, name, required_quantity, unit, is_optional
FROM recipe_ingredients ORDER BY recipe_id, id;

SELECT (SELECT COUNT(*) FROM recipes) AS recipe_count,
       (SELECT COUNT(*) FROM recipe_ingredients) AS ingredient_occurrence_count;

SELECT name FROM d1_migrations ORDER BY name;
```

Physical-ID ordering only makes capture transport reproducible; it has no
semantic or runtime-position authority. No steps, nutrition, order table,
parent provenance, user, household, shopping, inventory or plan table is read.

Future producer sequence, all fail-closed:

1. Require repository ID `1385308553`, reviewed immutable current-main SHA `S`,
   exact-`S` CI success, byte-pinned V1 source proof and explicit read-only
   authorization. Recheck main before any credential-bearing step and at final
   publication; a change invalidates this authorization packet, not the old
   T21R-B evidence anchored to its own SHA.
2. Require normal independent production Environment approval. Before exposing
   Cloudflare credentials or reading D1, inspect workflow approval history and
   require `state=approved`, environment `production`, the configured required
   reviewer and no self-approval. Missing history, `skipped`/bypass, wrong reviewer
   or changed reviewer policy stops. The historical run's `skipped` result must
   fail this future guard. Governance configuration changes are a separate
   operator decision; none was performed here.
3. Preserve the existing Cloudflare-account and `frigo-db` database-ID proof.
   Inspect least-privilege token scope independently: fixed SELECT-only code is
   not proof that the underlying credential itself lacks write permission. No
   credential is attached to classification or artifact steps, echoed or uploaded.
4. Read ledger L0 and independent counts C0; capture complete recipe IDs and
   require the reviewed V1 ID set before fetching ingredient names. An unexpected
   parent universe requires a new scope/privacy decision, not a silent read of
   potentially user-generated recipes. Capture occurrence rows A; read counts
   C1 and ledger L1. Repeat counts/capture/counts
   for B (C2, B, C3), then ledger L2. Every result must be successful/complete;
   prohibit silent paging truncation or dropping malformed rows. C0–C3 must be
   equal and match both arrays in A and B. A supplied offline count is not a
   substitute for these independent server observations.
5. Require L0=L1=L2 and exact equality to the reviewed 38-name migration prefix
   ending `0038_auth_onboarding_completion.sql`. Any 0039 or other unexpected
   migration stops. Equal tips/counts alone are insufficient.
6. Compare deterministic complete occurrence digests and semantic digests for
   A/B, including physical observations and recipe IDs; any difference stops
   before classification/publication. Equal observations establish only
   `OBSERVED_STABLE_NON_ATOMIC`: intervening writers/ABA changes and a transaction-
   coherent snapshot are not ruled out. Do not promote this to atomic.
7. Run the credential-free classifier on the verified minimal input; require
   `COUNT_CONSISTENT_OFFLINE_INPUT`, exact accounting, schema validation, source
   proof and bound per-recipe/conflict/ambiguity populations. Bind an outer receipt
   to `S`, repository/database identity, run/attempt, approval path, ledgers,
   counts and input/classification digests. The classifier alone is not that
   live receipt. Changed production counts are recorded as new observations with
   mandatory review, never silently forced to 6,720; changed V1 target proof
   remains `T21RC_AUTHORITY_CONTRADICTION`.
8. Recheck exact main and publication authorization. On any failure, upload no
   row manifest and do not continue with a partial repair candidate.

### Artifact privacy and audience

| Data | Default handling |
| --- | --- |
| Raw captures, names, quantities, physical IDs, credentials | Runner-local only; no logs, repository commit, upload or automatic attachment |
| Minimal sanitized manifest: occurrence handles, recipe/semantic IDs, flags, classes, reasons, source references | Runner-local by default; delivery only after independent privacy approval of an explicitly restricted audience |
| Counts, recipe summaries, semantic/classification digests and guard receipt | Aggregate review artifact only after all guards and final SHA check succeed; digest scope/limitations explicit |
| Optional names needed for manual conflict review | Separate private, narrowly scoped operator decision; not all 6,720 names in an Actions artifact |

This repository is public. Approved V1 catalog source is checked in, but that
does **not** establish that production-only enrichment identities are public
intellectual property. A GitHub artifact called "protected" is not an access
control: [artifact downloads require repository read access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).
Do not automatically upload the row manifest to this public repository's
Actions. Independent approval must establish a suitable restricted delivery
route or explicitly approve publication of the allowlisted evidence. No private
storage, publisher or permission change was configured here. Source aggregates
downloaded for this task were not republished.

GitHub approval-history contract:
[REST workflow runs](https://docs.github.com/en/rest/actions/workflow-runs#get-the-review-history-for-a-workflow-run).
Read-only emergency exceptions require separate documentation; T21R-C normal
approval is the proposed path. Admin bypass is forbidden for T21G repair,
migration and production deployment in every case.

## T19/T20 blast-radius dimensions — documentation only

No application, household isolation, inventory command, Week compatibility,
stored composition, role, eligibility, shopping or nutrition code/data changed.
Relevant accepted contracts remain ADR-030 (T19 shared authority) and ADR-031
(T20 compositions), plus `MEAL_COMPOSITION_V2.md` and the T21R-A certification.

| Possible future dimension | Compatibility evidence required in T21G; not an operation proposed here |
| --- | --- |
| Recipe identity/visibility | Preserve the common API/planner/cooking/swap/shopping authority. Stored plans bind source, fingerprint and count; inspect reference availability and stale-plan revalidation/regeneration, preventing D1-only planner exposure, cooking 404 and shopping-authority mismatch. |
| Ingredient identity/membership/multiplicity | Inventory matching, component aggregation and shopping demand can change even with unchanged 500 recipe IDs. Inventory commands/tenancy/revisions remain untouched. |
| Quantity/unit/optional | Strict conversion, required shopping amounts and nutrition references can change; contextual package weights are not assumed. |
| Name/content/order/metadata | T20 roles derive from title/category/tags/ordered ingredients/cook time; compare effective roles and stored overrides. Current physical order is still not authorized by this evidence. |
| Recipe versions/nutrition links | Linked evidence must match recipe version; runtime macros do not certify allergy or hard nutrition safety. Unknown safety/time/hard nutrition stays fail-closed. |
| Stored compositions/components/roles | Component recipe references lack a recipe FK; role assignments can cascade on recipe removal. Inventory before/after references, eligibility, roles and all-component shopping projection in an isolated, separately approved rehearsal. |

The last reviewed production release kept T20 off, but this task did not query
today's flags. T20 compatibility remains partial; 0039 does not repair catalog
hydration. Do not infer a writer, enrichment replay, reset-to-V1, removal of
production-only rows, physical-ID rewrite or order-row insertion from any class.

## T21G gate and current limits

`T21G_NOT_READY` is unconditional for this task. A future independently reviewed
live T21R-C receipt must first prove all observed production occurrences and
certified target occurrences accounted, deterministic differences separated
from bounded review/unknown populations, destructive dimensions explicitly
separated from mere enrichment observations, and a calculable blast radius.
Stored-reference/nutrition/role implications and physical order need their own
proof; no destructive decision or repair SQL is produced here.

Outstanding prerequisites: a separately authorized stable complete row capture;
actual 1,793 drift/20 conflict/per-recipe breakdowns; independent human review of
classifier/schema/query/permissions/stability; normal reviewer approval; and
approved artifact audience/delivery. An agent review is not Environment or
mutation approval. No push or PR is authorized by this packet.

## Verification and checkpoint

Final checks and verified implementation checkpoint are recorded below. Earlier
review found and corrected mixed-tuple duplicate/deficit false absence,
unverified completeness and alternate-ID conflicts hidden by same-ID drift.
The final bounded agent re-review found no remaining issue in those cases.
The required local migration smoke writes only throwaway in-memory SQLite
fixtures (including its existing 0039 test); production operational SQL writes,
migration/0039 applies, restores, mutations and deployments remain **0**.

### Exact executed checks

| Command / check | Result at this checkpoint |
| --- | --- |
| `pnpm exec vitest run tests/unit/t21rc-row-reconciliation.test.mjs tests/unit/t21rb-v1-semantic.test.mjs tests/unit/t21rb-v1-production.test.mjs --maxWorkers=2` | PASS, 3 files / 67 tests: 51 T21R-C + 11 semantic + 5 production-wrapper |
| `node --check scripts/t21rc-row-reconciliation.mjs`, `scripts/t21r-v1-authority.mjs`, `scripts/t21rb-v1-offline.mjs` | PASS |
| `pnpm exec prettier --check tests/unit/t21rc-row-reconciliation.test.mjs docs/ai/recipe-catalog/T21RC_ROW_RECONCILIATION_SCHEMA.json` | PASS |
| Installed ESLint Ajv 6.15 schema compile + actual manifest/nominal-input checks | PASS, including unverified/malformed/duplicate/conflict/text-bound cases |
| `node scripts/t21rc-row-reconciliation.mjs --input .hoplite/artifacts/t21rc-validation/cli-input-final.json` | PASS, synthetic V1-shaped 500 recipes / 2,702 exact production and target occurrences, source proof and schema validated, bridges=0 |
| `node scripts/t21rb-v1-offline.mjs --input .hoplite/artifacts/t21rc-validation/t21rb-cli-input-final.json` | PASS, existing aggregate CLI compatibility, exact=2,702; position authority still false |
| `pnpm lint` | PASS, exit 0 |
| `pnpm typecheck` | PASS, both Web/shared and Worker, exit 0 |
| `pnpm check:migrations` | PASS, `migration-smoke=ok`, in-memory SQLite only |
| `pnpm build` | PASS, Web build and Worker type compilation, exit 0 |
| `git diff --check`, `git diff --cached --check` | PASS; task-owned diff reviewed including newly added files |
| `pnpm exec vitest run --maxWorkers=2` on frozen source | 226 files, 4,956 passed / 1 failed of 4,957; unchanged certification query-safety test timed out at its existing 5,000 ms deadline |
| `pnpm exec vitest run --maxWorkers=1` | PASS, 226 files / 4,957 tests, 837.08 seconds; lower concurrency only, unchanged assertions/timeouts |

First full attempt had a 600-second command limit (exit 124), an intermediate
fixture failure and two CLI-heavy timeout cases. A later attempt was interrupted
(exit 130) for the final reviewed candidate fix. Frozen two-worker run completed
in 538.83 seconds with the one certification timeout above. No unrelated test,
assertion, Vitest timeout or workflow was edited to mask these results. The
unchanged auth-route diagnostic run separately passed 39/39. Fixture updates
reflect required completeness and correct exact-content ID-conflict semantics,
not reduced coverage. Raw logs and synthetic inputs remain ignored/local.

The final single-worker run passed the entire unchanged suite, including the
certification query-safety and staging catch-up tests. Two-worker timeout
evidence remains above rather than being overwritten or called a pass.

### Dependency audit — separate existing findings

`pnpm audit --json` returned exit 1 with **33 existing advisories**: 4 low,
17 moderate, 12 high, zero critical/info. No dependency or lockfile was changed.
This is not a T21R-C classifier correctness failure or authority to upgrade
unrelated packages; remediation needs separate scope.

### Verified checkpoint and final authority

- Implementation: `ec24101` / `ec24101bd906b820d3a6ac29dcc179dd62a1d3fa`, verified local commit containing
  classifier, tests, source-proof reuse, schema and design report. This report's
  completion/state entries are a later documentation checkpoint, whose own hash
  cannot be embedded in itself; final Git output identifies that checkpoint.
- Final `git fetch origin --prune` still resolves main to
  `a828b6354e29d89268a3d11c874158eb5ecb997c`; no source-main move or compatibility rebase.
  One managed worktree; implementation was ahead 1 / behind 0 before the
  documentation checkpoint. Existing untracked `.context/` preserved.
- Verified diff against main has no changes in application/packages, migrations,
  workflows, production/staging Wrangler configuration, package manifest or
  lockfile. No protected PayOS/authentication/runtime paths changed.
- No push, PR, merge, production dispatch or row upload. Operational production
  mutations/SQL writes/restores/migrations/0039 applies/deploys/flag changes: **0**.
  Local fixture validation is explicitly distinct from production operations.
- Next: independent human review of the T21R-C classifier, schema and protected
  read/privacy/governance path before separately authorizing any further read.
  `T21G_NOT_READY`, `repairAuthorized=false`, 0039 and production deploy STOPPED.
