# Private OCR certification dataset

The four original QA receipts and their independent ground truth are unavailable. Do not commit receipt images, ground truth, or provider output. Do not use production user receipts or derive expected lines from the historical incident report. This directory contains only this guide and the schema.

An operator supplies the four original, PII-safe QA images in this directory. Each file must start with its case name and have a `.jpg`, `.jpeg`, `.png`, or `.webp` extension:

- `qa/ocr/receipt_easy.*`
- `qa/ocr/receipt_medium.*`
- `qa/ocr/receipt_hard.*`
- `qa/ocr/receipt_veryhard.*`

The operator also supplies private `qa/ocr/expected.json` conforming to `qa/ocr/expected.schema.json`. It has `version: 1` and a `receipts` object with those four exact case keys. Each case has `file` (the local image basename), `items` (nonempty array of independently transcribed `{ "name": string, "quantity": positive number, "totalPriceVnd": nonnegative number }`), and `totalAmountVnd` (nonnegative number). Do not fill it until the originals are available and reviewed. Store any private data outside the public Git repository.

Run `node scripts/ocr-benchmark.mjs prepare --dataset qa/ocr` to create original, current frontend, candidate, and lossless variants in `.artifacts/ocr-benchmark`. The current frontend variant approximates browser canvas JPEG encoding at 2000 px and quality 0.82, including its rule to preserve an unresized original when JPEG is larger. Browser encoder bytes may differ from Sharp. The candidate is 2400 px JPEG quality 90; lossless is PNG. The script fails with `DATASET_UNAVAILABLE` until the real manifest exists.

Use a clean staging Plus QA account to submit each private variant through the normal scan endpoint. Record reviewed outputs in private `qa/ocr/results.json` as `{ "version": 1, "runs": [...] }` with exactly 16 entries, one per case and variant. Each run has `case`, `variant` (`original`, `current_2000_q82`, `candidate_2400_q90`, or `lossless_png`), nonnegative `latencyMs`, `items` with the same item fields as ground truth, and nonnegative `totalAmountVnd`. Keep sanitized request correlation, model routing, attempts, escalation, and provider cost in a private operator record. Run `node scripts/ocr-benchmark.mjs score --dataset qa/ocr`. The scorer matches exact normalized names across row order, then computes a row independent name edit metric; quantity and price matches are counted only for exact name pairs. Human review against the original images is still required.

Existing repository tests can already run without these images: mocked Qwen receipt schema/provider tests, receipt scan API and queue tests, canonical ingredient matching, and receipt confirmation and inventory tests on local D1. Only real receipt OCR accuracy, image preprocessing A/B comparison, original receipt line item correctness, latency and cost on the four QA images, and live staging behavior for those images require the missing private dataset.
