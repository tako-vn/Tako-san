# T21E audit pagination and temporal window refinement

Status: tooling change for independent review. This document records the frozen T21D evidence and the limits on what T21E can conclude. It does not authorize a production run or repair.

## Frozen T21D baseline

The existing metadata-only run is `36737394812`, attempt `1`, at main `4ab16c57a3d0f194dc7ed46046fcd5334fd91ee8`. Its sanitized artifact is `production-d1-temporal-forensics-36737394812-1` (artifact ID `11107753647`, SHA-256 `d44a1fe95bfcbeb3dd24d80307b5501b5f49c8630080db27686be12d82395f3b`). T21E uses this receipt as fixed evidence; it does not repeat the production collection.

The receipt identifies `frigo-db`, UUID `f975ec39-b2c8-4a2a-80e1-0366054599d3`, version `production`, created `2026-09-05T07:28:39.883Z`. Its 11 bookmark samples have 9 distinct digests and 8 observed transitions; `signalNoisy=false`. The digest at each of `2026-09-26T13:00:00Z`, `13:05:00Z`, and `13:10:00Z` is `34971393ee9c98b8ffe03fdc9d91b4239b56dead84116eaf7de025d1ec9539ed`. Thus no net bookmark-state difference was observed across those sampled endpoints. Equal endpoint digests do not prove that no internal transitions occurred. The reported external enrichment timestamp around 13:05 is not supported by a net database-wide bookmark difference across these samples. That finding does not establish that external enrichment never occurred. ZIP construction around 13:08:42-13:09:24 falls between equal-digest checkpoints; archive creation is a source lead, not proof of a production write.

The same receipt reports `auditLogs.available=true`, HTTP `200`, `pagesRead=1`, `complete=false`, `operationIdentityComplete=false`, and `d1Events=0`. Its `createDatabase`, `deleteDatabase`, and `timeTravelRestore` counts are `null`. Cloudflare access succeeded; the previous pagination check required `total_count`, which the Audit Logs v1 response need not include. In particular, `timeTravelRestore=null` means UNKNOWN, not zero.

## Audit Logs v1 contract

T21E retains `GET /accounts/{account_id}/audit_logs`, using sequential `page` and `per_page` pagination, with `per_page=1000` and a 50-page cap. This is Audit Logs v1. The distinct v2 endpoint, `/accounts/{account_id}/logs/audit`, uses cursor pagination and a different event schema; it is outside this change and outside the runtime allowlist. A switch to v2 would need a separate review of D1 operation semantics.

Each successful page must contain an array result and valid structural `result_info.page` and `result_info.per_page` integers. The response page must match the requested page; `per_page` must be positive, no greater than the requested page size, and consistent across pages. `count`, `total_count`, and `total_pages` are optional consistency hints, not requirements for completeness. If supplied, `count` must equal that page's result length and fit within `per_page`; `total_count` must be a non-negative safe integer and agree across pages and with the final accumulated event count; `total_pages` must be valid and consistent across pages. A terminal empty probe can follow the last non-empty page even if `total_pages` names that last page. Contradictory hints leave the audit incomplete; a hint's absence alone does not.

A valid empty result page is the authoritative completion signal. Pagination advances by one page even after a short non-empty page, matching the official Cloudflare TypeScript SDK's v1 page walk more closely. A first-page empty result proves an empty audit set without `total_count=0`; pages of 1000, 143, then 0 events require all three responses and report `pagesRead=3`. The terminal empty page counts toward `pagesRead` but contributes no events. Reaching the 50-page cap with no empty page, an invalid response, or an HTTP failure leaves `complete=false` and operation counts unknown. An HTTP failure on page 1 means `available=false`; a later failure after a successful page means `available=true`, `complete=false`, with the failing HTTP status recorded.

The sanitized D1 event retains `actionInfo` (from `action.info`) and `actionType` (from `action.type`) as different fields. Exact `actionInfo` values `CreateDatabase`, `DeleteDatabase`, and `TimeTravel` identify the three counted operations; generic action types such as `create`, `delete`, or `update` do not. Numeric counts, including zero for a proven empty result, require `available=true`, `complete=true`, and `operationIdentityComplete=true`. Any relevant D1 event with missing or empty `action.info` makes operation identity incomplete and all three counts unknown. The artifact excludes actor email/IP, token identifiers, raw metadata, old/new values, and raw HTTP details.

## Two fixed refinement windows

Only these coarse T21D state-change intervals are candidates for adaptive refinement:

| Window | Start UTC | End UTC |
| --- | --- | --- |
| A | 2026-09-26T12:00:00Z | 2026-09-26T13:00:00Z |
| B | 2026-09-26T13:10:00Z | 2026-09-26T18:00:00Z |

The refinement target is an interval of at most 60 seconds where bookmark digests differ across its endpoints. The algorithm samples a midpoint only for an interval with different endpoint digests and a duration above 60 seconds. It retains both halves when the midpoint reveals a third state, and stops on equal endpoint digests. An equal-digest pair shows no net bookmark-state difference across the sampled endpoints; it does not exclude internal transitions. At most 96 additional bookmark GET requests are permitted across both windows; exhaustion preserves partial intervals with `refinement.complete=false` and `refinement.budgetExhausted=true`. A failed sample records its availability and HTTP status without inventing a digest or a negative conclusion. The receipt reports sampled timestamps, full SHA-256 bookmark digests, transition-containing intervals, completeness, resolution, and request use. Raw Time Travel bookmark handles exist only transiently in runner memory and never enter the receipt, artifact, logs, documentation, or PR description.

The frozen 13:00-13:10 equal-digest interval remains visible and is not resampled to seek a different conclusion. A refined interval only correlates a database-wide net state advance with a time range; it does not prove a recipe ingredient change, an external enrichment writer, a SQL import, or an actor. The writer, output, source artifact, execution, and ingestion pipeline remain unproven.

## Safety and verification boundary

The database name and UUID gate must pass before bookmark or audit collection. Runtime Cloudflare access remains HTTPS GET only, without redirects, to database metadata, Time Travel bookmark lookup, and Audit Logs v1. SQL query, raw, export, import, restore, non-GET methods, and Audit Logs v2 remain forbidden. The existing workflow gates for exact main, exact-main CI, hardened SHA ancestry, the protected `production` Environment, main rechecks, and production concurrency remain in force. T21E development uses mocks and the frozen sanitized receipt; it makes no production Cloudflare call or workflow dispatch.

Validation covers empty and multi-page v1 responses with minimal page metadata, optional and conflicting pagination hints, malformed metadata, page cap, first- and later-page HTTP failures, D1 operation identity, missing `action.info`, single and multiple bookmark transitions, failed midpoint reads, request budget, and digest privacy. Any future production collection requires a separate independent review of the exact T21E PR head and its hosted CI. No T21E code result authorizes repair, release, migration 0039, position repair, restore, or deploy. `ROOT_CAUSE_STATUS=UNRESOLVED`.
