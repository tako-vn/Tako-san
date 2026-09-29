# Production catalog ingredient-line lineage diagnostic

Status: `READ_ONLY_TOOLING_READY_FOR_REVIEW`; no production recovery is authorized.

## Why this comparison exists

Production Environment-approved read-only run `36577380500` (main `d0c670289534c33187181b2eb7192c05a2962e22`) found 500 recipes, 6,720 ingredient rows and zero ingredient-order rows; hydration failed for all 500. A local replay of immutable migrations through 0038 yields 500 recipes, **2,702** ingredient rows and 2,702 explicit positions. The count gap alone does not identify the provenance or correct order of any live line.

## Reviewed read-only surface

The existing `Production D1 Read-Only Diagnostics` workflow retains its manual exact-main CI gate, production Environment approval, Cloudflare account/D1 identity check and five guarded catalog SELECTs. A new runner-local step compares the already-read ingredient rows against a local 0038 replay. It makes **no additional production query** and has no Cloudflare secret in its environment. The replay checks every migration byte against the exact-main release manifest and validates the 500/2,702 historical snapshot.

The separate `production-catalog-lineage-<run>-<attempt>` artifact contains only counts and aggregate SHA-256 digests. Raw recipe/ingredient IDs, names and rows stay on the runner. It reports exact historical line IDs/content, changed historical IDs, live-only IDs, absent historical IDs, complete historical line sets per recipe, matching/mismatched historical positions, and recipe version counts. A version-2 marker is **not** evidence that a line matches the canonical research V2 source; `researchV2LineageProven=false` and `positionAuthority=NONE_GRANTED_BY_THIS_DIAGNOSTIC` are unconditional. Even a full historical ingredient-line/order match is explicitly `NOT_A_RELEASE_CERTIFICATION`.

Any wrong D1 identity, ledger other than exact 0038, changed ledger, migration hash drift, malformed/duplicate line ID, incomplete SELECT or inconsistent aggregate aborts before a lineage receipt is written. The existing sanitized diagnostic receipt remains independently available on failure. No raw catalog file is uploaded.

## What this cannot establish

This comparison can prove the selected D1 ingredient fields match a reviewed historical V1 line field-for-field; it cannot prove that a nonmatching line is the canonical V2 research line or derive its position. The canonical V2 package remains release-blocked and its provisional projection must not be used as order authority. The diagnostic cannot identify which writer removed order rows or when. It does not repair data, restore Time Travel, apply 0039, change recipe authority, deploy or enable T20.

The catalog SELECT and order-coverage SELECT are separate remote reads, not one transactionally pinned snapshot. Aggregate consistency checks catch count disagreement, but same-count concurrent edits could escape them. Therefore even an exact-match receipt must not authorize a write or release without a fresh, coherent preflight.

After protected merge and new exact-main CI, a separate production Environment approval is required to rerun the read-only diagnostic. Review the receipt before designing any further V2/source-attribution probe or production repair. A repair requires independently reviewed per-line position evidence, fresh preflight/bookmark and post-write certification; this PR supplies none of those permissions.
