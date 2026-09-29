# D1 capacity and maintenance receipt repair

## Evidence and scope

The September 29 bounded production audit found Learning at 7.025 GB, Market
at 4.754 GB and Ops at 2.116 GB. September 24–29 retention receipts recorded
29,774 archive row-events, zero deleted rows and zero scrubbed rows. The
Learning hot-window schedule remains dry-run and ten Learning readers remain
blocked. This release does not establish ten-year capacity closure.

The audit JSON scrub UPDATE repeatedly traversed old date ranges for each
small batch. It now seeks the archived keys before retaining the original
eligibility and complete original-value compare-and-swap checks. NULL key
semantics are preserved. Failures identify the archive/readback/manifest/scrub/
checkpoint phase without exposing row payloads.

Durable audit maintenance now owns its scheduler ticket through the actual
terminal receipt. HTTP admission returns queued/pending, not completed.
Chunk progress and bounded failure counts use the existing D1 ticket under
the maintenance lease. Old deliveries cannot reset known failure counts.
Terminal redelivery repairs interrupted display logs for the same observed
run while preserving an observed successor. KV is still an eventually
consistent display; D1 is the terminal authority.

Capacity estimates retain the daily median diagnostic and add elapsed-time
net growth. The forecast uses the larger rate so quiet days cannot hide a
weekly batch. An already reached warning/max threshold has zero runway.
This is a warning estimate, not a ten-year capacity proof.

## Integration and publication boundary

The candidate begins with main `d1ca282c` and preserves the live Worker-only
backfill ownership commit `7ad9a9b5` by merge. The latter contains three files;
the merge must retain both parents. Other sessions' uncommitted root changes
are outside this checkout.

Publication requires the complete P9/CI checks, a fresh remote main and live
Worker comparison, clean exact deployment inputs and the existing deployment
wrapper's schema and active calibration gates. The wrapper also needs fresh
remote and live-source ancestry checks immediately before publication.

The parallel evening pipeline release must finish its Controller/Paper
sequence before this Worker release. That sequence's previously approved
Paper quote-age policy belongs to its release; this D1 change does not create
or alter any Paper admission, native fingerprint or equivalence certificate.

No cold-table drain, retention duration, scheduler frequency, RAM/CPU,
Cloud Run or Modal deployment is part of this D1 release. No paid pipeline
replay or bulk production cleanup is used as a smoke test.

## Verification and acceptance

Local SQLite tests execute real schema, archived original rows and UPDATE
statements, including changed payloads, moved owner heads and NULL keys.
Queue tests inject chunk, handoff, redelivery and terminal-log failures.
The new capacity tests cover periodic growth and reached thresholds.

Release artifacts and exact logs are kept in
`audits/d1-capacity-truth-20260929/` outside this clean checkout.
Production acceptance requires exact source/version readback and preserved
runtime/bindings. Actual scrub throughput and capacity improvement require
subsequent natural retention receipts; deployment success is not cleanup
success. Detached cold-reader owner integration and full historical Weekly
accounting remain separately incomplete.
