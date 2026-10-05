# L4 canonical risk overlay Paper release

## Root cause

For signal date 2026-10-02, the source recommendation for 6550 contained `alpha_context.risk_overlay.skip=true`, but L4 only checked an unproduced top-level `risk_skip`. The activated Paper plan assigned 6550 a 12.5% target. The unmodified seed-42 L4 runtime replayed the recorded plan on the immutable 10/02 snapshot with identical selected names and a maximum weight difference of `5.42e-16`; OPB was `base` in both. The local-versus-production selection difference arose from the new risk gate, not seed drift. The paired seed-42/43 study remains research-only; Wei chose to retain formal seed 42 and publish only the risk gate.

## Reviewed change

- `l4_distribution_runtime.py`: add the canonical nested `risk_overlay.skip` to `forbidden_buys`, preserving model forecasts and held positions.
- `active8_paper_admission.py`: add one exact Paper-only source transition and a new supplemental KV key ahead of the previous entry-visibility key. Revocation fails closed.
- `native_execution_behavior_release.json`: pin the changed native execution owner. The model checksum remains `9f179226aa7f5255d9221107386d377addcef29e5fdcd91e9d8be63fb6879a33`; no retraining, model switch, real-order flag change, account reset or NAV maturity transfer.

Exact source hashes: `l4_distribution_runtime.py` `b1d3773bac8cb892a73fb555bc32fbc5e8f8f9ff23c5f2b01dd3805f68b07686` → `4ce7820f1a0da71ab3939a6a5da10793d833a5e8429565f856b662d2c95f4400`; new native owner `native-paper-v1:b738eef531f291a276942ee0801cc44ae249fb40f4c88c4f67141f9ca1f40718`. The same locally built Worker native bundle reproduced the previous deployed owner exactly before calculating the new owner.

## Verification and release boundary

- Focused L4, runtime approval and single-B tests: 90 passed. New tests cover new-buy and held-name veto, exact source hash, unchanged risk/model fields, key precedence and revoked-key failure.
- `prepare_approval.py` checks the unmodified original admission and latest supplemental record, verifies seed-42 checksum and live-order-disabled flags, then creates a proposed exact approval in ignored `.tmp`; `approval-preflight.json` contains only redacted hashes and status.
- Stage the new KV key only with the exact reviewed approval checksum; preserve the prior key. Verify the no-traffic Controller revision before routing traffic, and update the daily `pipeline-v2` Job to the same image. Do not execute training jobs or backdate/rewrite the 10/02 activated plan. The next genuinely new plan must consume the new risk gate.

Raw evidence: `gs://stockvision-models/paired-nav-cold/v1/4a87387a820047ee2ef9976395882080c90e4b611f059f37a25a40bd602a0339.json.gz`; prior local `audits/tabpack-seed43-20261005/baseline-parity.json` and `comparison.json` in the separate research worktree; Paper D1 `l4_portfolio_plans_v1` plan `ff707ac52e9663b2faf96f2005f1c30ea145884cfe28803e067e962fcff7b9f3`.
