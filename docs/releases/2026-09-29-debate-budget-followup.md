# Debate budget follow-up release

## Source and scope

This release follows 26643d50, which includes the NAV transport release
4e47aa34 and the separately deployed Worker/Pages fixes. The Controller
raises the second debate round output cap to 1024 tokens and settles
completed Workers AI reservations from measured usage. Failed or ambiguous
calls retain their reservation. The Docker image asserts that its bundled
Native Paper owner equals the reviewed declaration at build time.

The exact new owner is
native-paper-v1:d82a2b99b2ba0c671dca95d113427fb31c1caa04cd5827f360dc462a5b9f016e.
Wei approved this exact source-build fingerprint on 2026-09-29. The
declaration grants no runtime admission, source equivalence, maturity
transfer, prestart replacement, real orders or model retraining.

## NAV release gate

The NAV display code identity includes the source SHA and all Controller
service source bytes. The display receipt from 4e47aa34 cannot serve the new
release. Before Controller traffic changes, rebuild the receipt from
original sources for the final source SHA, verify its complete D1 read set
and compare all 13 active strategy display responses with the original
result. On 2026-09-29, the original atomic candidate inventory and the
released 4e47aa34 display receipt both have zero entries; the active
strategy registry contains 13 strategies.

Deploy a no-traffic Controller candidate and verify provenance and display
responses before cutover. Recheck production drift immediately before
cutover. Update only Controller, active8-oof-materialize and the two Modal
apps from the approved source. Preserve current images and settings for
other Cloud Run jobs. The general deploy script synchronizes all jobs, so
its broad production path is outside this scoped release.

## Validation

Debate and budget tests passed 39 cases. After the declaration update, 69
focused debate, Native identity and NAV tests passed. Local P9 passed all
Worker contracts, 441 Controller tests, frontend build and P12 secret scan.
Its final Bug Hunter CPD artifact gate could not run because this worktree
has no scanner artifacts or callable scanner. CI intentionally runs P9
with that artifact gate skipped; require green CI on the final source.
