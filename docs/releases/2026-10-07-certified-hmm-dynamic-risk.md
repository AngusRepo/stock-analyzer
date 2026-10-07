# Certified HMM and shared daily dynamic risk

Wei approved release on 2026-10-07 with Go after the 49-file review and 105 Python tests / 14 Worker checks.

This Paper behavior release changes the HMM input contract, data quality owner, shared daily risk and atomic P9. It has a separate native identity and exact runtime approval key. No storage-only source equivalence or maturity transfer is permitted. Existing Active8, MLP and TabPack artifacts remain unchanged; no live orders are authorized.

Linux Cloud Build independently attested native-paper-v1:1bf2f15c1a3b3d3267f0a6786cd14cbd7b39e644dda02326115fdf8e12a7beb8. The first build rejected the old declaration, before traffic changed. This release corrects the declaration and reads its separate approval before the legacy fallback keys.

Evidence: audits/hmm-risk-repair-20261007/REPAIR_REVIEW.md, release-approval.json, controller-build.log, native-candidate-identity.json.
