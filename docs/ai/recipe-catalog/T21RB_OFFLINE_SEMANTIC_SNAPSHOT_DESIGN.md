# T21R-B: Offline semantic snapshot design

Status: `T21RB_PROTECTED_INTEGRATION_PREPARED`. The offline V1 comparator is
wired into the protected read-only production diagnostic workflow, but no new
production read or live V1 classification has been dispatched. This packet
neither authorizes repair, 0039, a flag change nor deployment.

## Goal and authority

Compare captured D1 recipe-content rows against the T21R-A certified V1
`RuntimeRecipe` ingredient projection, preserving duplicate multiplicity and
uncertainty. The target is release `rel-bd00a4f53fcaeee4`, 500 ordered
recipes, fingerprint
`f8cf8c7ff59df9fe29e246b9e3c9aad0fd155fa8df35bf671ac4d03fa2b5ab37`.
The source is the static 71 recipes plus the two approved batches of 30 and
399, composed with the checked-in release code. `scripts/t21rb-v1-offline.mjs`
recomposes this source, verifies the approved registry and migration bytes,
requires a byte-equal committed release manifest, and checks the T21R-A target
spec before comparing saved rows. It has no Cloudflare or D1 access.

This target is semantic, not a mapping onto existing physical D1 line IDs. The
V2 research catalog and the old V2-relative counts of 596 matches, 1,475
conflicts and 4,649 production-only lines are not V1 classifications.
Production and staging states are observations, not source authority.

## Protected capture boundary

The manual Production D1 Read-Only Diagnostics workflow reads the five
statements from `prepareRecipeContentRead()` in
`packages/db/src/recipe-content.ts`, plus the fixed order-coverage SELECT and
migration ledgers. It now retains the first five-statement result on the runner,
performs a second full five-statement read, and reads the ledger again. The
credential-free `scripts/t21rb-v1-production.mjs` wrapper checks the two
captures, three ledgers, coverage, prior sanitized diagnostic, repository and
D1 identity, then runs the offline comparator against the first capture.
Raw `runtime-catalog*.json`, SQL results, and credentials stay runner-local.
Earlier uploaded receipts lack the rows required for a V1 comparison.

Before a future protected dispatch, review the exact candidate SHA, repository
ID `1385308553`, production Cloudflare account and D1 database ID
`f975ec39-b2c8-4a2a-80e1-0366054599d3`, release manifest and workflow diff.
The manual exact-main CI gate, production Environment approval, credential
identity check, five-statement runtime SQL guard, reviewed fixed
coverage/ledger SELECTs, expected 38-entry ledger through 0038 and final
main-SHA recheck remain mandatory. The V1 receipt uploads only after all
steps, including the final main check, succeed. No raw row, recipe ID,
ingredient ID, name, household datum or credential may enter an uploaded
receipt or log.

Each catalog SELECT executes separately, not in one D1 transaction. The wrapper
requires successful five-result structures and exact equality of the complete
ordered result arrays across the two reads. It also requires all three ledger
reads to equal the reviewed 0038 prefix and binds the order-coverage aggregates
to the first capture and diagnostic receipt. This establishes
`OBSERVED_STABLE_NON_ATOMIC` only: matching observations and unchanged ledgers
cannot prove an atomic snapshot or exclude an intervening writer that leaves
both observed results equal. A failed, incomplete or differing read stops V1
classification; no V1 artifact is uploaded. No production action has been
executed by this integration work.

The ingredient comparator validates raw recipe IDs, ingredient fields and
parent recipe references. It counts malformed ingredient rows, duplicate
physical line IDs, unknown parents and missing or invalid positions, and leaves
uncertain occurrences unmatched for manual review. Its `semanticParity` covers
only the recipe ID set and V1 ingredient tuples. The other three SELECTs are
checked for response structure and repeated equality, with row counts exposed
as aggregates; their metadata, steps and nutrition content are not certified
by this receipt. The recipe runtime order is not compared to the V1 ordered
release manifest. Neither this receipt nor a matching ingredient result is a
complete catalog or release certification.

## Ingredient classification contract

The V1 target tuple is exactly
`[recipeId, ingredientId, name, requiredQuantity, unit, Boolean(isOptional)]`.
The live tuple uses raw D1 columns
`recipe_id, ingredient_id, name, required_quantity, unit, is_optional`.
Validate raw fields first: nonempty IDs/name/unit, positive finite quantity,
and an explicit 0/1 optional bit. Physical line `id` is a runner-local key,
not part of target equality. Do not use the runtime mapper's numeric/string
coercion for forensic matching.

Compare exact tuples as multisets per recipe. Exact equality certifies each
semantic occurrence. Duplicate multiplicity does not identify which physical
line maps to which target occurrence, so row mapping and live position remain
unknown. Released spelling and numeric values must match exactly; Unicode
normalization, fuzzy name similarity and V2 `quantity.runtime` are at most
informational.

| Class | Evidence | Authority consequence |
| --- | --- | --- |
| `EXACT_V1_SEMANTIC` | Exact tuple occurrence | Semantic match only; no physical row/position authority |
| `SAME_ID_CONTENT_DRIFT` | Same recipe and ingredient ID, changed fields | Manual review; no overwrite decision |
| `ID_CONFLICT_RESOLVED` | Unique cross-ID content tuple and strict bridge | Identity bridge only; no repair decision |
| `ID_CONFLICT_REVIEW_REQUIRED` | Cross-ID content resemblance without unique bridge | Informational; manual review |
| `UNREVIEWED_PRODUCTION_ONLY` | No target occurrence with sufficient evidence | May be valid enrichment; manual review |
| `TARGET_ONLY` | Target occurrence left unmatched | Missing relative to V1; no insertion decision |
| `MALFORMED` / `AMBIGUOUS` | Invalid raw field or competing candidates | Fail closed for that row |

Cross-ID bridges use strict predicates: `existing_canonical_id` requires a
nonempty `sourceId` distinct from `canonicalId` and null review;
`reviewed_new_canonical_id` requires a nonempty `sourceId`, `ING_ENR_` target
ID and an exact review object containing only nonempty `basis` and
`evidenceReference`. A source or target with multiple eligible bridge
candidates is ambiguous. Provisional/duplicate/ambiguous/invalid resolutions,
`ING_ENR_` prefix alone and name similarity never prove identity. The
committed V2 reconciliation metadata has zero usable cross-ID bridges because
all `sourceId` fields are null.

V1 target order is its released array order. Current live-line position
authority stays `false`; zero observed order rows are a hydration failure, not
permission to synthesize positions or call a position difference a repair
defect. The five SELECTs also expose recipe metadata, steps and legacy macros
for later comparisons. Their nutrition SELECT only contains recipe IDs with
links, so T20 hard-restriction nutrition evidence is not certified.

## Output, verification and next gate

The uploaded `production-t21rb-v1.json` contains allowlisted identity and
release references, statement row counts, order-coverage counts, ingredient
comparison counts and status flags. Raw rows stay runner-local; the receipt
does not publish per-statement content digests. `unmatchedProductionLines`
also includes malformed and unknown-parent ingredient rows; it is not a reviewed list of production-only
identities. The receipt says `NOT_A_RELEASE_CERTIFICATION`,
`runtimePositionAuthority=false`, `repairAuthorized=false` and
`T21G_NOT_READY`. Raw row-level review needs a separate protected evidence
path and must not be uploaded by this tool.

Offline fixtures cover exact equality, changed quantity/name/optional values,
duplicate multiplicity, malformed rows, cross-ID resemblance, valid and
ambiguous bridges, incomplete statements, capture drift, guard failures and
output redaction. The workflow integration is prepared for independent review;
no production diagnostic was dispatched by this task. No historical writer
attribution is required.

Only after independent review and a separately approved read-only capture may
T21R-B report actual V1-relative production counts. `T21G_NOT_READY` remains
until individual conflicts, production-only lines, T20 impact, bounded blast
radius and isolated rehearsal are resolved. No comparison class is a repair
instruction.
