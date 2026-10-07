# 3004 漲跌顯示參考價漏接

狀態：本地修補與驗證通過，Wei已明確批准本次commit＋僅Pages前端部署，發布進行中。Worker/Proxy/Controller/Research與交易規則不需變更。

## Root cause / evidence

- 正式Pages provenance source17d3806836857caa46964ba85456b16fff62b997。候選工作樹c84a90df的frontend與該source完全相同，沒有混入未發布前端變更。
- 正式KV intraday:price:3004：price121、reference_price=null、as_of2026-10-07T03:46:10.400Z，updated_at03:46:11.290Z。
- 只讀Proxy /display-quotes當次3004無90秒內成交，因此未返回3004；8039有price290.5/price_chg-5，可推導reference295.5。
- Paper事件170547/170507（11:45/11:40）signal.previousClose121.5。現有Worker /pending-buys已在execution_preview.daily_assessment.previous_close保留這項當日基準。
- 正式BotDashboard只從currentDisplayPrice(live,cached,now)取得reference；helper又把所有reference和price一起用90秒過濾，沒有接daily_assessment。因此fresh cached price121能顯示，但兩份報價都缺reference時顯示漲跌待更新。

## Fix

僅修改frontend/src/lib/pendingBuyDisplay.ts、pendingBuyDisplay.test.ts、pages/BotDashboard.tsx。

- 最新價格仍須有效、非未來時間且90秒內；不以基準或舊報價製造新價格。
- broker reference優先；同一交易日已觀察的reference不因報價安靜90秒而失效。仍不能跨交易日沿用。
- 即時/快取reference缺失時，可用同日execution_preview.daily_assessment（或完整訊號）的有效previous_close與已確認時間。無效/負時間/未來/跨日/無時間證據均拒絕。
- D1 checked_at無timezone時明確按UTC解讀，不依使用者瀏覽器時區。
- fallback標示「當日基準昨收」，tooltip说明沿用當日進場基準；不將它宣稱成新抓到的broker除權息參考價。

例：最新121、當日基準121.5 => -0.5元/-0.41%。若所有價格均過期，仍顯示報價待更新。

## Verification

pendingBuyDisplay在Asia/Taipei與UTC均通過，包括上述3004實際值、同日舊reference、跨日重置、broker優先、無效時間/基準、沒有或過期報價不造價。既有pendingEntryChecklist六項回歸通過，歷史通過不會變成當前送單資格。最終npm run build（TypeScript/Vite）通過；git diff --check通過。

依賴junction使用C:/tmp/stockvision-main-deploy-892e/frontend/node_modules；兩份package-lock JSON完全相同，byte hash差異僅文字格式。Browser工具kernel因Windows deny-read ACLs初始化失敗；未做瀏覽器視覺驗證，沒有聲稱正式畫面已變更。受保護Worker endpoint回401，診斷改採正式KV/Proxy/PaperD1＋精確Pages source。

build log：output/atr-warmup-repair/display-reference-build.log。根目錄unrelated changes未改。

## Release boundary

Wei已明確批准本次commit＋Pages部署。只提交上述三個frontend檔與本報告，使用現有Pages來源驗證部署工具。發布前核對正式Pages仍為17d38068、remote main仍為53e7474b；候選HEAD的原frontend與正式來源一致。發布後核對production-provenance與正式bundle含此fallback，不發布Worker或更動送單邏輯。不要強迫成交或重置資料。
