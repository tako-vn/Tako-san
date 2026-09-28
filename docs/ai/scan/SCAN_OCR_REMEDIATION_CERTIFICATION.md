# Scan and OCR remediation certification (2026-09-28)

**Status:** `SCAN_REMEDIATION_CODE_COMPLETE`. **Live OCR gate:** `LIVE_OCR_CERTIFICATION_BLOCKED_DATASET_UNAVAILABLE`. The live data blocker does not invalidate the green local code gate.

## Local evidence

- Initial `pnpm check`: 4,780 passed / 3 failed. Two scan regressions were fixed. The local Wrangler subprocess test was intermittently slow.
- Full Vitest with only the Wrangler subprocess case excluded by test-name filter: 215 files passed, 4,783 tests passed, 1 skipped. This run preceded the last small UI retry/network-message change; the affected UI tests were rerun afterward, 5/5 passed. The new guest async lifecycle integration suite passed 11/11.
- Final unfiltered `pnpm check` passed after rebase on main `12348efd015ae72337fbeb08651150a7d28ee638`: 216 test files / 4,804 tests, typecheck, lint, `migration-smoke=ok`, and production build. `git diff --check` and `node --check scripts/ocr-benchmark.mjs` passed.
- The Wrangler catch-up test passed 32/32 in the final canonical run. Earlier isolated runs timed out locally, so hosted Node 22 CI remains an important independent check. No test assertion or gate was weakened to conceal this issue.

## OCR dataset boundary

The four original `receipt_easy`, `receipt_medium`, `receipt_hard`, and `receipt_veryhard` QA images are unavailable. The previous report is incident evidence, not ground truth. No replacement image, expected line item, production user receipt, or OCR accuracy result was invented. `qa/ocr/expected.schema.json` and `qa/ocr/README.md` define the private operator format. `node scripts/ocr-benchmark.mjs prepare --dataset qa/ocr` currently returns `DATASET_UNAVAILABLE` as intended.

Runnable now with repository fixtures: mocked Qwen receipt schema/provider and routing tests, scan POST to Queue and mocked Qwen to D1 ready/read/confirm flows, guest quota/idempotency/fencing/retry/reconciliation tests, canonical Vietnamese matching, and receipt review and inventory truth tests. Existing fixtures are synthetic contract tests, not OCR accuracy certification. The four missing images plus independently transcribed `qa/ocr/expected.json` are required for real receipt line item correctness, preprocessing A/B, latency, model escalation/cost comparison, and the live staging receipt matrix.

The benchmark prepares original, current frontend 2000 px JPEG quality 0.82, candidate 2400 px JPEG quality 0.90, and lossless PNG variants. It records private hashes, dimensions, bytes, then scores 16 operator reviewed staging runs by item count, normalized name, quantity, price, total and latency. Human review against the original images remains required. Browser JPEG output can differ from Sharp. The operator must supply a safe staging Plus QA account and keep request/scan IDs and raw OCR private.

## Routing and release

Receipt uses `receipt_ocr`, primary `QWEN_OCR` (default physical `qwen-vl-ocr`) with `QWEN_MULTIMODAL` escalation. Fridge and food currently share `fridge_image_analysis`, primary `QWEN_MULTIMODAL` (default `qwen3.8-flash`). The UI labels food mode as ingredient recognition; distinct dish inference was not introduced. Task runtime allows up to three model attempts for these tasks; queue retries are separately bounded at three. Production model configuration was not changed.

Staging was not deployed or certified. Production recommendation: `NOT_READY_FOR_PRODUCTION` until exact-head CI, review, staging verification, and the private live OCR dataset gate are completed by the operator. No merge or production deployment was performed.

Private `qa/ocr/receipt_*`, `qa/ocr/expected.json`, and `qa/ocr/results.json` are Git ignored. CI config uses Node 22; local checks used host Node 25.9.0 except the isolated bundled Node 24 attempt. The earlier intermittent Wrangler timing issue should be checked in exact-head hosted CI.
