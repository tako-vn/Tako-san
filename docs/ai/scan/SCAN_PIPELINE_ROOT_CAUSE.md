# Scan pipeline root cause — 27/09/2026 QA "AI stopped responding" incident

Status of this document: **ROOT CAUSE CHECKPOINT** (written before any
application code change on this branch). The resolution section is appended
after the fix; the checkpoint text below is not rewritten.

## Repository authority

| Field | Value |
| --- | --- |
| REPOSITORY | `takovn2/Tako-san`, GitHub repository id `1385308553`, public, not a fork |
| Expected name in the brief | `takovn1/Tako-san` — `GET repos/takovn1/Tako-san` resolves (GitHub rename/transfer redirect) to the same id `1385308553`; both cited Deploy runs exist in this repository |
| STARTING_MAIN | `85660fa497` (local `main`) |
| STARTING_REMOTE_MAIN | `85660fa497` (`git ls-remote origin refs/heads/main`) |
| WORKTREE_STATUS | clean; only the untracked platform cache `.context/` |
| Branch | `hoplite/rhegion-c9ff1930`, created from `85660fa497`, 0 ahead / 0 behind at start |
| Protection | `main` protected; required status check `validate` (GitHub Actions), enforcement `everyone` |

## Release evidence (GitHub Actions, read-only)

- The last Deploy run whose **production** job ran is `36183890785`
  (`workflow_dispatch`, head `136cb6f`, production job
  2026-09-25T20:09:01Z → 20:15:16Z, success).
- Every later Deploy run up to 2026-09-28T06:10Z skipped the production job:
  `36221454575` (all jobs skipped), `36237637195`, `36240842196`,
  `36243811596`, `36269628127`, `36273034453`, `36274945067`,
  `36285175574` (staging **failure**, production skipped, 2026-09-27T01:19Z),
  `36292621523`, `36292920780`, `36305024017`, `36306554840`, `36308782040`,
  `36365130166`, `36371122773`, `36372371894`, `36385014725` (staging success,
  production skipped).
- The QA incident started around 12:35 JST on 27/09 (03:35Z). No GitHub
  Actions production deployment happened between the last production deploy
  (25/09 20:15Z) and the incident. Out-of-band `wrangler deploy` cannot be
  excluded without Cloudflare deployment history, which is not accessible here.
- `git diff 136cb6f 85660fa` touches no scan/AI path
  (`src/worker/routes/scans.ts`, `src/worker/services/scan-*.ts`,
  `src/worker/config/{ai,scan-quota-policy}.ts`, `packages/ai`,
  `packages/domain/src/index.ts`, scan pages/services/stores). The only
  differences are `src/web/services/meal-composition.ts` and the
  `MEAL_COMPOSITION_V2_ENABLED` var. Current-main analysis therefore applies to
  the production Worker that served the QA session.

## Traced code path (production vars: `SCAN_QUEUE_MODE=async`, `AI_QWEN_ONLY=true`)

1. `POST /auth/guest` creates a real D1 user plus
   `subscriptions(plan='free', status='active', max_scans_per_month=5)`
   (`src/worker/routes/auth.ts:1089-1091`).
2. `SCAN_QUOTA_POLICY = { free: 5, plus: 999999 }` per UTC calendar month
   (`src/worker/config/scan-quota-policy.ts:1,22-27`). Server subscription is
   the only entitlement authority; client hints are ignored.
3. `POST /scans/{fridge,receipt}` validates the image, then `reserveScanQuota`
   atomically inserts a `reserved` ledger row plus a `pending` scan row in one
   D1 batch (`src/worker/services/scan-quota.ts:37-176`). When the month is
   exhausted it returns HTTP **429 `SCAN_QUOTA_EXCEEDED`** before any R2, queue
   or AI work (`src/worker/routes/scans.ts:879-880`, `:1100-1101`).
4. Async producer: R2 put → `ensureScanQueueIntent` → `SCAN_QUEUE.send` →
   **`finalizeScanQuota(..., 'consumed')`** → 202
   (`scans.ts:942` fridge/food, `scans.ts:1157` receipt, `scans.ts:824` replay).
5. Queue consumer `processScanJob` claims a fenced lease, calls Qwen, and
   commits `ready` or `failed` (`src/worker/services/scan-queue.ts:409-551`).
   It **never reads or writes `scan_quota_ledger`**.
6. `reconcileStaleScanReservations` (daily cron `0 3 * * *`, 60-minute
   threshold) only touches rows still `reserved`; a `consumed` row is final.
7. Frontend: `ScanPage.scanFailureMessage` substring-matches only AI codes on
   the raw `HTTP 4xx: {json}` message (`src/web/pages/ScanPage.tsx:12-29`).
   `SCAN_QUOTA_EXCEEDED`, `RATE_LIMIT_EXCEEDED`, `QUEUE_UNAVAILABLE`,
   `QUOTA_UNAVAILABLE`, `IMAGE_STORAGE_FAILED`, `PAYLOAD_TOO_LARGE`,
   `IDEMPOTENCY_CONFLICT`, 401/403 and offline all fall back to
   "Không thể bóc tách hóa đơn. Vui lòng thử lại với ảnh rõ nét hơn!"
   (`:108`, receipt) or "Không thể xử lý ảnh hoặc nhận diện thất bại. Vui lòng
   thử lại!" (`:131`, fridge/food). The single "Thử lại" button (`:217`)
   re-sends the same command even for 429. No scan screen shows quota.
   `fetchJson` never reads `X-Request-Id` (`src/web/services/http.ts:15-39,
   112-123`).

## Deterministic reproduction

`tests/integration/scan-quota-root-cause.test.ts` (pre-fix contract) drives a
real guest session (`POST /auth/guest`) through the async producer, an
in-memory R2 double, the real `processScanJob` consumer with Worker
ack/retry semantics, and a deterministic provider double. Run on unchanged
production-equivalent code:
`npx vitest run tests/integration/scan-quota-root-cause.test.ts` → 1/1 PASS.

| # | Scan (QA order) | Provider double | HTTP | Ledger right after 202 | Deliveries | Scan | Ledger final |
| - | --- | --- | --- | --- | --- | --- | --- |
| 1 | receipt_easy | success | 202 | consumed | ack | ready | consumed |
| 2 | receipt_medium | `MODEL_NOT_FOUND` (permanent) | 202 | consumed | ack | failed | **consumed** |
| 3 | receipt_hard | `REQUEST_TIMEOUT` ×3 | 202 | consumed | retry, retry, ack | failed | **consumed** |
| 4 | receipt_veryhard | `AI_SCAN_NO_USABLE_ITEMS` | 202 | consumed | ack | failed | **consumed** |
| 5 | fridge_easy | success | 202 | consumed | ack | ready | consumed |
| 6 | fridge_medium | not called | **429 `SCAN_QUOTA_EXCEEDED`** | — | no message | no row | — |

`GET /me` afterwards: `plan=free, limit=5, used=5, remaining=0`. Replaying
scan 2 with the same `Idempotency-Key` returns 503 `MODEL_NOT_FOUND` and the
ledger still holds 5 `consumed` rows (the replay-side release is a no-op on a
consumed row). Only 2 of the 5 charged scans produced a usable result.

## ROOT CAUSE CHECKPOINT

**Primary explanation of the QA pattern (code-level, reproduced):** a guest is
a real free account with 5 scans per month. The first five accepted scans (four
receipts, fridge_easy) used the allowance; from the sixth request the Worker
answers 429 `SCAN_QUOTA_EXCEEDED` in a D1-only path without calling Qwen, and
the UI renders that as an image/AI failure. This matches "first five slow
(~25–30 s AI processing), then fast failures (~1–6 s)".

**Independent contributing defect (reproduced):** in async mode quota is
consumed at enqueue, before AI runs, and is never refunded when the scan fails.
This contradicts the synchronous path in the same file (release on provider or
persistence failure, consume only after a persisted result). It is not needed to
explain the QA sequence — six requests exhaust five scans either way — but it
makes failed AI work cost users their allowance.

### CONFIRMED

- Guest sessions are free accounts with `max_scans_per_month=5`.
- The 6th scan of the month is rejected with 429 `SCAN_QUOTA_EXCEEDED` before
  R2, queue or provider work, and without a scan row.
- Async enqueue consumes quota before provider completion; failed async scans
  (permanent error, exhausted retries, no usable items) are never refunded.
- The frontend masked `SCAN_QUOTA_EXCEEDED` (and every other non-AI gate code)
  as an image/recognition failure, offered a retry that could never succeed,
  and showed no quota.
- `X-Request-Id` is emitted by the Worker but never captured by the client, and
  scan/AI logs carry no correlation id.
- `ai: configured` in `/health/ready` only means a non-empty `QWEN_API_KEY`.
- `food` mode runs the same ingredient task (`fridge_image_analysis`) as
  `fridge`; nothing recognises dishes.
- Staging sets `AI_MOCK_MODE=true` (`wrangler.staging.jsonc:35`), so staging
  scans never exercise Qwen.

### DISPROVED

- A production deployment after 25/09 20:15Z caused the incident: no GitHub
  Actions production job ran between then and 28/09 06:10Z.
- Scan/AI behaviour differs between the production SHA `136cb6f` and main
  `85660fa`: no scan/AI file changed.
- Quota is only checked after AI work: it is checked and reserved first.

### NOT YET VERIFIED

- That the specific QA requests after ~12:35 JST were 429
  `SCAN_QUOTA_EXCEEDED`: no Cloudflare credentials, Worker logs, or D1 access
  are available in this environment, and the QA report has no correlatable
  request ids.
- That one guest session made all QA scans, and whether it scanned earlier in
  the same month.
- Qwen provider health during the incident; real OCR accuracy.
- Absence of out-of-band (non-Actions) deployments.

Next step after this checkpoint: fix the async quota lifecycle at the consumer
(authoritative terminal point), then the client error taxonomy/quota display,
then canonical normalization and correlation.
