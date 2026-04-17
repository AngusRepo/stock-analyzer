# Progress — StockVision

## Session 2026-04-17 21:20 TWD — Handoff Prep

### What this session did (Claude → GPT handoff prep)
1. Wrote `memory/project_handoff_to_gpt.md` (English self-contained, 12 sections)
2. Rewrote `memory/MEMORY.md` index (8 sections, archived old sessions)
3. Wrote `memory/project_uncommitted_ml_service_2026_04_17.md` — documents 3 dirty files
4. Added Current Status sections to `ML_POOL_ARCHITECTURE.md` / `QUANT_TRENDS_RESEARCH.md` / `RISK_FRAMEWORK_ARCHITECTURE.md` (all phases NOT STARTED)
5. Verified TWSE stale date (roadmap #48) is CLOSED — caller uses `effectiveDate = reportDate ?? date`
6. Verified gkmx5 pipeline (#11)

### Key discoveries
- **predict_stock_v2 crash root cause IDENTIFIED**: `get_features` missing `target_rank` for single-stock predict. Fix exists uncommitted in 3 ml-service files.
- **Pipeline cron DID fire today at 17:30 TWD** (earlier claim it didn't fire was wrong — correction in `memory/project_handoff_to_gpt.md` §3.1).
- **5 consecutive days of silent pipeline failure exposed** (4/13-4/17) via `cron:log:pipeline:<date>` KV keys:
  - 4/13 / 4/15 / 4/16 / 4/17 = `Queue timeout: predictions only has 3 rows after 300s` (predict_stock_v2 crash)
  - 4/14 = `Pipeline V2 trigger HTTP 403 Forbidden` (different one-day bug, self-resolved)
- **Execution chain fully mapped**: Cloud Scheduler `pipeline` → Worker `/api/admin/trigger/pipeline` → `runFullPipeline()` → `runMLAndRiskV2()` → POST ml-controller `/pipeline/v2/run` → Cloud Run Job `pipeline-v2`.
- **Buy signals written today (4/17) promoted via manual retry**: 2493, 8210, 5515 (run_date=2026-04-16).

### Dirty git state
```
M ml-service/app/features/__init__.py   (predict-time target_rank optional + NaN fix)
M ml-service/app/main.py                (pass allow_missing_target=True)
M ml-service/app/models.py              (MarkovSwitching np.asarray)
```
All three are validated bug fixes. See `memory/project_uncommitted_ml_service_2026_04_17.md` for diff rationale + commit/deploy sequencing (M24 discipline).

### Open decisions for Wei
1. Commit + `modal deploy` the 3 dirty files? (unblocks pipeline 3-5 → ~2500 preds)
2. Fix 17:30 cron not firing (check Cloud Scheduler)
3. CCD scheduled-task replacement (short checkpoints vs external scheduler) — roadmap #10

### Next session entry point
Read `memory/project_handoff_to_gpt.md` §8 verification commands, then address the 3 Wei decisions above.

---

## Session 2026-04-16

### Portfolio
- Total: $1000201 (0.02%)
- Positions: 0 | Cash: $890201
- MDD: 10.6% | Sharpe(30d): 0.3986294602622852

### Today's Pipeline
- Screener: 25 → ML BUY: 0 → T2: 0 orders
- Trades: 0 BUY / 0 SELL

### Positions
No positions.

### Model Health
- Degraded: None
- Optuna params version: latest

### Deployments
- Worker: latest
- ML (Modal): deployed
- Controller (Cloud Run): deployed

### Cron Schedule
```
17:30 data-update → 17:40 screener → 18:00 ml-predict → 18:05 recommendation → 18:35 obsidian
07:15 morning-setup → T2 debate → paper trading
```

### Action Items
- [ ] Monitor pipeline execution
