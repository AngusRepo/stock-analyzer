# Evening timeliness and ten-year storage follow-up, 2026-09-23

## Verified causes
- Sept21 15:31 UTC: TimeXer input snapshot behind market session before GPU spawn. Current source now produces a same-date inference-input snapshot independently of the post-pipeline research export.
- Sept21 20:45 UTC: D1 7429 overload at prediction pruning. The prediction prune lookup uses a covering date index; no missing index there. Existing deployed client now has overload-specific backoff.
- Sept22 16:24–16:27 UTC: inference snapshot export failed on a legacy cold archive lacking original CREATE TABLE metadata. Existing deployed compatibility reader now separates verified read projection from exact-schema restore. Formal checksum readback of the original 100-row legacy price object passed, 0.188 seconds.
- Watchdogs used new Taipei date after midnight despite schedules continuing into the next day. Screener/pipeline recovery missed the previous evening root. Worker task map also discarded resolved scheduler context. Indicator's trading-day policy stopped Friday continuation on Saturday.
- Formal EXPLAIN confirms the archive-only predictions query scanned the full table and sorted it. New query bounds the existing date index. 280,000-row local fixture: same 100 rows, 37.37 ms old / 0.52 ms new; formal new read 100 rows / 0.406 seconds. Local timing is not a production latency claim.
- Archive read errors omitted the acknowledged cursor when recording failure; retries restarted from the beginning.

## Changes
- Select the previous evening's actual root receipt before 08:00, pass the selected business date through ticket and handler, preserve explicit dates and historical-session fences.
- Indicator recovery is a lineage-fenced continuation, including Friday-to-Saturday; it does not create a fresh holiday root.
- Extend screener/learning recovery through 06:50 TW and indicator recovery through 06:55. Existing stage leases, retry limits and identity checks remain authoritative.
- Indexed predictions archive pagination, strict cutoff and exact tie handling. Keep prior cursor on read failures.
- Correct archive scheduler to four quarter-hour slots/hour (02:07–06:52), matching its documented cadence; no deletion enabled.
- Ten-year readiness counts reader-blocked data too, with explicit reclaim_enabled=false. Sequential table inspection avoids a burst of Learning queries.

## Validation
- 40 relevant Worker test cases passed; two additional HTTP route cases verify business-date ticket and handler parity across weekday and Friday midnight.
- 72 Python snapshot/preparation/cold-reader/callback tests passed.
- Worker production and test TypeScript checks passed.
- Native execution identity unchanged: native-paper-v1:affbaa94ef057bbebde2b0b3b7ca25d1d1a043f1b2c2934e994ddd10fe478408; settlement/equity replay output parity verified.
- No retraining, model replacement, GPU research or production orders.

## Evidence
Local raw: runtime.json, cloud-job-milestones.json, snapshot-failures.json, live-scheduler.json (auth headers removed), formal-cold-readback.json.
Tracked compact: retention-query-proof.json, native-execution-parity.json.
Ten-year remains incomplete: 10 Learning dataset readers, current verified reclaim executor/backlog closure and sustained capacity equilibrium remain required. General deletion stays disabled. Future nightly completion must be established from runtime, not declared from tests.
