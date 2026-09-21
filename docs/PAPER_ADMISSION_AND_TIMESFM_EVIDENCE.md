# Paper 主策略與 TimesFM evidence（2026-09-21）

Wei 本次批准 A 直接以 Paper 試驗資格啟用，取代先等待 L3 NAV 入場的舊規則。
A：八模型，價格 TimeXer 取代 DLinear，L4 三頭。B：外生 TimeXer＋三頭＋EV MLP，持續配對比較。
此決策不表示 NAV PASS、收益優越或實盤授權。既有模型與 OOF 重用，不重訓。

## 執行契約

- 使用原 `run_active8_ensemble_bundle_promotion_controller` 原子指標／歷史／回滾交易。
- Paper receipt 綁定 L3、L4、21 項工程驗收、現行風控、執行設定與來源指紋。
- KV `ml:active8:paper_admission:v1` 必須與原始 receipt 完全相同；撤銷或設定漂移會停止 serving。
- 原 NAV-only publication reader 對 Paper 返回空值，不借用或捏造 NAV 通過。
- Controller／Modal 的模式為 `paper_ensemble`，`buy_authorized=false`、`live_buy_authorized=false`，只開啟 `paper_buy_authorized`。
- 實盤 gateway 在存在 Paper admission 或無法確認 scope 時拒絕提交；實盤開關保持關閉。
- B 以 A 作為新帳本的 baseline，兩臂同起點／資金／費用；舊紀錄不改寫、不轉移成熟天數。
- 成交扣原價；退費估計為 `max(0, 原價手續費 - max(20, 原價手續費 * 0.25))`，次月 10 日待確認入帳才成為現金。

## TimesFM：歷史决策與證據限制

Obsidian：
- `02_Products/StockVision/Sessions/2026-06-22-stockvision-timesfm-sidecar-directioncorrect-ga-promotion-repair.draft.md`
- `02_Products/StockVision/Sessions/2026-06-24-stockvision-timesfm-l2-sidecar-and-active-8-l3-migration.draft.md`
- `02_Products/StockVision/Sessions/2026-06-25-stockvision-timesfm-followup-registry-moved-to-l2-feature-release.draft.md`

6/22 紀錄將負向 OOS／live IC 列為取消 TimesFM 直接 alpha 投票的原因；同日也修過 direction_correct 無效值污染。這不是已完成 L2 增量收益驗證的證據。
6/24 決定把它作為 L2 輔助特徵／不確定性資訊，並要求資料物化、成本、OOS/live 驗證與配套 L3 重訓。當時完成的是工程遷移。

原始同批 512 筆版本比較：`ml-service/benchmark_results/timesfm20_vs_25_migration_supported_contexts_compare.json`。

| context | TimesFM 2.0 IC | TimesFM 2.5 IC |
|---|---:|---:|
| 60 | -0.048528 | +0.032705 |
| 128 | -0.024540 | +0.049009 |
| 256 | +0.020508 | -0.010468 |

這比較的是版本／視窗，不是完整八模型有無 L2 的消融實驗。無法據此宣稱 L2 改善收益。
正式 `v20260612T160113_timesfm25_ctx1024` 的原始 GCS config 明列 `pending_oos_for_context_1024`。
長歷史比較檔 `timesfm20_vs_25_long_history_compare.json` 的 `contexts=[]`，只有 runtime 指標，不是 1024 OOS 通過。

本次恢復的是驗證過 checksum 的 diagnostic evidence：`timesfm-verified-evidence-v1`，直接 alpha 維持禁止，未經特徵重訓的 L3 不接收新增欄位。
GCS config SHA256：`4a50cf7c81ba719e50da5837d5986ac1430368210d787ad7c9dc8d9bfae678b9`。
Controller 傳遞凍結 checksum，Modal 核對實際 bytes，cache 以版本與 checksum 區分。

## 驗證與操作

本機原生 SQLite publisher、Controller／Modal frozen inference、失效／竄改／撤銷拒絕及實盤 gateway 阻擋均需通過。
跨 Worker 時鐘實測領先本機 0.205 秒；在既有讀取允許的 5 秒範圍內等本機追上，不放寬 observed-before-freeze。
本機可明確設定 `NATIVE_PAPER_RUNNER` 使用同 Dockerfile 打包的 Worker；manifest 持續雜湊實際執行器與原生程式。
完整 P9 與相同 source SHA 部署讀回完成後，才依批准 receipt 切換。營運 receipt 另存 audit，勿把本文件當成功上線證據。
