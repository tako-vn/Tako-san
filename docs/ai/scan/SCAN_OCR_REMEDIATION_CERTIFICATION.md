# Scan and OCR remediation certification (2026-09-29)

## Status boundaries

| Gate | Status | Evidence and limit |
| --- | --- | --- |
| CODE, PR #22 | `SCAN_REMEDIATION_POST_MERGE_CERTIFIED` | Independent review #5343949516 approved exact head `439451afeb81aee732c3e7d13acaf0a194b1e70e`; normal merge produced `94056d29ed00a1000e65eb8e1348384638bc02af`. Exact-main CI run `36476834182`, job `109112533990`, passed lint, typecheck, 216 files / 4,804 tests, migration smoke and build. |
| STAGING_INFRA | `STAGING_EXACT_SHA_CERTIFIED` | Official deploy run `36477693577` served `94056d29` with readiness DB/Queue ok, recipe canary 1%, T20 true, AI mock. Production job was skipped. Staging D1/R2/Queue bindings are distinct in `wrangler.staging.jsonc`. |
| STAGING_QUOTA | `STAGING_QUOTA_API_PARTIAL` | Isolated guest A completed five accepted scans to ready and `/me` quota 0 to 5; sixth returned 429 `SCAN_QUOTA_EXCEEDED` and 5/5 snapshot. Same-key/same-bytes replay retained scan/quota; changed bytes or MIME returned 409; guest B could not read or confirm A's scan, and B's same raw key was tenant scoped. HTTP responses carried `X-Request-Id`. Direct D1 ledger rows and staging fault injection were not observed. |
| SYNTHETIC_OCR | `SYNTHETIC_OCR_LOCAL_BASELINE_COMPLETE` | Seed `20260929`, four fictitious receipts, 16 variants. Apple Vision single-run baseline: 100% normalized names, quantity/unit, line price and total; 0 name character error rate; 194-512 ms. This is a local image/preprocessing baseline, not Takosan Qwen certification. |
| REAL_QWEN_OCR | `REAL_QWEN_STAGING_CERTIFICATION_BLOCKED_CONFIGURATION` | Staging has `AI_MOCK_MODE=true`, and no safe dedicated non-production Qwen configuration or local `QWEN_API_KEY` was available. No live provider call or model/cost/latency claim. |
| ORIGINAL_QA_DATASET | `ORIGINAL_QA_DATASET_UNAVAILABLE` | Four historical images and independently transcribed expected results are missing. The old report is incident evidence, not ground truth. Live historical gate: `LIVE_OCR_CERTIFICATION_BLOCKED_DATASET_UNAVAILABLE`. |

## Scan quota contract

Local regression tests and exact-main CI cover: accepted enqueue reserves quota; fenced ready consumes once; transient retry keeps the reservation; terminal provider failure and retry exhaustion release it. Queue-intent persistence failure before send leaves a failed scan and released quota; same-key replay returns `SCAN_FAILED`/503 without new reservation or job, while a new key can start a new attempt. Ambiguous Queue.send outcome preserves the reservation and recoverable replay. Household/user scope and queue fencing are tested. Staging mock AI exercised accepted to ready and quota API behavior only; it did not exercise terminal provider failures, retry exhaustion, or the no-job path. No direct staging D1 ledger certification is claimed.

## OCR test boundary

`qa/ocr/README.md` names the existing mock Qwen, scan, queue, canonicalization, receipt review and inventory fixture tests runnable now, and the exact private paths/schema for historical images. `node scripts/ocr-benchmark.mjs prepare --dataset qa/ocr` returns `DATASET_UNAVAILABLE` until the operator supplies `qa/ocr/receipt_easy.*`, `receipt_medium.*`, `receipt_hard.*`, `receipt_veryhard.*`, plus `qa/ocr/expected.json` conforming to `qa/ocr/expected.schema.json`. Original receipt line-item accuracy, preprocessing A/B, live provider latency, escalation, tokens/cost and the four-image staging matrix require that dataset. No production user receipt or PII-bearing data was used.

The separate synthetic fixture instructions, provisional targets and local measurements are in `qa/ocr/synthetic/README.md`. The follow-up branch `codex/scan-synthetic-ocr-certification` adds the synthetic harness, removes two overly confident canonical aliases and exposes `X-Request-Id` via trusted-origin CORS. It is not part of the already deployed main SHA; its own local/hosted validation must be reported separately.

Production: `NOT_READY_FOR_PRODUCTION`. No production deploy, data mutation, secret change, or Qwen model switch was performed for this task.
