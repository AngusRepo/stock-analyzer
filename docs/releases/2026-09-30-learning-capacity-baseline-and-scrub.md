# Learning capacity baseline and audit JSON safety repair

## Verified causes

The three capacity callers read migration baselines from Ops although
`data_domain_backfill_cursors` remains on the legacy control-plane owner.
The empty shadow included the initial migration in the growth forecast.
Replaying saved production observations against the unchanged estimator
changes the September 30 maximum-capacity forecast from 18 to 36 days.
Learning is still 7,143,084,032 bytes; the warning threshold is already reached.
The projection is a warning estimate, not a capacity guarantee.

The audit JSON scrubber replaced every payload column of a qualifying row.
An existing compact pointer or a small sibling could grow after replacement,
and strategy PIT/context fields used directly by existing readers were lost.
This release preserves those exact hot fields and existing pointer identities,
and only replaces a column when its UTF-8 representation becomes smaller.
Pages without safe savings advance the existing cursor without writing an R2
archive, manifest, or source row. Original-value CAS and archive readback remain.
Manifest savings are labelled planned; successful scrub receipts report only
logical payload bytes removed, never physical D1 storage reclaimed.

## Verification

Ownership tests cover inactive and active domain routing and all three callers.
Real SQLite tests exercise the production schema, PIT recovery reader, archive
originals, checksum/readback, cursor continuation, preserved pointer identities,
no-saving pages and concurrent-source CAS failure. Existing candidate, domain,
CAS and resolver tests remain required. Complete P9 and exact commit CI must
pass before release; runtime source and bindings must be read back afterward.

## Publication and remaining capacity work

The release is based on main `8477bae93728a928e5b1a36f98615e1887ab4be3`,
preserving the other session's deferred-OOF pipeline publication fix.
Use fresh main and production ancestry checks and the existing deployment
wrapper. This release does not alter native admission, resource settings,
scheduler frequency, retention periods, or cold-table deletion admission.
Existing archive address formats remain unchanged.

This is not ten-year closure. In the bounded production census, 99.03% of
rows in the six surveyed large Learning tables are within 120 days. Old-row
deletion alone cannot resolve their current size. Remaining acceptance needs
the complete hot-window budget including indexes, every growing table's
lifecycle, complete cold-history reads, and measured natural reclamation that
keeps up with arrivals. Already scrubbed originals require separate verified
readback and a reviewed repair before any source mutation.

Evidence and full logs are retained outside the clean release checkout in
`audits/d1-capacity-truth-20260929/learning-capacity-20260930/`.
