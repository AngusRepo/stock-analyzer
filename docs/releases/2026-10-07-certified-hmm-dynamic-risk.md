# Certified HMM and shared daily dynamic risk

Wei approved release on 2026-10-07 with Go after the 49-file review and 105 Python tests / 14 Worker checks.

This Paper behavior release changes the HMM input contract, data quality owner, shared daily risk and atomic P9. It has a separate native identity and exact runtime approval key. No storage-only source equivalence or maturity transfer is permitted. Existing Active8, MLP and TabPack artifacts remain unchanged; no live orders are authorized.

Linux Cloud Build independently attested native-paper-v1:1bf2f15c1a3b3d3267f0a6786cd14cbd7b39e644dda02326115fdf8e12a7beb8. The first build rejected the old declaration, before traffic changed. This release corrects the declaration and reads its separate approval before the legacy fallback keys.

Evidence: audits/hmm-risk-repair-20261007/REPAIR_REVIEW.md, release-approval.json, controller-build.log, native-candidate-identity.json.

Actual release verification found a same-feature-date immutable-key conflict on HMM refresh. Market 0010 adds append-only observations; readers constrain both computation and reception timestamps. The first-observation table is preserved. SQLite tests cover same-date replacement, receipt-time PIT exclusion, checksum corruption, and atomic rollback. Final native identity: native-paper-v1:32e1345cac31e5422ddffc41a960a942ea7c8da532c04bac8b692c023a18f1cc.

Canonical bundle compilation runs from worker/, matching Docker and the native fixture. The final canonical native identity is native-paper-v1:644be1bbb2eb1d80882b6b1c77ed4563696e4ca8b4390574e93577c759ec502f; the root-cwd temporary fingerprint 32e1345 is not the admitted build.
