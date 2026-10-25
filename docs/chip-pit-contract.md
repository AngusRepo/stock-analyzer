# Chip PIT contract（籌碼挑戰者，`chip-pit-features-v1`）

R33 11/1 月訓的「籌碼模型」挑戰者專用。**不改** 7 個主模型的 131 contract（`formal131-without-unverified-daily-owners-v1`）；21 個 `chip_*` 特徵與 131 不重疊（`services/chip_pit.py` import 時檢查）。

- Contract：`data/feature_registry/chip_pit_feature_contract_v1.json`（與 `services/chip_pit.py` 常數由測試綁定）
- 程式：`ml-controller/services/chip_pit.py`（controller image 與 Modal image 都有 `services/`）
- 回補：`tools/chip_pit_backfill.py`
- 每日紀錄：`tools/finlab_v4_remote_backfill.py` daily refresh 結束時呼叫 `record_daily_capture`

## 資料與來源

| 類別 | 欄位（FinLab key） | 單位 | 推定公告（TW） |
|---|---|---|---|
| institutional | 外陸資／投信／自營商(自行)／自營商(避險) 買賣超股數 | 股 | 17:00 |
| margin | 融資今日餘額、融券今日餘額 | 張（×1000 換股） | 21:30 |
| lending | 借券賣出餘額、借券餘額 | 股 | 21:30 |
| turnover | 成交股數（比率分母） | 股 | 14:30 |

全部來自既有 FinLab capture（`gs://stockvision-models/finlab/v4/backfill/<capture>/raw/`），回補不呼叫 FinLab、不寫 D1。

## PIT 規則

訊號日 s 的截止 = **s 晚上 L3 讀到的那份 FinLab capture**（L3 在 evening chain 推論；早上 08:45 只跑 downstream，見 `premarket_pipeline.py`）。

1. **截止時間 cutoff(s)**
   - 有實際 capture：s 當天第一份 `backfill_status=ready` capture 的寫入時間（observed）。
   - 沒有：s 21:00 TW（`infra/gcp-scheduler-jobs.json` 的 `evening-chain` `0 13 * * 1-5` UTC；rule_presumed，測試綁定）。
   - 補跑造成 cutoff(s) > cutoff(s+1) 時，下修成 cutoff(s+1)（只會拿掉資訊）。
2. **觀測可得時間 available_at**
   - observed_capture：該 capture 檔案的 GCS 寫入時間（取得時間的上界）。
   - rule_presumed：資料日 + 推定公告時間 → 融資券、借券在歷史上一律 **d+1 才可用**；法人、成交量當天可用。
3. **vintage**：同一 (stock, data_date) 以最早觀測值為準；之後 vendor 改值只計數（`revised_after_first_seen`），不套用。整張表全空（vendor `empty`）不算觀測。
4. **視窗**：特徵列要等 20+1 個 session 視窗內每筆觀測都可得才能用；s 取「data_date ≤ s 且視窗可得 ≤ cutoff(s)」中最新的一列。
5. 已上市但當天不在表內的股票保留 null 列，不把舊值往後帶。

實證（`finlab-v4-daily-*` manifest `source_key_reports`，2026-07～10，65 個有 ready capture 的交易日）：第一份 ready capture 中位 21:00 TW；法人 same-day 62/65；融資券 same-day 12/65、借券 12–13/65，其餘是 `empty`。所以 rule_presumed 對融資券／借券取 d+1，與 serving 實況一致。

## 特徵（不設常數門檻；分母為 0 或 null → null；暖身不足 → null）

- 法人：`chip_inst_{foreign,trust}_net_vol_{5,20}`、`chip_inst_dealer_net_vol_5`、`chip_inst_total_net_vol_{1,5,20}` = Σ買賣超 / Σ成交量
- 融資券：`chip_margin_bal_chg_{1,5,20}`、`chip_short_bal_chg_{5,20}`（餘額變化率）、`chip_{margin,short}_bal_vol_20`（餘額股數 / 20 日均量）、`chip_short_margin_ratio`
- 借券：`chip_sbl_sell_bal_chg_{5,20}`、`chip_sbl_bal_chg_{5,20}`、`chip_sbl_sell_bal_vol_20`

## GCS 佈局（`gs://stockvision-models/chip-pit/v1/`）

- `history/<build_id>/{institutional,margin,lending,turnover}.parquet` + `manifest.json`（sha256、來源 capture、anchors、coverage gaps）
- `features/<build_id>/features.parquet` + `manifest.json`（`panel_sha256`、`features_sha256`、history manifest sha256）
- `daily/<business_date>/<capture_id>/<class>.parquet` + `receipt.json`（部署後每日，immutable）

panel 欄位：`stock_id, signal_date, <21 features>, chip_<class>_data_date, chip_<class>_basis`。

## W1 介面（R33 月訓 lifecycle）

```python
from services.chip_pit import load_panel, attach_chip_block
panel, chip_manifest = load_panel(bucket, "chip-pit/v1/features/<build_id>/manifest.json")
# 只在籌碼挑戰者 profile；X/feature_names/dates_arr/symbols_arr 是 universal_training 的 prep 陣列
X_chip, names_chip, chip_proof = attach_chip_block(X, feature_names, dates_arr, symbols_arr, panel)
```

- `load_panel` 驗 contract 版本、`features_sha256`、`panel_sha256`、無未來 data_date。
- `attach_chip_block` 依 (stock_id, signal_date) 逐列對齊；panel 沒有的列 → NaN；symbol 的 `.TW` 類後綴會去掉；名稱與既有特徵重疊直接拒絕。
- 主 7 模型不呼叫這兩個函式；131 prep 與 `FEATURES131` 檢查不變。
- 月訓的 build_id 與 manifest sha256 要寫進挑戰者 candidate 的 lineage。
- 11/1 之後的月訓：每月重跑回補工具（同一指令，`--end` 改成訓練截止日），部署後的 `daily/` 紀錄會自動成為 observed 來源。

## 指令

```bash
# 1) 補缺口（一次性，Modal finlab_v4_backfill，需 Wei go）：融資券＋借券 2023-03-01 起全歷史，只寫 GCS
#    payload: {"run_id":"chip-pit-gapfill-<date>","years":3,"write_d1":false,"apply_canonical_d1":false,
#              "lanes":"chip_diversity","gcs_bucket":"stockvision-models","source_start_date":"2023-03-01",
#              "source_end_date":"<最新交易日>","key_scope_json":"{\"chip_diversity\":[\"margin_balance\",\"short_balance\",\"security_lending_balance\",\"security_lending_sell_balance\"]}"}
# 2) 回補與特徵（本機或任何有 GCS 讀權限的地方；--upload 才寫 GCS，需 Wei go）
python tools/chip_pit_backfill.py --start 2023-03-01 --signal-start 2023-04-06 --end <訓練截止日> \
  --build-id chip-pit-<date> --out-dir <tmp> --bulk chip-pit-gapfill-<date> finlab-v4-3y-20260701-1782951243148 finlab-v4-5y-20260517 \
  --daily-since 2026-07-01 --require-complete --upload
```
