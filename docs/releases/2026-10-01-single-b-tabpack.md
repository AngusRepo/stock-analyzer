# 單一 B＋TabPack Paper 發布

狀態：本地實作與驗證完成。Wei 已明確回覆「批准本次完整 Paper 發布」，包含提交、推送／main 整合、部署與精確 Paper 寫入。發布進行中，最終狀態以遠端讀回為準。

## 決策與範圍

Wei 2026-10-01 指示開始替換殘差 MLP，採用 B，停止 A，收束資源。

- 唯一正式 Paper 策略：外生 TimeXer 所屬的八組 L3 → L4 三頭 → TabPack 殘差校正 → 原完整池配置器／OPB。
- 保留八組中的 TabM。TabPack 取代殘差 MLP。
- 固定既有比較協議 seed 42，採原 validation 選定的 member 5；不按測試期最高收益挑 seed，不重訓。
- 保留 OR15／VWAP 進出場、推薦進場參考價、TP1／TP2、停損及硬風控。選股 A 與 OR15「A 機制」是不同層。
- 沿用 Paper account 1、現金、持倉、交易與歷史 NAV；不清倉、不重置、不補造缺失績效。真實送單維持關閉。
- 既有費用／退費記帳與風控上限維持現行設定；研究的折扣成本不直接改寫帳戶可用現金。

## 資源收束

明確的 single_b_tabpack_v1 配置必須通過完整 Paper artifact 驗證，才會停用比較：

1. 保留正式八模型推論，停用額外比較模型與 A/B 候選分派。
2. 保留正式配置封存；不建立新的 A/B 配對帳戶。
3. 盤中配對 tick 在載入大型私有帳戶／D1 前回傳可驗證停用收據。正式 Paper 下單、退出、snapshot 不受此收據停用。
4. 晚間直接驗證正式 B 計畫，不再執行 A/B NAV 比較、候選晉級或比較顯示重算。
5. 正式 B 計畫顯示於 B 卡；舊 A 計畫仍保留 A 身分。歷史比較由使用者展開時讀取，背景輪詢停用。

## 證據

原始產物：主 workspace 的 audits/b-optimization-20261001/rollout/。

- export-verification.json：19,162 筆，與研究輸出最大差 2.235e-8；單筆／排列核對通過。
- actual-full-pool.json：1,910 檔完整池，9.53 秒；推論與 native features 一致、原 L3 baseline 保留、沒有 Top-K 預選。
- learning-cycle-proof.json：實際凍結 TabPack、合成帳戶／行情的 281 原生時段；精確重播、成本後帳戶 reward、次日原 OPB 消費同策略 reward。此例是現金日，不宣稱實際獲利。
- engineering-tests.xml 55、integration-tests.xml 116、packet-tests.xml 15、worker-tests.log 14：共 200 項通過。涵蓋 Paper 原子核准、live flags、持倉延續、成交／部分成交、資金保留、稅費、硬退出、零配對呼叫及舊 A 相容性。
- Worker 型別及前端 production build 通過。未宣稱已做雲端負載驗證或前瞻績效驗證。
- 發布封包修正了原 L4 ASCII JSON checksum 與 journal UTF-8 checksum 的交接不一致；保留各自原 serializer，新增中文內容及篡改拒絕測試。

模型 checksum：9f179226aa7f5255d9221107386d377addcef29e5fdcd91e9d8be63fb6879a33。

## 核准與部署順序

AGENTS.md 要求 Wei 明確批准 commit、push、deploy。新模型使用新的原始 Paper admission，不沿用只允許舊 runtime 調整的補充核准。

1. 審核 release-summary.json、cutover-packet.json、paper-admission-proposal.json 與本次程式差異。
2. 批准後提交、推送／併入 main，透過既有來源追蹤流程發布 Controller／必要 Jobs、Worker 與 Pages。若 main 有新增變更，先檢查整合差異與執行指紋。
3. 從不可變發布 image 讀回執行版本；重新驗證配置、L3 pointer、account head、plan parent 與 live flags。不得以未提交本機指紋冒充正式版本。
4. 確認無執行中委託後，寫入精確新配置及新 admission，透過原 atomic ensemble publisher 切換 B 的 L3；讀回兩層模型。跨 KV／D1 並非單一原子交易，過渡期間新買單應阻擋，硬風控退出繼續。
5. 以保留的帳戶建立新的 B 計畫；驗證 pending buys、首頁、正式帳戶、盤中 tick、晚間路徑及 reward 歸屬。不得用改名舊 A plan 代替新 B plan。
6. 完成以上才宣告正式上線。OPB 從新策略自己的 reward 開始，舊 A 的樣本不轉入 B。

## 回滾

發布時發現原 D1 batch 重複綁定大型 Paper admission：56 statements 共 26,012,703 bytes，HTTP 500，讀回確認模型 pointer 未提交。純 SELECT length 同一份 1,966,113 bytes 證據：1 份通過、11 份重現 500。修補讓第一個 pointer 綁定完整證據一次，後續 pointer/history/ensemble pointer 在同一 CAS transaction 中引用它；證據內容與回讀檢查不變。載荷降至 6,110,783 bytes；遠端 28 個原 CAS guards＋1 份證據的唯讀測試全部通過、零寫入。大型 SQLite 證據測試驗證各 pointer/history 完全相同及中途失敗全部回滾。Cloudflare 官方單列上限為 2,000,000 bytes；此次逐列均低於該值，未以拆交易方式規避限制。來源：https://developers.cloudflare.com/d1/platform/limits/；原始結果見 d1-readonly-payload-probe.json、d1-reduced-payload-probe.json、atomic-payload-diagnostic.json。

cutover-packet.json 保存原配置及模型指標；current-paper-admission.json 與 current-runtime-approval.json 保存舊核准證據。若正式讀回不符，阻擋新買單，保留硬風控退出、帳戶與交易紀錄；回復先前已核准 image/config/admission，透過既有 pointer 控制恢復模型。不得刪除已發生交易，亦不得直接套回舊帳戶現金。
