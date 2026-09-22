# NAV cold storage and safe D1 recovery

Large immutable NAV payloads belong in held, content-addressed GCS objects. D1 retains the original immutable manifest, bounded typed read view and cold/release receipts. Cold retention is at least 3650 days; object holds prevent unrelated bucket lifecycle deletion. No automatic hold release is provided.

Apply Learning migration 0048 before deploying the new writer. Deploy Worker readers, Controller and all jobs that consume NAV. Original snapshot ID, raw payload SHA-256, frozen_at and prospective eligibility must not change. Never present a projected-view checksum as the full original checksum.

For each legacy snapshot: require its exact manifest and expected checksum; archive the full original bytes; download, decompress and verify; exercise both Python and Worker readers; ensure no old NAV reader/writer execution is active; only then run the approved release. The release fences reinsertion and removes selected immutable keys in bounded pages. Lost responses can resume with the same approval ID. Missing-manifest prefixes are not deletable through this tool.

`ml-controller/scripts/nav_cold_storage.py` defaults to read-only inventory. Mutations require action, snapshot ID, expected checksum and approval ID. Keep receipts and source pointers outside the deployment artifact. After release, compare every original manifest, portfolio head/plan and database capacity with the before image. Payload bytes are not a promise of equal physical SQLite size reduction.

A code rollback after hot release MUST retain a cold reader or first restore all archived hot bytes through a separately reviewed recovery migration. Never roll back to a legacy-only reader with deleted hot parts.

D1 remains capped at 10 GB per database. Cold-at-write prevents the NAV full-history amplification; it does not prove every other Learning dataset has a safe deletion reader. Keep generic retention in preflight until exact row dependencies and restore/read behavior are verified. A 120-day policy flag alone is not deletion authorization or proof of ten-year closure. Capacity readiness must include actual usage, growth forecasts, executor coverage and remaining unsealed parts; never claim unlimited capacity.


## Interrupted payloads (Learning 0049)

An incomplete prefix is forensic evidence, not a valid NAV snapshot. Keep the missing original manifest missing. `paired_nav_orphan_archive.archive_orphan` requires an exact ID, contiguous expected fragment count and approval ID, verifies a held GCS backup, then publishes an immutable receipt that fences future fragment or manifest writes. `release_orphan` verifies that receipt and backup before deleting at most 250 fragments per statement. A lost response resumes under the same identity. Before publishing the fence, confirm the interrupted producer is no longer active and all deployed writers use cold-at-write. Never retire a currently executing producer merely to reclaim space.

The 2026-09-22 approved backups are `5a258754548ac16bb536f7e6138ef35313339c7946d22959ed97f6cda57bdd96` (4,890 fragments) and `a28dd482305106309f7eaff1875f5405785f6e20a14dce036c2964d3cd1849b4` (17,210 fragments). Their full fragment envelopes were read back and verified in `audits/ab-capacity-closure-20260922/orphan-cloud-backups.json`. They grant zero prospective or maturity credit. Backup approval is distinct from migration deployment and release approval.

## General retained rows

`retentionHotWindowDrain` bounds reads to 1 MiB before Worker materialization, uses existing date indexes, preserves original SQLite DDL, and compares all original values in the same SQL statement as deletion. Source changes abort the whole batch. Python `restore_retention_archive.py` restores verified chunks to a NEW local SQLite file and checks every value; it never restores into production. The service-authenticated Worker reader accepts an artifact ID, not arbitrary object keys or URLs.

Ten-year R2 objects use `evidence/class=ten_year_cold_archive/`. Deploy the conditional, checksum-verified retry writer before applying any bucket lock to this prefix. A lock must not accidentally cover debug or staging objects. Existing lifecycle rules observed on 2026-09-22 only expire debug/unreferenced/staging prefixes; no bucket locks were configured. Verify actual CLI/runtime configuration after any change.

Historical predictions: rolling accuracy, bulk ensemble backtests, ML confidence cache and compute snapshot signal export now merge cold history with hot-row precedence. This is NOT proof that every Learning/Market reader is covered. Keep the generic deletion schedule in preflight until remaining label/OOF/PIT/market-history consumers, missing-response reconciliation and each dataset's restore contract are verified. Do not declare complete from policy values or one successful batch. Readiness requires current per-dataset receipts and zero measured backlog, with global capacity/runway evidence checked separately.
