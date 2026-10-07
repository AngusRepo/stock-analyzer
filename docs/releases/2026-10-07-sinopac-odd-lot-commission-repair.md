# 永豐零股低收與含費成本精確修補

狀態：本地修補及驗證通過。Wei於本次對話明確批准「Commit push deploy」；開始提交、推送此修補分支、部署Worker／Pages及套用先前提案的指定Paper帳務更正。正式完成證據將另附發布紀錄。

## Root cause / verified policy

正式Paper config費率0.001425、minCommission20，所有買賣原先共用Math.round(value*rate)與20元下限，沒有傳入實際成交股數，因此零股也收20元。BotDashboard又以avg_cost作「買入價」並取一位小數，混淆成交與含費成本。

永豐官方批次下單說明及其目前公開程式明列零股成交价金*0.1425%、最低1元；官方手續費FAQ說明費用小數捨去。低收與折扣月退是分開規則，不以20元低收先扣再說多收額是退費。

- https://www.sinotrade.com.tw/inside/Batch_Order
- https://www.sinotrade.com.tw/inside/dist/view/Batch_Order/js/main.nw.min.js
- https://www.sinotrade.com.tw/richclub/Decoding_Stock/video/-65645bd51c0a5012c8480876
- https://www.sinotrade.com.tw/ec/upload/Service-charge.pdf 頁0：一般月退次月15日，假日提前。

Wei提供2.5折月退。未取得專屬方案逐筆／委託彙總與月退進捨位，不新增自動月退，不把估計退費加現金，不改既有凍結A/B fee_terms或研究帳本。

## Forward code fix

calcCommission必須傳實際成交股數，避免遺漏盤別。使用現有buildTwOrderLegs將整股與零股分開計費；整股保留cfg最低費，零股最低1；gross佣金小數捨去。顯式零費率／零低收研究fixture保持0。所有買進、換股賣出、強制／EOD／盤中全額及部分賣出、rescore、手動買賣，以及淨報酬風控估費，共12個呼叫點傳入對應實際股數。月退折數不作用於先扣現金。

單元案例：31股@122 gross5；1股@122 gross1；999股成交10000 gross14；1000股成交10000 gross20；1000股成交20000 gross28；1001股成交10010為整股20+零股1；1331股@122為分盤別230。拒非有限／非正價金、非安全整數／非正股數。commission接近2但仍不足2時不加epsilon進位。

前端只將「買入價」改為「含費均成本」、顯示兩位小數，加上含買進手續費說明；不改損益基礎或成交紀錄。

## Order96 correction prepared

唯讀正式D1核對：3004 order96於2026-10-07 04:10:21 UTC買31股@122、commission20、total_cost3802；position2 shares31/avg_cost3802÷31/entry122；settlement84 amount3802、settled0、settlement_date2026-10-12。Account1 settled cash933951.13。當日3004僅此一筆order。

正確gross佣金5、total_cost3787、avg_cost3787÷31=122.16129032258064。尚未交割，修正T+2應付3802→3787會使available buying power增加15，settled cash不動；這15是費用更正，不是月退。

tools/repair_paper_3004_odd_lot_fee_20261007.sql先以精確order／position／settlement條件建立correction事件，再同批修正三份資料，保留order note及原event170752/R2證據；附fee_correction、完成事件。任何股數／佣金／交割狀態／新成交改變均不執行，重試不重複。正式SELECT使用相同guard目前ready；發布後仍需fresh guard。只有account1/order96，不修改其他歷史訂單或研究帳戶。

批准後以鎖定Wrangler4.100.0的--command傳完整SQL，不使用--file大檔import。已查該版本source：command走一次/query，Cloudflare官方API接受以分號連接的SQL batch；整批執行，不逐項遠端提交。

## Verification

- paperTradeMath單元通過，含3004實值、1元下限、捨去／邊界、混合盤別及無效輸入。
- paperSwingNative共13個原生流程通過。新增odd_lot_fee以真實shared買賣call path：31股@20部分買成交費1、T+2應付621、含費成本621÷31、settled cash不變；次日hard stop賣31股費1。既有board buy佣金29→28預期依官方捨去調整。
- 帳務更正及l4NativeLedger共7測試通過：更正、購買力／現金守恆、原證據保留、重試不重複、四種狀態變動拒絕、故障整批回滾。
- Worker source/tests兩份TypeScript檢查通過；Wrangler部署dry-run通過；前端TypeScript/Vite build通過；diff check通過。
- Browser工具kernel ACL限制仍存在，未做視覺render驗證。

主要log／證據：output/atr-warmup-repair/odd-fee-native.log、odd-fee-correction-tests.log、odd-fee-typecheck.log、odd-fee-worker-dry-run.log、odd-fee-frontend-build.log、odd-fee-repair-ledger-preflight.json、odd-fee-repair-settlement-preflight.json、odd-fee-correction-guard-readback.json。

## Proposed release scope

正式Worker目前43fa60f029a64d0f82d6684ade93c013214e9d6b（e3d9cb99-8c53-46e1-8b36-6b88aa047961），Pages e06698d1118d2c8cb4ef54f58a1e6187148ee4ce。兩者fresh只讀核對通過。候選HEAD77b3483f包含這兩項已發布修補。

本次只commit必要source／tests／guarded correction SQL／此報告，push修補分支，部署Worker及Pages，fresh核對後更正order96一次。Proxy、Controller、Research、交易門檻／ATR／L5／真實交易開關不變，不重跑交易cron。永豐實盤成本與損益介面的完整串接不在本次發布範圍。
