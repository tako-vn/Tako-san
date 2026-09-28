# Scan quota semantics (ADR-039)

Authority: server subscription (`subscriptions`) for the entitlement,
`scan_quota_ledger` (one row per scan command, unique `scan_id` and
`idempotency_key`) for usage. `used = count(status != 'released')` for the
user and UTC month; `scan_quota_periods.used_count` is a projection. Client
plan/quota hints are ignored. Free = 5, Plus = 999999
(`src/worker/config/scan-quota-policy.ts`).

## Invariants

1. Bad input (missing/undecodable image, oversize payload, invalid key or scan
   type) is rejected before a reservation exists.
2. A valid accepted command holds exactly one `reserved` row while it can
   still produce a result.
3. `reserved → consumed` happens only in the consumer's lease-fenced batch that
   commits `ready` (async) or after the persisted synchronous result (sync).
4. `reserved → released` happens when the command can no longer produce a
   result: terminal failure, pre-send enqueue failure, storage failure, or
   stale reconciliation.
5. `consumed` and `released` are never overwritten by a late or stale worker;
   a `released` row is re-reserved only by a new attempt of the same command.
6. A command (one idempotency key per user/household) is charged at most once.

## Transition table (async production path)

| Situation | HTTP to client | Scan | Queue job | Quota |
| --- | --- | --- | --- | --- |
| Month exhausted | 429 `SCAN_QUOTA_EXCEEDED` + `quota` snapshot | none | none | unchanged |
| Quota ledger unavailable | 503 `QUOTA_UNAVAILABLE` | none | none | unchanged |
| Accepted and queued | 202 | pending | pending | **reserved** |
| R2 storage failure | 503 `IMAGE_STORAGE_FAILED` | failed | none | **released** |
| Queue intent not persisted (nothing sent) | 503 `QUEUE_UNAVAILABLE`, `quotaStatus: released` | failed | failed/none | **released** |
| `send()` failed ambiguously | 503 `QUEUE_UNAVAILABLE`, `quotaStatus: reserved` | pending | pending | reserved until same-key recovery or reconciliation |
| Provider success, result committed | (poll) ready | ready | ready | **consumed** (same batch) |
| Permanent provider/output failure | (poll) failed + `errorCode` | failed | failed | **released** (same batch) |
| Retryable failure, attempts left | (poll) pending | pending | pending | reserved |
| Retryable failure, attempts exhausted (incl. timeout) | (poll) failed | failed | failed | **released** |
| Result commit failed in D1 | (poll) pending → retried | pending | pending | reserved; consumed once on the committed attempt |
| Lease expired on final attempt | (poll) failed `MAX_ATTEMPTS_EXCEEDED` | failed | failed | **released** (claim batch) |
| Reservation stale (no live job, > 60 min) | (poll) failed `RESERVATION_EXPIRED` | failed | failed | **released** (reconciler) |
| Late worker after reclaim/reconcile | none | unchanged | unchanged | unchanged (fence rejects) |
| Same key while pending | 202 replay, same job re-sent | pending | pending | unchanged |
| Same key after ready/confirmed | 200 replay with stored result | unchanged | unchanged | unchanged |
| Same key after refunded failure | 202, new attempt of the same command | pending | re-armed | reserved again (one row) |
| Same key, different bytes/MIME/type | 409 `IDEMPOTENCY_CONFLICT` | unchanged | unchanged | unchanged |

Synchronous mode (`SCAN_QUEUE_MODE=sync`, rollback switch): success →
consumed; provider timeout/failure or persistence failure → released.

"Legitimately processed but nothing usable" is a failure (`INVALID_RESPONSE`
for zero items, `AI_SCAN_NO_USABLE_ITEMS` for only generic labels) and is
released; the product never charged for it in synchronous mode.

## Evidence

- `tests/integration/scan-async-quota-lifecycle.test.ts` — cases A–J, tenant
  isolation, receipt/fridge POST → queue → provider → D1 → GET → confirm,
  lease reclaim and reconciliation fencing, final-attempt lease expiry.
- `tests/integration/scan-quota-root-cause.test.ts` — the QA sequence on a
  real guest session and same-key re-attempt after a refunded failure.
- `tests/integration/scan-quota-idempotency.test.ts`,
  `scan-quota-reconciliation.test.ts`, `auth-me-quota.test.ts` — reservation
  races, month rollover, reconciliation and `/me` projection.
