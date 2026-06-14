# StockVision Full PlanScope Local Prod-Ready Audit

schema_version: `stockvision-local-prod-ready-audit-v2`
roadmap_scope_version: `planscope-full-session-root-2026-06-14`
local_closure: `done`
local_prod_ready: `done`
failed_checks: `0`

| # | Check ID | Status | Detail |
|---:|---|---|---|
| 1 | `scheduler_manifest:weekly-optuna` | `pass` | required local scheduler job is present |
| 2 | `scheduler_manifest:adaptive-meta-policy-replay` | `pass` | required local scheduler job is present |
| 3 | `scheduler_manifest:linucb-multiplier-replay` | `pass` | required local scheduler job is present |
| 4 | `scheduler_manifest:monthly-optuna` | `pass` | required local scheduler job is present |
| 5 | `scheduler_manifest:optuna-queue` | `pass` | required local scheduler job is present |
| 6 | `runtime_pin:scikit-learn==1.9.0` | `pass` | reviewed official/stable runtime pin is present |
| 7 | `runtime_pin:xgboost==3.2.0` | `pass` | reviewed official/stable runtime pin is present |
| 8 | `runtime_pin:lightgbm==4.6.0` | `pass` | reviewed official/stable runtime pin is present |
| 9 | `runtime_pin:torch==2.12.0` | `pass` | reviewed official/stable runtime pin is present |
| 10 | `runtime_pin:torch-geometric==2.8.0` | `pass` | reviewed official/stable runtime pin is present |
| 11 | `runtime_pin:neuralforecast==3.1.9` | `pass` | reviewed official/stable runtime pin is present |
| 12 | `runtime_pin:tabm==0.0.3` | `pass` | reviewed official/stable runtime pin is present |
| 13 | `runtime_pin:timesfm[torch]==2.0.1` | `pass` | reviewed official/stable runtime pin is present |
| 14 | `runtime_pin:optuna==4.9.0` | `pass` | reviewed official/stable runtime pin is present |
| 15 | `controller_runtime_pin:optuna==4.9.0` | `pass` | controller Optuna/GA route dependency is pinned to reviewed official/stable version |
| 16 | `worker_runtime_pin:hono==4.12.25` | `pass` | reviewed Worker/meta runtime pin is present (actual=4.12.25) |
| 17 | `worker_runtime_pin:wrangler==4.100.0` | `pass` | reviewed Worker/meta runtime pin is present (actual=4.100.0) |
| 18 | `worker_runtime_pin:typescript==6.0.3` | `pass` | reviewed Worker/meta runtime pin is present (actual=6.0.3) |
| 19 | `active9_track:LightGBM` | `pass` | active-9 model is a production_slot_member in the backend track |
| 20 | `active9_track:XGBoost` | `pass` | active-9 model is a production_slot_member in the backend track |
| 21 | `active9_track:ExtraTrees` | `pass` | active-9 model is a production_slot_member in the backend track |
| 22 | `active9_track:TabM` | `pass` | active-9 model is a production_slot_member in the backend track |
| 23 | `active9_track:GNN` | `pass` | active-9 model is a production_slot_member in the backend track |
| 24 | `active9_track:DLinear` | `pass` | active-9 model is a production_slot_member in the backend track |
| 25 | `active9_track:PatchTST` | `pass` | active-9 model is a production_slot_member in the backend track |
| 26 | `active9_track:iTransformer` | `pass` | active-9 model is a production_slot_member in the backend track |
| 27 | `active9_track:TimesFM` | `pass` | active-9 model is a production_slot_member in the backend track |
| 28 | `active9_track:TimesFM:timesfm25` | `pass` | TimesFM production slot is backed by the TimesFM 2.5 runtime/config, not a separate TimesFM25 voter |
| 29 | `ui:new_flow_workbench` | `pass` | Model Pool renders the new workbench |
| 30 | `ui:retired_hidden` | `pass` | retired ML are filtered from the main surface |
| 31 | `ui:meta_replay_visible` | `pass` | meta replay is visible in the evidence flow |
| 32 | `ui:multiplier_replay_visible` | `pass` | LinUCB multiplier replay is visible in the evidence flow |
| 33 | `roadmap:p0:adaptive_l2_name_boundary` | `pass` | legacy adaptive_l2 formula constants remain separated from new L2 coarse ML gate/search naming |
| 34 | `roadmap:p0:l2_l3_semantics` | `pass` | L2 is 3ML coarse and L3 is 6ML formal family evidence, not a single top-k ranker |
| 35 | `roadmap:p0:l3_family_view` | `pass` | Model Pool exposes L3 by Tree/TabM/Sequence/GNN family semantics |
| 36 | `roadmap:p0:meta_policy_boundary` | `pass` | LinUCB/NeuralUCB/NeuralTS/NeuCB are meta-policy research lanes with LinUCB as production baseline |
| 37 | `roadmap:p0:l4_allocator_boundary` | `pass` | L4 sparse allocation is separated from meta-policy replay and legacy top-k override remains disabled |
| 38 | `roadmap:p0:opb_controller_ml_controller_surface` | `pass` | ML controller adaptive surface describes OPB as the sparse tangent allocation controller, not a separate research owner |
| 39 | `roadmap:p0:opb_controller_worker_surface` | `pass` | Worker adaptive governance describes OPB consistently with the controller surface |
| 40 | `roadmap:p1:active9_dataset_policy` | `pass` | active-9 dataset policy includes all production slots and retired model exclusions |
| 41 | `roadmap:p1:active9_verified_replay_source` | `pass` | adaptive meta replay uses verified active-9 prediction rows only |
| 42 | `roadmap:p1:active9_confidence_hook` | `pass` | adaptive confidence hook is scoped to active-9 evidence and excludes retired CatBoost |
| 43 | `roadmap:p1:retired_models_not_ic_tracked` | `pass` | retired models are not tracked as active model IC sources |
| 44 | `roadmap:p1:active9_teacher_labels` | `pass` | PLE/Listwise router evidence expects active-9 teacher labels without fake backfill |
| 45 | `roadmap:p1:optuna_worker_boundary` | `pass` | Worker triggers controller-owned 9-source sweep Job; it does not fan out or mutate production |
| 46 | `roadmap:p1:optuna_controller_boundary` | `pass` | controller owns long-running research sweep and separates L2/circuit search from bandit dims |
| 47 | `roadmap:p1:scheduler_policy_surface` | `pass` | scheduler policy exposes required Optuna/adaptive replay tasks |
| 48 | `roadmap:p1:post_verify_chain` | `pass` | post-verify chain closes rolling IC, reward ledger, adaptive params, shadow evidence, and strategy learning |
| 49 | `roadmap:p1:neural_shadow_replay_read_only` | `pass` | NeuralUCB/NeuralTS/NeuCB shadow state is evidence/research, not production mutation |
| 50 | `roadmap:p2:strategy_promotion_gate` | `pass` | strategy promotion requires shadow-first evidence and Wei approval for production allocation |
| 51 | `roadmap:p2:strategy_lab_governance_ui` | `pass` | Strategy Lab exposes shadow approval and Wei approval gates |
| 52 | `roadmap:p2:model_pool_promotion_governance` | `pass` | Model Pool separates artifact/parameter governance from the L2/L3 alpha vote graph |
| 53 | `roadmap:p2:active9_artifact_promotion_blocker` | `pass` | artifact promotion blocks non-active-9 models from production selection |
| 54 | `roadmap:p2:l4_pending_buy_policy` | `pass` | pending-buy execution is owned by L4 sparse final BUY rows only |
| 55 | `roadmap:p2:l4_pending_buy_query` | `pass` | pending-buy orchestrator filters executable rows to sparse tangent allocation output |
| 56 | `roadmap:p2:l4_data_quality_owner` | `pass` | DataQuality has an explicit owner check for L4 allocator pending-buy execution |
| 57 | `roadmap:p2:l4_recommendation_context` | `pass` | recommendation context exposes sparse final allocation evidence and controller provenance |
| 58 | `roadmap:p3:layered_funnel_evidence` | `pass` | daily recommendation evidence exposes L1/L1.25/L1.5/L3.5 layer contracts |
| 59 | `roadmap:p3:daily_health_observability` | `pass` | daily recommendation API returns strategy portfolio intelligence health |
| 60 | `roadmap:p3:model_pool_evidence_ui` | `pass` | Model Pool UI surfaces active-9 fleet health and meta-policy evidence boundaries |
| 61 | `replay_file:adaptive_meta_policy_replay_20260605_20260611.json` | `pass` | read-only replay evidence file exists |
| 62 | `replay_fail_closed:adaptive_meta_policy_replay_20260605_20260611.json` | `pass` | replay evidence is explicitly non-mutating |
| 63 | `replay_status_terminal:adaptive_meta_policy_replay_20260605_20260611.json` | `pass` | replay has a terminal gate status; fail is acceptable when fail-closed |
| 64 | `replay_file:linucb_multiplier_replay_20260605_20260611.json` | `pass` | read-only replay evidence file exists |
| 65 | `replay_fail_closed:linucb_multiplier_replay_20260605_20260611.json` | `pass` | replay evidence is explicitly non-mutating |
| 66 | `replay_status_terminal:linucb_multiplier_replay_20260605_20260611.json` | `pass` | replay has a terminal gate status; fail is acceptable when fail-closed |
