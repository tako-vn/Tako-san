# Scan and OCR remediation certification (2026-09-28)

**Status:** `SCAN_REMEDIATION_CODE_CERTIFIED_LOCAL`. **Live OCR gate:** `LIVE_OCR_CERTIFICATION_BLOCKED_DATASET_UNAVAILABLE`. The live data blocker does not invalidate the green local code gate.

## Local evidence

- PR #22 review found an async queue-intent failure replay gap: failed scan/released quota with no job could reserve again on the same idempotency key. The regression now returns `SCAN_FAILED`/503 with no new reservation or Queue message. Synchronous replay coverage remains green.
- First follow-up `pnpm check` passed typecheck and lint, then timed out one unrelated AI provider test at five seconds (4,803/4,804 tests). The isolated suite passed 23/23 and the second unfiltered `pnpm check` passed 216 files / 4,804 tests, typecheck, lint, `migration-smoke=ok`, and build. The exact OCR/scan fixture command in `qa/ocr/README.md` passed 10 files / 210 tests.
- `git diff --check` and `node --check scripts/ocr-benchmark.mjs` passed. Hosted CI run `36437178487` / job `108977987256` passed on implementation head `45b6115f5b8bbf54f44182ae8bd9e28d49fa3e8a`: ESLint, typecheck, 216 Vitest files, migration smoke, and build. Verify the current PR head check after any later documentation commit.

## OCR dataset boundary

The four original `receipt_easy`, `receipt_medium`, `receipt_hard`, and `receipt_veryhard` QA images are unavailable. The previous report is incident evidence, not ground truth. No replacement image, expected line item, production user receipt, or OCR accuracy result was invented. `qa/ocr/expected.schema.json` and `qa/ocr/README.md` define the private operator format. `node scripts/ocr-benchmark.mjs prepare --dataset qa/ocr` currently returns `DATASET_UNAVAILABLE` as intended.

Runnable now with repository fixtures: mocked Qwen receipt schema/provider and routing tests, scan POST to Queue and mocked Qwen to D1 ready/read/confirm flows, guest quota/idempotency/fencing/retry/reconciliation tests, canonical Vietnamese matching, and receipt review and inventory truth tests. Existing fixtures are synthetic contract tests, not OCR accuracy certification. The four missing images plus independently transcribed `qa/ocr/expected.json` are required for real receipt line item correctness, preprocessing A/B, latency, model escalation/cost comparison, and the live staging receipt matrix.

The benchmark prepares original, current frontend 2000 px JPEG quality 0.82, candidate 2400 px JPEG quality 0.90, and lossless PNG variants. It records private hashes, dimensions, bytes, then scores 16 operator reviewed staging runs by item count, normalized name, quantity, price, total and latency. Human review against the original images remains required. Browser JPEG output can differ from Sharp. The operator must supply a safe staging Plus QA account and keep request/scan IDs and raw OCR private.

## Routing and release

Receipt uses `receipt_ocr`, primary `QWEN_OCR` (default physical `qwen-vl-ocr`) with `QWEN_MULTIMODAL` escalation. Fridge and food currently share `fridge_image_analysis`, primary `QWEN_MULTIMODAL` (default `qwen3.8-flash`). The UI labels food mode as ingredient recognition; distinct dish inference was not introduced. Task runtime allows up to three model attempts for these tasks; queue retries are separately bounded at three. Production model configuration was not changed.

Staging read-only health and readiness were 200 at `12348efd015ae72337fbeb08651150a7d28ee638`; DB/Queue were ok and AI was `mock`. The release workflow only deploys reviewed main SHAs, so PR #22 was not staged. This health check does not certify the PR or real Qwen OCR. Production recommendation: `NOT_READY_FOR_PRODUCTION` until exact-head CI, independent review, a valid staging release path, and the private live OCR dataset gate are completed by the operator. No merge or production deployment was performed.

Private `qa/ocr/receipt_*`, `expected.json`, and `results.json` are Git ignored. CI uses Node 22; local checks used host Node 25.9.0. The unrelated provider test timeout passed in the focused rerun and full rerun.
