# RFS 與正式 B sparse 配置比較

## 權責

正式配置仍由 L4 三頭／TabPack／OPB／sparse 決定。比較器只在 `node_write_d1` 成功發布計畫後觀察一次，不建立帳戶、不改配置或委託、不呼叫 LLM、不訓練、不自動晉級。觀察失敗寫入 metrics，不撤銷已成功發布的正式計畫。

## 修補的缺口

舊 RFS 只存在 legacy allocator 分支，正式 `l4_distribution` 提前返回後不再產生資料。舊 owner allowlist 也不接受目前 owner，且凍結候選不含可靠 ADV。直接增加 allowlist 會把約束與成本不同的配置拿來比較，不能採用。

新收據版本 `rfs-b-sparse-comparison-v1` 與歷史資料分開。它是既有 RFS-inspired 靜態成本前緣的工程比較版本，不是論文完整重現，也不是已訓練的 direct-weight 模型。

## 同一份輸入

1. 已啟用 Paper plan 必須與 `allocation_snapshot_id` 對得上。
2. checksum 驗證的 frozen capture 必須與觀察中的 plan 相同；plan 與 account checksum 也必須一致。
3. 讀取全候選池、正式預期報酬、原持倉、同一 covariance／時間尺度、OPB 後的限制與費率。
4. 保留曝險、單檔上限、群組上限、鎖定、禁買、最小部位、最多持倉及可用資金限制，不先 top-k 篩選。
5. sparse 原收據的換倉成本與同帳戶費率重算值必須一致。

## 成交金額與成本

`canonical_market_daily.value` 取訊號日以前、60 個市場交易日內最近 20 筆已報告金額，且必須有訊號日當天資料。使用金額，不猜成交量的股／張單位；缺日保留在 `liquidity_evidence`，不補零、不刪候選。少於 20 筆或最新日缺漏會阻擋整組比較。

兩邊採相同買賣費率及從既有持倉換到目標的增量成本。額外市場衝擊係數 10bps 是研究假設，並非已校準成交模型。尚未模擬最低手續費、OR15 實際成交及逐筆滑價。

RFS 先以 covariance／成本計算靜態 proximal aim，再以該 aim 作線性偏好，透過與正式配置相同的離散限制求解。離散化是工程近似，不宣稱等同精確二次距離投影；MILP 最多 3 秒，未證明可行／最適即拒收。此設計避免為研究資料再跑昂貴的完整二次最佳化。

## 收據與成熟結果

- Learning migration：`0060_rfs_sparse_comparison.sql`。
- `rfs_sparse_comparisons_v1`：plan_id 唯一，原始 packet 不可被重試覆蓋；保存 schema、policy、model、snapshot、實際觀察時間、阻擋原因及 checksum。
- `rfs_sparse_outcomes_v1`：每個 plan 的 5／20 交易日結果各一筆。
- 觀察後第一個完整收盤價作為實驗起點；盤後補看舊計畫不能借用早已發生的行情。
- 結果是相同日期、含成本的固定籃子 adjusted-close 比較，**不是 Paper NAV，也不是 OR15／ORL 完整交易回測**。
- 任一正權重個股缺起訖價格時整組延後；不把停牌／缺價個股從損益分母移除。
- 每次例行觀察最多檢查 40 組未成熟收據，按最後檢查時間輪巡，避免長期缺價堵住後续資料。
- 畫面累積的是有效配置配對與日期；634 檔候選仍只是一組配置。模型／policy 不同分 cohort，5／20 日期不混算。同日起點先平均，再跨日平均；重疊持有期不冒充獨立樣本 CI。

## 發布順序與驗收

1. 核准後套用 Learning 0060 migration，讀回兩張表。
2. 發布 Controller／執行盤前 L4 的 pipeline-v2 image，再發布 Worker／Pages；沿用目前所有硬體設定。
3. Paper 執行身分因 Learning table registry 變動而改變。必須另取得精確 KV 寫入批准；不得自動刷新。
4. 第一份新的、已發布且 frozen capture 一致的計畫開始前向累積。10/2 舊 head 與其首份 capture 不一致，不補造有效樣本。
5. 驗收 plan_id、snapshot、有效／阻擋計數、Worker clock；成熟結果尚未到期時應為 0，不是故障。

回滾：回復匹配的 Worker／Controller／pipeline image 及 Paper 核准值；研究表保留，不刪歷史。正式配置不依賴這兩張研究表。paired morning/day Scheduler 保持 PAUSED，除非另有明確恢復授權。
