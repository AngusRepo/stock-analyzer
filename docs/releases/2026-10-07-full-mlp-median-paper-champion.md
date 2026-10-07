# Full MLP median Paper champion：切換候選

狀態：本地驗收完成，Wei 已明確批准本次 commit、push、部署、Paper 設定與兩組前向切換；正式生效以發布後 readback 為準。未重新訓練、未真實下單。基底為正式 HMM release `bdf904c74e2e1e72b3c3889aa7b5e4a884905612`，使用隔離工作樹。

## 模型與核心行為

正式 Paper champion 從固定單 seed TabPack 改為原始 E0 Full MLP median：

`score(date, symbol) = Anchor(date, symbol) + median(Δ42, Δ43, Δ44)`

λ 固定 1；Half shadow 為 λ=0.5。median 對同一股票、同一天的三個完整模型殘差取值，不是平均三個 seed、不縮放 Anchor、不使用報告分數或股票清單。既有原始 34 個輸入、128 寬度、三個 residual blocks、LayerNorm/GELU、inner/full scaler、label RMS 與 Anchor 均完整保留。66 個 FP32 tensor 與原 checkpoint 精確一致。模型缺漏、身分、checksum、配方或來源不符時拒絕整份模型／計畫，不靜默變成單 seed 或 Anchor。

完整權重以私有 GCS 的三個內容定址 NPZ 保存，設定只引用其 SHA、路徑、長度；22 個 tensor／seed 由完整 loader 驗證並載入。總權重 1,170,212 bytes，設定約 19 KB；不截斷網路。格式禁止 pickle，限制容器解壓大小，快取也驗證物件長度。原始訓練 L3 與目前 serving L3 分別記錄，沒有偽造相同 lineage。

候選 checksum：`3ecdc98a80b22dede5fe99649225f98865cde83e08c348a30572b9a5623e7928`。

Paper mode：`single_b_full_mlp_median_v1`。原 TabPack mode 保留供歷史讀取與回滾。新模型仍使用既有全池稀疏配置器、OPB、五檔上限及風控；不存在額外 Top-K 預選。OPB 綁定新 model/policy 身分，以 cold start base 開始，不挪用 TabPack reward。帳戶、成交歷史、費用、OR15、持有／出場與 live gates 的設定不變。

## 相依範圍

- Controller：完整模型 exporter／loader／推論、配置計畫、release／admission、runtime grant、OPB 身分、B tag、單 B 模式、每日 refresh、月更的配方／dispatch／恢復命名空間、OOF lifecycle 與相關 API。
- Worker：完整模型／mode gate、recommendation metadata、排程依賴、maturity 顯示與 native Paper 執行鏈。Frontend 顯示實際 champion 與三 seed／λ。
- Modal：新增完整三 seed 月更 candidate job；沿用原 E0 因果 OOF、內層選 epoch、完整資料重 fit 流程。這次沒有執行訓練。候選不會自動升級正式。
- 原三臂前向及 HMM risk-v3 前向：分別保留原 M/H/T checkpoint、protocol、帳戶與風控 owner；只以明確 role transition 允許 live champion 為 M。T 仍是固定正式 TabPack seed42/member5，不改成 TabPack median。
- 新 native release 有獨立 KV approval key；保留原 HMM approval，不繼承模型成熟度／效力。

正式部署須協調 Worker、frontend Pages、Controller、Modal source 及十個共用 Controller image jobs：`active8-oof-materialize`、`dataset-snapshot-export`、`l4-distribution-refresh`、`optuna-research-sweep`、`pipeline-v2`、`s12-structure-batch`、`screener-v2`、`strategy-mining-research`、`verify-v2`、`weekly-backtest-research`。只改 image/source provenance，不觸發工作或重新訓練。工具型 min0/min1 jobs 不屬於此 image。

## 驗收證據

私有證據位於 `output/mlp-cutover/`，已 gitignore；不得把完整設定、授權、帳戶或憑證加入 Git。

| 驗收 | 結果 |
|---|---|
| 原 checkpoint、Anchor 與 adapter | 66 個 tensor 精確相等；700 檔原始 adapter 完全一致 |
| 原 E0 九個 score columns | Full 最大誤差 3.7252903e-8；Half 1.8626451e-8；容許 1e-6 |
| 完整全池配置 | 700 檔，無 preselection，認證 gap=0，約 3.13 秒 |
| 模型／權重／切換／月更測試 | 43 passed |
| lifecycle／refresh／歷史恢復／路由測試 | 41 passed |
| Worker native Paper 與 release/mode 合約 | 17 passed，包含 Full 完整 compact artifact 走真實 Paper engine |
| 前置 Python 回歸 | 73 passed；與上述部分重疊，不相加宣稱獨立測試數 |
| Worker／frontend | TypeScript、frontend production/PWA build、Worker dry run 通過 |
| 私有 GCS | 三物件已 staging；真實 loader 清空快取後冷讀與 SHA 驗證通過 |
| 兩組前向 successor | 各 700 檔、九欄比對誤差 0、樣本 0；尚未發布 |
| 切換／回滾包 | grant chain、完整 configuration checksum 與 source vectors 驗證通過 |

最終本地 canonical native identity：`native-paper-v1:bd5664cc7791ac18797c66f8c181709a18a2a3118badbecd19fb749433dbd1f5`。必須從 `worker/` 編譯；Linux image build 的獨立 attestation 必須與宣告相等，否則不得導入流量。

全池配置是 10/06 凍結 source 的工程驗證，使用實際帳戶結構但不構成新的前向訊號；publication=false、orders=0。尚無可聲稱已完成的 10/07 prospective plan。新模型必須等待下一個真正 canonical source／交易日的計畫，不能把舊 targets 改名當成 Full 的新 plan。

## 前向封存

前向協定保留原定 120 個共同成熟訊號日且六個完整月，day60 的預登記檢查不變；不改成事後 40 日規則。保留舊 cohort，不重寫樣本。發布前重新讀取兩個 live head，必須仍是已驗證的 armed、零樣本與零成熟狀態；若已收樣本則停止，建立經審查的新 transition，不能沿用過期零樣本假設。

| Job | 新 successor runtime SHA |
|---|---|
| `l4-three-arm-forward` | `5bc0ffa9b8940042eecffea9625f16fde0095a8d27dea73d3ebeb6cd7937a1c1` |
| `l4-three-arm-forward-risk-v3` | `cbf84f716e1a97d92414141f78e892d390956415e73079ed52f13ec2048e3312` |

第一個可計入訊號日依實際部署／封存時鐘決定。不得回填尚未在決策前封存的當日資料。四個既有前向排程的設定保留；發布 successor 時更新各自 image/archive prefix，risk-v3 另須驗證 shared daily risk owner 與 Worker approved source SHA。

## 發布與回滾

1. 批准後先重讀 live Worker／Controller provenance、原設定、runtime approval 與兩組 forward head；若有變更，重建切換包並重新驗證。只提交本隔離工作樹的相關檔案。
2. Commit/push 後以該 SHA 建立 Controller image 與 native attestation；保持既有 secret bindings、帳戶、服務變數、HMM 與 live gates。Modal 只部署來源，不執行 training function。
3. 先以獨立 key stage 新 Paper runtime grant，保留原 approval。協調 Worker／Controller／共用 jobs／frontend 與正式設定切換；設定快取失效後 readback 必須匹配。未全部驗收前不手動觸發交易／新計畫。
4. 兩組 forward successor 以各自新封存 namespace／image 初始化；重新確認 H/T 仍為 shadow，M/H/T 原始模型與成熟樣本數不被改寫。
5. 驗收 canonical production bundle PASS、完整 MLP artifact/λ=1、native/source checksum、計畫 owner／新 policy identity、shared daily risk、shadow head/scheduler。下一個 canonical plan 必須呈現真正 Full 計分；只宣告已觀察到的結果。
6. 不符則切回 private rollback config 與原 Worker/Controller/job image、原 release key／forward image；不清帳戶、不刪成交／封存、不轉移 reward 或成熟度。

2026-10-07 唯讀 production bundle 檢查曾遇到 HTTP500；Cloud Run request log 明確記錄 no available instance，非模型例外。重查已回 HTTP200、PASS、drift_fields=[]、real_order_writes=0；這是目前 TabPack 正式版本的 admission 健康證據，不是新候選已部署的證據。

依據：原 checkpoint／frozen runtime、兩組 live armed head、原 HMM release source、實際 KV config/admission/account 結構，以及本工作樹的 executable tests。效力仍為 `unproven`，工程驗收不等於前向獲利證據。
