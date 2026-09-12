# ML advice and L4 decision ownership

The promoted L3 ensemble may recommend BUY, HOLD or SELL. Those are advisory
predictions, not admission grants or final portfolio actions. L4 owns the final
selection through validated Alpha EV / Fusion and sparse allocation. OPB selects
allocator parameter arms using mature rewards when its owner-bound prior is
production-approved; otherwise sparse remains the controller.

## Contract

- Preserve the full valid L3 evidence pool, including SELL, HOLD and NO_SIGNAL.
  Missing/error predictions and incomplete formal model contracts still fail closed.
- Ranking qualification, PIT/lineage, model identity and family evidence remain
  mandatory. A zero ML UI score or blocked directional qualification is not a veto.
- ML advice lives in `ensemble_v2.advisory_signal`, `signal_role=advisory_only`,
  and `score_components.mlAdvisory`; qualified direction and its blockers remain
  available for interpretation. The immutable model artifact is never rewritten.
- Only validated `l4_alpha_ev` or `allocator_ev_fusion` expected returns enter the
  sparse objective. Remove the ML-BUY / inverse-volatility continuity fallback.
  Missing EV produces `validated_l4_expected_return_unavailable` and no allocation.
- `decision-owner-contract-v4` uses `allocator_opb_policy` as selection owner.
  A missing EV owner implies `risk_abstention` and
  `action_gate=validated_expected_return_required`, not an alternate ML owner.
- A final BUY requires a positive selected sparse/OPB allocation. ML SELL does not
  submit an exit or a short order. This change does not alter position exits.
- Preserve the existing risk restrictions, OPB prior admission, explicit OPB cash
  allocation, and RFS comparison-only boundary. RFS still compares with sparse.
- Ensemble ranking promotion remains independent. There is no model retraining,
  threshold reduction, changed bundle or new shadow in this repair.

## Learning scope

Sparse recomputes the constrained optimum from current EV, return-history risk,
correlation and concentration inputs. It is not another trained model. OPB learns
arm preferences from mature reward history (with decay); its allowed arms and
risk boundaries remain configured. Neither learns from future labels or fills a
portfolio merely to produce BUY recommendations.

## Verification

Regression coverage varies only ML advice across BUY/STRONG_BUY/HOLD/SELL/
STRONG_SELL/NO_SIGNAL while using the real promoted five-model artifact contract
and identical valid L4 EV. The filter, family contract, allocator and D1 writer
must preserve the advice while letting L4 select. Tests also require abstention
for missing/negative EV, missing family evidence, failed ranking, risk restrictions,
research-only rows, disabled allocation and authoritative empty OPB allocations.

Recorded production rows for September 9 and 10 contain 1,269 HOLD recommendations,
all with risk-abstention EV ownership and no enabled OPB allocation. An admission
replay must not manufacture positive EV or returns for those rows. This replay is
not a strategy performance backtest: no intrahold price path, execution simulation
or new holdout is claimed.
