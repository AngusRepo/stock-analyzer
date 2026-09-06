# Approved deployment follow-up — 2026-09-06

- Wei approved commit/push/deploy and required follow-up repairs after reviewing the scoped inventory. Previous local-only restriction is superseded for this release, not for formal retraining/promotion/orders.
- Restored deployment wrappers, current worktree and memory. Inspecting origin/main and production source before changes. No remote mutation yet.
- FinLab source repair must precede activating independent-calendar consumers. Missing raw data cannot be replaced by synthetic evidence or a validation bypass.

# Final local status — 2026-09-06

- Implemented archive pointer closure; shared EMA/MACD and true last-20 volume; independent FinLab sessions and exact 3/5/10-session consumers; per-dataset immutable receipts after exact write acknowledgements; immutable sector generations and exact frozen taxonomy on both new and legacy reads.
- Added fixed IPO prospective shadow to existing native snapshot and daily maturity hooks. No production allocator/promotion writes. No credit for four already-inspected research dates. Existing L4 authority and valid frozen maturity remain unchanged.
- Final regression: 275 Python tests passed (18 files), 10 Worker suites passed, Worker/frontend TypeScript passed, Vite production build passed. Final repair-planner partial-OHLCV assertion separately rerun passed (not double-counted).
- Synthetic localhost-only browser tests: 1280/390/320 px; no horizontal overflow, zero page errors; missing/unavailable states pass. Research model SHA256 unchanged.
- Last hardening caught legacy PIT falling back to mutable taxonomy, and data writer acknowledgements comparing reported totals instead of requested counts; both repaired and regression-tested.
- Closure/release report: audits/outbox/2026-09-05-l4-ipo-local-closure/LOCAL_CLOSURE_AND_RELEASE_CHECKLIST.md.
- Production remains untouched. Complete original 8/20 FinLab artifact, actual domain readback, historical label repairs and nightly closure are pending explicit approval. The initial cause of 8/20 omission is not proven; do not claim otherwise.

# Earlier implementation log — 2026-09-05 (superseded by final local status above)

- Canonical/archive/sector regression: 107 Python tests passed. New source-calendar and receipt SQLite tests pass 2/3; remaining test fixture needs import registration, fixed awaiting rerun. Worker horizon and session guard tests pass.
- Immutable sector generations: 4 focused SQLite tests pass, including submillisecond cutoff discrimination with deterministic clock. SQL julianday loses precision; new generation timestamps use fixed-width UTC microseconds and lexical comparison.
- IPO fixed model matches sealed phase8 models.json SHA256. Added candidate/prediction/batch/evaluation tables, live-day-only freeze hook and mature join hook, no formal pointer/allocation mutation. Existing research dates receive no prospective credit.
- Same-page IPO component/API drafted; types, integration, failure/retry tests and browser screenshots pending. Do not report closure yet.

- Technical parity: 30 cross-language fixtures passed (EMA warmup, full prefix, last-20 volume invariance). Compare identically defined seed components only; Python raw seed total is not Worker ScoreV2 final aggregate.
- FinLab skill fully re-read. Source confirmed manifest is written before Market domain writes and per-run metadata overwrites prior dataset receipts; PIT consumer still reads mutable membership despite existing immutable taxonomy snapshots.
- Implementing immutable complete sector generations with producer readback and exact historical taxonomy IDs; no historical publication timestamp backdating.

- Restored AGENTS rules and Obsidian receipt, existing research evidence, current worktree status and historical plans.
- Read planning, React performance, webapp-testing and PDF skills; FinLab full re-read pending after combined-output truncation.
- First local fix in progress: unified authenticated archive reader accepts generic dataset snapshots, validates checksum and original row/run identity; OOF SQL and Python client discover and resolve both pointer formats. Tests pending.
- User explicitly chose local completion with release checklist before commit/push/deploy and production backfill.
- Archive tests: Python 6 passed; generic Worker identity/checksum/auth suite and existing legacy suite passed using parent workspace tsx (no worktree node_modules). First attempted local tsx path missing; resolved with explicit parent runner and NODE_PATH.
- Canonical MACD helper added for Worker/Python; indicator and recommendation fallback share the same warmup; avg20 now uses last 20 bars in both scoring paths. Cross-language tests pending.
- A multi-file patch partially applied before an unexpected import shape; inspected diff and applied only remaining hunks. No sealed evidence changed.
- Handoff PDF extraction had encoding noise; historical documents only, current source remains authoritative. Need UTF-8 recheck of relevant excerpts.

---

# Historical progress — StockVision

## Session 2026-05-11

### Portfolio
- Total: $1005316 (0.53%)
- Positions: 0 | Cash: $1002159
- MDD: 11.5% | Sharpe(30d): 0.39840838026112807

### Today's Pipeline
- Screener: 64 → ML BUY: 3 → T2: 0 orders
- Trades: 0 BUY / 1 SELL

### Positions
No positions.

### Model Health
- Degraded: DLinear(IC=-0.030231)
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

# 2026-08-14 — P0, L4 Lineage, and 10-Year D1 Closure

- Loaded `planning-with-files`, `security-best-practices`, relevant JavaScript/React/FastAPI references, and `vercel-react-best-practices`.
- Recalled Obsidian notes for L4/Fusion, OOF lineage, D1 architecture, prior P0 closure, and the 2026-08-08 full-pipeline audit.
- Verified Worker and ml-controller production both use immutable source `6e468f5e` from 2026-08-08.
- Created isolated worktree `C:/tmp/stockvision-p0-lineage-d1-closure-20260814` on `codex/p0-lineage-d1-closure-20260814`.
- No production mutation performed.

## Validation log

| Check | Result |
|---|---|
| Cloudflare deployment provenance | PASS; source SHA and 100% version confirmed |
| ml-controller provenance | PASS; source SHA, image digest, revision and 100% traffic confirmed |
| Dirty-workspace isolation | PASS; new clean worktree from production SHA |

## Current phase

Phase 0 — restore source, memory, and planning.

## Next actions

1. Read the most relevant Obsidian notes and prior audit report.

## Phase 0 complete

- Read the five relevant Obsidian notes and recovered the scope/cadence/storage decisions.
- Phase 1 started: production incident and freshness audit for 2026-08-08 through 2026-08-14.
2. Inventory current L4/L4+ source and production state.
3. Audit 8/8–8/14 runtime incidents in parallel with D1 capacity/ownership checks.

## 2026-08-14 local closure verification

### Implemented

- Repaired L4/L4+ candidate identity, cadence, shadow pairing, serving-pointer semantics, and same-contract history comparison.
- Added exact legacy/learning identity migrations and pre-copy fail-closed guard.
- Closed Active-8 immutable candidate overwrite and direct-refresh dead promotion paths.
- Added bounded evidence, terminal truth, screener recovery, scheduler canonical truth, callback redaction, and learning-domain D1 routing safeguards.
- Registered all durable D1 ownership and added recursive FK/delete reconciliation without enabling strict routing.

### Validation log

| Check | Result |
|---|---|
| Worker full TypeScript type-check | PASS |
| Frontend TypeScript + Vite production build | PASS; 2,624 modules transformed |
| Frontend maturity wiring | PASS; 3/3 |
| Worker maturity/identity/serving/Multi-D1 tests | PASS |
| Worker storage/scheduler/screener recovery tests | PASS |
| ml-controller targeted P0 suites | PASS; 136/136 |
| callback security/retrain contract | PASS; 9/9 |
| Python syntax compile on modified call paths | PASS |
| Exact identity migration | PASS; byte-identical/idempotent/existing cadence preserved |
| Production mutations | NONE |

### Deployment boundary

- No commit, push, deploy, D1 migration, job execution, retrain, full-fit, promotion, or order was performed.
- Strict Multi-D1 cutover remains blocked by direct legacy references and missing domain outbox/inbox ownership.

## Workers AI cross-review

- Invoked a real Cloudflare Workers AI Mistral model through a localhost-only temporary Worker; prompt contained only sanitized architecture/evidence summaries.
- Completed two-turn adversarial review and evidence challenge.
- Result: no new repo-supported blocker; retained existing D1 cutover and L4/Fusion quality blockers only.
- Temporary Worker processes, source/config, logs, and local ports were removed after the review.
