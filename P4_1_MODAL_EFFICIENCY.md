# P4.1 Modal Efficiency Plan

目標：提升 Modal / ML runtime 效率與可觀測性，不用降規格換省錢。

## 已完成

- 補 Modal 成本估算：CPU、memory、GPU 分開計價，寫入 `cost_events`。
- 補 direct remote / map 呼叫遙測：controller 端可看到 Modal function、wall time、aggregate compute seconds。
- 補 retrain follow-up 成本閉環：`retrain_orchestrator` 完成後回報 orchestrator、feature selection、tree、FT、DLinear、PatchTST、SHAP runtime。
- 補 Model Pool IC 診斷：UI 區分 raw IC rows、weekly windows、last IC status，避免把 0 誤判成沒有資料。
- 補 universal model load cache：Modal warm container 內避免重複下載與反序列化同一份 universal artifact。
- 補可切換 batch predict contract：預設仍用穩定的 `predict_single_stock`，`MODAL_PREDICT_BATCH_V2=1` 才啟用 chunked batch。

## 優化順序

1. 先部署遙測，不改 production predict path，收集真實 Modal cost / runtime 分布。
2. 跑一次 `model-ic-tracker` 或 `/model_pool/compute_weekly_ic`，確認 10 組 model 都有 raw IC rows 與 weekly windows。
3. 用同一批 morning recommendation payload 做 A/B benchmark：current map vs `MODAL_PREDICT_BATCH_V2=1`。
4. 只有在 latency 不惡化且 cost / cold-start 明顯下降時，才把 batch predict 變成預設。
5. 依 cost_events 排名前幾名 function 再調整 CPU / memory / GPU / scaledown window，不先猜硬體配置。
6. 若 batch predict 確認有效，再往下一刀做 feature matrix / artifact IO 共用，避免每支股票重建相同上下文。

## 不做

- 不為了省錢降低 FT / sequence model GPU 規格。
- 不在沒有 benchmark 前把 predict path 改成單一大 batch。
- 不讓 Modal 直接寫 D1；仍透過 controller callback 維持 owner 邊界。
