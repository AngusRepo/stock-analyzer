# D1 retention scan / historical projection release — 2026-09-28

State: release candidate; production deployment requires successful publication gates.

## Baseline and scope
- Base: production/main 7c7568d2c30baa15fdb6cb00d7d2c570e0e964fb.
- Branch: codex/d1-retention-scan-20260928.
- Worker-only release: materialized Market discovery anchors, indexed archive dates/cursors, unchanged-payload projection retry suppression.
- No migrations, retention-window changes, cold-reader authorization changes, data deletion, Cloud Run/Modal deployment or retraining.
- Native bundle and owner remain exactly identical to baseline (603b0789...f7586).

## Evidence
- 40 targeted Worker tests; both source/test TypeScript checks.
- Real D1 readonly probes: all zero returned rows / zero writes; three major scans total 6,695,206 rows read, versus about 147,258,375 per cycle estimated from Sep27 sampled query analytics.
- Fixture anchor calls: 10,000 -> 20 with equal output; exact-delete rechecks preserve the original predicate.
- Full report and raw receipts: C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/audits/weekly-retention-20260928/REPORT.md.

## Publication gates
1. Recheck production and remote main; preserve all prior deployments.
2. Commit only reviewed patch/tests/release note; push branch and open PR.
3. Require full P9 CI, merge onto current main, verify source ancestry and clean deployment inputs.
4. Deploy Worker through provenance wrapper; verify version/source and read-only behavior after deployment.
5. Keep blocked-reader and JSON-retention CPU failures visible. Natural cron cost improvement remains a post-release observation.

## Rollback
Revert this PR on current main and redeploy through the same gates. No data/schema rollback is required.
