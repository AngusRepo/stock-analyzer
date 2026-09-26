# D1 retention release — 2026-09-26

## Approval and scope

Wei replied **Approved** after the S12 bounded-page / durable artifact-expiry report and its 61-test / actual-source parity results. This release publishes those Worker retention changes and their tested Worker dependencies from `codex/ga-evidence-cloudrun-audit`, based on `48f722b5f628e01276752b103528f92ec3069454`.

The included dependencies are S12 structure/replay readers, shared calibration context, compact release receipts/identities/rewards, producer retry protection, bounded drain accounting and truthful retention closure. The runtime deployment target is the Cloudflare Worker. The new bounded-page API is committed for subsequent scheduler integration; existing synchronous consumers retain their explicit limits. Learning source delete gates remain closed, and no confirmed drain or retraining is included.

## Schema order

1. Verify production source baseline and present schema definitions/readiness.
2. Explicitly apply Learning0056 (covering index), Learning0057 (additive cold identities, rewards, immutable release guards), and Ops0020 (durable expiry claims / reference guards). No R2 deletion is part of these migrations; Ops0020 backfills metadata for already-deleted payloads.
3. Read back exact new table/index/trigger definitions and migration metadata. Deploy tooling additionally checks required tables before admitting code.
4. Deploy the clean merged main commit through the provenance wrapper. Read back source tag/version, health, read-only domain schema/cold history and closure checks. Retention throughput remains subject to natural schedule evidence.

## Native Paper source build

Adding domain metadata and shared artifact code changes the locally bundled native source fingerprint. The reviewed candidate is recorded below and must pass native execution regression tests.

- Candidate owner: `native-paper-v1:45b37734e2682be6b199ac139147a5a9b8ac0c814bc30f4b6bc12893ab28e2bc`
- Candidate bundle SHA256: `8f4ee49ab625f3e6f0da2b6c50deb42f15e4449ace8dafdbd3b3030c3d5a049d`
- Previous production owner: `native-paper-v1:62e24f33350617b91e2e2f1f20a95e1939e9ecf6ef35d2cac7b81693abaa1c78`

`native_execution_behavior_release.json` records the reviewed build only and grants no runtime authority. No source-equivalence certificate, active runtime approval, private snapshot, successor, maturity or first-session schedule is changed by this Worker release. The controller image remains separately versioned; any later deployment of this new native build needs its own runtime admission and source/successor preflight.

## Verification and remaining work

The source report is `audits/ga-evidence-cloudrun-20260925/REPORT-S12-PAGES-EXPIRY-20260926.md` in the shared root workspace. Release-specific proofs are saved under `audits/d1-retention-release-20260926/` there.

Required checks include the scoped Worker tests, both TS configurations, native storage/frames/registration checks, PR CI and post-deploy readbacks. Pending work remains durable calibration page-output/checkpoint commits with frozen hot/lifecycle state; cross R2/D1 writer/orphan reconciliation; cold-reference retirement and long-term index bounds; other Learning consumers. GA/RFS/controller changes remain in the source worktree for a separate release review.

## Rollback

Restore the previous Worker version if code qualification fails after deployment. Additive tables/indexes and durable claims remain; never delete claims or resurrect payload-deleted manifests. The existing source-delete gates stay closed. Record exact deployed version, rollback source and schema state in the release receipt.

## Pre-release compatibility fix

Native integration identified that the shared artifact writer queried the production expiry table inside the sealed private host. The writer now uses the existing trusted request-local database capability to recognize the isolated artifact store; production calls still require the claim check, with no request/config bypass. Native frame/ledger/registration tests must pass before publication.
