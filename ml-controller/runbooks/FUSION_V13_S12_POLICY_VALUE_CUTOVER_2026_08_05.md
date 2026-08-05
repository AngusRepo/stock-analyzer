# Fusion V13 / S12 Policy-Value Cutover - 2026-08-05

## Invariants

- The complete L0-passed cohort continues through L1, L1.25, L1.5, L2, L3, L3.5, and L4. This cutover adds no Top-K truncation.
- L4 remains the day-t selection/alpha feature producer. It is not a fallback expected-return serving owner.
- Fusion is the sole expected-return serving owner and must fail closed when its primary artifact is unavailable.
- S12 is not an evening candidate owner, feature source, fallback, or duplicate setup-watch lane.

## Canonical artifact contract

The only supported production contract is:

- `contract_version=allocator-ev-fusion-contract-v13`
- `semantic_version=allocator-ev-fusion-s12-policy-value-day-t-causal-v4-lineage-bound`
- exactly two served heads:
  - `P(next-session S12 policy executes)`
  - `E(net return | executed)`
- `expected_return = execution_probability * conditional_net_return`

All serving features must be available at day-t from the L0-L4, ScoreV2, ensemble, or market lineage. Candidate-time S12 structure is forbidden. S12 historical replay is joined only as a mature label source.

## S12 ownership

S12 has exactly two roles:

1. Historical replay labels for Fusion training/evaluation after outcomes mature.
2. Live intraday execution policy for existing Pending Buy candidates and holdings.

The former candidate snapshot module is research-only and must not run in the canonical evening chain. The legacy `s12_candidate_snapshot_chunk` consumer remains temporarily only to drain already-queued messages without side effects.

## Promotion boundary

- Accepted serving tiers: `production_primary` or `shadow` only.
- Primary requires offline gates, PIT/no-lookahead validation, replay coverage, probability calibration, conditional-return quality, multiple-testing correction, and train/serve parity.
- A failed candidate remains shadow. It is never silently served through L4, S12, or legacy expected-return fallback.
- This cutover does not retrain the ML model pool, dispatch full-fit, or place orders.

## Runtime ownership

- `allocator-ev-feature-snapshot-backfill`: persists day-t causal features only.
- `allocator-ev-fusion-refresh`: joins mature S12 replay labels, builds/evaluates the two-head artifact, and applies guarded promotion when explicitly enabled.
- `active8-oof-cohort-materializer`: emits the same day-t feature contract; it does not fetch candidate-time S12.
- Daily evening chain: regime -> Fusion readiness -> complete L0-L4 pipeline. No S12 snapshot stage.
- Paper/live entry tasks: one S12 execution-policy lane for Pending Buy/holding state. No duplicate setup watch.

## Coordinated deployment order

1. Deploy `ml-controller` and its shared Cloud Run Jobs from one immutable image.
2. Run Fusion v13 dry-run refresh and require artifact-contract plus offline-gate success.
3. Deploy Worker contract/readiness/orchestrator changes.
4. Promote the validated v13 artifact through the guarded Fusion refresh path.
5. Deploy frontend observability changes.
6. Execute read-only production checks below.

Do not deploy the Worker strict-v13 serving contract before a valid v13 artifact is available unless an intentional fail-closed recommendation window is accepted.

## Post-deploy verification

- Latest primary artifact is v13 and has exactly the two required heads.
- No served coefficient or feature name contains `s12`.
- The L0 canonical cohort count is preserved into the downstream full-slate lineage; later count changes are attributable to recorded hard gates, not Top-K.
- Evening scheduler and observability page contain no S12 candidate/setup-watch stage.
- Historical replay research recovery still produces mature label evidence.
- Pending Buy/holding intraday S12 execution remains active through the canonical execution task.
- Missing/invalid Fusion artifact produces explicit risk abstention and a visible blocker.

## Rollback

Roll back controller, shared Jobs, Worker, and frontend to the same prior immutable release. Do not restore L4 or S12 as an expected-return owner. If no compatible primary artifact exists, remain fail closed until the release set and artifact contract are coherent.
