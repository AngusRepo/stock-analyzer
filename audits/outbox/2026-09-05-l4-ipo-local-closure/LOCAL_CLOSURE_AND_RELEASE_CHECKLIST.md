# L4 修補與 IPO 同步觀察：本機完成／部署待批准

- 日期：2026-09-05–09-06（Asia/Taipei）。
- 授權：先完成本機修補，部署前列清單確認。尚未 commit、push、deploy、正式資料補跑、正式 ML retrain、promotion、正式配置異動或關機。
- 工作位置：`codex_ev_fix_wt`；分支 `codex/postverify-closure-20260905-v3`；開始 HEAD `e861b0a6fbc0db1b0bf8957e58fa49b0ea04c0c0c0`。
- 結論：本次確認範圍的程式修補已通過本機驗證；正式資料修復與 nightly runtime closure 尚未執行，不宣稱正式環境已修復。

## 保留的決策

1. L4 保持現行多特徵 Ridge 學習、重新排序與原有 promotion 流程，不縮小權責、不改為僅單調校準。
2. 不重新累積或覆寫既有正確 L4 frozen evidence。原研究的 7,744 訓練列及 1,940 前瞻列，不在歷史日曆修復的覆寫範圍。
3. IPO 使用既有研究候選的固定參數，僅 shadow；沒有新增正式配置或自動 promotion 路徑，也沒有新增另一套 nightly cron。
4. 8/25–8/28 四個已看過結果的研究日期不能冒充新 IPO 前瞻成熟日。IPO 上線後才以當日原生輸入封存，五個交易日報酬成熟後比較。L4 既有成熟度不歸零。

## Root cause → 本機修補 → 尚需正式驗證

| 問題 | 本機修補及證據 | 批准後仍需執行 |
|---|---|---|
| Generic audit pointer 未被 OOF SQL／reader 發現，封存 evidence 因此漏讀 | 統一既有 authenticated resolver；驗證 manifest、R2 checksum、原始 run／row／symbol、完整回傳；不遞迴讀 pointer、不以空值替代 | 部署 Worker／controller，抽查原封存資料實際讀回，保留原始時間與身份 |
| Worker EMA 與 Python SMA／不同 MACD warmup，以及 avg20 誤用全歷史均量 | 共用 EMA12/26/9 與 35-bar warmup 定義；均量使用最後 20 bars；30 個跨語言 fixture 通過 | 驗證下一次 native screener／fallback／backtest 相同 seed components；不要把新計算回填成舊原生決策 |
| 整日 8/20 價格缺口被「由已寫入價格推導的日曆」隱藏，導致五日窗口偏移 | 從 FinLab 原始 close 序列建立獨立 session owner；投影前核對 canonical／compatibility coverage；五日及 3/5/10 日標籤與 OOF 下一交易日都讀此日曆 | 取回完整原始 FinLab artifact、補 8/20 OHLCV／adj_close／index／summary／market_risk，再重算確實錯位的標籤；不能只補日曆 |
| FinLab 同 run 不同 dataset 回執互相覆蓋，且資料未寫完先宣告 metadata 完成 | dataset×date 不可覆寫 receipt；compact manifest 合併 lanes；所有 data 寫入確認後才發布 Ops receipt，成功數必須等於實際送出的筆數 | 實際資料 readback；receipt 狀態只叫 write_acknowledged，不冒充逐欄 checksum readback 已完成 |
| Sector rebuild 覆蓋原版本與發布時間；歷史 consumer 使用可變分類 | 完整不可變 sector generation、原始實際發布時間、分類 snapshot ID／checksum／筆數／來源／完成時間核對；舊資料也只讀當時的 frozen taxonomy | 發布下一筆原生 generation；已遺失的歷史版本無法憑今日資料恢復，明確 unavailable，不 backdate |
| 缺少與 L4 同期的 IPO 前瞻觀察 | 當日 native snapshot 完成 readback 後凍結 IPO 與同批 L4；既有 daily OOF continuation 成熟 join；獨立 Learning 表，失敗／不完整不寫成完成 | migrations 與服務上線後驗證真實 freeze → maturity → API → UI；目前只有本機 fixture，沒有正式 IPO 數字 |

8/20「最初為什麼沒有寫入」仍未取得能證明原始事故原因的 producer log；已證明並修補的是整日缺口被漏掉的日曆／驗證機制。不能宣稱查明誰刪除了資料。

## 頁面內容

- 在既有 L4／L4+ 區塊下方新增「L4 × IPO 同步對照」。
- 顯示最新封存日期、封存日數／股票列數、IPO 成熟日數、完整配對日數。
- 每日展開：L4 與 IPO 的 Rank IC、RMSE、同一研究配置 proxy 淨報酬、資金使用率、最大單檔權重及配對報酬差。
- 正值綠、負值紅；RMSE 保持中性色並以百分點顯示。讀取失敗／未成熟／缺少 L4 對照皆不同於報酬為 0。
- 保留原有 session 的數值正負色彩修改；L1:L1.25:L1.5 的 32:32:36 不變。
- 桌面並排、手機堆疊，無狹窄 modal 或橫向捲動。

## 不可誤讀的研究限制

- 固定 IPO 來源：`audits/outbox/2026-09-05-l4-frozen-verification/phase8/models.json`。
- SHA256：`887b0ab6ad8e8a35a1a009eeb8a88a8fec1e47e9799712dd0c2f8c33c2c4b01e`，本次實際核對一致。
- 不新增 fitting。原研究 optimizer 達停止條件不代表最優解或 stationarity 已證明。
- 使用同一 long-only／可保留現金的固定 QP proxy，不是正式 sparse＋OPB，也不是實際連續持倉報酬；無 top-k。
- 五日窗口可能重疊；少量成熟日、個股集中及 clipping 都限制推論。軟體測試通過不等於 IPO 報酬改善已被證明。
- 同日期、同完整股票母體、同成本只扣一次 18 bps。缺一部分 L4 對照不計入完整配對，也不計算優劣增量。

## 最終本機驗證

| 驗證 | 結果 |
|---|---|
| 18 個 Python 測試檔（archive、技術 parity、FinLab、PIT、IPO、Active-8、L4／Fusion／forward evaluator） | 275 passed，14.07 秒 |
| 最後追加的 historical repair 部分 OHLCV 防覆寫斷言 | 同一測試另行重跑 1 passed；不重複累加總數 |
| Worker 10 組：screenerEvidenceResolver、legacyEvidenceResolver、canonicalSessionIntegrity、priceHorizonProjection、priceHorizonProjectionRetry、priceHorizonTerminalStateContract、dataDomainRegistry、ipoShadowReadModel、pipelineDecisionMaturity、eveningChainFullClosureContract | PASS |
| Worker production 與 tests TypeScript；Frontend TypeScript | PASS |
| Frontend Vite production build | PASS；既有 caniuse-lite 過期提醒非 blocking，本次不改無關依賴 |
| Edge 本機合成 fixture：1280／390／320 px | 無水平 overflow、對照內容可見、缺值／錯誤狀態通過、page errors = 0 |
| Browser 隔離 | 所有非 `http://127.0.0.1:5178/` 請求均封鎖；不是 production data |
| git diff --check | PASS（只有既有 CRLF 提醒） |

截圖：`ipo-shadow-1280.png`、`ipo-shadow-390.png`、`ipo-shadow-320.png`，皆為明確標註的合成測試資料。

## 待批准的 release scope

1. Worker：archive reader、technical math、來源日曆及 horizon consumer、D1 owner registry、maturity IPO read model。
2. ML controller：相同 technical owner、archive loader、FinLab source calendar／per-dataset receipts、sector immutable generation／PIT reader、IPO freeze／mature 及既有 daily hooks。
3. Frontend：IPO 同期觀察、contract、保留的正負色彩變更。
4. 修復工具與回歸測試：原始 FinLab 單日離線 repair planner；manual apply 與 daily writer 共用 domain routing、dry-run、寫入順序及回執驗證。
5. 四份 migration：
   - Market `0006_sector_flow_pit_generations.sql`
   - Market `0007_finlab_source_sessions.sql`
   - Ops `0013_finlab_materialization_receipts.sql`
   - Learning `0039_ipo_prospective_shadow.sql`

不以 `git add .` 整包加入。既有 `2026-09-05-l4-frozen-verification` 研究原始資料保持不動；本機 pip 隔離 runtime、node_modules junction、dist 與截圖不屬 production bundle。測試 source／harness 可以保留作可重現驗證。本機 runtime 沒有改正式依賴。

## 批准後的必要順序（尚未執行）

1. 重新 read-only 核對 origin/main、worktree、prod source SHA／image／Worker version；保存 serving pointer 與 frozen evidence checksum baseline，避免覆蓋他人變更或退版。
2. 取回完整原始 FinLab artifact 與受影響 label／Core identity inventory，在本機產出真實 before/after repair plan。原封存的 sequence／部分價格不能代替完整 OHLCV、index、summary。
3. 檢查待套用 migration 是否與正式現況衝突、容量及可回復性，再套用四份 additive migration；不得 reset 資料庫或刪舊證據。
4. **先 seed FinLab 來源日曆並修復 8/20 完整 canonical／compatibility／index／summary／market_risk，readback 通過後才啟用新的日曆 consumer。** 不能先部署 consumer 再任由既知缺口把 chain 擋住。
5. 依 source provenance 部署 Worker、ML controller、Frontend，核對實際流量與版本。若原始資料不可得，整包部署先停，不放寬驗證或製造假資料。
6. 只重投影比對確實 entry／exit 錯位的 3／5／10 日標籤；五日已知影響集中在 8/13–8/19，實際重跑日期由完整 inventory 決定。恢復 archive 可讀性後，依相依關係補跑必要 evidence／metrics，保存前後差異。
7. 不回填新特徵為舊 native prediction、不重訓舊 artifact、不覆寫本來正確的 L4 frozen labels、不把 8/25–8/28 納入 IPO 前瞻成熟度、不移動 formal serving pointer。
8. 下一次原生 daily 驗證完整 IPO snapshot readback、單一 candidate 身份、immutable retry、五日 label join；成熟前顯示 pending，成熟後 API／頁面顯示相同結果。IPO quality 觀察不構成 promotion。
9. 驗證 evening chain 的 producer → receipt → maturity → API freshness，包含故障可見、retry 不重複、正式配置未變。沒有這一步的 runtime evidence，不宣稱 automation closure。

## Obsidian recall receipt

- query: "L4 full-day evidence synthesis data-first IPO parallel shadow"
- status: found
- answer_policy: cite_wiki_hits
- citations:
  - `06_MOC/MOC-Home.md`
  - `02_Products/StockVision/超級連結_moc/MOC-StockVision.md`
  - `02_Products/StockVision/Sessions/2026-09-05-l4-full-day-evidence-synthesis-and-data-first-single-owner-optimization-recommen.draft.md`

原 note 的縮小 L4 權責只是先前建議；本次遵循 Wei 最新明確決策，不實作縮權，另寫新 Session draft 保留決策演進。
