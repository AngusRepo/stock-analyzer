# P4.1 Modal Efficiency And Runtime Closure

Updated: 2026-04-30

## Authoritative ML Taxonomy

- Alpha prediction voters: 8 production voters, `XGBoost`, `CatBoost`, `ExtraTrees`, `LightGBM`, `FT-Transformer`, `Chronos`, `DLinear`, `PatchTST`.
- State-space overlays: `KalmanFilter`, `MarkovSwitching`; these provide regime/noise/context signals and must not be counted as ML vote denominator.
- Experimental shadow challengers: `ResidualMLP`, `GNN`; these may predict in shadow but must not vote in production.
- Meta optimizer: `GAOptimizer`; this learns strategy/meta parameters and is not an alpha prediction model.

## P4 Closure Checklist

- Batch predict contract: `predict_batch_v2` is the default Modal path; `MODAL_PREDICT_BATCH_V2=0` keeps the single-stock map fallback available.
- Runtime observability: `/health` exposes `batchPredictContract` so deploy smoke can verify the active predict mode and chunk size.
- UI/API vote contract: recommendation cards and Worker context only count the 8 alpha prediction voters; overlays, challengers, `ensemble`, and `StackingRank` are excluded from vote totals.
- Lifecycle IC scope: weekly IC tracks the 8 alpha prediction models and challenger rows; state-space overlays remain contextual overlays.
- Cost posture: keep L4 only where it materially improves training throughput (`FT-Transformer`, `DLinear`, `PatchTST`, feature/SHAP search). Do not downgrade hardware solely to save money.
- Remaining P4 observation item: compare one full production evening predict run before/after batch v2 using `cost_events` and pipeline duration; tune `MODAL_PREDICT_BATCH_SIZE` only from measured latency/cost.

## Expected Improvement

- Reduces Modal container fan-out for daily predict while preserving per-symbol failure isolation at chunk level.
- Prevents recurring `/10` vote confusion by separating alpha voters from overlays and experiments.
- Gives deploy smoke a deterministic way to catch accidental fallback to the older predict path.
