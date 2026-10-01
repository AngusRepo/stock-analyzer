# Paper L4 debate batching and OR15 rebreak

Wei explicitly approved commit, push and deploy of these two changes on 2026-10-01.

## Scope

- Capture pending same-session L4 constraints once, merge vetoes and strictest caps, and submit one canonical optimizer request. Wait for pending debates when all captured requests are debate-only; independent hard-risk events may proceed. Acknowledge only captured IDs after a valid plan receipt, preserve retries, and leave arrivals for the next batch.
- Recognize the latest genuine OR15/VWAP crossover after an earlier signal expires. Remaining continuously above the opening range does not refresh age. Keep the deployed market-session window, completed-bar, freshness and risk checks.
- Preserve B + frozen TabPack, original Paper account, trading configuration, model pointer, fees, and history. No retraining or real orders.

## Runtime release

The Worker code is also bundled into the Controller's native Paper runner. Deploy the exact tested Controller/native runner, relevant Jobs, Modal source package and Worker. Pages inputs are unchanged.

Use `ml:active8:paper_runtime_approval:v1:2026-10-01-or15-rebreak-l4-batch` for this exact release. Existing builds retain their earlier release-specific approval. Prepare and validate the supplemental receipt with the original validator, pin the new native owner and reviewed authority-reader source hash, and read it back before routing. Keep the immutable original B admission/publication unchanged; no performance-maturity transfer.

## Verification

- Worker L4 batching tests: partial debate, one request for a completed batch, strictest caps, stable retry, concurrent arrivals, hard-risk priority, malformed receipt.
- OR15 tests: second crossovers at 09:25, 12:00 and 13:29; full-session first signals; unfinished/stale/expired/lost breakout and close boundary.
- Existing L4 portfolio/account/reward integration, native full-chain and Worker type checks.
- Existing supplemental approval drift, revocation, race and live-order guards.
- Actual serving bundle/provenance, unchanged account/model/config and exact supplemental approval readback after deployment.

## OPB evidence boundary

Read-only D1 audit on 2026-10-01 found six formal-account reward receipts (9/22–10/1), all complete and zero return cash days. The 9/30 old-policy plan actually consumed four earlier receipts and selected `high_score_conservative` with `learned_policy` status. This proves persisted reward consumption, not learned profitability. New B policy `17885369...` has no eligible receipts and correctly starts at `cold_start_base`; old A samples are not imported. OPB adapts among approved allocation constraints; this is not automatic TabPack/L3 retraining or stock-specific causal diagnosis.

Raw receipts and final deployment result: `audits/b-optimization-20261001/intraday-followup/` in the primary workspace. Keep failed test/environment attempts with the successful reruns.

## Rollback

Route back to the saved pre-release Controller revision and deploy its matching Worker image/source; restore matching job/native versions and supplemental runtime key from the backup. Never reset account/history or republish the frozen B model to perform a runtime rollback.
