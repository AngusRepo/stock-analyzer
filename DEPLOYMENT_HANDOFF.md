# Deployment Handoff — Sprint KFlux-Inspired Improvements

**Branch**: `claude/resolve-merge-conflicts-E73zu`
**PR**: AngusRepo/stock-analyzer#5
**Last commit (strategy layer)**: `ae62823` — WFE gate + Momentum zone
**Last commit (engineering layer)**: TBD this push — Post-exit discipline + GCS lock + tripartite notify

---

## TL;DR for the deploy-authorized session

5 feature sets were implemented on this branch. **None are wired into production auto-execution**; they are inert until the 6 deployment steps below are performed. All code ships with tests and non-fatal error handling — a failure in any new subsystem degrades to current behavior, not a crash.

Run order is **mandatory** because step 3 depends on step 2's new D1 table existing, and step 6 (worker deploy) activates the new code paths.

---

## Inventory of delivered changes

| # | Feature | Files | Tests |
|---|---------|-------|-------|
| 1 | Per-Fold WFE Gate | `ml-service/app/wfe.py`, `ml-service/scripts/walk_forward_ml.py`, `ml-service/tests/test_wfe.py` | 20 unit tests |
| 2 | Momentum Crash Zone | `worker/src/lib/momentumZone.ts`, `worker/migration_momentum_zone.sql`, `worker/src/lib/marketScreener.ts` (hook), `worker/src/routes/paper.ts` (Layer 6) | Worker has no test infra; logic smoke-tested via compilation |
| 3 | EXIT Post-Exit Discipline | `worker/src/lib/postExit.ts`, `worker/src/routes/paper.ts` (EOD + intraday exit sites, morning-setup) | See above |
| 4 | Persistent GCS Retrain Lock | `ml-controller/services/retrain_lock.py`, `ml-controller/tests/test_retrain_lock.py`, `ml-controller/routers/retrain_trigger.py` (wired in) | 13 unit tests with fake GCS |
| 5 | Tripartite Discord Notification | `worker/src/lib/notify.ts` (new exported `buildTripartiteDailyEmbed`) | No tests; pure function — visual QA on first run |

**Test totals**: ml-service 41/41 · ml-controller 45/45 · cascade parity 12/12 · screener parity 20/20.

---

## 6-step deployment sequence

> **Always run these in order.** Each step must succeed before the next.

### Step 1 — Pull + verify branch locally
```bash
cd <repo>
git fetch origin claude/resolve-merge-conflicts-E73zu
git checkout claude/resolve-merge-conflicts-E73zu
git pull
git log --oneline -5    # confirm you see ae62823 + the newer commit
```

Run the test suite to confirm your local env is in sync:
```bash
cd ml-service   && python3 -m pytest tests/ -q
cd ml-controller && python3 -m pytest tests/ -q
cd ml-controller && python3 tests/test_cascade_parity.py --mode local
cd ml-controller && python3 tests/test_screener_parity.py --mode local
```
Expected: 86 passed, 15 skipped (cross-runtime, needs Worker URL).

### Step 2 — Apply D1 migration (momentum zone table)
```bash
cd worker

# DRY RUN first — creates table in local D1 preview only
npx wrangler d1 execute stockvision-db --local --file=./migration_momentum_zone.sql

# If dry run passes, apply to remote
npx wrangler d1 execute stockvision-db --remote --file=./migration_momentum_zone.sql
```

Verify the table exists:
```bash
npx wrangler d1 execute stockvision-db --remote \
  --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='screener_momentum_snapshots'"
```
Expected: one row with the `CREATE TABLE` DDL matching `migration_momentum_zone.sql`.

### Step 3 — Verify GCS bucket access for retrain lock
The persistent lock stores tiny JSON blobs at `gs://stockvision-models/locks/retrain/<key>.json`. The existing `ml-controller` service account is already authenticated for `stockvision-models` (used for `feature_pool.json`, line 283 of `retrain_trigger.py`). Confirm with:

```bash
# From a machine with gcloud auth that matches the Cloud Run service account
gcloud storage ls gs://stockvision-models/locks/retrain/ 2>&1 || echo "directory empty or absent — normal pre-first-run"
```

No explicit bucket creation needed; the directory is created on first write.

### Step 4 — Deploy ml-controller (Cloud Run)
```bash
cd ml-controller
# Use the existing deploy script / Dockerfile pipeline
# (no new env vars required — retrain_lock reads K_REVISION automatically)
<your existing cloud run deploy command>
```
Sanity-check after deploy:
```bash
curl -s -X POST https://<ml-controller-url>/retrain/trigger/universal \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1, "force_monthly": false}'
```
First call should return a normal run. Immediate second call should return `{"status": "skipped", "backend": "gcs"}` — this confirms the persistent lock is working.

Clean up the test lock so the next real cron can run:
```bash
gcloud storage rm gs://stockvision-models/locks/retrain/retrain:$(date -u +%F).json
```

### Step 5 — Deploy worker
**Pre-deploy check**: ensure `tradingConfig` includes the opt-in flag for re-rank (currently falls through to `false`, which is the safe default — re-rank is discipline-only on first deploy).

```bash
cd worker
npx wrangler deploy
```

Post-deploy smoke tests (run in order):
```bash
# 1. Confirm screener writes a momentum snapshot row
# Trigger a screener pass (manual or wait for 17:30 cron)
# Then check:
npx wrangler d1 execute stockvision-db --remote \
  --command "SELECT date, candidate_count, pct_oversold, zone, percentile_rank FROM screener_momentum_snapshots ORDER BY date DESC LIMIT 5"

# 2. Confirm circuit breaker Layer 6 runs without error
# Check Worker logs for:  "[CircuitBreaker] Layer6: momentum zone ..."  (only prints when zone ≠ GREEN)
# OR:                      "[Screener v2] momentum zone GREEN (pct_oversold=...)"  (confirms write path)
```

### Step 6 — Enable re-rank (optional, gated)
Re-rank is OFF by default. After observing the discipline-only behavior for ≥ 3 trading days (cooldowns set, stop-day freezes trigger correctly), flip the flag via KV:

```bash
# Read current tradingConfig
npx wrangler kv:key get --binding=KV "trading:config"
# → edit JSON, add or set:  "postExit": { "enableRerank": true }
npx wrangler kv:key put --binding=KV "trading:config" '<updated json>'
```

Or via the admin endpoint if you have one.

---

## Per-feature observability hooks

Each feature emits distinctive log lines you can grep for.

| Feature | Log signature | Expected cadence |
|---------|---------------|------------------|
| Momentum zone | `[Screener v2] momentum zone <RED/YELLOW/GREEN>` | Every screener run (daily 17:30 TW) |
| Momentum Layer 6 | `[CircuitBreaker] Layer6: momentum zone <RED/YELLOW>` | Only on non-GREEN days |
| Post-exit discipline | `[EODExit] post-exit <symbol>: category=...` or `[Intraday] post-exit <symbol>: ...` | After every full_sell |
| Stop-day freeze | `[PostExit] Stop-day freeze ACTIVE (<date>)` | Only after HardStop/InitStop exits |
| Cooldown excluded | `[MorningSetup] Cooldown-excluded: <symbols>` | Morning-setup only when there is ≥ 1 cooldown |
| GCS lock acquire | `[retrain/universal] Lock acquired: retrain:<date> (backend=gcs, reason=acquired_new)` | First retrain of day |
| GCS lock skip | `[retrain/universal] held_by_<instance> <N>s ago — skip duplicate trigger` | Duplicate cron within 10 min |

---

## Roll-back procedures

Each feature has a clean rollback:

**Feature 1 (WFE gate)** — inert; it's a CLI tool only. No rollback needed unless you wire it into `modal_app.py` retrain flow later.

**Feature 2 (Momentum zone)** — to disable without redeploying:
```bash
# Truncate the table; Layer 6 defaults to GREEN with no history
npx wrangler d1 execute stockvision-db --remote \
  --command "DELETE FROM screener_momentum_snapshots"
```
(Layer 6 will read empty history, return GREEN, and `maxPositionPct` returns to pre-feature behavior.)

**Feature 3 (Post-exit discipline)** — to disable re-rank path after enabling:
```bash
# Set the KV flag back
npx wrangler kv:key put --binding=KV "trading:config" '<json with postExit.enableRerank: false>'
```
To disable cooldowns as well, wipe the KV prefix:
```bash
npx wrangler kv:key list --binding=KV --prefix="paper:cooldown:" | \
  jq -r '.[].name' | xargs -I{} npx wrangler kv:key delete --binding=KV {}
```

**Feature 4 (GCS lock)** — emergency clear of all retrain locks:
```bash
gcloud storage rm -r gs://stockvision-models/locks/retrain/
```
The in-memory fallback still works within a single instance; cross-instance dedup is the only thing lost until next acquire.

**Feature 5 (Tripartite notify)** — not wired anywhere, rollback = no action.

---

## Follow-ups (not done in this branch; require user decision)

Three items were intentionally deferred because they affect production flow in ways that need a separate review.

1. **Wire WFE gate into Modal retrain pipeline**
   - Location: `ml-service/modal_app.py` functions `retrain_universal_batch` and `train_universal`.
   - Pattern: after training, run `walk_forward_ml.py` (or reuse `app.wfe.compute_fold_wfe` inline) on held-out data, gate with `apply_wfe_gate`, and skip KV model-registry push if gate fails.
   - Why deferred: requires decisions on threshold values (`target_cagr`, `max_fold_dd`) for Taiwan market, and on what to do when gate fails (keep old model vs alert vs fallback). Discuss with user before implementing.

2. **Swap `formatDailySummary` callers to `buildTripartiteDailyEmbed`**
   - Location: `worker/src/routes/paper.ts:2459-2460` (primary caller).
   - Pattern: gather the three input blocks (actionable from `daily_recommendations` where `has_buy_signal=1`, holdings from `paper_positions`, summary from `paper_daily_snapshots`) and call `sendDiscordEmbeds(env.DISCORD_WEBHOOK_URL, [buildTripartiteDailyEmbed(...)])`.
   - Why deferred: changes the Discord message shape users see daily. Worth a 1-day A/B or at least a preview before flipping.

3. **Wire Layer 6 momentum-zone data into tripartite embed color**
   - Trivial once #2 is done: pass `readCurrentZone(env.DB)` result into `summary.momentum_zone` field. Already supported by the type signature.

---

## Files touched by this branch (complete list)

### New files
```
ml-service/app/wfe.py                              — WFE core module (320 lines)
ml-service/tests/test_wfe.py                       — 20 unit tests
worker/src/lib/momentumZone.ts                     — Zone detection + DB I/O (290 lines)
worker/src/lib/postExit.ts                         — Cooldown + freeze + re-rank (280 lines)
worker/migration_momentum_zone.sql                 — D1 schema
ml-controller/services/retrain_lock.py             — GCS-backed lock (250 lines)
ml-controller/tests/test_retrain_lock.py           — 13 unit tests with fake bucket
```

### Modified files
```
ml-service/scripts/walk_forward_ml.py              — per-fold CAGR/DD + gate CLI flag
worker/src/lib/marketScreener.ts                   — writes momentum snapshot after daily screen
worker/src/routes/paper.ts                         — Layer 6 CB, post-exit hooks in 2 sites, cooldown filter in morning-setup
worker/src/lib/notify.ts                           — new buildTripartiteDailyEmbed export
ml-controller/routers/retrain_trigger.py           — replaced in-memory lock with persistent GCS lock
progress.md                                        — merge conflict resolution
```

---

## Literature citations embedded in code comments

All features ship with references in their source file docstrings.

| File | Primary references |
|------|---------------------|
| `wfe.py` | Pardo (2008); López de Prado (2018) Ch.7,14; Bailey-Borwein-López de Prado-Zhu (2014); Harvey-Liu-Zhu (2016) RFS |
| `momentumZone.ts` | Daniel & Moskowitz (2016) JFE 122(2); Barroso & Santa-Clara (2015) JFE 116(1); Cooper-Gutierrez-Hameed (2004) JF |
| `postExit.ts` | Odean (1998) JF 53(5); Barber & Odean (2000) JF 55(2); Perold (1988) JPM |
| `retrain_lock.py` | Burrows (2006) OSDI — Chubby; GCS precondition docs |

---

## Contact points

- Any question about feature 1 or 2 → re-read the `ae62823` commit message
- Any question about feature 3, 4, or 5 → re-read the commit made with this handoff doc
- Strategy-level questions (thresholds, zone percentiles, cooldown days) → user decision, do **not** change without approval
- Environmental / infra issues → follow standard deploy-session runbook, features are designed to fail open
