# Scan quota contract (2026-09-28)

One logical scan command, scoped to user and household and its idempotency key, owns one monthly ledger row. A reservation occupies a slot while work is pending. Queue acceptance is not a successful scan. The scan result and quota settlement share a fenced D1 batch under the queue claim token.

| Event | Scan/queue result | Ledger result | Replay |
| --- | --- | --- | --- |
| Valid async POST/enqueue | pending | reserved | Same key and image reuses scan and reservation |
| Ready receipt/fridge result | ready | consumed | Same result, no second charge |
| Confirmation | confirmed | consumed | No second charge |
| Permanent provider/schema/no-usable-result failure | failed | released | Same key returns durable failure; new AI attempt uses a new key |
| Transient failure before retry limit | pending | reserved | Queue retries the same job |
| Retry exhausted or lease expired at max attempts | failed | released | Late worker cannot commit |
| Queue-intent persistence failure before send | failed | released | No queued work is asserted |
| Ambiguous queue send | pending | reserved | Same key re-sends one intent; reconciler bounds staleness |
| Storage or DB failure before usable result | failed | released | No charge; DB outage may itself prevent durable settlement |
| Reservation expiry | failed | released | Reconciliation closes old work; a new attempt needs capacity |
| Invalid input before reservation | no scan | no ledger row | Fix input |

The implementation follows user-value semantics: no usable AI result releases quota, including no detectable items. A ready scan consumes quota before user confirmation. For provider and infrastructure failures, the UI says the failed scan does not use a slot once its terminal state is durable. D1 outage can delay that transition; reconciliation must run when D1 recovers.

The queue uses a 75-second AI operation cap, a ten-minute claim lease, and `scan_queue_jobs.max_attempts` default 3. Permanent error codes avoid pointless retries; timeout/network/429/upstream failures are bounded. A stale claim token cannot write result or quota. Period usage is a projection of non-released ledger rows. No schema migration was needed.
