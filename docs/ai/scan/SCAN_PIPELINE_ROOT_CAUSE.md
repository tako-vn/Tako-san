# Scan pipeline root cause checkpoint (2026-09-28)

Repository authority: `takovn2/Tako-san` (`R_kgDOUpIhiQ`), remote main and starting branch commit `85660fa497f3da7110a07ec2189309fbef81d701`. Work is on `fix/scan-ai-quota-ocr-reliability`; main was not edited. The historical attachment's contradictory `takovn1` stop condition is superseded by the user's explicit `takovn2/Tako-san` request.

## Confirmed by code and local tests

- Free and guest accounts have five scan slots per month. Production configuration selects `SCAN_QUEUE_MODE=async`.
- Before this change, both scan POST routes finalized quota as consumed immediately after Queue `send`, before AI or scan result was ready. The consumer did not settle quota. Thus a later provider failure could consume a guest slot.
- The frontend had no quota specific presentation for `SCAN_QUOTA_EXCEEDED`, allowing a quota rejection to look like an OCR/image failure. The new UI distinguishes quota, rate limiting, provider, image, storage, and DB errors.
- The historical production workflow run `36183890785` deployed `136cb6ff3d2921eac237c7b106b37ab5ee12a13f`; a later run `36285175574` failed staging and skipped production. The latter cannot explain the earlier QA observation.

## Disproved or narrowed

- The old claim that the AI backend stopped responding after about 12:35 JST is not established by the QA report. A five-slot quota and misleading frontend text provide a concrete alternative explanation. No model swap is justified from that report.
- The current code has real receipt OCR routing and provider failure classification; mocked local tests establish wiring, not live OCR accuracy.

## Unverified

- The exact old QA requests have not been correlated with production quota rows or sanitized logs, so their cause is not proven individually.
- Live staging behavior of this branch and accuracy on the four original receipt images remain untested. The images and independent ground truth are unavailable.
- Provider availability cannot be inferred from a configured readiness flag. No paid public health probe was added.

No production mutation, deployment, merge, or secret change was performed.
