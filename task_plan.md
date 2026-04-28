# V2 Regression Baseline

## Goal
建立一套可重複執行的 V2 regression baseline，先驗證目前 repo 能跑的靜態檢查與高風險 smoke，再依此順序修復 review findings。

## Scope
- Worker type-check 與高風險 paper trading / admin auth / scheduler 路徑
- Frontend build 與可見 UX 破損
- ml-controller / ml-service Python 語法與關鍵模組 smoke
- 必要的 live contract 檢查：Cloudflare D1、GCP、Modal baseline 與 proxy contract 現況

## Phases
- [completed] Phase 1: 建立 baseline checklist 與驗證順序
- [completed] Phase 2: 執行靜態檢查（worker/frontend/python compile smoke）
- [completed] Phase 3: 執行高風險 smoke / live contract 驗證
- [completed] Phase 4: 彙整結果，標記 blocker / quick wins / 修復順序
- [completed] Phase 5: 修復 worker 高風險問題（proxy contract / provenance / admin auth / SQL / scheduler）
- [completed] Phase 6: 修復 ml-service 缺 chips schema drift
- [completed] Phase 7: 重新驗證 frontend mojibake / broken labels（目前 source 未重現）
- [completed] Phase 8: 修復 prod hardcoded defaults cleanup

## Baseline Checklist
1. Worker `tsc --noEmit`
2. Frontend `tsc --noEmit && vite build`
3. `ml-controller` Python compile/import smoke
4. `ml-service` Python compile/import smoke
5. Proxy contract reality check
6. D1 data-shape checks for predictions / recommendations / scheduler
7. 將結果寫回 `findings.md` 與 `progress.md`

## Review Findings To Regress
1. Plan A proxy contract mismatch
2. Morning setup latest-prediction provenance bug
3. Admin route auth boundary inconsistency
4. Momentum gate 20-day average volume SQL bug
5. Missing chips schema drift
6. Scheduler next-run / heatmap correctness
7. Hardcoded production config drift
8. Frontend mojibake / broken labels

## Notes
- 不做 deploy、retrain、commit、push、真單操作。
- 先驗證可重現與可監測，再開始修 bug。

## Baseline Result Snapshot
- Worker `tsc --noEmit`: pass
- Frontend `npm run build`: pass（sandbox 內 `esbuild` spawn EPERM，非 sandbox build 正常）
- `ml-controller` py_compile smoke: pass
- `ml-service` py_compile smoke: pass
- Cloudflare D1 remote query: pass
- GCP `ml-controller` describe: pass
- Modal profile/app list: pass

## Current Fix Status
- Fixed: Plan A proxy contract mismatch on Worker side
- Fixed: morning-setup prediction/date binding
- Fixed: admin read-route auth boundary for scheduler/costs/debate/adaptive
- Fixed: momentum gate recent-20-volume SQL
- Fixed: scheduler named-DOW parsing + heatmap job id
- Fixed: ml-service missing-chips schema stability
- Fixed: env-driven CORS / worker URL / CF IDs / GCP job config cleanup
- Fixed: config_pool worker URL fallback removal
- Checked: frontend mojibake finding does not reproduce on current source; build remains green
- Remaining: deeper config coverage audit for non-critical scripts / services
