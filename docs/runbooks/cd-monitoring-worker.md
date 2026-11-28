# 監控 Worker（stockvision-monitoring）的 CD 部署

適用：`.github/workflows/deploy-cloudflare.yml` 的 monitoring 單元，程式在 `tools/deploy_units.py`（`monitoring_planned`、`monitoring_decision`）。

## 怎麼決定要不要部署

- 監控 Worker 的路由全部在 Cloudflare Access 後面，沒有公開的 live version；live tag 只能用 Cloudflare token 讀，token 只在需要 Wei 核准的 `cloudflare` job 裡。
- `plan`（不需要 token）只把 monitoring 標成 candidate，條件是：`units=monitoring|all`；這次本來就要部署 Worker 或 Pages；或者從「上一次確認點」到 HEAD 之間動到 monitoring 的輸入；或者最近 50 個 run 都找不到確認點。
- 確認點：最近一個 `cloudflare` job 裡 `Verify monitoring Worker` 成功的 run 的 commit。沒有部署任何東西的 run（main 已前進、被 reject、cancel、失敗）不算確認點，所以那段變更會留給下一輪。
- `Decide monitoring Worker`（有 token）讀 live 之後再決定：live 等於 HEAD，或 live..HEAD 沒動到 monitoring，就跳過；動到了就先 gate、再部署、最後 verify。live 不在 main 歷史上時直接失敗。
- `units=monitoring|all`（workflow_dispatch）會強制部署：只要 live 不等於 HEAD，就算 live..HEAD 沒動到 monitoring 也照樣部署。live 已經等於 HEAD 時仍然跳過，不會重新建立 version。
- Decide 失敗時（包含 `wrangler versions view` 失敗、live 不在 main 歷史上），Worker 和 Pages 照常部署，監控 Worker 不部署；`Verify monitoring Worker` 會在 job 最後失敗，整個 run 變紅，也不留確認點。

## 哪些情況會連 Pages 一起擋住

- **Deploy monitoring Worker 失敗**：後面的 Deploy Pages、Verify Pages 都會被 skip，run 變紅。只有 Decide 失敗可以不擋 Pages。
- **只有 monitoring 要部署，D1 又有 pending migration**：`Require applied D1 migrations` 會失敗，後面的 step（包含 Pages）全部被 skip。先套用 migration，再重跑。

## 注意：不會把 rollback 固定住

- **live 讀成空字串**（沒有 100% 流量的版本、tag 不是 SHA，或 `wrangler deployments status` 暫時失敗）時，視為「要部署」，會用 HEAD 覆蓋，gate 只檢查 HEAD。`wrangler versions view` 失敗則不同：`--live` 會直接報錯，走的是上面「Decide 失敗」那條路，不會部署。
- **刻意 rollback**：用 wrangler 把監控 Worker 退回舊版、但沒有 revert main 的話，只要舊版到 HEAD 之間動過 monitoring，下一個會檢查 monitoring 的 run 就會把它覆蓋回 HEAD。任何 Worker 或 Pages 部署都會檢查 monitoring，所以通常就是下一次 Worker/Pages 部署。
- 要保留 rollback，請在 main 上 revert 對應的 commit，不要只在 Cloudflare 上退版。
