# NAV cold storage and safe D1 recovery

Large immutable NAV payloads belong in held, content-addressed GCS objects. D1 retains the original immutable manifest, bounded typed read view and cold/release receipts. Cold retention is at least 3650 days; object holds prevent unrelated bucket lifecycle deletion. No automatic hold release is provided.

Apply Learning migration 0048 before deploying the new writer. Deploy Worker readers, Controller and all jobs that consume NAV. Original snapshot ID, raw payload SHA-256, frozen_at and prospective eligibility must not change. Never present a projected-view checksum as the full original checksum.

For each legacy snapshot: require its exact manifest and expected checksum; archive the full original bytes; download, decompress and verify; exercise both Python and Worker readers; ensure no old NAV reader/writer execution is active; only then run the approved release. The release fences reinsertion and removes selected immutable keys in bounded pages. Lost responses can resume with the same approval ID. Missing-manifest prefixes are not deletable through this tool.

`ml-controller/scripts/nav_cold_storage.py` defaults to read-only inventory. Mutations require action, snapshot ID, expected checksum and approval ID. Keep receipts and source pointers outside the deployment artifact. After release, compare every original manifest, portfolio head/plan and database capacity with the before image. Payload bytes are not a promise of equal physical SQLite size reduction.

A code rollback after hot release MUST retain a cold reader or first restore all archived hot bytes through a separately reviewed recovery migration. Never roll back to a legacy-only reader with deleted hot parts.

D1 remains capped at 10 GB per database. Cold-at-write prevents the NAV full-history amplification; it does not prove every other Learning dataset has a safe deletion reader. Keep generic retention in preflight until exact row dependencies and restore/read behavior are verified. A 120-day policy flag alone is not deletion authorization or proof of ten-year closure. Capacity readiness must include actual usage, growth forecasts, executor coverage and remaining unsealed parts; never claim unlimited capacity.
