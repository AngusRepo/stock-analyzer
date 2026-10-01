# 2026-10-01 native NAV and evening pipeline performance

Wei approved deployment and a local commit of these performance repairs. The
implementation is commit `6af9e73c979244665f5feaf3e12e0e376ffc4e41`, based on
`origin/main` commit `6c8e4e90cfe03acd2a601db672524a8a48c5e393`.

## Changes

- Compress large native SQL state fields while preserving logical object hashes
  and reads of legacy objects.
- Locate delivery boundaries using aliases, then verify the actual boundary and
  consumed predecessor; reuse successful same-request immutable readbacks.
- Share one verified bootstrap within a sibling registration group.
- Seal held-symbol projections after full replay/account reconciliation and use
  them for subsequent holdings inference, with legacy full-state fallback.
- Reuse an exactly matching, replay-validated formal risk context in strategy
  setup; expose recommendation subphase timings.

## Release identity and limits

The native owner is
`native-paper-v1:52d29436dabf158873b4f8c0b7c3648cf879d92b7c1342083c303ccd52ee5893`.
The Dockerfile verifies it against the compiled bundle and Python source bytes.
This declaration grants no runtime admission, source equivalence, maturity
transfer, promotion, retraining, or real-order authority. Old incomplete NAV
sessions cannot be repaired by changing their owner or inventing expired frames.

Local verification before mainline integration: 115 focused tests passed and
both 281-frame accounting scenarios passed. The historical allocator-equivalence
case `test_changed_selection_policy_preserves_old_ten_sessions_without_transferring_them`
also fails on clean baseline `f7e6c59d` with `nav_review_immutable_input_conflict`.
Mainline integration and deployment checks are recorded in the session draft.

## Exact Paper runtime reapproval

Wei explicitly approved the exact source compatibility repair, Paper supplemental
KV update/readback, local commit and deployment on 2026-10-01 after the initial
deployment attempt was stopped before production routing.

The old supplemental Paper approval pins both changed source files.
`approved_source_change` therefore supports only the two exact old/new hashes
in `PERFORMANCE_SOURCE_CHANGE`. The updated KV record must retain the original
admission, model identities, trading/risk settings and zero maturity transfer,
and pin the complete new configuration. Every other source or policy change
still fails. This does not normalize NAV identities or certify historical source
equivalence. Retain the old approval for rollback and verify the candidate's
exact serving configuration before switching production traffic.

The candidate reads the release-specific supplemental key
`ml:active8:paper_runtime_approval:v1:2026-10-01-native-nav-performance` first.
Absence falls back to the existing key; an invalid staged record fails closed.
The old serving version continues to read the original key during candidate
verification. After the traffic switch, synchronize the original key for
existing operational consumers. Keep its prior value as the rollback record.

## Existing OR15 context drift

Before release, production's canonical bundle endpoint already reported a
variables checksum mismatch. Its exact cause was S12 primary owner `1` in the
old admission versus `0` on the Worker. The Worker was already configured for
OR15 but the native context scalar allowlist omitted `PAPER_INTRADAY_ENTRY_OWNER`.
Wei explicitly approved exporting that existing flag and aligning the Paper
supplemental approval to `S12_INTRADAY_PRIMARY_OWNER_ENABLED=0` and
`PAPER_INTRADAY_ENTRY_OWNER=or15_vwap_v1`, including tests, local commit, Worker and
Controller deployment. The exact declaration rejects any other prior/current
owner or additional policy drift. Worker trading settings are not changed by
this repair; historical NAV registrations and missing frames are not rewritten.

Raw evidence: Cloud Logging `pipeline-v2`, 2026-09-30 15:40-16:30 UTC;
GCS `shadow/paired-native/v1/objects/0b7b187534f428c6e537e239c889009a0a15bf766fad8ae5268d569b1996b3f2.json`;
Obsidian `02_Products/StockVision/Sessions/2026-10-01-native-nav-and-evening-performance-repair.draft.md`.
