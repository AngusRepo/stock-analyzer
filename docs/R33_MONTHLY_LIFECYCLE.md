# R33 monthly lifecycle: deploy, serving parity, readiness

## Deploy settings

- Worker: `R33_MONTHLY_PROFILE = "1"` in `worker/wrangler.toml` [vars]. The Worker deploy has no `keep_vars`, so the value must live in the file. With the flag set, only the monthly OOF lifecycle uses the R33 profile.
- Scheduler: `active8-oof-weekly` is `"desiredState": "PAUSED"` in `infra/gcp-scheduler-jobs.json`, matching the live job.
- Challengers: nothing has to be set. The Modal orchestrator reads `app.challenger_models.LIFECYCLE_SLOTS` (PR #71). Until that module is deployed, R33 runs no challenger; after it is deployed, the `linear_neutral` slot runs automatically. `R33_OOF_CHALLENGER_MODELS` on the controller is an optional override and takes slot names.

## Serving parity (base 201cb5594 vs this branch)

```
python ml-service/scripts/r33_serving_parity.py --base 201cb5594 \
  --manifest gs://stockvision-models/walk_forward/oof_cohorts/<cohort>/manifest.json --json out.json
```

The script is read-only (local CPU, GCS read only for `--manifest`) and runs in two parts.

1. Static. It lists every top-level symbol of `ml-service/app/*.py` and `modal_app.py` that differs from the base. It then intersects that list with an import-resolved `(module, symbol)` call graph, which is the union of the base and branch edges. The graph is rooted at the serving entrypoints:
   - the daily predict functions, `pipeline_prediction_bundle` and `l4_native_prediction`;
   - daily `inference_only` prep and canonical adjusted prep;
   - the frozen forward-extension shadow;
   - the ASGI app.
2. Dynamic. It runs the shared code that is reachable from those roots, once in the base tree and once in the branch tree, in two isolated interpreters with the same frozen inputs:
   - the production rosters, run through `model_order` / `validate_order`;
   - `PROFILES131` membership and the `FEATURES131` hash;
   - `assess_fold_forward_sources` on every window of a production OOF manifest;
   - the `UniversalPrepRequest` defaults.

Result on 2026-10-25 with cohort `active8-oof-r32-plan-a-2026-03-18-2026-09-22-known-2026-10-01`:

- `status: pass`.
- 25 dynamic checks over 7 windows, with no differences. The base and branch output sha256 are both `14af252a…720c6e`.
- The same result holds for the r128 core16 split-r135 cohort.
- Of the 44 changed symbols, 8 are reachable from serving:
  - 7 are covered by the dynamic run: `model_order`, `validate_order`, `R33_MODELS`, `PROFILES131`, `R33_PROFILE`, `assess_fold_forward_sources` and `UniversalPrepRequest`.
  - 1 is proven inert for serving by code: `prep_universal_batch`. Its row slice at `universal_training.py:767-769` runs only when `feature_warmup_rows` is set. The default is 0 (`:87`), and the controller sets it only for R33 training prep (`r33_prep`, `retrain_trigger.py:1470, :2022, :2051`).

Every other changed line is training-only (new-file line numbers):

| File | Lines | Owner (training only) |
|---|---|---|
| `app/gnn_training.py` | 395-396, 452-454 | `train_graphsage_universal` |
| `app/tabm_training.py` | 262-264, 328-329 | `train_tabm_universal` |
| `app/neuralforecast_sequence_runtime.py` | 130, 579, 873-908, 935-959, 1311-1610 | `_resolve_nf_training_options`, `_train_dense_purged_oof`, `_make_nf_model`, `_train_nf`, `train_neuralforecast_sequence_artifact` |
| `app/purged_cv.py` | 342-371 | `purged_explicit_walk_forward_indices` |
| `app/timexer_job.py` | 29-32, 123-161 | `materialize_inputs` / `run` (reached only from `train_timexer_universal`; `timexer_universal_predict` uses `app.timexer_inference`) |
| `app/timexer_training.py` | 38, 110-111, 221-222 | `load_windows`, `train` |
| `app/training_finalizer.py` | 203, 273, 275 | `reduce_tree_model_child_results` |
| `app/training_policy.py` | 675-679, 705-710, 967-968 | `build_group_train_payload`, `build_tree_model_child_payloads`, `UniversalTrainingPolicy` |
| `app/universal_training.py` | 120-121, 187-276, 632, 687, 1008-1108, 1529, 1614-1616 | `UniversalTrainRequest`, `validate_immutable_oof_snapshot_for_registration`, `_save_oos_rank_artifact`, `train_universal_from_gcs` |
| `app/full_fit_scope.py`, `app/timexer_cutoff.py`, `app/oof_challengers.py` | new | imported only by the training owners above |
| `modal_app.py` | 735-964, 2577, 2622, 2658, 2908-2927, 3016-3440, 4012-4054 | `retrain_orchestrator`, `train_tree_models_split_parent`, `train_tree_models`, `train_wf_tree_window`, `_oof_challenger_*`, `walk_forward_orchestrator`, `train_patchtst_universal` |

## Readiness preflight

```
POST {ML_CONTROLLER_URL}/walk_forward/oof/r33-readiness
Authorization: Bearer <controller token>
Content-Type: application/json

{"end_date": "2026-10-30"}
```

`end_date` is optional and defaults to today in Taipei time. The endpoint dispatches no Modal, Cloud Run or prep work and writes no GCS, D1 or KV object. It only reads GCS and runs D1 SELECTs (market and ops).

It returns `{"verdict": "ready" | "not_ready", "blocking_checks", "warnings", "checks": [...]}` with these checks:

| Check | Owner reused | Blocks when |
|---|---|---|
| `profile_roster` | `model_profiles` + `model_order` | the roster is not the 7 R33 models, the profile is outside `PROFILES131`, or the test window is not 21 |
| `sequence_selection` | `ensure_active8_daily_prep(dry_run=True)` → `_r33_sequence_selection` | the freshest vintage has fewer than `_r33_required_price_sessions()` (1532) price sessions; the selection receipt is returned |
| `prep_plan` | `_verified_prep_only_receipt`, `_latest_canonical_prep_prefix` | the sealed source receipt is invalid. Otherwise it reports `reuse_sealed`/`build` and `reuse_latest`/`build` |
| `capture_inventory` | `inspect_capture_inventory(per_field_auxiliary, require_aligned_history)` | the inventory is not ready and a new source prep must be built (only a warning when a sealed prep is reused) |
| `l2_pool` | `r33_calibration_job.load_l2_pool` over the planned 21×7 mature sessions | there is no pool at all. Missing days are a warning, because they silently drop out of calibration |
| `tabpack_closure_skipped` | source of `run_walk_forward_oof_lifecycle` / `r33_monthly_lifecycle` | the R33 branch does not return before native L4/TabPack, P3 or closure, or the R33 owner references them |
| `challenger_slots` | `_r33_challenger_models` | an override name overlaps the release roster |
