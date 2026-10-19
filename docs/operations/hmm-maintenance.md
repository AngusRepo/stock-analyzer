# HMM 自動維護與決策版本一致性

狀態：本地候選；未啟用正式排程、未重訓、未部署。只更新 HMM，不更新 Active8／MLP／TabPack 或其他策略模型。

## 固定行為

- 日線 HMM 每個合格交易日推論；`/regime/current` 維持唯讀，不能 fit／save。
- 每日 14:00、20:00 TPE 的獨立 GCP Scheduler `hmm-maintenance` 包含週末與假日。
- 模型滿精確 7 天，或無法涵蓋官方日曆下一交易日 13:30，才派送更新。7 天是維運起點，沒有宣稱是實證最佳週期。
- 模型有效期維持精確 216 小時，等於邊界可用、超過一秒不可用。其他模型既有 freshness 行為不變。
- 下一交易日距離超過 9 天時先延後獨立維護；每日排程持續檢查，進入可涵蓋的時間範圍才派送。
- 每個實際 HMM 訓練輸入最多 2 次；非模型欄位的 macro 註記變化不重置計數。單一 Modal 任務上限 300 秒，無自動無限重試，GCS 全域 lease 為 600 秒。
- 模型更新過程獨立於 L4。舊模型仍涵蓋決策時間就沿用；不足則在 L4 昂貴運算之前回報 `HMM_MODEL_UPDATE_REQUIRED`，由既有鏈恢復機制重試，不忙等。

## 授權與啟用

只有正式 GCS `market_regime/maintenance-policy.json` 通過下列完整契約才能 fit。repo 內沒有已啟用的授權，測試字串也不是正式批准。

```json
{
  "schema_version": "hmm-maintenance-policy-v1",
  "enabled": false,
  "approved_by": null,
  "approval_ref": null,
  "input_contract": "8b6542b50ea5c57c768e76bd517712e42579141cc1533169f2046cffce1a5e5f",
  "target_prefix": "market_regime",
  "refresh_after_days": 7,
  "max_age_days": 9,
  "max_attempts_per_input": 2
}
```

發布批准須明確包含：commit／push／Worker、Controller、共用 Jobs、Modal 同源部署；僅 HMM 的本次更新及此範圍內的持續自動更新；上述單一排程及必要的獨立 Paper runtime admission。保留策略配置、9 天風控期限、NAV 缺失與成熟度，不授予真實下單。

取得批准後，以實際批准收據填入 `approved_by=Wei`、`approval_ref`、`enabled=true`；寫入 GCS 使用 generation CAS 並回讀。先完成服務同源部署與必要 Paper 准入，再啟用維護政策與排程。不得單獨先啟用政策讓舊 consumer 讀取新版 artifact path。

## 訓練、驗收與切換

1. Controller 讀取最新合格 HMM 資料，檢查官方下一交易日涵蓋時間；歷史請求不得觸發正式維護。
2. Modal 再次讀取正式政策、取得 GCS CAS lease、檢查同一輸入嘗試次數。
3. 使用現有合格、連續六特徵資料與現有 HMM 方法，至少 30 sessions。驗證收斂、normalizer、posterior、轉移矩陣、正定 covariance、輸入及特徵 checksum。
4. 將候選放入 `market_regime/versions/<run>/hmm_detector.joblib`；固定 generation 回讀，先驗 hash 再反序列化與驗收。
5. 保存舊 metadata；重驗 lease／政策後，唯一一次 generation-CAS metadata 切換啟用新版本。候選驗收或 activation CAS 失敗不改正式 metadata。
6. 每次嘗試寫入 `market_regime/maintenance-attempts/<training-input-key>.json`。派送只代表已排隊；正式訓練完成以 admitted receipt 與 metadata 回讀為準。達兩次上限不再派送。

## 推論快取與 L4 銜接

- 每日 HMM 入口先 preflight，快取與 D1 恢復必須同時符合模型 SHA／generation、輸入 checksum、風險品質 checksum 與時序。拒絕的歷史狀態不得寫回 KV。
- 最新已完成交易日的即時決策使用實際推論時刻；明確的歷史重播保留原歷史截止時間，不冒用新模型。
- L4 啟動前固定 `pipeline_hmm_contract`；推薦、配置及正式寫入再次核對。`hmm_lineage` 在 plan hash 生成前納入，並寫入推薦 allocation。
- pending buys 比對 plan／推薦與風控使用的相同模型、輸入、品質身分；不同版本要求重算受影響的推薦與配置，不直接放行。
- 今日已封存 run 不可覆寫或更改模型身分。恢復要形成新的可追溯決策版本；先驗證原資料／個股預測的適用性，再只重算 HMM 影響的下游，不宣稱所有舊預測必然可沿用。
- 模型切換不能直接觸發 L4 全部重跑；目前新增程式沒有另行 dispatch Persona／Atomic／NAV 或 Active8 訓練。

## 回滾

先以 CAS 停用 maintenance policy、暫停該排程；確認沒有持有中的維護 lease，再以目前 metadata generation 為條件，恢復該版本保存的 `previous-metadata.json`。保留候選與嘗試收據，不刪除歷史。舊模型仍需通過既有 216 小時有效期；回滾不會自動恢復買單資格。回滾 consumer 前必須先恢復相容 metadata。

## 驗證邊界

本地測試使用合成資料、假的 fit／GCS／HTTP 與本地 SQLite，不能當成正式訓練、雲端部署、策略效益或已產出可買清單的證明。訓練週期與訓練窗口的效益比較不在本次盤前恢復的必要路徑。
