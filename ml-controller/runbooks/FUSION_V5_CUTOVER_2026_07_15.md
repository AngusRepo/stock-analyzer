# Fusion V5 Cutover Review - 2026-07-15

> Superseded on 2026-08-05 by `FUSION_V13_S12_POLICY_VALUE_CUTOVER_2026_08_05.md`.
> V5 mixed L4/S12 ownership, assistive tier, candidate-time S12 serving inputs, and L4 rollback
> are no longer valid production procedures.

## Decision boundary

Fusion V5 may replace canonical L4 as the production expected-return owner only when the
latest mature-date dry-run passes its existing quality contract. Do not lower gates, inject
labels, or promote a failed artifact to avoid an empty recommendation list.

Required evidence:

1. Verification labels use exactly the fifth future trading session.
2. Snapshot and replay rows pass the as-of/no-lookahead contract.
3. Selection OOS date-clustered IC and top-bottom spread pass.
4. Execution probability beats climatology on Brier/log-loss.
5. S12 replay execution samples and dates pass coverage.
6. Artifact registry state is `offline_passed`; config promotion is not based on stale V2/V4 artifacts.

## Cutover procedure

1. Run verification label repair for all newly mature prediction dates.
2. Rebuild `allocator_ev_feature_snapshots` through the latest mature date.
3. Run `POST /allocator_ev_fusion/refresh` with `dry_run=true`, `promote=false`.
4. Inspect OOS metrics, replay coverage, source dates, owner lineage, and failed gates.
5. If and only if decision is PASS, rerun refresh with `dry_run=false`, `promote=true`.
6. Read back Worker `trading:config` and artifact registry; confirm the same V5 model version.
7. Run the target-date evening chain and every dependent scheduler.
8. Confirm every allocator candidate records `expected_return_owner=allocator_ev_fusion` and the
   expected V5 model version. Mixed owners in one allocation batch are a blocker.

## OPB after Fusion V5

The existing L4 counterfactual prior must not be reused after owner cutover.

1. Run `POST /opb_arm_prior/refresh` with `expected_return_owner=allocator_ev_fusion`,
   `dry_run=true`, `promote=false`.
2. Confirm all five fixed arms have the required mature dates and no replay failures.
3. Promote only a PASS artifact. Runtime accepts it only when its owner matches the candidate
   expected-return owner.
4. Keep the live chosen-arm reward ledger separate. Counterfactual samples warm-start the prior;
   actual production rewards update the posterior.
5. If the Fusion V5 prior is not ready, OPB remains production with its conservative static prior;
   it must not fall back to the L4-specific artifact.

## Post-cutover checks

1. Compare BUY and POTENTIAL_BUY counts, Score V2 distribution, expected-return distribution,
   allocation weights, cash weight, and selected OPB arm against the last canonical-L4 run.
2. Investigate score/BUY inversions with per-candidate EV and marginal utility evidence. Do not
   restore top-K ranking.
3. Monitor five mature trading sessions for realized net return, execution probability calibration,
   turnover, cash drag, concentration, and owner/version drift.
4. Re-run Fusion V5 and owner-specific OPB prior refresh on the normal weekly cadence.

## Rollback

Rollback to the last validated canonical L4 artifact when owner/version drift, malformed V5
payloads, non-finite EV, or material live calibration degradation appears. Restore the matching
L4-specific OPB prior artifact, rerun the affected evening chain, and preserve the failed V5
artifact as shadow evidence.
