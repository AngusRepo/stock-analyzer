# Morning Setup P0-P7 Post-Deploy Validation Runbook

Post-deploy validation for the 2026-06-23 Morning Setup / RRG / formal137 / TimesFM sidecar repair.

Do not execute deploy, D1 migration, scheduler rerun, or any production mutation without explicit Wei approval in the current session.

## Scope

- P1: `pending_buy_filter_audit` schema and latest Morning Setup filter audit.
- P2: RRG must persist and consume a full rotation model: tail, transition path, velocity, acceleration, quadrant age, hysteresis, rotation score, and rotation regime. Missing momentum must not classify as a real quadrant.
- P3: formal137 0081/0193 missing feature refs should not be caused by alias/materialization gaps.
- P4: TimesFM must be L1.75 sidecar only, not a direct ML vote/weight, and not an active L2 feature input until formal137 registry/retrain/release is complete.
- P5: Morning Briefing must distinguish scheduler success from actual delivery.
- P6: Local closure gate must remain green before production validation.
- P7: Production readback and UI/API smoke after deploy.

## 0. Preconditions

Run locally before any production action:

```powershell
cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\worker
npm.cmd run type-check
npx tsx src/lib/morningSetupP0P6ClosureContract.test.ts
npx tsx src/lib/pendingBuyFilterAuditMigrationContract.test.ts
npx tsx src/lib/morningBriefingDeliveryContract.test.ts
```

Run Python RRG checks:

```powershell
cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12
.\ml-service\.venv\Scripts\python.exe -m pytest ml-controller\tests\test_rrg_calculator.py ml-controller\tests\test_sector_flow_service.py -q
```

Proceed only if all checks pass.

## 1. Approved Production Actions

Only after Wei explicitly approves production mutation/deploy in the current session:

```powershell
cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\worker
npx.cmd wrangler@4 d1 execute stockvision-db --remote --file=.\migration_pending_buy_filter_audit_2026_06_23.sql
npx.cmd wrangler@4 d1 execute stockvision-db --remote --file=.\migration_sector_flow_rotation_model_2026_06_23.sql
```

Then deploy the approved Worker/frontend/controller bundle using the current release path. Do not run retrain or live trading actions as part of this runbook.

## 2. Read-Only D1 Validation

Use `--command` for each SELECT in `worker/preflight_morning_setup_p0_p7_readonly_2026_06_23.sql`.

Do not run this read-only audit against remote D1 with `--remote --file`.

Minimum expected readbacks:

- `p7_schema_pending_buy_filter_audit`: table and all three indexes = `1`.
- `p7_schema_sector_flow_rotation_model`: all rotation model columns = `1`.
- `p7_pending_buy_filter_audit_latest_run`: latest run has audit rows after Morning Setup is rerun; `reject_action_rows = 0`.
- `p7_rrg_latest_rs_snapshot`: `missing_momentum_classified_rows = 0`.
- `p7_rrg_rotation_model_latest_snapshot`: rotation coverage should be non-zero after the next sector-flow write; `rotation_score_rows`, `rotation_regime_rows`, `transition_path_rows`, `quadrant_age_rows`, and `valid_tail_json_rows` should match the rows with complete RS/momentum/quadrant evidence.
- `p7_timesfm_sidecar_latest_ensemble`: `timesfm_direct_weight_rows = 0`; `timesfm_l2_feature_input_active_rows = 0`; `timesfm_l2_blocked_reason_rows` appears after the next daily ensemble write.
- `p7_formal137_missing_feature_refs_latest_recommendations`: 0081/0193 gaps may still exist if true source data is absent, but they must not be caused by missing alias names added in this repair.

## 3. Scheduler / API Smoke

Read-only or scheduled-trigger validation after deploy:

```powershell
cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\worker
npx.cmd wrangler@4 d1 execute stockvision-db --remote --command "SELECT id, trade_date, source_reco_date, status, debate_status, candidate_count, error_message, created_at, updated_at FROM pending_buy_runs ORDER BY id DESC LIMIT 3;"
```

Check the Worker daily recommendations API and UI card:

- ML vote denominator should be 8 direct-alpha models.
- TimesFM should show as `L1.75 TimesFM sidecar` / direct alpha blocked.
- TimesFM should show `L2 input PENDING` with `L2 block formal137/retrain/release`, not active L2 feature input.
- L2/L3 card should show direct ML + sidecar semantics, not `9ML Stack` with TimesFM as voter.

Check Morning Briefing logs:

- If no delivery channel is configured, summary must say `not delivered: no_channel_configured`.
- It must not say `sent to not_sent:no_channel_configured`.

## 4. Morning Setup Rerun Validation

Only after Wei approves rerunning the scheduler/task:

- Rerun Morning Setup for the intended trade date.
- Rerun Pre-market Warmup / Debate reconcile if required by dependency order.
- Read back latest `pending_buy_runs`.
- Read back latest `pending_buy_filter_audit`.
- Confirm `state=empty` is no longer ambiguous: summary must expose either hard-safety, soft-risk, or actual zero initial buy-signal state.

Expected outcomes:

- RRG Lagging/Weakening candidates are not hard rejected solely by quadrant.
- Their watch points include `rrg_soft_overlay:*:debate_required=true`.
- Their watch points include `rrg_rotation_model:<regime>:score=<score>:path=<transition_path>`.
- Debate can see soft-risk candidates when other hard gates pass.

## 5. Stop Conditions

Stop and investigate before further reruns if any of these occur:

- `pending_buy_filter_audit` table or indexes are missing after migration.
- `missing_momentum_classified_rows > 0`.
- RRG rotation model columns are missing or latest sector-flow rows have `rotation_score_rows = 0` while complete RS/momentum/quadrant evidence exists.
- `timesfm_direct_weight_rows > 0`.
- `timesfm_l2_feature_input_active_rows > 0` before formal137 registry/retrain/release is completed.
- Morning Briefing reports `sent to not_sent:no_channel_configured`.
- Latest Morning Setup has `candidate_count = 0` while readback shows prior BUY recommendations and no filter audit explaining the drop.
