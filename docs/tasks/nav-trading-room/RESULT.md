# NAV trading room — local verification complete

## Scope / root cause

The existing pipeline PairedNavShadow was an accounting-count/status summary. It exposed no daily NAV amounts, positions or original simulated fills, so it was not an account-comparison view. Added a read-only view in the existing trading room instead of creating another ledger or promoter.

- `/bot` preserves current Paper; `/bot?tab=nav` opens lazy NAV comparison. Browser back/forward works.
- Candidate/baseline raw NAV, daily returns/delta, cash, stock utilization, costs, drawdown, positions and sealed simulated fills. Date cutoff supports historical inspection; longest displayed window is 90 records, explicitly labeled and earlier dates remain selectable.
- Pipeline keeps collection progress and navigation; existing stage NAV decisions/blockers remain unchanged.
- New admin/service-authenticated Learning read endpoints; no-store, bound query parameters and date/pair validation. No new tables, migrations or mutation endpoints.
- Original Python journal hashes, predecessor chain, pair identity, receipt parts/manifest hash and original content hash checked. Preserve Python number bytes rather than reserialize JS numbers.
- Absent/corrupt receipts do not become zero trades; corrupt journals do not become zero assets. Unavailable valuations remain null. No EV/pre-outcome data converted to NAV.
- Existing pre-outcome preservation changes in this worktree remain untouched except integration-test extension and pipeline summary placement.

## Verification

- 22 Python tests passed: test_nav_candidate_decision.py + test_nav_daily_primary.py. Includes original journal -> Worker -> React, and existing actual gate/receipt consumers.
- Original Python-origin Worker room test: 2 pairs and 2 verified execution receipts; NAV/cost equality, historical cutoff, missing/tampered receipts, tampered journals, no writes, authentication, invalid dates/pair and no-store HTTP response passed.
- 9 frontend unit/wiring tests passed; original NAV SSR rendering also passed.
- Worker and frontend TypeScript checks passed; frontend production build passed. Existing non-blocking Browserslist age warning remains, not changed in this task.
- Python Playwright / headless installed Edge, all APIs intercepted: desktop 1440px, mobile 390px, no whole-page horizontal overflow, stacked accounts, selector/date filter, refresh of both list and detail, error/empty/invalid/missing states, Paper switch/browser back. No runtime page errors or mutation requests.
- Manual screenshot inspection found crowded mobile holdings columns; corrected spacing/minimum table width. Additional repair: split pure presentation helpers from apiClient to preserve server rendering.

## Evidence (synthetic, NOT production performance)

- `C:/tmp/sv-navroom-20260913-2/` — isolated original Python integration artifacts.
- `C:/tmp/sv-navroom-20260913-1/browser-fixture.json` — original journal read-model export used for visual tests; synthetic accounting scenario, not ROI proof.
- `C:/tmp/sv-navroom-20260913-1/browser-final/` — screenshots and result.json.
- `frontend/scripts/nav-trading-room-browser.py`, `worker/tests/navTradingRoom.ts` — reproducible verification.

## Release boundary

2026-09-13 release preflight: user approved commit/push/deploy. Moved the shared interface into `worker/src/lib/navTradingRoomContract.ts`, because root Dockerfile compiles Worker with `--rootDir src` and did not copy root `shared/`. Frontend still imports the same single type definition. Exact Cloud Run TypeScript compilation, Worker production/test types, frontend types, 62 Controller tests, 9 Worker tests and 10 frontend tests passed. No runtime accounting or gate semantics changed by this packaging repair.

Local only. No commit, push, deployment, production data replay, training, real/paper orders, accounting changes or serving-pointer movement. This UI does not itself create missing paired accounts or advance maturity. This turn's runtime deployment scope would be Worker + Frontend; prior uncommitted Controller repairs are separate changes already present in the worktree.
