# Production catalog V2 semantic lineage diagnostic

Status: `READ_ONLY_TOOLING_READY_FOR_REVIEW`. No production recovery, 0039 apply, restore or deploy is authorized.

## Why this comparison exists

Protected production run `36653466481` on main `252096cccf602d07d6e33067024c5df2d6ba8a3e` proved historical V1 line identity is rejected (6720 live-only IDs vs 2702 historical) while recipe IDs still match. Canonical Recipe Refresh V2 is 500/6766 and `productionReleaseReady=false`. Count proximity is not identity proof.

## Matching contract

Authoritative identity requires `recipe_id` plus `ingredient_id` plus quantity/unit/optional. Names may be NFKC/trim/casefolded only when IDs still agree. Runtime quantity may match V2 `quantity.runtime` only with the same ID.

Cross-ID content similarity is informational (`ID_CONFLICT_CONTENT_MATCH`). It never sets `semanticV2LineageProven`. A cross-ID bridge is allowed only from reconciliation `existing_canonical_id` or `reviewed_new_canonical_id` with a review object. `provisional_new_canonical_id`, `ambiguous`, `invalid`, and `duplicate_alias` never grant authority.

Missing canonical lines are metadata-classified (`candidateReasonCounts`). Classification is not causal proof: `missingLinesCausallyExplained=false` while `ingestionPipelineProven=false`. Recipe subset class is `V2_SUBSET_WITH_CLASSIFIED_MISSING_LINES`.

Unique canonical source indexes prove relative order only. Position holes (`[0,2,3]`) set `recipesWithPositionHoles` / `requiresContiguousReindex`. `runtimePositionAuthority=false` always. Allowed `positionAuthority`: `NONE`, `PARTIAL`, `CANONICAL_V2_RELATIVE_ORDER_CANDIDATE`.

`researchV2LineageProven=false` until ingestion and transformation are independently proven. Artifact is counts/digests only. No extra production SELECT. No Cloudflare secret on this step.
