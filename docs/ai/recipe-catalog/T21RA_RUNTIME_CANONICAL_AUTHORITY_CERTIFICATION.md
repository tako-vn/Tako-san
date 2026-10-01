# T21R-A: Runtime canonical authority certification

Status: `T21RA_CANONICAL_TARGET_CERTIFIED` within one precise scope: the
current approved **D1 RuntimeRecipe release projection**. This certification
can drive a future read-only T21R-B semantic comparison. It does not certify
physical production D1 line IDs, positions for live enriched rows, nutrition
profile evidence, or a repair action. `T21G_NOT_READY`; 0039 and production
deploy remain `STOPPED`. This task made zero production reads or mutations.

## Executive decision and repository authority

The current code accepts expanded D1 runtime authority only when it matches V1
catalog release `rel-bd00a4f53fcaeee4`: 71 static recipes plus reviewed
30-recipe and 399-recipe batches, **500 ordered recipes**, with fingerprint
`f8cf8c7ff59df9fe29e246b9e3c9aad0fd155fa8df35bf671ac4d03fa2b5ab37`.
That is the exact target for D1 to serve `RuntimeRecipe` under the checked-in
Worker release contract. The last observed public production readiness reported
the static 71-recipe fallback because D1 failed hydration; this packet is not a
flag or cutover decision. V2 research content has no approved runtime release
fingerprint and cannot replace this target on the strength of recency or count.

`repository_id=1385308553` resolved to `vn-tako4/Tako-san`; name is mutable.
After `git fetch origin --prune`, `origin/main` was
`3e0f6531b98feb1e44743513b91aff131bbd522b`. The forensic workspace
`/Users/tunbee27/Documents/frigo` remained on `main` at
`f6a48a1f65f8303fe41463ef0dce442a1aed2c24`, ahead 33 / behind 614;
its untracked evidence was preserved. This work uses the clean managed worktree
`/Users/tunbee27/.codex/worktrees/t21-recovery-decision/frigo` on
`codex/t21ra-runtime-canonical-authority` based directly on `origin/main`.
Prior decision commit `8603fff` remains on
`codex/t21-production-recovery-decision`; its packet was read as context with
`git show`, not merged, overwritten, or treated as main authority.

`CERTIFIED` means included in the reviewed, reproducible release projection
and checked by T19 readiness. `PROVEN` denotes a verified code/source rule,
without implying a released dataset. `PARTIAL` has a narrower proven scope.
`UNKNOWN` cannot be promoted by row count, name similarity, or live deployment.
The companion `T21RA_RUNTIME_CANONICAL_TARGET.json` records these levels for
machine readers without embedding any recipe rows.

## Authority candidates and source matrix

| Dimension | V1 release | V2 research | Dated staging | Observed production | Reconciliation | T21R-A authority |
| --- | --- | --- | --- | --- | --- | --- |
| Recipe IDs and order | CERTIFIED: exact 500 | SUPPORTED: same 500/order | CERTIFIED V1 at run time | PROVEN set match only | NOT_AUTHORITY | V1 manifest, CERTIFIED |
| Recipe metadata | CERTIFIED runtime fields | CANDIDATE, source review incomplete | CERTIFIED V1 fingerprint | UNKNOWN content | NOT_AUTHORITY | V1 projection, CERTIFIED |
| Ingredient semantic ID | CERTIFIED V1 canonical IDs | CANDIDATE, many provisional IDs | CERTIFIED V1 fingerprint | V2-relative aggregate only | PROVEN bridge rules; zero current bridges | V1 IDs, CERTIFIED for target |
| Membership/ingredient order | CERTIFIED ordered V1 arrays | CANDIDATE relative source order | CERTIFIED V1 fingerprint | UNKNOWN live mapping; zero order rows | NOT_AUTHORITY | V1 target CERTIFIED; live mapping UNKNOWN |
| Quantity/unit | CERTIFIED V1 values/closed units | CANDIDATE, projection loss | CERTIFIED V1 fingerprint | PARTIAL V2 aggregate only | NOT_AUTHORITY | V1 values, CERTIFIED |
| Optional flag | CERTIFIED V1 true-or-absent | CANDIDATE boolean | CERTIFIED V1 fingerprint | PARTIAL V2 aggregate only | NOT_AUTHORITY | V1 values, CERTIFIED |
| Steps | CERTIFIED V1 ordered content | CANDIDATE, 4,938 | CERTIFIED V1 fingerprint | UNKNOWN | NOT_AUTHORITY | V1 steps, CERTIFIED |
| Runtime nutrition macros | CERTIFIED as present | CANDIDATE; release coverage blocked | CERTIFIED V1 fingerprint | UNKNOWN | NOT_AUTHORITY | V1 macros, CERTIFIED as present |
| Linked nutrition evidence | PARTIAL, separate tables | CANDIDATE, 1/500 publishable | UNKNOWN from runtime receipt | UNKNOWN | NOT_AUTHORITY | Separate T03 evidence gate, PARTIAL |
| Reconciliation | Not needed to define V1 source | No approved current bridge | NOT_AUTHORITY | UNKNOWN per row | PROVEN code rules | Rules PROVEN; live result UNKNOWN |
| Runtime positions | CERTIFIED only for V1 target rows | NOT_AUTHORITY for live D1 positions | CERTIFIED V1 hydration | UNKNOWN live mapping | NOT_AUTHORITY | Live-row position authority FALSE |
| Physical D1 line IDs/version | Outside runtime fingerprint | No live PK lineage | Not certified by fingerprint | 6,720 live lines, parent version=2 | No bridge | NOT_AUTHORITY for runtime target |

Source candidates:

| Source | Pinned identity | Standing |
| --- | --- | --- |
| Static baseline | `packages/recipes/src/data.ts`/`vietnamese-bank.ts`; 71; fingerprint `9ae153e64d34b30d72bb985d4070d8e210201219c0e8f8998ce8f99057fc7c3f` | Approved fallback and V1 prefix, not complete 500-recipe source |
| Reviewed imports | `data/recipe-import/approved-batches.json` SHA-256 `2dcd4b03c1f2991d74de0c938b5f5a850034c6659a963ca2438f9308542dbb42`; pilot 30 + scale 399 | Reviewed, deterministic source |
| Active V1 release | `packages/recipes/src/import/catalog-release.current.json` file SHA-256 `fa47d31f344736d338dc0ba50654e4604f793089fe97e44857e7dd5dd0134ac0` | Current approved D1 runtime contract |
| V2 | `data/recipe-refresh/v2/manifest.json` file SHA-256 `adf1784bb32b5b4fac7e9942dcc85d63339674282565b1dfa8e20c099ad7ea22`; canonical root `da87da20475fa8d7ec92c716e899ee572339573258ae6d9cc7f3f8f554f2d695` | Research canonicalized, not release ready |
| Reconciliation | `data/recipe-refresh/v2/ingredient-reconciliation.json` file SHA-256 `95f7d680ab2bedafebb39595341b55ba5d278a5c98fb14851ab116105f7d0ca5` | Rules constrain IDs; current file yields no cross-ID bridge |
| Staging D1 | Run `36494932501`, artifact `11003036030`, SHA `8072e0fea9f8f3588426969007dda06cadbbfbb7` | Dated V1 runtime certification, not source authority |
| Production D1 | Run `36706489599`, candidate SHA `df857a8ea25fe81f3bc220bb9cfee50c1d41aac3` | Observation only, not canonical |

## V1 authority chain and V2 exclusion

```text
ALL_RECIPES (71) + reviewed pilot (30) + reviewed scale (399)
  -> deterministic normalization and exact canonical ingredient resolution
  -> composed release rel-bd00a4f53fcaeee4 / ordered 500 IDs
  -> SHA-256 of stable ordered RuntimeRecipe projection: f8cf8c7f...a2b5ab37
  -> immutable 0034/0036/0037 rows and explicit order tables
  -> D1 hydrator + exact T19 manifest readiness
  -> dated Sep 28 staging runtime certification
```

Source and transform edges are PROVEN by checked-in code plus
`pnpm recipe:import:check`; staging parity was CERTIFIED at its run time.
Production parity was REJECTED at the last read-only receipt. Import
normalization requires reviewed recipes, exact canonical ID or unique exact
alias, positive finite quantity, a closed unit vocabulary and contiguous
steps. Token/fuzzy aliases suggest review only. The 500-recipe manifest is
recomposed from static data plus the two approved immutable batches, not
hand-chosen from staging. The full runtime fingerprint covers recipe identity,
metadata, ordered ingredient semantic IDs/names/quantity/unit/optional,
steps, tags, image URL and optional legacy nutrition macros. It does not hash
physical line PKs, parent version/provenance, linked nutrition evidence,
`recipe_media` rows or timestamps.

V1 and V2 manifests contain the same 500 recipe IDs in the same order; V2
names the V1 release ID as its base. No added, removed or renamed **IDs** are
shown between those two manifests. Their content differs: for example, V1
`gl-01` uses 180 g `SPAGHETTI_PASTA`, whereas V2's first research line has
200 g and a provisional `ING_ENR_` ID. Matching recipe IDs do not make V2
content authoritative. V2 has 500 recipes, 6,766 source ingredient lines and
4,938 steps; only 3,770 lines enter its provisional runtime projection, so
2,996 are excluded. Its provisional fingerprint
`6d0e3eb85696bb7c31bc54ac62783bc94432aaf008028eca79b17041f3eaed87`
is not a release fingerprint. The current manifest says
`productionReleaseReady=false`, `runtimeProjectionReady=false` and
`finalRuntimeFingerprint=null`. The gate fails with
`RUNTIME_PROJECTION_LOSS`, `INGREDIENT_RECONCILIATION_INCOMPLETE`,
`SOURCE_CONTENT_VERIFICATION_INCOMPLETE`, and
`NUTRITION_EVIDENCE_INCOMPLETE`. V2 nutrition: 1 publishable, 288 blocked,
211 null. Its eligibility derivation also sets production readiness false
explicitly; future promotion requires a separate reviewed release decision
even after content blockers are fixed. V2 source or `quantity.runtime` must
not replace V1 `requiredQuantity`/unit under the current release contract.

## Fingerprints, staging and migration meaning

| Digest | Meaning | Authority |
| --- | --- | --- |
| `fa47d31f344736d338dc0ba50654e4604f793089fe97e44857e7dd5dd0134ac0` | V1 manifest file bytes, identical at current main and last verified active Worker SHA `136cb6ff3d2921eac237c7b106b37ab5ee12a13f` | Source PROVEN |
| `f8cf8c7ff59df9fe29e246b9e3c9aad0fd155fa8df35bf671ac4d03fa2b5ab37` | Full ordered V1 RuntimeRecipe projection | Required by checked-in D1 readiness; CERTIFIED in staging Sep 28 |
| `adf1784bb32b5b4fac7e9942dcc85d63339674282565b1dfa8e20c099ad7ea22` | V2 manifest file bytes | File PROVEN, not release |
| `da87da20475fa8d7ec92c716e899ee572339573258ae6d9cc7f3f8f554f2d695` | V2 research canonical artifact root | Source PROVEN, not release |
| `6d0e3eb85696bb7c31bc54ac62783bc94432aaf008028eca79b17041f3eaed87` | V2 provisional runtime projection | NOT_AUTHORITY for production release |
| `c9254cdc3da230eeca6e32f205c54bed7b305d1d4edb64a245e050d62285fd53` | Local migration-through-0038 V1 aggregate | Historical comparison only |
| `4a777ad38efc684fe42c26bad0afdeb21a476460e840f44039a27602212bdd4a` | Sep 30 production V2 comparator live aggregate | Observation only |
| `321e59c716a6eb16b2375ae878b81c23fe0917ac1b25c53499b65afb8231f52b` | Staging 0039 migration-chain hash | Schema, not catalog content |

Migration 0033 concerns scan evidence; 0034 establishes legacy parity and
explicit runtime order; 0035 adds media metadata; 0036/0037 add 30/399
reviewed recipes with positions; 0038 concerns auth onboarding. Candidate
0039 (SHA-256 `24407e61f1aac2b3430bc5cef7a6d1c76d57a39f6314915c4915fc7209e777d5`)
adds only T20 composition/component/role tables and indexes. It does not
change catalog rows, positions or nutrition, and cannot cure zero hydration.
The production ledger at the last receipt was 38 through 0038; 0039 remains
`STOPPED`.

Staging `frigo-db-staging-v3` / `7854298a-20f5-46aa-9cbf-917079c2a3dd`:
0039 run `36287079403`, artifact `10919819859`, recorded 500 recipes,
2,702 lines, 2,064 steps, 2,702 order rows and 500 runtime fields with no
aggregate drift and clean FK/quick checks. Later run `36494932501`, artifact
`11003036030`, checked `2026-09-28T22:53:36Z` at SHA
`8072e0fea9f8f3588426969007dda06cadbbfbb7`, certified
`rel-bd00a4f53fcaeee4`: 500/500 hydrated, ID/order match, V1 fingerprint
match, legacy prefix and approved batches match, ledger 39/0039, FK/quick
checks PASS. This proves V1 compatibility on that staging snapshot, not V2
release readiness, current staging state, or production target correctness by
itself.

Production `frigo-db` / `f975ec39-b2c8-4a2a-80e1-0366054599d3`:
existing run `36706489599` observed 500 physical recipes (all parent
`version=2`), 6,720 ingredient rows, **zero** ingredient-order rows, 0/500
hydrated and ledger 38/0038. Its V2 comparator found 596 authoritative
same-ID semantic matches, 1,475 cross-ID content matches and 4,649
production-only lines. These categories are **V2-relative aggregates**, not
precomputed V1-target row classifications. The V1 replay comparator found
the same recipe ID set but zero exact historical *physical line IDs*. None
proves a live runtime fingerprint, step/nutrition/metadata coverage, a
position mapping, or historical writer. Parent `version=2` is not a V2 release
certificate. The last public readiness reported static fallback with
`CATALOG_DIAGNOSTICS`. No new production read was made in T21R-A.

## Runtime position authority

V1's ordered ingredient arrays and explicit 0034/0036/0037 order rows define
V1 target order. The T19 hydrator requires one explicit unique integer
position per line, contiguous `0..N-1` for each recipe; it never sorts by
physical line ID to manufacture authority. V2 has only source-relative order;
its diagnostic kept `runtimePositionAuthority=false`. No reviewed bijection
maps V1 or V2 lines onto the 6,720 live physical rows, and production has zero
order rows. Thus `runtimePositionAuthority=false` **for current live lines**.
T21R-B may record missing order coverage as an observed hydration failure,
but must not classify a live position difference as a repair defect or
assign one by source array order, lexical ID, or arbitrary reindexing.

## Reconciliation authority and manual review

`existing_canonical_id` is a cross-ID bridge only with a nonempty `sourceId`
distinct from `canonicalId` and `review=null`. `reviewed_new_canonical_id`
requires a nonempty `sourceId`, an `ING_ENR_` `canonicalId`, and an exact
review object with only nonempty `basis` and `evidenceReference`. Same-ID
semantic comparison needs no bridge but still needs recipe membership,
ingredient ID, quantity, unit, optional flag and name comparison; exact V1
release parity requires exact field content. Normalized name comparison with
matching ID is a separate informational category unless the applicable
release contract authorizes it. Cross-ID content/name similarity alone is
never identity proof. Provisional, duplicate alias, ambiguous and invalid
resolutions grant no bridge.

The V2 reconciliation file contains 2,515 entries: 505 existing, zero
reviewed new, 1,642 provisional and 368 duplicate alias. Every entry has
`sourceId=null`; no current entry passes either cross-ID predicate. An
`ING_ENR_` prefix alone grants no authority. For T21R-B,
`ID_CONFLICT_RESOLVED` requires a **unique bridge passing either strict
predicate**, plus matching content tuple; otherwise
`ID_CONFLICT_REVIEW_REQUIRED`. A production-only identity can become
`VALID_REVIEWED_NEW_CANONICAL` or `VALID_EXISTING_CANONICAL_ALIAS` only with
its exact evidence; otherwise mark `UNREVIEWED_PRODUCTION_ONLY`,
`PROVISIONAL`, `AMBIGUOUS` or `INVALID` relative to the named comparison
source. Unknown identity, membership, quantity or optional semantics require
`MANUAL_REVIEW_REQUIRED`. No category specifies a repair action.

T21R-B must use duplicate-preserving multisets of semantic tuples. A tuple
match with multiplicity greater than one does not identify a unique physical
row; row mapping and position remain UNKNOWN and require manual review. The
existing 1,475 conflicts and 4,649 production-only count cannot be copied
from the V2 comparison into a new V1 comparison.

## T19, T20 and stored composition contracts

T19 uses one authority snapshot for API, planner, cooking, swap and shopping.
Static mode exposes 71 recipes. D1 visibility requires complete
recipe/ingredient/step/runtime-field hydration, explicit parent and ingredient
order, zero hydration failures, exact 500 count/IDs/order, byte-equal 71
static prefix and the reviewed runtime fingerprint. Planner facts are fenced
to visible IDs. Stored plans bind source, fingerprint and count, so authority
drift causes revalidation or rejection instead of D1-only planner exposure or
cooking 404. `T19_COMPATIBILITY=PASS` for the V1 target contract; observed
production D1 readiness fails.

T20 candidates derive from the same visible T19 catalog, T02 inventory and
T03 hard restrictions. Unknown safety/time/hard nutrition fails closed;
Manual cannot override it. Roles depend on title/category/tags/ordered
ingredients/cook time, with reviewed stored roles able to override. Stored
compositions retain recipe references and authority/revision checks;
shopping projection inherits those identities. Identity/content change can
make a component unavailable or change eligibility/roles, even if 500 recipe
IDs remain. Some component references lack FK while role assignments can
cascade on recipe deletion. A future T20-enabled release needs isolated
reference inventory and before/after roles, hard eligibility and shopping
comparison for compositions, Week plans and cooked history. The last reviewed
production release kept T20 off; this task did not verify today's flag.
`T20_COMPATIBILITY=PARTIAL` until nutrition evidence, stored references and
role outcomes are certified. No stored data is modified here.

## T21R-B gate and unresolved dimensions

`T21R_B_READINESS=READY` has a narrow meaning: the next task may **design**
a reviewed, read-only row snapshot and compare its semantic fields against
the certified V1 RuntimeRecipe target. It does not dispatch the snapshot now,
or convert a comparison into a repair manifest. The minimum target dimensions
are certified: recipe identity, ingredient semantic identity/membership,
quantity/unit and optional semantics; strict reconciliation rules are proven.
Any match must respect duplicate counts. Unmatched/conflicted rows remain
`MANUAL_REVIEW_REQUIRED` and no position difference on current live rows may
be labeled a repair defect.

| T21R-B may compare | Must remain unresolved without more evidence |
| --- | --- |
| Recipe IDs/order against release manifest | Whether live enriched content should be retained or removed |
| Exact ingredient semantic ID/membership/quantity/unit/optional/name multiset against V1 arrays | Cross-ID bridge without its strict evidence; physical row mapping on duplicate tuples |
| Steps and metadata against V1 RuntimeRecipe fields | Current production values until an approved snapshot exists |
| Runtime nutrition macros as present in V1 | Linked nutrition evidence and hard eligibility |
| Missing order coverage as runtime failure | Target position of each current live physical row |

Still unresolved before repair design: coherent approved production row
snapshot; individual review of cross-ID and production-only identities; any
live-line position mapping; nutrition evidence and T20 stored-reference
compatibility; bounded blast radius and isolated rehearsal. Historical writer
identity is not a prerequisite. T21G remains `T21G_NOT_READY`.

## Offline validation and safety closeout

- `pnpm install --offline --frozen-lockfile`: PASS; no package/lockfile change.
- `pnpm recipe:import:check`: PASS, release `rel-bd00a4f53fcaeee4`, 500 recipes,
  two approved batches.
- `pnpm recipe:refresh:check`: PASS, source root and provisional fingerprint
  reproduced.
- `pnpm recipe:refresh:release-check`: expected BLOCKED (exit 1) with all four
  release blockers; this is confirmation that V2 is not approved.
- Focused Vitest authority/refresh/release-readiness: 3 files, 39/39 PASS.
- `pnpm check:migrations`: PASS (`migration-smoke=ok`), local SQLite only.
- No executable tooling or application code was added. Typecheck, lint, full
  tests and build were not needed for these report/spec-only additions.
  JSON validation, `git diff --check` and final worktree status appear in the
  closeout below. Production SQL, production API calls, restores, mutations,
  migration applies, deploys and flag changes: **0**.

### Evidence map and final checks

- Release composition and review gates: `packages/recipes/src/import/release-manifest.ts:9`,
  `scripts/recipe-import.mjs:36`, `packages/recipes/src/import/normalize.ts:95`,
  `packages/recipes/src/import/ingredients.ts:4`.
- Fingerprint and D1 acceptance: `packages/recipes/src/catalog-fingerprint.ts:14`,
  `packages/recipes/src/runtime-recipe.ts:20`,
  `packages/recipes/src/recipe-authority.ts:145`,
  `packages/recipes/src/runtime-hydration.ts:135`,
  `packages/db/src/recipe-content.ts:18`.
- V2 release gate and strict identity bridge:
  `packages/recipes/src/refresh/release.ts:84`,
  `scripts/production-catalog-v2-lineage.mjs:159`.
- T20 dependence on effective authority: `src/worker/services/meal-composition.ts:145`,
  `packages/recipes/src/composition/roles.ts:93`,
  `packages/recipes/src/composition/candidates.ts:44`.
- T21R-A target JSON parsed successfully and its release ID, recipe count,
  ordered V1/V2 ID set, manifest SHA and runtime fingerprint were checked
  against current source: PASS. `git diff --cached --check`: PASS.

A direct offline V1/V2 identity comparison found identical ordered IDs and
slugs, but two different titles: `vn-bun-01` and
`imp-7d38862afc164a8d`. Those V2 titles are unapproved content candidates;
no recipe ID was renamed. This comparison does not assert that every other
runtime field is equal.
