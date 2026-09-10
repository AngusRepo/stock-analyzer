# Active-8 ranking promotion and directional qualification

The immutable ensemble remains promotable when chronological ranking evidence passes, even when zero BUY/SELL signals qualify. `validation.decision` on newly built artifacts has `decision_scope=ranking`. Rank IC/spread, PIT, model identity, selected model contracts and atomic pointer checks remain mandatory.

Interval calibration and per-direction qualification are derived separately by `ensemble_qualification.py`. A directional rejection is a terminal assessment in the serving response, not a failed cohort or retryable job. It must never set the bundle's `production_effect=false`, clear members, or block daily prediction/evidence materialization.

Each direction requires a potentially reachable final affine model bound, adequate held-out active dates/rows, positive net evidence with a five-date block lower bound, and the relevant interval coverage. Strong BUY/SELL are evaluated independently; a blocked strong signal can downgrade to a qualified ordinary signal. These are model-signal checks, not proof of executable portfolio performance. Existing Fusion/sparse trading and risk contracts remain authoritative. The 200 rows / 10 active dates are minimum evidence floors, not sufficient statistical proof by themselves.

Legacy v1 payloads are never rewritten. Their checksum and selected base identities remain intact; the API derives qualifications from their existing evidence. Missing directional evidence does not become a pass. A legacy ranking-qualified bundle remains production and continues emitting forecasts while blocked directions return HOLD with `signal_status=policy_blocked`. `market_hold` identifies a normal HOLD under an otherwise qualified direction policy.

Controller and Modal package identical dependency-free qualification modules independently. A byte-parity regression test prevents drift. Roll out both readers before relying on newly produced qualification metadata. The release script updates Controller, Jobs and both Modal apps from the same source; no model retraining or bundle replacement is necessary for this repair.

Model Pool must display serving health, ranking qualification, interval coverage and directional qualification separately. A directional block must not turn a ready five-model fleet into 0/8 or downgrade its membership identity health.

Validation:
- New artifact with zero directional observations is ranking PASS and direction BLOCKED.
- Bad interval coverage does not prevent a ranking-qualified artifact from being created.
- Atomic promotion + readback succeeds with direction BLOCKED and preserves production status.
- Ranking/identity failures still block promotion.
- Current immutable 2026-09-09 fixture retains forecasts and checksum.
- Ordinary/strong and BUY/SELL qualifications are independent.
- Raw BUY cannot bypass recommendation qualification.
- Snapshot continuation, daily lifecycle, terminal admission receipts and root DAG closure remain covered by existing tests.

Release acceptance: actual serving bundle ranking PASS; can_promote=true in read-only replay; ready_count stays 5; selected model identities/checksum unchanged; Model Pool exposes distinct qualification state. Do not claim a new profitable decision policy, force BUY, or create extra shadows as part of this release.
