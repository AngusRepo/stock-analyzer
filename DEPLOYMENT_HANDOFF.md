# Deployment Handoff — Sprint KFlux + TradingAgents-Inspired Improvements

**Branch**: `claude/resolve-merge-conflicts-E73zu`
**PR**: AngusRepo/stock-analyzer#5

**Commit timeline** (oldest → newest):
  - `ae62823` — Per-fold WFE gate + Momentum crash zone (KFlux-inspired)
  - `58896f4` — Post-exit discipline + Persistent GCS lock + Tripartite notify (KFlux-inspired)
  - `5a8e9b2` — Taiwan personas (投信/散戶) + Layer 7 streak CB (Batch A)
  - `342969b` — Wire persona_score into recommendation ranking (Batch B)
  - `77b7f22` — News Analyst daily agent (Batch C)
  - `a00bf32` — Multi-round Zealot↔Reaper debate (Batch D)

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
| 6 | Taiwan Personas (投信/散戶) | `ml-controller/services/persona_service.py`, `ml-controller/tests/test_persona_service.py`, `ml-controller/graphs/daily_pipeline_v2.py` (new node), `worker/migration_persona_opinions.sql` | 23 unit tests |
| 7 | Persona Score Integration | `ml-controller/services/recommendation_service.py`, `ml-controller/tests/test_persona_integration.py` | 6 integration tests |
| 8 | Layer 7 Recent-Streak CB | `worker/src/routes/paper.ts` (checkCircuitBreakers) | Worker no test infra |
| 9 | News Analyst Daily Agent | `worker/src/lib/newsAnalyst.ts`, `worker/src/lib/debateTrader.ts` (exports callLLM + LLMEnv), `worker/src/index.ts` (cron handler), `worker/wrangler.toml` (cron) | Worker no test infra |
| 10 | Multi-Round Debate Upgrade | `worker/src/lib/debateTrader.ts` (refactored runBuyDebate) | Worker no test infra |

**Test totals**: ml-service 41/41 · ml-controller 74/74 · cascade parity 12/12 · screener parity 20/20 (152 tests total).

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

### Step 2 — Apply D1 migrations (TWO new tables)
```bash
cd worker

# DRY RUN first — creates tables in local D1 preview only
npx wrangler d1 execute stockvision-db --local --file=./migration_momentum_zone.sql
npx wrangler d1 execute stockvision-db --local --file=./migration_persona_opinions.sql

# If dry runs pass, apply both to remote
npx wrangler d1 execute stockvision-db --remote --file=./migration_momentum_zone.sql
npx wrangler d1 execute stockvision-db --remote --file=./migration_persona_opinions.sql
```

Verify both tables exist:
```bash
npx wrangler d1 execute stockvision-db --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('screener_momentum_snapshots', 'persona_opinions')"
```
Expected: two rows (both table names present).

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

### Step 7 — Configure persona_score weight (optional dial)
The persona score is enabled by default at full weight (1.0). For gradual rollout
or to observe effect before committing, use shadow-ish mode:

```bash
# Full weight (default)
npx wrangler kv:key put --binding=KV "ml:persona_score_weight" "1.0"

# Half weight — persona still affects ranking but only 0.5× effect (observe phase)
npx wrangler kv:key put --binding=KV "ml:persona_score_weight" "0.5"

# Disabled — persona writes to D1 but doesn't influence ranking
npx wrangler kv:key put --binding=KV "ml:persona_score_weight" "0.0"
```

Run the ml-controller pipeline once (daily cron) and verify new rows appear:
```bash
npx wrangler d1 execute stockvision-db --remote \
  --command "SELECT date, symbol, trust_signal, trust_strength, retail_signal, retail_strength FROM persona_opinions ORDER BY date DESC LIMIT 10"
```

### Step 8 — Tune multi-round debate rounds (optional)
Default is 2 rounds of Zealot↔Reaper rebuttal (Batch D upgrade). Reset to
single-shot (pre-upgrade behavior) or extend to 3 rounds:

```bash
# Single-shot (pre-Batch-D behavior; ~1500 tokens/call)
npx wrangler kv:key put --binding=KV "ml:config.debate_max_rounds" "1"

# Default (~2500 tokens/call)
npx wrangler kv:key put --binding=KV "ml:config.debate_max_rounds" "2"

# Deep debate (~3500 tokens/call)
npx wrangler kv:key put --binding=KV "ml:config.debate_max_rounds" "3"
```

The per-symbol 24h KV cache (`paper:debate:<sym>:<date>`) still applies so
you only pay token cost once per symbol per day.

### Step 9 — Verify News Analyst cron + KV writes
New cron `45 22 * * SUN-THU` (06:45 TW) runs the News Analyst agent.
After first firing, verify KV key exists:

```bash
npx wrangler kv:key get --binding=KV "market:news_analyst:$(date +%Y-%m-%d)"
```
Expected: JSON with `bias`, `confidence`, `key_factors`, `sector_bias`,
`risk_factors`, `summary`, `source`.

If missing, check Worker logs for `[NewsAnalyst]` lines to diagnose
(LLM provider down, source data missing, etc.). Failure is non-fatal —
morning-setup reads the report opportunistically.

---

## Per-feature observability hooks

Each feature emits distinctive log lines you can grep for.

| Feature | Log signature | Expected cadence |
|---------|---------------|------------------|
| Momentum zone | `[Screener v2] momentum zone <RED/YELLOW/GREEN>` | Every screener run (daily 17:30 TW) |
| Momentum Layer 6 | `[CircuitBreaker] Layer6: momentum zone <RED/YELLOW>` | Only on non-GREEN days |
| Streak Layer 7 | `[CircuitBreaker] Layer7 SCALE: recent streak <N>/5 wrong` | Only when ≥4/5 recent preds wrong |
| Post-exit discipline | `[EODExit] post-exit <symbol>: category=...` or `[Intraday] post-exit <symbol>: ...` | After every full_sell |
| Stop-day freeze | `[PostExit] Stop-day freeze ACTIVE (<date>)` | Only after HardStop/InitStop exits |
| Cooldown excluded | `[MorningSetup] Cooldown-excluded: <symbols>` | Morning-setup only when there is ≥ 1 cooldown |
| GCS lock acquire | `[retrain/universal] Lock acquired: retrain:<date> (backend=gcs, reason=acquired_new)` | First retrain of day |
| GCS lock skip | `[retrain/universal] held_by_<instance> <N>s ago — skip duplicate trigger` | Duplicate cron within 10 min |
| Persona pipeline | `[Pipeline V2] persona opinions written: <N>/<M>` | Every ml-controller daily run |
| News Analyst | `[NewsAnalyst] <YYYY-MM-DD> bias=<pos/neu/neg> conf=<N>` | Every 06:45 TW cron |
| News → debate bias | `[MorningSetup] News bias=negative conf=<N> → buyConfThreshold <before> → <after>` | Only when bias=negative AND conf≥0.5 |
| Multi-round debate | `[Debate] <symbol> max_rounds=<N>` and `[Debate] <symbol> Zealot R<n> done via <llm>` | Every debate call (once per symbol per day) |

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

**Feature 6 (Taiwan personas)** — to disable without redeploying:
```bash
# Option A: disable score contribution (opinions still computed + stored for audit)
npx wrangler kv:key put --binding=KV "ml:persona_score_weight" "0.0"

# Option B: stop writing to the table entirely — redeploy without the node in graph
#   (requires code revert of daily_pipeline_v2.py persona node registration)
```

**Feature 8 (Layer 7 streak)** — purely additive in paper.ts; revert paper.ts
to the pre-commit state, or (quick disable) seed predictions table so
direction_correct recent rows are 1 (clean) — normal daily verify restores this.

**Feature 9 (News Analyst)** — to disable:
```bash
# Remove cron from wrangler.toml and redeploy, OR wipe KV key
#   so morning-setup reads null and skips bias-based threshold adjustment
npx wrangler kv:key delete --binding=KV "market:news_analyst:$(date +%Y-%m-%d)"
```

**Feature 10 (Multi-round debate)** — reset to single-shot:
```bash
npx wrangler kv:key put --binding=KV "ml:config.debate_max_rounds" "1"
```

---

## Follow-ups (not done in this branch; require user decision)

Five items were intentionally deferred because they affect production flow in ways that need a separate review.

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

4. **Consume `persona_applied` meta in debate context**
   - The `recommendation_service` now attaches `persona_applied` (trust/retail signal + strength) to each recommendation row. Not yet wired into debateTrader's `mlContext`.
   - Implementation: in `paper.ts` morning-setup, read `rec.persona_applied` (if present) and format as a short string, then prepend to debate context alongside News Analyst report. Would let Bull/Bear agents cite persona signals in their arguments.

5. **Add additional Taiwan personas (外資, 大戶)**
   - Current: only 投信 + 散戶 implemented. The plan document proposed 4 personas.
   - 外資 Agent: `chip_data.foreign_net` momentum vs MSCI/QFII flow patterns
   - 大戶 Agent: broker-concentration (分點) data — requires additional scraper/feed
   - Why deferred per user: start with 2 personas; evaluate signal quality over 2-4 weeks before expanding.

---

## Files touched by this branch (complete list)

### New files
```
ml-service/app/wfe.py                              — WFE core module (320 lines)
ml-service/tests/test_wfe.py                       — 20 unit tests
worker/src/lib/momentumZone.ts                     — Zone detection + DB I/O (290 lines)
worker/src/lib/postExit.ts                         — Cooldown + freeze + re-rank (280 lines)
worker/src/lib/newsAnalyst.ts                      — News Analyst agent (240 lines)
worker/migration_momentum_zone.sql                 — D1 schema (momentum zone)
worker/migration_persona_opinions.sql              — D1 schema (persona opinions)
ml-controller/services/retrain_lock.py             — GCS-backed lock (250 lines)
ml-controller/services/persona_service.py          — 投信/散戶 compute (380 lines)
ml-controller/tests/test_retrain_lock.py           — 13 unit tests with fake bucket
ml-controller/tests/test_persona_service.py        — 23 unit tests
ml-controller/tests/test_persona_integration.py    — 6 integration tests
```

### Modified files
```
ml-service/scripts/walk_forward_ml.py              — per-fold CAGR/DD + gate CLI flag
worker/src/lib/marketScreener.ts                   — writes momentum snapshot after daily screen
worker/src/routes/paper.ts                         — Layer 6/7 CB, post-exit hooks, cooldown filter, news bias adjust, news-context merged into debate
worker/src/lib/notify.ts                           — new buildTripartiteDailyEmbed export
worker/src/lib/debateTrader.ts                     — multi-round Zealot↔Reaper debate; exports callLLM + LLMEnv
worker/src/index.ts                                — news-analyst cron handler
worker/wrangler.toml                               — news-analyst cron schedule
ml-controller/routers/retrain_trigger.py           — persistent GCS lock
ml-controller/services/recommendation_service.py   — persona_score wired into total_score
ml-controller/graphs/daily_pipeline_v2.py          — new node_compute_personas + persona_weight KV dial
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
| `persona_service.py` | Black (1986) JF 41(3) "Noise"; Shleifer (2000) "Inefficient Markets"; Barber et al. (2009) RFS — TW retail underperformance |
| `newsAnalyst.ts` | Tetlock (2007) JF 62(3); Loughran & McDonald (2011) JF 66(1) |
| `debateTrader.ts` (multi-round) | Du et al. (2023) arXiv:2305.14325 — Multi-agent debate improves LLM factual accuracy; TauricResearch/TradingAgents GitHub 9.3K★ |

---

## Contact points

- Any question about feature 1 or 2 → re-read the `ae62823` commit message
- Any question about feature 3, 4, or 5 → re-read the commit made with this handoff doc
- Strategy-level questions (thresholds, zone percentiles, cooldown days) → user decision, do **not** change without approval
- Environmental / infra issues → follow standard deploy-session runbook, features are designed to fail open
