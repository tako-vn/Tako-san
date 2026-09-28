# Synthetic OCR QA

This dataset contains fictitious grocery receipts generated from structured source rows. It is separate from the four original incident receipts. `SYNTHETIC_OCR_LOCAL_BASELINE_COMPLETE` describes the local Apple Vision measurement below; `ORIGINAL_QA_DATASET_UNAVAILABLE` remains an independent gate.

The deterministic generator uses seed `20260929` and the repository's Nunito test font. It writes `expected.synthetic.json` from source rows before rendering any image. That manifest contains exact name, quantity, unit, line price, and receipt total. The fake merchant is `TAKOSAN QA MART`; no customer names, addresses, payment details, or production receipts are used. Images and raw OCR output stay in Git-ignored `.artifacts/ocr-synthetic/`.

```bash
node scripts/generate-synthetic-ocr.mjs
swift scripts/ocr-synthetic-apple-vision.swift
node scripts/score-synthetic-ocr.mjs
```

The generator creates 4 receipts with 8, 14, 21, and 29 lines. Each has original, current frontend approximation (maximum dimension 2000 px, JPEG quality 0.82, preserving a smaller original if JPEG grows), candidate (maximum dimension 2400 px, JPEG quality 0.90), and lossless PNG variants. The frontend's browser encoder may differ from Sharp. `prepared.synthetic.json` records the renderer versions, image sizes, dimensions, and SHA-256 values. Run the Apple Vision command only on macOS; the manifest, generator and scorer tests run without it.

## PROVISIONAL_SYNTHETIC_QA_THRESHOLDS

These engineering targets were fixed before scoring. They are not historical QA or production acceptance criteria. Accuracy denominators are the ground-truth line counts.

| Case | Receipt total exact | Normalized line names | Quantity and unit | Line total price |
| --- | --- | --- | --- | --- |
| easy | 100% | >=95% | >=95% | >=95% |
| medium | >=95% | >=90% | >=90% | >=90% |
| hard | >=90% | >=85% | >=85% | >=85% |
| veryhard | report raw result | report raw result | report raw result | report raw result |

## Local Apple Vision baseline (2026-09-29)

All 16 variants yielded the expected 8/14/21/29 lines, 100% normalized names, quantity/unit, line prices, and receipt totals; character error rate was 0. Per-run OCR latency ranged from 194 to 512 ms. The `current_2000_q82` image sizes ranged from 63,792 to 135,718 bytes. All easy, medium and hard variants met the provisional targets. These are single-run local measurements without provider/network latency, model escalation, token usage, or cost. Canonical mapping rate is `null` because this Apple Vision baseline does not run Takosan's Qwen/domain pipeline.

A perfect local baseline on these generated images does not certify Takosan Qwen OCR or prove that the candidate preprocessing helps. Real Qwen requires an isolated non-production environment with the correct secret and `AI_MOCK_MODE=false`; the shared staging environment uses mock AI. Keep provider outputs private under `.artifacts/ocr-synthetic/`. The original four receipt gate still requires the independently transcribed private dataset described in `qa/ocr/README.md`.
