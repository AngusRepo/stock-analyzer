# FinLab Research Digest for StockVision

Generated: 2026-05-13T17:49:38.300Z

## Scope

- Source: FinLab article site, `https://www.finlab.tw/`.
- Coverage target: all WordPress posts, not only VIP articles.
- Storage rule: keep metadata and paraphrased research notes only; do not store article bodies.

## Executive Synthesis

這次不是只讀 VIP 文章，而是把 FinLab 文章站的 WordPress posts 全量索引後分批閱讀：共 `253` 篇，涵蓋 `45` 篇 index 上帶 VIP/限定分類的文章與其他公開文章。實際逐頁閱讀後，因頁面權限/標記方式不同，讀取時有 `29` 篇呈現為 VIP visible/unlocked，其餘為 public visible。

對 StockVision 最有價值的不是單篇策略報酬率，而是 FinLab 文章反覆呈現出的「研究方法論」：

1. 把靈感拆成可驗證因子，先做可得日、樣本期、分群、交易成本與容量檢查。
2. 因子不要直接變成買賣建議，先進 shadow feature / challenger。
3. 回測不能只看年化報酬，要同時看 MAE/MFE、最大回落、換手、流動性、漲跌停、處置股、交割與可成交性。
4. 籌碼與法人資料要上升到產業/主題層級，並和價格位置、成交量、市場寬度一起 gate，避免追高。
5. 美股、世界指數、FRED / BLS / 台灣景氣燈號等資料適合補 morning setup / regime context，但不應直接取代既有大盤 regime engine。

最該導入 StockVision 的不是「某一個 FinLab 策略」，而是把文章中的因子家族、清洗規則、回測檢核與 execution feasibility 變成我們自己的 feature backlog。

## Step 1 Article Index

Indexed articles: 253
Read articles so far: 253

```json
{
  "byTopic": {
    "execution": 27,
    "data / factor": 59,
    "screener": 72,
    "fundamentals / revenue": 17,
    "risk / portfolio": 4,
    "ML / AI": 16,
    "regime / macro": 7,
    "backtest": 16,
    "other": 24,
    "chips / institutional flow": 11
  },
  "byPriority": {
    "P1": 139,
    "P0": 84,
    "P2": 30
  },
  "byAccess": {
    "public_or_unknown": 208,
    "vip_tagged": 45
  },
  "readByTopic": {
    "data / factor": 59,
    "screener": 72,
    "chips / institutional flow": 11,
    "fundamentals / revenue": 17,
    "regime / macro": 7,
    "backtest": 16,
    "execution": 27,
    "ML / AI": 16,
    "risk / portfolio": 4,
    "other": 24
  },
  "readByAdoption": {
    "P0": 84,
    "P1": 139,
    "P2": 30
  }
}
```

Full machine-readable index: `data/finlab_research/article_index.json`
Paraphrased notes checkpoint: `data/finlab_research/article_notes.json`

### Full Article Index

| title | date | section | topic | visible access level | priority |
|---|---:|---|---|---|---|
| [Alpha Arena 背後的技術解析、缺陷與潛力](https://www.finlab.tw/alpha-arena-%e8%83%8c%e5%be%8c%e7%9a%84%e6%8a%80%e8%a1%93%e8%a7%a3%e6%9e%90%e3%80%81%e7%bc%ba%e9%99%b7%e8%88%87%e6%bd%9b%e5%8a%9b/) | 2025-11-05 | PYTHON財經, 加密貨幣, 技術面, 投資新手 | execution | public_or_unknown | P1 |
| [把「靈感」煉成「因子」：從感覺到證據的逆襲](https://www.finlab.tw/factor_analysis_3_factor/) | 2025-08-22 | FinLab 量化平台, Python新手教學, PYTHON財經, 基本面分析, 投資新手, 股票策略, 財經PYTHON教學 | data / factor | public_or_unknown | P0 |
| [復刻與優化 00900 ：使用 IC Decay 優化高股息策略成「長跑軍火庫」](https://www.finlab.tw/%e5%be%a9%e5%88%bb%e8%88%87%e5%84%aa%e5%8c%96-00900-%ef%bc%9a%e4%bd%bf%e7%94%a8-ic-decay-%e5%84%aa%e5%8c%96%e9%ab%98%e8%82%a1%e6%81%af%e7%ad%96%e7%95%a5%e6%88%90%e3%80%8c%e9%95%b7%e8%b7%91%e8%bb%8d/) | 2025-06-03 | VIP文章, FinLab 量化平台, Python新手教學, PYTHON財經, 基本面分析, 投資新手, 股票策略, 財經PYTHON教學 | screener | vip_tagged | P1 |
| [復刻與優化 00919：玩轉高股息 ETF](https://www.finlab.tw/%e5%be%a9%e5%88%bb%e8%88%87%e5%84%aa%e5%8c%96-00919%ef%bc%9a%e7%8e%a9%e8%bd%89%e9%ab%98%e8%82%a1%e6%81%af-etf/) | 2025-05-06 | VIP文章, FinLab 量化平台, Python新手教學, 基本面分析, 投資新手, 股票策略, 財經PYTHON教學, 選股策略 | fundamentals / revenue | vip_tagged | P1 |
| [如何復刻0056高股息ETF，並打造超越市場的進階策略！](https://www.finlab.tw/%e5%a6%82%e4%bd%95%e5%be%a9%e5%88%bb0056%e9%ab%98%e8%82%a1%e6%81%afetf%ef%bc%8c%e4%b8%a6%e6%89%93%e9%80%a0%e8%b6%85%e8%b6%8a%e5%b8%82%e5%a0%b4%e7%9a%84%e9%80%b2%e9%9a%8e%e7%ad%96%e7%95%a5%ef%bc%81/) | 2025-03-25 | VIP文章, FinLab 量化平台, Python新手教學, PYTHON財經, 基本面分析, 股票策略, 財經PYTHON教學, 選股策略 | fundamentals / revenue | vip_tagged | P1 |
| [分散風險的迷思？當心「攤薄」效應！](https://www.finlab.tw/risk-of-diversification/) | 2025-02-23 | FinLab 量化平台, Python新手教學, PYTHON財經, 股票策略 | risk / portfolio | public_or_unknown | P1 |
| [只要 3 個財報指標，報酬率高得驚人](https://www.finlab.tw/fundamental-3-indicators/) | 2025-02-16 | FinLab 量化平台, Python新手教學, PYTHON財經, 基本面分析 | fundamentals / revenue | vip_tagged | P0 |
| [使用月營收與動能策略選股的完整介紹](https://www.finlab.tw/%e4%bd%bf%e7%94%a8%e6%9c%88%e7%87%9f%e6%94%b6%e8%88%87%e5%8b%95%e8%83%bd%e7%ad%96%e7%95%a5%e9%81%b8%e8%82%a1%e7%9a%84%e5%ae%8c%e6%95%b4%e4%bb%8b%e7%b4%b9/) | 2025-01-12 | FinLab 量化平台, Python新手教學, VIP文章 | screener | vip_tagged | P0 |
| [Qlib 與 FinLab 整合，展現 AI 選股的神蹟。](https://www.finlab.tw/qlib-finlab-implementation-source-code/) | 2025-01-06 | AI看股票 | ML / AI | vip_tagged | P1 |
| [Information Coefficient 是什麼，要如何使用？](https://www.finlab.tw/information-coefficient/) | 2024-11-19 | PYTHON財經, Python新手教學 | execution | public_or_unknown | P1 |
| [選股策略分析：運用意圖因子衡量主力的方向](https://www.finlab.tw/linearfactor/) | 2024-11-02 | FinLab 量化平台, Python新手教學, PYTHON財經, 選股策略 | data / factor | public_or_unknown | P0 |
| [量化交易完整指南：策略、實施與風險管理](https://www.finlab.tw/%e9%87%8f%e5%8c%96%e4%ba%a4%e6%98%93%e5%ae%8c%e6%95%b4%e6%8c%87%e5%8d%97%ef%bc%9a%e7%ad%96%e7%95%a5%e3%80%81%e5%af%a6%e6%96%bd%e8%88%87%e9%a2%a8%e9%9a%aa%e7%ae%a1%e7%90%86/) | 2024-10-15 | FinLab 量化平台, Python新手教學, PYTHON財經 | screener | public_or_unknown | P1 |
| [業外收入比例：用3個財報數據，選出年化報酬率 22％ 以上的投資組合！](https://www.finlab.tw/%e6%a5%ad%e5%a4%96%e6%94%b6%e5%85%a5%e6%af%94%e4%be%8b%ef%bc%9a%e7%94%a83%e5%80%8b%e8%b2%a1%e5%a0%b1%e6%95%b8%e6%93%9a%ef%bc%8c%e9%81%b8%e5%87%ba%e5%b9%b4%e5%8c%96%e5%a0%b1%e9%85%ac%e7%8e%87-22/) | 2024-10-05 | FinLab 量化平台, Python新手教學 | screener | public_or_unknown | P0 |
| [揭開 OpenFE 在量化交易中的神秘面紗：高效自動化特徵生成的原理與實踐](https://www.finlab.tw/openfe-auto-gene-feature/) | 2024-09-15 | AI看股票, FinLab 量化平台, PYTHON財經 | data / factor | vip_tagged | P1 |
| [大跌後的底氣 - 獨家主力波動指標](https://www.finlab.tw/broker_transaction_indicator/) | 2024-08-07 | FinLab 量化平台, Python新手教學, 籌碼面, 股票策略, 財經PYTHON教學 | data / factor | vip_tagged | P0 |
| [FinLab 1.2 支援全自動下單！](https://www.finlab.tw/finlab-1-2-portfolio-publish/) | 2024-07-26 | FinLab 量化平台, Python新手教學 | execution | public_or_unknown | P0 |
| [市場短線過熱新聞滿天飛，技術指標達到超買階段，究竟該不該賣股票呢?!](https://www.finlab.tw/%e5%b8%82%e5%a0%b4%e7%9f%ad%e7%b7%9a%e9%81%8e%e7%86%b1%e6%96%b0%e8%81%9e%e6%bb%bf%e5%a4%a9%e9%a3%9b%ef%bc%8c%e6%8a%80%e8%a1%93%e6%8c%87%e6%a8%99%e9%81%94%e5%88%b0%e8%b6%85%e8%b2%b7%e9%9a%8e%e6%ae%b5/) | 2024-07-11 | Python新手教學, PYTHON財經 | data / factor | public_or_unknown | P1 |
| [5種低波動因子，高效策略快速實踐](https://www.finlab.tw/low-volitility-metrics/) | 2024-06-11 | FinLab 量化平台, Python新手教學, PYTHON財經 | data / factor | public_or_unknown | P0 |
| [探討一個全局有效的因子優化方法](https://www.finlab.tw/better_factor/) | 2024-06-10 | PYTHON財經, Python新手教學 | data / factor | vip_tagged | P0 |
| [台股突破21,000，居高思危，用選擇權未平倉量避開股市潛在下跌風險](https://www.finlab.tw/%e5%8f%b0%e8%82%a1%e7%aa%81%e7%a0%b421000%ef%bc%8c%e5%b1%85%e9%ab%98%e6%80%9d%e5%8d%b1%ef%bc%8c%e7%94%a8%e9%81%b8%e6%93%87%e6%ac%8a%e6%9c%aa%e5%b9%b3%e5%80%89%e9%87%8f%e9%81%bf%e9%96%8b%e8%82%a1/) | 2024-06-04 | Uncategorized | risk / portfolio | public_or_unknown | P1 |
| [槓桿動態調控策略的量化分析](https://www.finlab.tw/leverage-dynamic-adjustment-strategy/) | 2024-05-22 | FinLab 量化平台, Python新手教學, 技術面, 股票策略 | screener | public_or_unknown | P1 |
| [如何利用主力買賣超張數預測台灣股市趨勢：深入分析與策略指南](https://www.finlab.tw/main-force-indicator-for-0051/) | 2024-05-13 | Uncategorized | regime / macro | public_or_unknown | P1 |
| [每天看外資買賣超卻不知道怎麼解讀嗎?外資避險指標大公開，讓你提前避開股市大幅回落](https://www.finlab.tw/%e6%af%8f%e5%a4%a9%e7%9c%8b%e5%a4%96%e8%b3%87%e8%b2%b7%e8%b3%a3%e8%b6%85%e5%8d%bb%e4%b8%8d%e7%9f%a5%e9%81%93%e6%80%8e%e9%ba%bc%e8%a7%a3%e8%ae%80%e5%97%8e%e5%a4%96%e8%b3%87%e9%81%bf%e9%9a%aa%e6%8c%87/) | 2024-05-09 | Uncategorized | data / factor | public_or_unknown | P0 |
| [能夠升級所有策略的指標：F-Score](https://www.finlab.tw/%e8%83%bd%e5%a4%a0%e5%8d%87%e7%b4%9a%e6%89%80%e6%9c%89%e7%ad%96%e7%95%a5%e7%9a%84%e6%8c%87%e6%a8%99%ef%bc%9af-score/) | 2024-04-20 | FinLab 量化平台, Python新手教學, PYTHON財經 | data / factor | public_or_unknown | P0 |
| [使用 Python 和 finlab 庫優化台灣股市投資策略](https://www.finlab.tw/%e4%bd%bf%e7%94%a8-python-%e5%92%8c-finlab-%e5%ba%ab%e5%84%aa%e5%8c%96%e5%8f%b0%e7%81%a3%e8%82%a1%e5%b8%82%e6%8a%95%e8%b3%87%e7%ad%96%e7%95%a5/) | 2024-04-14 | FinLab 量化平台, PYTHON財經 | screener | public_or_unknown | P1 |
| [飆股可以賺更多？/ 台股賣出的技術](https://www.finlab.tw/%e9%a3%86%e8%82%a1%e5%8f%af%e4%bb%a5%e8%b3%ba%e6%9b%b4%e5%a4%9a%ef%bc%9f-%e5%8f%b0%e8%82%a1%e8%b3%a3%e5%87%ba%e7%9a%84%e6%8a%80%e8%a1%93/) | 2024-04-02 | FinLab 量化平台, Python新手教學, PYTHON財經 | execution | vip_tagged | P1 |
| [如何超越 00733，台股最強 ETF？](https://www.finlab.tw/%e5%a6%82%e4%bd%95%e8%b6%85%e8%b6%8a00733%e5%8f%b0%e8%82%a1%e6%9c%80%e5%bc%b7-etf/) | 2024-02-12 | PYTHON財經 | fundamentals / revenue | public_or_unknown | P2 |
| [利用 0050 的概念，優化選股的績效](https://www.finlab.tw/0050%e7%9a%84%e5%84%aa%e5%8c%96%e4%bb%a5%e5%8f%8a%e5%8f%b0%e7%81%a3%e5%b8%82%e5%a0%b4%e5%b8%82%e5%80%bc%e7%a0%94%e7%a9%b6/) | 2024-02-07 | PYTHON財經, 技術面, 股票策略 | screener | public_or_unknown | P1 |
| [台灣股市選股策略 Python 起手勢](https://www.finlab.tw/python-taiwan-stock-market-selection/) | 2024-01-18 | Uncategorized | screener | public_or_unknown | P1 |
| [揭秘庫藏股：庫藏股投資策略再優化，股市條件探勘（Part 2）](https://www.finlab.tw/inventory-down/) | 2024-01-01 | VIP文章, 基本面分析, 籌碼面 | screener | vip_tagged | P0 |
| [揭秘庫藏股：智慧投資策略與市場動態的完美結合（Part 1）](https://www.finlab.tw/inventory-up/) | 2023-12-31 | 股票策略, 基本面分析, 籌碼面 | screener | public_or_unknown | P0 |
| [毛利率的選股潛力：一種數據驅動的方法](https://www.finlab.tw/margin-new-high-event-analysis/) | 2023-12-13 | FinLab 量化平台, Python新手教學, PYTHON財經 | screener | public_or_unknown | P1 |
| [事件研究法（中）使用事件交易模組](https://www.finlab.tw/event-study-usage/) | 2023-10-31 | FinLab 量化平台, Python新手教學, 基本面分析, 股票策略 | screener | public_or_unknown | P0 |
| [僅用財報製作 30% 年報酬的美股多空對沖策略](https://www.finlab.tw/financial-report-strategy-long-short/) | 2023-10-07 | 股票策略, AI看股票, FinLab 量化平台, Python新手教學, 財經PYTHON教學 | backtest | public_or_unknown | P0 |
| [事件研究法上：找到異常報酬率](https://www.finlab.tw/event-study-1/) | 2023-09-27 | 選股策略, FinLab 量化平台, 股票策略 | backtest | public_or_unknown | P1 |
| [事件交易分析法：減資事件是我的印鈔機](https://www.finlab.tw/capital-reduction-short/) | 2023-09-20 | 選股策略, 基本面分析, 股票策略 | screener | public_or_unknown | P0 |
| [事件交易：現金增資放空](https://www.finlab.tw/followup-offering-short/) | 2023-09-17 | VIP文章, 股票策略, 選股策略 | screener | vip_tagged | P1 |
| [反思菲式思考 Part.4｜站在菲神的肩膀上研發策略｜預判法說會有用嗎？](https://www.finlab.tw/investor-conference/) | 2023-09-06 | VIP文章 | screener | vip_tagged | P1 |
| [反思菲式思考 Part.3｜站在菲神的肩膀上研發策略｜預判恢復信用交易有用嗎？](https://www.finlab.tw/https-www-finlab-tw-phcebus-thinking-report-part3-credit-transaction-recovery/) | 2023-08-28 | FinLab 量化平台, 基本面分析, 籌碼面 | screener | public_or_unknown | P0 |
| [反思菲式思考 Part.2｜策略回測探討](https://www.finlab.tw/phcebus-thinking-report-part2-backtest-sop/) | 2023-08-25 | Python新手教學, FinLab 量化平台, 選股策略 | screener | public_or_unknown | P1 |
| [反思菲式思考 Part.1｜關鍵交易思維的啟發](https://www.finlab.tw/phcebus-thinking-report-part1/) | 2023-08-24 | 投資新手, FinLab 量化平台, Python新手教學, 生產力, 股票策略 | execution | public_or_unknown | P1 |
| [客製化選股策略的回測價格序列 / 比較進出場的時間點特性](https://www.finlab.tw/customed-tw-stock-backtest-price/) | 2023-08-17 | FinLab 量化平台, 生產力 | screener | public_or_unknown | P1 |
| [脫離韭菜命運的關鍵：利用MAE分析實踐正確的停損](https://www.finlab.tw/mae-distribution-stop-loss-setting/) | 2023-08-17 | FinLab 量化平台, 技術面 | risk / portfolio | public_or_unknown | P1 |
| [V轉指標：台股市場 ATR 波動率指標](https://www.finlab.tw/tw-stock-market-atr/) | 2023-08-16 | FinLab 量化平台, 大盤漲跌, 技術面 | regime / macro | public_or_unknown | P0 |
| [FinLab 量化交易線上研討會：講者徵選(延至2023/8/31)](https://www.finlab.tw/finlab-2023-fall-speaker_hiring/) | 2023-07-19 | FinLab 量化平台 | execution | public_or_unknown | P1 |
| [美股探險記第4課:美股選股池分類器使用教學｜本益成長比最適合用在哪些產業？](https://www.finlab.tw/us_stock_industry_peg/) | 2023-07-07 | VIP文章, FinLab 量化平台, Python新手教學, 股票策略 | data / factor | vip_tagged | P1 |
| [美股探險記第3課:1分鐘上手美股回測｜股價淨值比在美股策略還有效嗎？](https://www.finlab.tw/us_start_build_pb_strategy_backtest/) | 2023-07-02 | Python新手教學, FinLab 量化平台, 股票策略 | data / factor | public_or_unknown | P1 |
| [美股探險記第2課:美股資料庫使用者指南](https://www.finlab.tw/us_database_doc/) | 2023-06-29 | Python新手教學, FinLab 量化平台 | data / factor | public_or_unknown | P1 |
| [美股探險記第1課:為什麼要投資美股？](https://www.finlab.tw/why_invest_in_us_stocks/) | 2023-06-27 | FinLab 量化平台, 投資新手, 總體經濟, 選股策略 | screener | public_or_unknown | P1 |
| [探討進出時機的處置股策略 / 我跳進來了，我又跳出去了，打我啊笨蛋XD](https://www.finlab.tw/alerting_stock/) | 2023-06-06 | 選股策略, FinLab 量化平台, VIP文章 | screener | vip_tagged | P0 |
| [新手看價，老手看量，高手看波動率](https://www.finlab.tw/low_volatility_research/) | 2023-05-17 | VIP文章, FinLab 量化平台, 技術面, 選股策略 | screener | vip_tagged | P1 |
| [生命週期投資法則：眾多諾貝爾經濟學獎得主同聲讚譽的長期投資方法！](https://www.finlab.tw/lifecycle-investing/) | 2023-04-09 | FinLab YouTube, FinLab 量化平台, VIP文章 | backtest | vip_tagged | P1 |
| [成長飆股怎麼找？超級績效選股法大解密](https://www.finlab.tw/%e6%88%90%e9%95%b7%e9%a3%86%e8%82%a1%e6%80%8e%e9%ba%bc%e6%89%be-%e8%b6%85%e7%b4%9a%e7%b8%be%e6%95%88%e9%81%b8%e8%82%a1%e6%b3%95%e5%a4%a7%e8%a7%a3%e5%af%86/) | 2023-03-20 | 投資新手, FinLab YouTube, FinLab 量化平台, 基本面分析, 技術面, 股票策略, 選股策略 | screener | public_or_unknown | P0 |
| [資產配置：獲得年報酬 40% 的穩健投資組合 (腳本公開)](https://www.finlab.tw/portfolio_optimization/) | 2023-03-16 | FinLab YouTube, VIP文章, 股票策略, 選股策略 | backtest | vip_tagged | P1 |
| [給小資族的禮物｜低價股量化策略的實戰訣竅](https://www.finlab.tw/low_price_strategy_tw_stock/) | 2023-02-16 | 技術面, Python新手教學, VIP文章, 投資新手, 選股策略 | screener | vip_tagged | P1 |
| [建構出自己的 Smart ETF 00905 2.0！ Part3 – 優化策略實作](https://www.finlab.tw/%e5%bb%ba%e6%a7%8b%e5%87%ba%e8%87%aa%e5%b7%b1%e7%9a%84-smart-etf-00905-2-0-part3-%e5%84%aa%e5%8c%96%e7%ad%96%e7%95%a5%e5%af%a6%e4%bd%9c/) | 2023-01-11 | FinLab 量化平台, VIP文章, 股票策略 | fundamentals / revenue | vip_tagged | P1 |
| [建構出自己的 Smart ETF 00905 2.0 ! Part2 – 12 個獲利因子程式碼懶人包大公開](https://www.finlab.tw/smart-etf-00905-%e7%a8%8b%e5%bc%8f%e9%a9%97%e8%ad%89%e5%af%a6%e4%bd%9c/) | 2023-01-04 | FinLab 量化平台, VIP文章, 基本面分析 | fundamentals / revenue | vip_tagged | P1 |
| [用Python回測總經指標(3)｜台灣景氣燈號｜加減碼策略](https://www.finlab.tw/tw_business_indicator_changed_weight_strategy/) | 2022-12-29 | FinLab 量化平台, VIP文章, 總體經濟, 選股策略 | regime / macro | vip_tagged | P0 |
| [建構出自己的 Smart ETF 00905 2.0 ! Part1 - 公開說明書內容解析](https://www.finlab.tw/smart-etf-00905-%e5%85%ac%e9%96%8b%e8%aa%aa%e6%98%8e%e6%9b%b8%e5%85%a7%e5%ae%b9%e8%a7%a3%e6%9e%90/) | 2022-12-27 | 選股策略, VIP文章, 股票策略 | screener | vip_tagged | P1 |
| [別買 ETF 因為存在根本性的缺陷！/ 程式交易特別企劃 - 建構出自己的ETF (前導篇)](https://www.finlab.tw/etf-defect/) | 2022-12-27 | 選股策略, VIP文章, 股票策略 | screener | vip_tagged | P1 |
| [冰風暴概念股季節效應｜老王是對的嗎？](https://www.finlab.tw/winter_storm_industry_index_backtest/) | 2022-12-27 | FinLab 量化平台, Python新手教學, VIP文章 | other | vip_tagged | P2 |
| [現金及約當現金：如何評估企業的現金流？](https://www.finlab.tw/%e7%8f%be%e9%87%91%e5%8f%8a%e7%b4%84%e7%95%b6%e7%8f%be%e9%87%91%e5%a6%82%e4%bd%95%e8%a9%95%e4%bc%b0%e4%bc%81%e6%a5%ad%e7%9a%84%e7%8f%be%e9%87%91%e6%b5%81/) | 2022-12-23 | Uncategorized | data / factor | public_or_unknown | P1 |
| [技術指標教室｜動量指標 AROON](https://www.finlab.tw/aroon_indicator/) | 2022-12-22 | 技術面, FinLab 量化平台, Python新手教學, 投資新手 | data / factor | public_or_unknown | P0 |
| [產業資料庫的基礎應用](https://www.finlab.tw/industry_themes_database_basic_application/) | 2022-12-20 | FinLab 量化平台, Python新手教學, 基本面分析, 生產力 | data / factor | public_or_unknown | P0 |
| [使用 Python 進行股票分析指南：入門篇](https://www.finlab.tw/python-quantitative-trading-introduction/) | 2022-12-09 | Python新手教學 | screener | public_or_unknown | P1 |
| [FinLab 開發與研究月報 (2022-11)](https://www.finlab.tw/finlab_monthly_dev_report_202211/) | 2022-11-30 | VIP文章, FinLab 量化平台, 投資新手, 生產力, 選股策略 | screener | vip_tagged | P1 |
| [選股回測系統豆知識 (2)｜持股比例上限設定](https://www.finlab.tw/backtest_system_position_limit/) | 2022-11-28 | Python新手教學, FinLab 量化平台, 選股策略 | screener | public_or_unknown | P1 |
| [選股回測系統豆知識 (1)｜報酬率計算](https://www.finlab.tw/backtest_system_rule/) | 2022-11-24 | FinLab 量化平台, 投資新手 | backtest | public_or_unknown | P1 |
| [選股策略系統性學習(1)｜新手初訪](https://www.finlab.tw/stock_strategy_learning_system_for_beginner/) | 2022-11-23 | Python新手教學, FinLab 量化平台, 投資新手, 選股策略 | screener | public_or_unknown | P1 |
| [月營收選股｜股價創新高｜新手必學的雙動能策略](https://www.finlab.tw/revenue_and_price_engine_strategy/) | 2022-11-16 | Python新手教學, FinLab 量化平台, VIP文章, 基本面分析, 技術面, 投資新手, 財經PYTHON教學 | screener | vip_tagged | P0 |
| [投信買賣超選股策略｜時空序列分析的秘招｜停損怎麼設？](https://www.finlab.tw/time_series_analysis_of_investment_trust_strategy/) | 2022-11-15 | FinLab 量化平台, VIP文章, 籌碼面, 選股策略 | chips / institutional flow | vip_tagged | P0 |
| [用Python回測總經指標(2)｜美國失業率 vs S&P 500指數](https://www.finlab.tw/us_unemployment_rate_seasonally_adjusted_sp500_backtest/) | 2022-11-10 | 總體經濟, FinLab 量化平台, VIP文章, 財經PYTHON教學, 選股策略 | data / factor | vip_tagged | P0 |
| [Python爬蟲教學｜美國勞動部統計局API｜失業率](https://www.finlab.tw/us_unemployment_rate_seasonally_adjusted_crawler/) | 2022-11-10 | 總體經濟, Python新手教學, 投資新手, 生產力 | regime / macro | public_or_unknown | P1 |
| [Python爬蟲教學｜台股數據｜集保戶股權分散表](https://www.finlab.tw/python_crawler_tdcc_inventory/) | 2022-11-09 | Python新手教學, 投資新手, 財經PYTHON教學 | risk / portfolio | public_or_unknown | P1 |
| [低波動本益成長比策略 / MAE_MFE 機器學習選股](https://www.finlab.tw/low_volatility_stratgy_by_mae_mfe_ml/) | 2022-11-08 | AI看股票, FinLab 量化平台, VIP文章, 基本面分析, 技術面, 籌碼面, 選股策略 | chips / institutional flow | vip_tagged | P0 |
| [用Python回測總經指標(1)｜M1B & M2 年增率](https://www.finlab.tw/tw_monetary_aggregates_m1b_strategy/) | 2022-11-04 | 總體經濟, FinLab 量化平台, 技術面, 選股策略 | data / factor | public_or_unknown | P0 |
| [Python爬蟲教學｜ 財經數據｜台灣貨幣總計數 M1B & M2](https://www.finlab.tw/tw_monetary_aggregates_m1b_crawler/) | 2022-11-03 | 財經PYTHON教學, 總體經濟 | other | public_or_unknown | P2 |
| [產業面選股策略｜同業本益比比較法](https://www.finlab.tw/industry_pe_strategy/) | 2022-11-02 | FinLab 量化平台, VIP文章, 選股策略 | data / factor | vip_tagged | P1 |
| [台股財報資料豆知識 ｜ 時序索引操作](https://www.finlab.tw/tw_stock_financial_statement_time_series_knowledge/) | 2022-10-28 | Python新手教學, FinLab 量化平台, 生產力 | data / factor | public_or_unknown | P0 |
| [國安基金與庫藏股應用教學｜政府軍急了嗎？](https://www.finlab.tw/treasury_stock_national_security_fund/) | 2022-10-17 | 籌碼面, FinLab 量化平台, Python新手教學, VIP文章 | chips / institutional flow | vip_tagged | P0 |
| [如何用指標計分來選股? / Python 資料分級處理](https://www.finlab.tw/basic_score_strategy/) | 2022-09-27 | Python新手教學, FinLab 量化平台, VIP文章, 基本面分析 | data / factor | vip_tagged | P0 |
| [突破策略豆知識 / 如何避免假突破?](https://www.finlab.tw/breakthrough_stock_picking_strategies/) | 2022-09-22 | 技術面, FinLab 量化平台, VIP文章, 投資新手, 股票策略, 選股策略 | screener | vip_tagged | P1 |
| [3 行 code 自動輸入帳密 Fugle API - 全自動交易 Fugle 篇](https://www.finlab.tw/auto-trading-fugle/) | 2022-09-18 | FinLab 量化平台, 選股策略 | screener | public_or_unknown | P1 |
| [彈性進出場的判斷 ｜ 優勢比率應用](https://www.finlab.tw/edge-ratio-follow-application/) | 2022-09-01 | 技術面 | other | public_or_unknown | P2 |
| [FinLab x Google雲端平台 / 3步驟實現Python全自動交易，從今以後躺著都能賺！(下)](https://www.finlab.tw/auto-trading-part2/) | 2022-08-31 | FinLab 量化平台, 選股策略 | screener | public_or_unknown | P1 |
| [FinLab x Google雲端平台 / 3步驟實現全自動交易，從今以後躺著都能賺！(上)](https://www.finlab.tw/auto-trading-part1/) | 2022-08-31 | FinLab 量化平台, 選股策略 | screener | public_or_unknown | P1 |
| [1 分鐘學會！使用 Lux API 自動視覺化 Pandas 資料](https://www.finlab.tw/lux-api-tutorial/) | 2022-08-23 | Uncategorized | data / factor | public_or_unknown | P1 |
| [史上最強大的台股板塊圖 / 操作說明書](https://www.finlab.tw/%e5%8f%b2%e4%b8%8a%e6%9c%80%e5%bc%b7%e5%a4%a7%e7%9a%84%e5%8f%b0%e8%82%a1%e6%9d%bf%e5%a1%8a%e5%9c%96-%e6%93%8d%e4%bd%9c%e8%aa%aa%e6%98%8e%e6%9b%b8/) | 2022-08-02 | Python新手教學, FinLab 量化平台, 生產力 | data / factor | public_or_unknown | P1 |
| [客製化流動性風險檢測 / 策略可以實戰嗎?](https://www.finlab.tw/customized_liquidityanalysis/) | 2022-06-27 | FinLab 量化平台, VIP文章, 生產力, 選股策略 | backtest | vip_tagged | P0 |
| [選股策略回測有新功能！包含權重多空對沖、Sunburst 產業分析、PandasTA 技術指標 - FinLab 0.3.2.dev 再進化！](https://www.finlab.tw/%e9%81%b8%e8%82%a1%e7%ad%96%e7%95%a5%e5%9b%9e%e6%b8%ac%e6%96%b0%e5%8a%9f%e8%83%bd%e6%ac%8a%e9%87%8d%e5%a4%9a%e7%a9%ba%e5%b0%8d%e6%b2%96sunburst-%e7%94%a2%e6%a5%ad%e5%88%86%e6%9e%90pandasta-%e6%8a%80/) | 2022-06-18 | FinLab 量化平台 | data / factor | public_or_unknown | P0 |
| [Plotly-Sunburst｜輕鬆監控多策略部位｜DashBoard 應用教學(5)](https://www.finlab.tw/plotly-sunburst-dashboard/) | 2022-06-17 | 生產力, FinLab 量化平台, Python新手教學 | data / factor | public_or_unknown | P1 |
| [Qlib-巨人級的AI量化投資平台](https://www.finlab.tw/qlib-intro/) | 2022-06-10 | 生產力, AI看股票 | ML / AI | public_or_unknown | P1 |
| [FRED總體經濟指標輕鬆抓/美國汽車指標/美股回測外掛教學](https://www.finlab.tw/fred%e7%b8%bd%e9%ab%94%e7%b6%93%e6%bf%9f%e6%8c%87%e6%a8%99%e8%bc%95%e9%ac%86%e6%8a%93%e7%be%8e%e5%9c%8b%e6%b1%bd%e8%bb%8a%e6%8c%87%e6%a8%99%e7%be%8e%e8%82%a1%e5%9b%9e%e6%b8%ac%e5%a4%96%e6%8e%9b/) | 2022-05-25 | Python新手教學, VIP文章, 生產力, 股票策略, 財經PYTHON教學 | data / factor | vip_tagged | P0 |
| [大盤融資維持率｜融資融券主力板塊Treemap｜DashBoard製作教學(4)](https://www.finlab.tw/%e8%9e%8d%e8%b3%87%e8%9e%8d%e5%88%b8%e4%b8%bb%e5%8a%9b%e6%9d%bf%e5%a1%8atreemap%e5%a4%a7%e7%9b%a4%e8%9e%8d%e8%b3%87%e7%b6%ad%e6%8c%81%e7%8e%87/) | 2022-05-22 | 籌碼面, PYTHON財經, 生產力 | chips / institutional flow | public_or_unknown | P0 |
| [大盤融資維持率｜Plotly-多重圖組｜DashBoard製作教學(3)](https://www.finlab.tw/plotly-%e5%a4%9a%e9%87%8d%e5%9c%96%e7%b5%84%e8%9e%8d%e8%b3%87%e7%b6%ad%e6%8c%81%e7%8e%87dashboard%e8%a3%bd%e4%bd%9c%e6%95%99%e5%ad%b83/) | 2022-05-18 | Python新手教學, 生產力, 籌碼面, 財經PYTHON教學 | chips / institutional flow | public_or_unknown | P0 |
| [機器學習 Python 做比特幣交易，如何找到好的特徵？增進模型的有效工具](https://www.finlab.tw/python-machine-learning-bitcoin-feature-engineering/) | 2022-05-11 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [遇到「神準」的狙擊｜如何超越散戶?](https://www.finlab.tw/the_behavior_of_individual_investors/) | 2022-04-15 | 投資新手 | other | public_or_unknown | P2 |
| [現金流量表超簡單策略開發](https://www.finlab.tw/cashflow_backtest_easy/) | 2022-04-12 | 基本面分析, 投資新手 | fundamentals / revenue | public_or_unknown | P0 |
| [護國神山抄底策略](https://www.finlab.tw/2330_bband_rebound/) | 2022-03-09 | 技術面, VIP文章, 股票策略, 財經PYTHON教學 | screener | vip_tagged | P1 |
| [研發費用率選股策略](https://www.finlab.tw/research_expense_ratio_strategy/) | 2022-02-24 | 選股策略, FinLab 量化平台, Python新手教學, PYTHON財經, VIP文章, 基本面分析, 股票策略 | screener | vip_tagged | P0 |
| [揭開策略的波動面紗｜MAE&MFE分析圖組使用指南](https://www.finlab.tw/display_mae_mfe_analysis/) | 2022-02-19 | 生產力, 技術面 | data / factor | public_or_unknown | P1 |
| [Finlab 量化平台徵稿活動得獎作品 營業利益率選股-安正](https://www.finlab.tw/finlab_submit2/) | 2022-02-13 | AI看股票 | screener | public_or_unknown | P2 |
| [ATR指標應用 / 肯特納通道（Keltner Channel）](https://www.finlab.tw/atr_keltner_channel/) | 2022-02-13 | 技術面, FinLab 量化平台, 選股策略 | data / factor | public_or_unknown | P0 |
| [Finlab 量化平台徵稿活動得獎作品 集技術面和籌碼面於一身的的AI選股策略-陳士謀](https://www.finlab.tw/finlab_submit1/) | 2022-02-09 | AI看股票 | screener | public_or_unknown | P1 |
| [Python 實作：現在該不該買山寨幣？](https://www.finlab.tw/python-%e5%af%a6%e4%bd%9c%ef%bc%9a%e7%8f%be%e5%9c%a8%e8%a9%b2%e4%b8%8d%e8%a9%b2%e8%b2%b7%e5%b1%b1%e5%af%a8%e5%b9%a3%ef%bc%9f/) | 2022-02-06 | Uncategorized | other | public_or_unknown | P2 |
| [七七四十九種PEG本益成長比，找出潛力成長股，製作年報酬率 30% 的選股策略！](https://www.finlab.tw/peg/) | 2022-01-22 | 選股策略, VIP文章, 基本面分析, 股票策略 | data / factor | vip_tagged | P0 |
| [2021 交易聖杯初體驗](https://www.finlab.tw/2021-trading-and-learning/) | 2022-01-03 | Python新手教學, 投資新手 | screener | public_or_unknown | P1 |
| [4種均線指標 / 讓你在大盤崩崩前高歌離席!](https://www.finlab.tw/index_filter/) | 2021-12-24 | 技術面, VIP文章, 大盤漲跌 | data / factor | vip_tagged | P0 |
| [加密貨幣的貪婪與恐懼](https://www.finlab.tw/%e5%8a%a0%e5%af%86%e8%b2%a8%e5%b9%a3%e7%9a%84%e8%b2%aa%e5%a9%aa%e8%88%87%e6%81%90%e6%87%bc/) | 2021-12-10 | 加密貨幣 | other | public_or_unknown | P2 |
| [5 個步驟設定選股條件，股票爆發力更上一層樓！](https://www.finlab.tw/5-%e5%80%8b%e6%ad%a5%e9%a9%9f%e8%a8%ad%e5%ae%9a%e9%81%b8%e8%82%a1%e6%a2%9d%e4%bb%b6%ef%bc%8c%e8%82%a1%e7%a5%a8%e7%88%86%e7%99%bc%e5%8a%9b%e6%9b%b4%e4%b8%8a%e4%b8%80%e5%b1%a4%e6%a8%93%ef%bc%81/) | 2021-11-22 | Uncategorized | screener | public_or_unknown | P1 |
| [Python 財報月報股價爬蟲，台股資料庫終極解決之道！](https://www.finlab.tw/python-%e8%b2%a1%e5%a0%b1%e6%9c%88%e5%a0%b1%e8%82%a1%e5%83%b9%e7%88%ac%e8%9f%b2%ef%bc%8c%e5%8f%b0%e8%82%a1%e8%b3%87%e6%96%99%e5%ba%ab%e7%b5%82%e6%a5%b5%e8%a7%a3%e6%b1%ba%e4%b9%8b%e9%81%93%ef%bc%81/) | 2021-11-08 | PYTHON財經, Python新手教學, 財經PYTHON教學 | data / factor | public_or_unknown | P0 |
| [徵稿送 FinLab VIP 量化平台會員](https://www.finlab.tw/finlab_platform_solicit_article_activity/) | 2021-11-02 | 生產力, 選股策略 | screener | public_or_unknown | P2 |
| [台股超簡單 Python 技巧，三行程式碼：打造年報酬 +20% 的選股策略！](https://www.finlab.tw/%e5%8f%b0%e7%81%a3%e8%82%a1%e5%b8%82%e6%9c%80%e5%bc%b7%e7%9a%84-python-package/) | 2021-10-31 | Python新手教學, PYTHON財經, 技術面, 投資新手, 生產力, 股票策略 | backtest | public_or_unknown | P1 |
| [FinLab量化策略平台入門者操作指南](https://www.finlab.tw/finlab_platform_intro/) | 2021-10-30 | 生產力, 股票策略 | other | public_or_unknown | P2 |
| [ETH 2.0的崛起｜超越比特幣市值的潛力？](https://www.finlab.tw/sdb-report-ethereum-investor-guide/) | 2021-10-07 | 加密貨幣 | other | public_or_unknown | P2 |
| [本益比河流圖｜Python Plotly 應用教學](https://www.finlab.tw/pepb-river-chart/) | 2021-09-27 | 生產力, Python新手教學, VIP文章, 基本面分析 | data / factor | vip_tagged | P0 |
| [進化後的本益比｜本益成長比選股策略](https://www.finlab.tw/finlab-tw-stock-peg-strategy/) | 2021-09-24 | 股票策略, VIP文章, 基本面分析, 選股策略 | data / factor | vip_tagged | P0 |
| [本益比選股策略 / 產業因子分析](https://www.finlab.tw/finlab-tw-stock-pe-strategy/) | 2021-09-23 | 基本面分析, FinLab YouTube, VIP文章, 股票策略, 財經PYTHON教學, 選股策略 | data / factor | vip_tagged | P0 |
| [合約負債 / 營建業選股策略](https://www.finlab.tw/building-contingent-liability-strategy/) | 2021-08-13 | 股票策略, PYTHON財經, VIP文章, 基本面分析, 選股策略 | screener | vip_tagged | P0 |
| [小型股噴發的日子結束了？ADLs 指標顯示：接下來是決定性的時刻！](https://www.finlab.tw/adls-stock-indicator/) | 2021-07-14 | 大盤漲跌, 技術面, 股票策略 | data / factor | public_or_unknown | P0 |
| [大盤融資維持率｜地板指標幫你搶長線反彈｜0050擇時策略優化？](https://www.finlab.tw/mt_rate_strategy/) | 2021-06-13 | 大盤漲跌, 籌碼面 | chips / institutional flow | public_or_unknown | P0 |
| [Plotly-TreeMap｜台股版塊地圖｜DashBoard製作教學(2)](https://www.finlab.tw/dashboard2-plotly-treemap/) | 2021-05-22 | 生產力, Python新手教學 | other | public_or_unknown | P2 |
| [庫藏股實施家數｜崩盤後的長線抄底訊號｜左側交易](https://www.finlab.tw/treasury-stock-signal/) | 2021-05-16 | 大盤漲跌, VIP文章, 籌碼面, 股票策略 | chips / institutional flow | vip_tagged | P0 |
| [台股研究室實作風險因子Beta｜單因子選股｜風險因子Beta｜Ep.1](https://www.finlab.tw/%e5%8f%b0%e8%82%a1%e7%a0%94%e7%a9%b6%e5%ae%a4%e5%af%a6%e4%bd%9c%ef%bd%9c%e5%96%ae%e5%9b%a0%e5%ad%90%e9%81%b8%e8%82%a1%ef%bd%9c%e9%a2%a8%e9%9a%aa%e5%9b%a0%e5%ad%90beta%ef%bd%9cep-1/) | 2021-05-09 | 股票策略, Python新手教學, Uncategorized, 技術面, 選股策略 | data / factor | public_or_unknown | P0 |
| [Plotly＆Dash初體驗｜已實現損益儀表板｜DashBoard製作教學(1)](https://www.finlab.tw/realizedprofitloss_dashboard_plotly/) | 2021-05-03 | Python新手教學, 財經PYTHON教學 | other | public_or_unknown | P2 |
| [ADL指標幫你判斷台股盤勢｜順勢為王｜教你走出拉G盤的迷霧｜](https://www.finlab.tw/adl-in-tw-stock/) | 2021-04-30 | 財經PYTHON教學, 大盤漲跌, 技術面, 選股策略 | data / factor | public_or_unknown | P0 |
| [我的量化交易工作環境之 D43-720 4K 桌上型護眼大型螢幕](https://www.finlab.tw/benq-d43-720-4k/) | 2021-03-30 | 生產力 | execution | public_or_unknown | P1 |
| [給投資新手的理財規劃 / 小資族投資0050滾出千萬可能嗎？少看這集晚10年退休（免費工具分享）](https://www.finlab.tw/financial-planning/) | 2021-01-29 | FinLab YouTube, Python新手教學, 投資新手, 財經PYTHON教學 | other | public_or_unknown | P2 |
| [年報酬30％的泡沫選股策略秘技大公開 / 實際下單做實驗 / FinLab 財經實驗室](https://www.finlab.tw/bitcoin-stock-bubble-analysis-lppl-strategy/) | 2021-01-22 | PYTHON財經, FinLab YouTube, 大盤漲跌, 股票策略, 財經PYTHON教學, 選股策略 | screener | public_or_unknown | P0 |
| [2021股票、比特幣崩盤確切時間點 ?! 免費工具大揭密 (附程式碼) / FinLab 財經實驗室](https://www.finlab.tw/bitcoin-stock-bubble-analysis-lppl/) | 2021-01-14 | 股票策略, AI看股票, FinLab YouTube, PYTHON財經, 加密貨幣, 大盤漲跌, 財經PYTHON教學 | regime / macro | public_or_unknown | P1 |
| [台股籌碼策略1-董監改選行情的江湖傳說](https://www.finlab.tw/directors-and-supervisors-re-election-strategy/) | 2021-01-10 | 股票策略, 籌碼面, 選股策略 | screener | public_or_unknown | P0 |
| [投資組合(1)來打造專屬的投資組合吧！](https://www.finlab.tw/portfolio-theories-1-intro/) | 2020-11-28 | Python新手教學, PYTHON財經, 股票策略, 選股策略 | screener | public_or_unknown | P1 |
| [2021年投資股票？請買一檔標的叫做比特幣。](https://www.finlab.tw/202-1invest-bitcoin-as-a-stock/) | 2020-11-19 | 加密貨幣 | other | public_or_unknown | P2 |
| [做量化投資會遇到的挑戰？](https://www.finlab.tw/quantitative-trading/) | 2020-09-27 | Python新手教學, PYTHON財經, 財經PYTHON教學 | other | public_or_unknown | P2 |
| [IBM-Q 量子電腦黑客松比賽心得](https://www.finlab.tw/quantum-computing-hackathon/) | 2020-09-12 | 量子電腦 | other | public_or_unknown | P2 |
| [為什麼要開這堂課程？用 Python 理財 - 打造加密貨幣實戰策略](https://www.finlab.tw/why-crypto-currency-python-course/) | 2020-08-27 | 加密貨幣 | execution | public_or_unknown | P2 |
| [Pandas 魔法筆記(1)-常用招式總覽](https://www.finlab.tw/pandas-%e9%ad%94%e6%b3%95%e7%ad%86%e8%a8%981-%e5%b8%b8%e7%94%a8%e6%8b%9b%e5%bc%8f%e7%b8%bd%e8%a6%bd/) | 2020-08-21 | Python新手教學 | other | public_or_unknown | P2 |
| [生技股如何安全買？逆勢爆賺策略分享](https://www.finlab.tw/python-biotech-stock-portfolio/) | 2020-08-05 | PYTHON財經, 技術面, 股票策略, 財經PYTHON教學, 選股策略 | screener | public_or_unknown | P1 |
| [台積電如何買？用 Python 研發投資策略](https://www.finlab.tw/twii-2330-invest/) | 2020-07-29 | 選股策略, PYTHON財經, 技術面, 股票策略 | screener | public_or_unknown | P1 |
| [股價淨值比能找到好股票？用歷史數據讓你感受它的厲害！](https://www.finlab.tw/pb-data-analysis-explain/) | 2020-07-23 | 基本面分析, 股票策略 | data / factor | public_or_unknown | P0 |
| [好用Package：用ffn分析時間序列](https://www.finlab.tw/ffn-intro/) | 2020-07-23 | PYTHON財經, 財經PYTHON教學 | execution | public_or_unknown | P1 |
| [Python 低風險高報酬投資組合](https://www.finlab.tw/low-risk-fft-spy-strategy/) | 2020-07-23 | 財經PYTHON教學 | backtest | public_or_unknown | P1 |
| [加速度指標選股：免費Python實做教學看這裡！](https://www.finlab.tw/%e5%8a%a0%e9%80%9f%e5%ba%a6%e6%8c%87%e6%a8%99%e5%af%a6%e5%81%9a/) | 2020-07-23 | 財經PYTHON教學 | data / factor | public_or_unknown | P0 |
| [ROE怎麼看? 機器學習告訴你！](https://www.finlab.tw/roe%e6%80%8e%e9%ba%bc%e7%9c%8b-%e6%a9%9f%e5%99%a8%e5%ad%b8%e7%bf%92%e5%91%8a%e8%a8%b4%e4%bd%a0/) | 2020-07-23 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [Python新手教學(Part 0)： 用Python投資？你想不到的好處!](https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b80%e7%82%ba%e4%bd%95%e7%94%a8python%e6%8a%95%e8%b3%87/) | 2020-07-22 | Python新手教學, 財經PYTHON教學 | execution | public_or_unknown | P1 |
| [用程式分析房地產可行嗎？房價分析看這裡！](https://www.finlab.tw/real-estate-analasys-histograms/) | 2020-07-22 | 實價登入 | other | public_or_unknown | P2 |
| [用程式分析房地產可行嗎？房地產爬蟲教學在這裡！](https://www.finlab.tw/real-estate-analysis1/) | 2020-07-22 | 實價登入 | other | public_or_unknown | P2 |
| [利用機器學習預測漲跌-優化方式](https://www.finlab.tw/generate-labels-stop-loss-stop-profit/) | 2020-07-22 | AI看股票, 財經PYTHON教學 | ML / AI | public_or_unknown | P1 |
| [論文導讀：利用CNN神經網路來交易ETF](https://www.finlab.tw/cnn-time-series-image-conversion-approach/) | 2020-07-22 | AI看股票 | ML / AI | public_or_unknown | P2 |
| [Python新手教學(Part 7)：策略再進化](https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b8%ef%bc%9a%e7%ad%96%e7%95%a5%e5%84%aa%e5%8c%96/) | 2020-07-22 | 財經PYTHON教學, Python新手教學 | execution | public_or_unknown | P1 |
| [python新手教學(Part 6)：避開危險的投資時機 - 夏普指數策略](https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b8%ef%bc%9a%e5%a4%8f%e6%99%ae%e6%8c%87%e6%95%b8%e7%ad%96%e7%95%a5/) | 2020-07-22 | 財經PYTHON教學, Python新手教學 | backtest | public_or_unknown | P1 |
| [Python新手教學(Part 5)：如何衡量風險與報酬？夏普比率告訴你](https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b8%ef%bc%9a%e9%a2%a8%e9%9a%aa%e8%88%87%e5%a0%b1%e9%85%ac/) | 2020-07-22 | 財經PYTHON教學, Python新手教學 | backtest | public_or_unknown | P1 |
| [Python新手教學(Part 4)：台股的好兄弟是？台股相關性研究](https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b84%e7%9b%b8%e9%97%9c%e6%80%a7%e5%88%86%e6%9e%90/) | 2020-07-22 | 財經PYTHON教學, Python新手教學 | execution | public_or_unknown | P1 |
| [Python新手教學(Part 3)：全球指數歷史數據下載大全](https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b83%e5%85%a8%e7%90%83%e6%8c%87%e6%95%b8%e6%ad%b7%e5%8f%b2%e6%95%b8%e6%93%9a/) | 2020-07-22 | 財經PYTHON教學, Python新手教學 | execution | public_or_unknown | P1 |
| [Python新手教學(Part 2)：全球指數一次抓](https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b82%e5%85%a8%e7%90%83%e6%8c%87%e6%95%b8%e4%b8%80%e6%ac%a1%e6%8a%93/) | 2020-07-22 | 財經PYTHON教學, Python新手教學 | execution | public_or_unknown | P1 |
| [爬蟲 Python 新手教學(Part 1)：簡單程式碼，爬全球的股票!](https://www.finlab.tw/%e7%94%a8%e7%88%ac%e8%9f%b2%e7%88%ac%e5%85%a8%e4%b8%96%e7%95%8c%e8%82%a1%e5%83%b9/) | 2020-07-22 | 財經PYTHON教學, Python新手教學 | fundamentals / revenue | public_or_unknown | P0 |
| [論文導讀：利用MI-LSTM預測股價](https://www.finlab.tw/%e5%88%a9%e7%94%a8mi-lstm%e9%a0%90%e6%b8%ac%e8%82%a1%e5%83%b9/) | 2020-07-22 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [VIX美股大跌投資法：Python實作教學看這裡！](https://www.finlab.tw/python%ef%bc%9avix%e7%be%8e%e8%82%a1%e5%a4%a7%e8%b7%8c%e6%8a%95%e8%b3%87%e6%b3%95/) | 2020-07-22 | 財經PYTHON教學 | execution | public_or_unknown | P1 |
| [別再錯過的選股策略！](https://www.finlab.tw/%e4%bd%a0%e9%8c%af%e9%81%8e%e7%9a%84%e9%81%b8%e8%82%a1%e7%ad%96%e7%95%a5%e6%80%9d%e8%b7%af/) | 2020-07-22 | 選股策略 | data / factor | public_or_unknown | P1 |
| [用Machine learning 學習看技術指標](https://www.finlab.tw/machine-learning%ef%bc%9a%e4%bd%bf%e7%94%a8%e6%8a%80%e8%a1%93%e6%8c%87%e6%a8%99%e9%a0%90%e6%b8%ac%e5%a4%a7%e7%9b%a4/) | 2020-07-22 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [如何用machine learning學習 總體經濟？](https://www.finlab.tw/%e6%a9%9f%e5%99%a8%e5%ad%b8%e7%bf%92-%e7%b8%bd%e9%ab%94%e7%b6%93%e6%bf%9f/) | 2020-07-22 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [論文導讀：機器學習與基因演算法選股](https://www.finlab.tw/%e6%a9%9f%e5%99%a8%e5%ad%b8%e7%bf%92%e8%88%87%e5%9f%ba%e5%9b%a0%e6%bc%94%e7%ae%97%e6%b3%95%e9%81%b8%e8%82%a1/) | 2020-07-22 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [加速度指標：歷史年報酬20％的策略](https://www.finlab.tw/%e5%8a%a0%e9%80%9f%e5%ba%a6%e6%8c%87%e6%a8%99-%e5%8a%a0%e9%80%9f%e4%bd%a0%e7%9a%84%e7%8d%b2%e5%88%a9/) | 2020-07-22 | 選股策略 | backtest | public_or_unknown | P0 |
| [用KD值選股：你還需搭配這三種指標](https://www.finlab.tw/%e7%94%a8kd%e5%80%bc%e9%81%b8%e8%82%a1%ef%bc%9a%e9%82%84%e9%9c%80%e6%90%ad%e9%85%8d%e9%80%99%e4%b8%89%e7%a8%ae%e6%8c%87%e6%a8%99/) | 2020-07-22 | 選股策略 | data / factor | public_or_unknown | P0 |
| [如何用Python獲得上市上櫃股票清單?](https://www.finlab.tw/python%ef%bc%9a%e5%a6%82%e4%bd%95%e7%8d%b2%e5%be%97%e4%b8%8a%e5%b8%82%e4%b8%8a%e6%ab%83%e8%82%a1%e7%a5%a8%e6%b8%85%e5%96%ae/) | 2020-07-22 | PYTHON財經 | screener | public_or_unknown | P1 |
| [超簡單用Python預測股價](https://www.finlab.tw/%e8%b6%85%e7%b0%a1%e5%96%ae-machine-learning-%e9%a0%90%e6%b8%ac%e8%82%a1%e5%83%b9/) | 2020-07-22 | 財經PYTHON教學 | execution | public_or_unknown | P1 |
| [超簡單安裝Python教學](https://www.finlab.tw/python%e8%82%a1%e7%a5%a8%e6%8a%95%e8%b3%87/) | 2020-07-22 | 財經PYTHON教學 | execution | public_or_unknown | P1 |
| [簡單又有效：股價加速度選股指標](https://www.finlab.tw/%e7%b0%a1%e6%98%93%e7%9a%84%e5%a4%96%e8%b3%87-%e5%9f%ba%e6%9c%ac%e9%9d%a2%e7%ad%96%e7%95%a5/) | 2020-07-22 | 技術面 | data / factor | public_or_unknown | P0 |
| [「外資買入成本指標」選股 - Python教學看這裡](https://www.finlab.tw/python%ef%bc%9a%e8%a8%88%e7%ae%97%e5%a4%96%e8%b3%87%e8%b2%b7%e5%85%a5%e6%88%90%e6%9c%ac/) | 2020-07-22 | 財經PYTHON教學 | data / factor | public_or_unknown | P0 |
| [三大法人爬蟲：Python實作教學](https://www.finlab.tw/%e4%b8%89%e5%a4%a7%e6%b3%95%e4%ba%ba%e7%88%ac%e8%9f%b2/) | 2020-07-22 | 財經PYTHON教學 | chips / institutional flow | public_or_unknown | P0 |
| [如何判斷投資理財課程的好壞？](https://www.finlab.tw/%e6%8a%95%e8%b3%87%e7%90%86%e8%b2%a1%e8%aa%b2%e7%a8%8b%e7%9a%84%e5%a5%bd%e5%a3%9e/) | 2020-07-22 | 大盤漲跌, 股票策略, 選股策略 | screener | public_or_unknown | P2 |
| [為何時間管理總是失敗？](https://www.finlab.tw/%e7%82%ba%e4%bd%95%e6%99%82%e9%96%93%e7%ae%a1%e7%90%86%e7%b8%bd%e6%98%af%e5%a4%b1%e6%95%97%ef%bc%9f/) | 2020-07-22 | 生產力 | other | public_or_unknown | P2 |
| [如何做回測績效檢討？](https://www.finlab.tw/%e5%9b%9e%e6%b8%ac%e7%b8%be%e6%95%88%e6%aa%a2%e8%a8%8e/) | 2020-07-22 | 選股策略 | backtest | public_or_unknown | P1 |
| [你最該避開的三個疲勞陷阱！](https://www.finlab.tw/%e4%bd%a0%e6%9c%80%e8%a9%b2%e9%81%bf%e9%96%8b%e7%9a%84%e4%b8%89%e5%80%8b%e7%96%b2%e5%8b%9e%e9%99%b7%e9%98%b1%ef%bc%81/) | 2020-07-22 | 生產力 | other | public_or_unknown | P2 |
| [股票投資組合系列（一）](https://www.finlab.tw/%e8%82%a1%e7%a5%a8%e6%8a%95%e8%b3%87%e7%b5%84%e5%90%88%e7%b3%bb%e5%88%97%ef%bc%88%e4%b8%80%ef%bc%89/) | 2020-07-22 | 股票策略, 選股策略 | screener | public_or_unknown | P1 |
| [用 Python 超簡單自動下單](https://www.finlab.tw/%e9%80%9a%e7%94%a8%e8%87%aa%e5%8b%95%e4%b8%8b%e5%96%ae%e6%b3%95%ef%bc%88%e4%b8%8b%ef%bc%89/) | 2020-07-22 | 財經PYTHON教學 | execution | public_or_unknown | P0 |
| [ROE到底高或低才好？](https://www.finlab.tw/roe%e5%88%b0%e5%ba%95%e9%ab%98%e6%88%96%e4%bd%8e%e6%89%8d%e5%a5%bd%ef%bc%9f/) | 2020-07-22 | 基本面分析 | fundamentals / revenue | public_or_unknown | P1 |
| [創新高有多高？](https://www.finlab.tw/%e5%89%b5%e6%96%b0%e9%ab%98%e6%9c%89%e5%a4%9a%e9%ab%98%ef%bc%9f/) | 2020-07-22 | 技術面 | screener | public_or_unknown | P0 |
| [我的量化投資史](https://www.finlab.tw/%e6%88%91%e7%9a%84%e9%87%8f%e5%8c%96%e6%8a%95%e8%b3%87%e9%bb%91%e6%ad%b7%e5%8f%b2/) | 2020-07-22 | 股票策略, 選股策略 | screener | public_or_unknown | P1 |
| [python上櫃資料爬蟲輕鬆做](https://www.finlab.tw/%e7%b0%a1%e5%96%aepython%e4%b8%8a%e6%ab%83%e8%b3%87%e6%96%99%e7%88%ac%e8%9f%b2%e5%af%a6%e5%81%9a/) | 2020-07-22 | PYTHON財經, 財經PYTHON教學 | data / factor | public_or_unknown | P1 |
| [大跌後：用python找出強勢股！](https://www.finlab.tw/%e5%a4%a7%e8%b7%8c%e5%be%8c%ef%bc%9a%e6%89%be%e5%87%ba%e5%bc%b7%e5%8b%a2%e8%82%a1%ef%bc%81/) | 2020-07-22 | 技術面 | screener | public_or_unknown | P1 |
| [股票入門SOP懶人包](https://www.finlab.tw/%e8%82%a1%e7%a5%a8%e5%85%a5%e9%96%80%e6%87%b6%e4%ba%ba%e5%8c%85/) | 2020-07-22 | 股票策略, 選股策略 | screener | public_or_unknown | P1 |
| [用深度學習幫你解析K線圖！](https://www.finlab.tw/%e7%94%a8%e6%b7%b1%e5%ba%a6%e5%ad%b8%e7%bf%92%e5%b9%ab%e4%bd%a0%e8%a7%a3%e6%9e%90k%e7%b7%9a%e5%9c%96%ef%bc%81/) | 2020-07-22 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [月營收這樣看！三種月營收選股法 - Python實作教學](https://www.finlab.tw/python-%e7%b0%a1%e5%96%ae%e7%94%a8%e6%9c%88%e7%87%9f%e6%94%b6%e9%81%b8%e8%82%a1%ef%bc%81/) | 2020-07-22 | 財經PYTHON教學 | screener | public_or_unknown | P0 |
| [三種看月營收的進階方法！](https://www.finlab.tw/%e4%b8%89%e7%a8%ae%e6%9c%88%e7%87%9f%e6%94%b6%e9%80%b2%e9%9a%8e%e7%9c%8b%e6%b3%95/) | 2020-07-22 | 基本面分析 | fundamentals / revenue | public_or_unknown | P0 |
| [用數學計算日馳何時崩盤！](https://www.finlab.tw/%e7%94%a8%e6%95%b8%e5%ad%b8%e8%a8%88%e7%ae%97%e6%97%a5%e9%a6%b3%e4%bd%95%e6%99%82%e5%b4%a9%e7%9b%a4%ef%bc%81/) | 2020-07-22 | 財經PYTHON教學 | execution | public_or_unknown | P1 |
| [自動下單(Part 1)：用Python爬取交易記錄](https://www.finlab.tw/%e7%94%a8python%e7%8d%b2%e5%8f%96%e6%8c%81%e8%82%a1%e6%90%8d%e7%9b%8a%e8%a1%a8/) | 2020-07-22 | 財經PYTHON教學 | execution | public_or_unknown | P0 |
| [新年賀禮 - 投信跟盤法！](https://www.finlab.tw/%e6%8a%95%e4%bf%a1%e8%b7%9f%e7%9b%a4%e6%b3%95%ef%bc%81/) | 2020-07-22 | 籌碼面 | chips / institutional flow | public_or_unknown | P0 |
| [利用Pandas輕鬆取得股價並回測](https://www.finlab.tw/%e5%88%a9%e7%94%a8pandas%e8%bc%95%e9%ac%86%e5%8f%96%e5%be%97%e6%ad%b7%e5%8f%b2%e8%82%a1%e5%83%b9/) | 2020-07-22 | 財經PYTHON教學 | regime / macro | public_or_unknown | P1 |
| [坊間沒在教的RSI選股技巧](https://www.finlab.tw/%e5%9d%8a%e9%96%93%e6%b2%92%e5%9c%a8%e6%95%99%e7%9a%84rsi-%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7/) | 2020-07-22 | 技術面 | screener | public_or_unknown | P1 |
| [腦力激盪的外資策略！](https://www.finlab.tw/%e8%85%a6%e5%8a%9b%e6%bf%80%e7%9b%aa%e7%9a%84%e5%a4%96%e8%b3%87%e7%ad%96%e7%95%a5%ef%bc%81/) | 2020-07-22 | 籌碼面 | chips / institutional flow | public_or_unknown | P0 |
| [Python 股票 5 分鐘超簡單選股與回測 - 讓你投資股票少繳學費！](https://www.finlab.tw/python-%e7%b0%a1%e5%96%ae%e9%81%b8%e8%82%a1%e5%92%8c%e5%9b%9e%e6%b8%ac/) | 2020-07-22 | 財經PYTHON教學 | screener | public_or_unknown | P1 |
| [威廉．納葛維茲-價值型選股策略](https://www.finlab.tw/%e5%a8%81%e5%bb%89%ef%bc%8e%e7%b4%8d%e8%91%9b%e7%b6%ad%e8%8c%b2-%e5%83%b9%e5%80%bc%e5%9e%8b%e9%81%b8%e8%82%a1%e7%ad%96%e7%95%a5/) | 2020-07-22 | 選股策略 | screener | public_or_unknown | P0 |
| [市值營收比-幫你找到便宜獲利股](https://www.finlab.tw/%e5%b8%82%e5%80%bc%e7%87%9f%e6%94%b6%e6%af%94/) | 2020-07-22 | 基本面分析 | fundamentals / revenue | public_or_unknown | P0 |
| [避開大盤大跌的方法！](https://www.finlab.tw/%e9%81%8e%e6%bf%be%e5%a4%a7%e7%9b%a4%e7%9a%84%e7%b0%a1%e5%96%ae%e6%96%b9%e6%b3%95%ef%bc%81/) | 2020-07-22 | 大盤漲跌 | regime / macro | public_or_unknown | P1 |
| [用Python超簡單計算：158種常見技術指標](https://www.finlab.tw/python-%e7%b0%a1%e5%96%ae158%e7%a8%ae%e6%8a%80%e8%a1%93%e6%8c%87%e6%a8%99%e8%a8%88%e7%ae%97/) | 2020-07-22 | 財經PYTHON教學 | data / factor | public_or_unknown | P1 |
| [Python 時間序列實做！](https://www.finlab.tw/python-%e6%99%82%e9%96%93%e5%ba%8f%e5%88%97%e5%af%a6%e4%bd%9c%ef%bc%81/) | 2020-07-22 | 財經PYTHON教學 | execution | public_or_unknown | P1 |
| [如何定義KD鈍化？](https://www.finlab.tw/kd1/) | 2020-07-22 | 技術面 | screener | public_or_unknown | P1 |
| [利用Pandas輕鬆選股 - Python實作教學](https://www.finlab.tw/python%ef%bc%9a%e5%88%a9%e7%94%a8pandas%e8%bc%95%e9%ac%86%e9%81%b8%e8%82%a1/) | 2020-07-22 | 財經PYTHON教學 | screener | public_or_unknown | P1 |
| [超短線上影黑密技！](https://www.finlab.tw/%e8%b6%85%e7%9f%ad%e7%b7%9a%e4%b8%8a%e5%bd%b1%e9%bb%91%e5%af%86%e6%8a%80%ef%bc%81/) | 2020-07-22 | 技術面 | screener | public_or_unknown | P1 |
| [財報爬蟲超簡單 - 用Python一次抓綜合損益、資產負債、營利分析](https://www.finlab.tw/python-%e8%b2%a1%e5%a0%b1%e7%88%ac%e8%9f%b2-1-%e7%b6%9c%e5%90%88%e6%90%8d%e7%9b%8a%e8%a1%a8/) | 2020-07-22 | 財經PYTHON教學 | screener | public_or_unknown | P1 |
| [外資大賣，反而要買！？](https://www.finlab.tw/%e8%b7%9f%e8%91%97%e5%a4%96%e8%b3%87%e8%b2%b7%e8%82%a1%e7%a5%a8/) | 2020-07-22 | 籌碼面 | chips / institutional flow | public_or_unknown | P0 |
| [超簡單用python抓取每月營收](https://www.finlab.tw/%e8%b6%85%e7%b0%a1%e5%96%ae%e7%94%a8python%e6%8a%93%e5%8f%96%e6%af%8f%e6%9c%88%e7%87%9f%e6%94%b6/) | 2020-07-22 | 財經PYTHON教學 | fundamentals / revenue | public_or_unknown | P0 |
| [超簡單台股每日爬蟲教學](https://www.finlab.tw/%e8%b6%85%e7%b0%a1%e5%96%ae%e5%8f%b0%e8%82%a1%e6%af%8f%e6%97%a5%e7%88%ac%e8%9f%b2%e6%95%99%e5%ad%b8/) | 2020-07-22 | 財經PYTHON教學 | screener | public_or_unknown | P1 |
| [利用Machine Learning 選股新手教學](https://www.finlab.tw/%e5%88%a9%e7%94%a8machine-learning-%e9%81%b8%e8%82%a1%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b8/) | 2020-07-22 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [讓Machine Learning幫你看財報！](https://www.finlab.tw/%e8%ae%93machine-learning%e5%b9%ab%e4%bd%a0%e7%9c%8b%e8%b2%a1%e5%a0%b1%ef%bc%81/) | 2020-07-22 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [本益成長比真的越低越好！？](https://www.finlab.tw/%e6%af%94%e6%9c%ac%e7%9b%8a%e6%af%94%e6%9b%b4%e5%a5%bd%e7%94%a8%e7%9a%84%e6%9c%ac%e7%9b%8a%e6%af%94%e6%88%90%e9%95%b7%e7%8e%87%ef%bc%81/) | 2020-07-22 | 基本面分析 | data / factor | public_or_unknown | P1 |
| [絕無僅有的超強指標！](https://www.finlab.tw/%e7%b5%95%e7%84%a1%e5%83%85%e6%9c%89%e7%9a%84%e8%b6%85%e5%bc%b7%e6%8c%87%e6%a8%99%ef%bc%81/) | 2020-07-22 | 基本面分析 | data / factor | public_or_unknown | P1 |
| [Machine Learning 表示：看季線最無用！](https://www.finlab.tw/machine-learning-%e8%a1%a8%e7%a4%ba%ef%bc%9a%e7%9c%8b%e5%ad%a3%e7%b7%9a%e6%9c%80%e7%84%a1%e7%94%a8%ef%bc%81/) | 2020-07-22 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [基礎回測框架介紹](https://www.finlab.tw/%e5%9b%9e%e6%b8%ac%e6%a1%86%e6%9e%b6%e4%bb%8b%e7%b4%b9/) | 2020-07-22 | 選股策略 | screener | public_or_unknown | P1 |
| [財報狗選股策略實作 -  讓你免費取得價值4000元/年的選股策略](https://www.finlab.tw/%e8%b2%a1%e5%a0%b1%e7%8b%97%e9%81%b8%e8%82%a1%e6%a2%9d%e4%bb%b6%e6%9c%80%e4%bd%b3%e5%8c%96/) | 2020-07-22 | 財報狗分析 | screener | public_or_unknown | P0 |
| [教你用財報狗巴菲特免費選股](https://www.finlab.tw/%e6%95%99%e4%bd%a0%e7%94%a8%e8%b2%a1%e5%a0%b1%e7%8b%97%e5%b7%b4%e8%8f%b2%e7%89%b9%e5%85%8d%e8%b2%bb%e9%81%b8%e8%82%a1/) | 2020-07-22 | 財報狗分析 | screener | public_or_unknown | P0 |
| [價值股策略](https://www.finlab.tw/%e5%83%b9%e5%80%bc%e8%82%a1%e5%9b%9e%e6%b8%ac/) | 2020-07-22 | 選股策略 | screener | public_or_unknown | P1 |
| [用杜邦分析加強你的選股技巧（下）回測](https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%8b%ef%bc%89%e5%9b%9e%e6%b8%ac/) | 2020-07-22 | 基本面分析 | screener | public_or_unknown | P0 |
| [用杜邦分析加強你的選股技巧（中）淨利率](https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%ad%ef%bc%89%e6%b7%a8%e5%88%a9%e7%8e%87/) | 2020-07-22 | 基本面分析 | screener | public_or_unknown | P1 |
| [小資族也可以使用的選股法！](https://www.finlab.tw/%e5%b0%8f%e8%b3%87%e6%97%8f%e4%b9%9f%e5%8f%af%e4%bb%a5%e4%bd%bf%e7%94%a8%e7%9a%84%e9%81%b8%e8%82%a1%e6%b3%95%ef%bc%81/) | 2020-07-22 | 選股策略 | data / factor | public_or_unknown | P1 |
| [用杜邦分析加強你的選股技巧（中）總資產週轉率](https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%ad%ef%bc%89%e7%b8%bd%e8%b3%87%e7%94%a2%e8%bd%89%e6%8f%9b%e7%8e%87/) | 2020-07-22 | 基本面分析 | screener | public_or_unknown | P1 |
| [拆解ROE用杜邦分析加強你的選股技巧（中）權益乘數](https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%ad%ef%bc%89%e6%ac%8a%e7%9b%8a%e4%b9%98%e6%95%b8/) | 2020-07-22 | 基本面分析 | fundamentals / revenue | public_or_unknown | P1 |
| [用杜邦分析加強你的選股技巧（上）](https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%8a%ef%bc%89/) | 2020-07-22 | 基本面分析 | screener | public_or_unknown | P1 |
| [買股票只考慮ROE是不夠的！](https://www.finlab.tw/%e8%b2%b7%e8%82%a1%e7%a5%a8%e5%8f%aa%e8%80%83%e6%85%aeroe%e6%98%af%e4%b8%8d%e5%a4%a0%e7%9a%84%ef%bc%81/) | 2020-07-22 | 基本面分析 | fundamentals / revenue | public_or_unknown | P0 |
| [EPS跟ROE哪個比較好用？](https://www.finlab.tw/eps%e8%b7%9froe%e5%93%aa%e5%80%8b%e6%af%94%e8%bc%83%e5%a5%bd%e7%94%a8%ef%bc%9f/) | 2020-07-22 | 基本面分析 | fundamentals / revenue | public_or_unknown | P1 |
| [14年14倍的選股策略！](https://www.finlab.tw/%e6%af%94%e7%ad%96%e7%95%a5%e7%8b%97%e9%82%84%e8%a6%81%e5%ae%89%e5%85%a8%e7%9a%84%e9%81%b8%e8%82%a1%e7%ad%96%e7%95%a5%ef%bc%81/) | 2020-07-22 | 選股策略 | data / factor | public_or_unknown | P1 |
| [大盤要跌了嗎？利用企業本益比分佈來判斷！](https://www.finlab.tw/%e5%a4%a7%e7%9b%a4%e8%a6%81%e8%b7%8c%e4%ba%86%e5%97%8e%ef%bc%9f%e5%88%a9%e7%94%a8%e4%bc%81%e6%a5%ad%e6%9c%ac%e7%9b%8a%e6%af%94%e5%88%86%e4%bd%88%e4%be%86%e5%88%a4%e6%96%b7%ef%bc%81/) | 2020-07-22 | 大盤漲跌 | data / factor | public_or_unknown | P1 |
| [本益比能幫你選出優質股？](https://www.finlab.tw/%e6%9c%ac%e7%9b%8a%e6%af%94%e8%83%bd%e5%b9%ab%e4%bd%a0%e9%81%b8%e5%87%ba%e5%84%aa%e8%b3%aa%e8%82%a1%ef%bc%9f/) | 2020-07-22 | 基本面分析 | data / factor | public_or_unknown | P0 |
| [用股價淨值比來判斷大盤漲跌](https://www.finlab.tw/%e7%94%a8%e8%82%a1%e5%83%b9%e6%b7%a8%e5%80%bc%e6%af%94%e4%be%86%e5%88%a4%e6%96%b7%e5%a4%a7%e7%9b%a4%e6%bc%b2%e8%b7%8c/) | 2020-07-22 | 大盤漲跌 | data / factor | public_or_unknown | P1 |
| [股價淨值比有這麼神？](https://www.finlab.tw/%e8%82%a1%e5%83%b9%e6%b7%a8%e5%80%bc%e6%af%94%e6%9c%89%e9%80%99%e9%ba%bc%e7%a5%9e%ef%bc%9f/) | 2020-07-22 | 基本面分析 | data / factor | public_or_unknown | P0 |
| [只用一行程式碼分析數據!? - 實用的 Python Package](https://www.finlab.tw/one-line-info-dataframe/) | 2020-07-21 | 財經PYTHON教學 | data / factor | public_or_unknown | P1 |
| [投資組合 Paper Trading 1分鐘就上手 - Cmoney 大富翁股票 API 教學](https://www.finlab.tw/cmoney-paper-trading/) | 2020-07-21 | 財經PYTHON教學 | execution | public_or_unknown | P1 |
| [機器學習真的無法預測股價嗎？](https://www.finlab.tw/ml-can-not-predict-price/) | 2020-07-21 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [每天只要15分鐘 - 超簡單學會 Python 自動化貨投資比特幣](https://www.finlab.tw/btc-summary/) | 2020-07-21 | 加密貨幣 | execution | public_or_unknown | P0 |
| [用Python投資加密貨幣：交易策略訊號實做 (Part 3)](https://www.finlab.tw/btc-trading-signal/) | 2020-07-20 | 加密貨幣 | execution | public_or_unknown | P1 |
| [用Python投資加密貨幣：爬蟲下載歷史數據 (Part 2)](https://www.finlab.tw/btc-crawler-py/) | 2020-07-20 | 加密貨幣 | other | public_or_unknown | P2 |
| [用Python投資加密貨幣：為什麼是比特幣？ (Part 1)](https://www.finlab.tw/python-bitcoin-trading-why-bitcoin/) | 2020-07-20 | 加密貨幣 | other | public_or_unknown | P2 |
| [台北最抗跌公寓在哪？ Python 告訴你 (Part 3)](https://www.finlab.tw/real-state-best-district-old-buildings-taipei/) | 2020-07-20 | 實價登入 | other | public_or_unknown | P2 |
| [Bokeh 探索頻道(2)~客製化技術圖表升級](https://www.finlab.tw/bokeh-stock-chart-with-technical-analysis/) | 2020-07-20 | 財經PYTHON教學 | data / factor | public_or_unknown | P1 |
| [策略最佳化是有效的嗎？（附程式碼）](https://www.finlab.tw/backtesting-key-optimization/) | 2020-07-20 | 股票策略 | backtest | public_or_unknown | P1 |
| [策略優化 - 如何避免過擬合？](https://www.finlab.tw/backtesting-overfitting-probability/) | 2020-07-20 | 選股策略 | screener | public_or_unknown | P1 |
| [AI讀書心得：人工智慧在台灣 - 產業轉型的契機與挑戰](https://www.finlab.tw/ai-in-taiwan/) | 2020-07-20 | AI看股票 | ML / AI | public_or_unknown | P1 |
| [Bokeh 探索頻道(1)~Python互動式圖表函數庫初體驗](https://www.finlab.tw/python-bokeh1-setup-and-first-impression/) | 2020-07-20 | 財經PYTHON教學 | data / factor | public_or_unknown | P1 |
| [用Python投資加密貨幣：手機監控與自動下單 (Part 12)](https://www.finlab.tw/btc-aws-signal-trigger-condition/) | 2020-07-20 | 加密貨幣 | execution | public_or_unknown | P0 |
| [用Python投資加密貨幣：用AWS Lambda即時更新交易訊號 (Part 11)](https://www.finlab.tw/btc-aws-lambda-signal-update/) | 2020-07-20 | 加密貨幣 | execution | public_or_unknown | P1 |
| [用Python投資加密貨幣：架設一個簡易的AWS交易系統 (Part 10)](https://www.finlab.tw/aws-lambda-initial-setup/) | 2020-07-20 | 加密貨幣 | execution | public_or_unknown | P1 |
| [創新高股票，你還少看了這個因子！](https://www.finlab.tw/break-new-high-roe-stock/) | 2020-07-20 | 股票策略 | data / factor | public_or_unknown | P0 |
| [用Python投資加密貨幣：入金加密貨幣 (Part 9)](https://www.finlab.tw/btc-deposit-ways/) | 2020-07-20 | 加密貨幣 | other | public_or_unknown | P2 |
| [用Python投資加密貨幣：如何投資加密貨幣 (Part 8)](https://www.finlab.tw/btc-deposit-how/) | 2020-07-20 | 加密貨幣 | other | public_or_unknown | P2 |
| [用Python投資加密貨幣：三年20倍的策略參數最佳化 (Part 7)](https://www.finlab.tw/btc-backtesting-optimization/) | 2020-07-20 | 加密貨幣 | backtest | public_or_unknown | P1 |
| [用Python投資加密貨幣：比特幣操作最強指標(看盤篇) (Part 6)](https://www.finlab.tw/btc-tradingview-intro/) | 2020-07-20 | 加密貨幣 | data / factor | public_or_unknown | P1 |
| [用Python投資加密貨幣：比特幣操作最強指標(原理篇) (Part 5)](https://www.finlab.tw/best-indicator-bitcoin/) | 2020-07-20 | 加密貨幣 | data / factor | public_or_unknown | P1 |
| [用Python投資加密貨幣：實做回測策略 (Part 4)](https://www.finlab.tw/btc-simple-sma-backtesting/) | 2020-07-20 | 加密貨幣 | backtest | public_or_unknown | P1 |
| [策略狗『績優股獵犬3』- 簡單回測](https://www.finlab.tw/%e7%ad%96%e7%95%a5%e7%8b%97%e3%80%82%e7%b8%be%e5%84%aa%e8%82%a1%e7%8d%b5%e7%8a%ac3%e3%80%82%e7%b0%a1%e5%96%ae%e5%9b%9e%e6%b8%ac/) | 2020-07-20 | 財報狗分析 | backtest | public_or_unknown | P0 |
| [策略狗。績優股獵犬2。何時買股才對？](https://www.finlab.tw/%e7%ad%96%e7%95%a5%e7%8b%97%e3%80%82%e7%b8%be%e5%84%aa%e8%82%a1%e7%8d%b5%e7%8a%ac2%e3%80%82%e4%bd%95%e6%99%82%e8%b2%b7%e8%82%a1%e6%89%8d%e5%b0%8d%ef%bc%9f/) | 2020-07-20 | 財報狗分析 | fundamentals / revenue | public_or_unknown | P0 |
| [策略狗。績優股獵犬1。如何找到優質股？](https://www.finlab.tw/%e7%ad%96%e7%95%a5%e7%8b%97%e3%80%82%e7%b8%be%e5%84%aa%e8%82%a1%e7%8d%b5%e7%8a%ac1%e3%80%82%e5%a6%82%e4%bd%95%e6%89%be%e5%88%b0%e5%84%aa%e8%b3%aa%e8%82%a1%ef%bc%9f/) | 2020-07-20 | 財報狗分析 | fundamentals / revenue | public_or_unknown | P0 |
| [用 Python 打造投資網站(1) - 開啟地圖](https://www.finlab.tw/financial-website-building-part1/) | 2020-07-20 | 財經PYTHON教學 | data / factor | public_or_unknown | P1 |

## Step 2-3 Batch Reading Notes

### 把「靈感」煉成「因子」：從感覺到證據的逆襲

- URL: https://www.finlab.tw/factor_analysis_3_factor/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 和一般做法，哪裡不一樣？ / 我們的範例策略： / 把策略拆成可驗證的語言：特徵 & 標籤 / 因子報酬（Factor Return）：它到底有沒有賺到「解釋力」？ / 因子集中度（Centrality）：因子擁擠嗎？ / 因子貢獻度 (Shapley Values)：把功勞分清楚 / IC（Information Coefficient）：預測力的體檢表 / 趨勢偵測：隨時間變化數值

### 選股策略分析：運用意圖因子衡量主力的方向

- URL: https://www.finlab.tw/linearfactor/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 核心選股邏輯 / 價格意圖因子 / 三大篩選條件 / 選股指標 / 為什麼 / 為什麼這個策略有用？ / 總結 / YOU MIGHT ALSO LIKE

### 大跌後的底氣 - 獨家主力波動指標

- URL: https://www.finlab.tw/broker_transaction_indicator/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 什麼是籌碼分點資料 / 資料來源與取得方式 / 籌碼分點資料的深度分析 / 過往如何通過籌碼分點資料識別主力資金動向 / 過往的券商分點指標 / 主力買賣超 / 買賣家數差

### 5種低波動因子，高效策略快速實踐

- URL: https://www.finlab.tw/low-volitility-metrics/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 低波動因子 / 什麼是低波動因子？ / 為什麼要使用低波動因子？ / 如何搭配低波動因子？ / 學術研究支持 / 因子的選擇與計算 / NATR (Normalized Average True Range) / 標準差 (Standard Deviation)

### 探討一個全局有效的因子優化方法

- URL: https://www.finlab.tw/better_factor/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 此文章為VIP限定 / 因子選股的基本概念 / 因子構建的數學邏輯 / 代碼解析 / 驚人的結果 / 結語 / YOU MIGHT ALSO LIKE / Python新手教學(Part 7)：策略再進化

### 每天看外資買賣超卻不知道怎麼解讀嗎?外資避險指標大公開，讓你提前避開股市大幅回落

- URL: https://www.finlab.tw/%e6%af%8f%e5%a4%a9%e7%9c%8b%e5%a4%96%e8%b3%87%e8%b2%b7%e8%b3%a3%e8%b6%85%e5%8d%bb%e4%b8%8d%e7%9f%a5%e9%81%93%e6%80%8e%e9%ba%bc%e8%a7%a3%e8%ae%80%e5%97%8e%e5%a4%96%e8%b3%87%e9%81%bf%e9%9a%aa%e6%8c%87/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: YOU MIGHT ALSO LIKE / 本益比能幫你選出優質股？ / 如何用machine learning學習 總體經濟？ / Alpha Arena 背後的技術解析、缺陷與潛力 / Python新手教學(Part 0)： 用Python投資？你想不到的好處! / 別買 ETF 因為存在根本性的缺陷！| 程式交易特別企劃 – 建構出自己的ETF (前導篇) / 投資組合 Paper Trading 1分鐘就上手 – Cmoney 大富翁股票 API 教學 / 如何做回測績效檢討？

### 能夠升級所有策略的指標：F-Score

- URL: https://www.finlab.tw/%e8%83%bd%e5%a4%a0%e5%8d%87%e7%b4%9a%e6%89%80%e6%9c%89%e7%ad%96%e7%95%a5%e7%9a%84%e6%8c%87%e6%a8%99%ef%bc%9af-score/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / Python 時間序列實做！ / 只要 3 個財報指標，報酬率高得驚人 / FinLab x Google雲端平台 | 3步驟實現全自動交易，從今以後躺著都能賺！(上) / 用深度學習幫你解析K線圖！ / 用Python投資加密貨幣：爬蟲下載歷史數據 (Part 2) / python新手教學(Part 6)：避開危險的投資時機 – 夏普指數策略 / 論文導讀：機器學習與基因演算法選股

### 技術指標教室｜動量指標 AROON

- URL: https://www.finlab.tw/aroon_indicator/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: Momentum indicators（動量指標）是什麼？ / Aroon 技術指標是什麼？ / AROON 技術指標公式 / AROON技術指標分析應用 / FinLab 量化平台實驗 AROON 指標選股 / 實驗條件 / 持有條件 / 出場條件

### 產業資料庫的基礎應用

- URL: https://www.finlab.tw/industry_themes_database_basic_application/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 產業資料 / 簡單查詢應用 / 簡單回測範例 / 自定義產業分類 / 小結 / YOU MIGHT ALSO LIKE / 研發費用率選股策略 / 史上最強大的台股板塊圖 | 操作說明書

### 用Python回測總經指標(2)｜美國失業率 vs S&P 500指數

- URL: https://www.finlab.tw/us_unemployment_rate_seasonally_adjusted_sp500_backtest/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 回測文章主要價值在驗證框架與防過擬合 checklist。
- Useful datasets: price; benchmark; transaction cost assumptions
- Possible feature: strategy_robustness_score; turnover_penalty; parameter_stability
- Cleaning rule: 所有策略需記錄資料可得日、再平衡日、交易假設。
- Backtest design: walk-forward、rolling window、不同成本假設、容量壓力測試。
- Production risk: 文章中的漂亮績效不能直接進 pending buy，必須 shadow test。
- Outline markers: 資料取得 / 圖表觀測 / 總經指標回測 / 程式範例 / 回測結果 / 全歷史 / 2000年至今 / 結論

### 用Python回測總經指標(1)｜M1B & M2 年增率

- URL: https://www.finlab.tw/tw_monetary_aggregates_m1b_strategy/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 指標意義 / 圖表觀察 / M1與Ｍ2交叉訊號回測 / M1均線指標 / Top Down 選股策略實測 / 動能策略範例 / 動能策略＊資金行情指標回測 / 結論

### 台股財報資料豆知識 ｜ 時序索引操作

- URL: https://www.finlab.tw/tw_stock_financial_statement_time_series_knowledge/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 財報發布日定義 / 財報截止日定義 / 上市櫃一般公司 / 保險業 / 金融業 / 量化平台財報資料操作 / 取得資料 / 時序轉換

### 如何用指標計分來選股? | Python 資料分級處理

- URL: https://www.finlab.tw/basic_score_strategy/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 方法一、Pandas qcut / 方法二、程式簡化 / 函數封裝 / 策略開發 / 優化 / 結論 / YOU MIGHT ALSO LIKE / 國安基金與庫藏股應用教學｜政府軍急了嗎？

### 選股策略回測有新功能！包含權重多空對沖、Sunburst 產業分析、PandasTA 技術指標 - FinLab 0.3.2.dev 再進化！

- URL: https://www.finlab.tw/%e9%81%b8%e8%82%a1%e7%ad%96%e7%95%a5%e5%9b%9e%e6%b8%ac%e6%96%b0%e5%8a%9f%e8%83%bd%e6%ac%8a%e9%87%8d%e5%a4%9a%e7%a9%ba%e5%b0%8d%e6%b2%96sunburst-%e7%94%a2%e6%a5%ad%e5%88%86%e6%9e%90pandasta-%e6%8a%80/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 熊市做什麼 / 1. 熊市是給你研發選股策略用的 / 2. 機會是給準備好的人的 / 3. 萬年如一日，一日如萬年 / 4. 永遠都在研發策略 / 策略新功能 / 1. SunBurst 讓你一眼看出目前股票部位的產業偏好 / 2. 回測支援多空對沖

### FRED總體經濟指標輕鬆抓|美國汽車指標|美股回測外掛教學

- URL: https://www.finlab.tw/fred%e7%b8%bd%e9%ab%94%e7%b6%93%e6%bf%9f%e6%8c%87%e6%a8%99%e8%bc%95%e9%ac%86%e6%8a%93%e7%be%8e%e5%9c%8b%e6%b1%bd%e8%bb%8a%e6%8c%87%e6%a8%99%e7%be%8e%e8%82%a1%e5%9b%9e%e6%b8%ac%e5%a4%96%e6%8e%9b/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 此文章為VIP限定 / FRED API 操作說明 / 帳號註冊&獲取API_KEY / API使用規則 / 拉取總經指標的時間序列 / 依據索引拉取其他相關指標 / 資料應用範例 / 美國汽車相關總體經濟指標繪圖

### ATR指標應用 | 肯特納通道（Keltner Channel）

- URL: https://www.finlab.tw/atr_keltner_channel/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: ATR定義 / ATR如何解讀與使用 / 股價波動率 / 停損停利 / 肯特納通道（Keltner Channel） / 肯特納通道 V.S. 布林通道 / 肯特納通道策略範例 / 策略條件

### 七七四十九種PEG本益成長比，找出潛力成長股，製作年報酬率 30% 的選股策略！

- URL: https://www.finlab.tw/peg/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 此文章為VIP限定 / 有PE了，為什麼還需要PEG? / PEG的公式 / PEG定義 / 切分資料集 / 單用PEG回測 / 搭配濾網設計 / PEG跟月營收配嗎?

### 4種均線指標 | 讓你在大盤崩崩前高歌離席!

- URL: https://www.finlab.tw/index_filter/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / ADLs / Vix / 融資維持率 / 多空頭家數排列 / 完整程式碼 / 執行結果 / ADLs

### 使用月營收與動能策略選股的完整介紹

- URL: https://www.finlab.tw/%e4%bd%bf%e7%94%a8%e6%9c%88%e7%87%9f%e6%94%b6%e8%88%87%e5%8b%95%e8%83%bd%e7%ad%96%e7%95%a5%e9%81%b8%e8%82%a1%e7%9a%84%e5%ae%8c%e6%95%b4%e4%bb%8b%e7%b4%b9/
- Topic: screener
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 此文章為VIP限定 / 程式碼簡介 / 核心程式碼： / 數據來源與處理 / 1. 收盤價 (Closing Price) / 2. 當月營收 (Monthly Revenue) / 條件篩選邏輯 / 1. 技術面條件

### 業外收入比例：用3個財報數據，選出年化報酬率 22％ 以上的投資組合！

- URL: https://www.finlab.tw/%e6%a5%ad%e5%a4%96%e6%94%b6%e5%85%a5%e6%af%94%e4%be%8b%ef%bc%9a%e7%94%a83%e5%80%8b%e8%b2%a1%e5%a0%b1%e6%95%b8%e6%93%9a%ef%bc%8c%e9%81%b8%e5%87%ba%e5%b9%b4%e5%8c%96%e5%a0%b1%e9%85%ac%e7%8e%87-22/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 有些數據看似不起眼，但竟然可以這樣影響投資結果！ / 使用的數據 / 計算一個指標 / 公式的原理 / 這個指標的由來 / 找出表現最好的公司 / 用回測來驗證 / 回測結果

### 揭秘庫藏股：庫藏股投資策略再優化，股市條件探勘（Part 2）

- URL: https://www.finlab.tw/inventory-down/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 摘要 / 論文參考 / 事件交易分析法 / 各式相關的因子 / 交易策略 / 結論 / YOU MIGHT ALSO LIKE / 合約負債 | 營建業選股策略

### 揭秘庫藏股：智慧投資策略與市場動態的完美結合（Part 1）

- URL: https://www.finlab.tw/inventory-up/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 庫藏股是什麼？ / 為什麼需要庫藏股 / 怎麼利用庫藏股事件獲利 / 結論 / 用程式自動下單 / YOU MIGHT ALSO LIKE / 財報爬蟲超簡單 – 用Python一次抓綜合損益、資產負債、營利分析 / VIX美股大跌投資法：Python實作教學看這裡！

### 事件研究法（中）使用事件交易模組

- URL: https://www.finlab.tw/event-study-usage/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: YOU MIGHT ALSO LIKE / 成長飆股怎麼找？超級績效選股法大解密 / 使用 Python 進行股票分析指南：入門篇 / 選股策略系統性學習(1)｜新手初訪 / 生技股如何安全買？逆勢爆賺策略分享 / 選股策略分析：運用意圖因子衡量主力的方向 / Python新手教學(Part 7)：策略再進化 / 加速度指標：歷史年報酬20％的策略

### 事件交易分析法：減資事件是我的印鈔機

- URL: https://www.finlab.tw/capital-reduction-short/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 簡介事件研究法 / 這隻策略大概有多好？– 敘述性統計 / 什麼因子可能影響績效？– 橫斷面回歸分析 / YOU MIGHT ALSO LIKE / 別買 ETF 因為存在根本性的缺陷！| 程式交易特別企劃 – 建構出自己的ETF (前導篇) / 復刻與優化 00900 ：使用 IC Decay 優化高股息策略成「長跑軍火庫」 / 每天只要15分鐘 – 超簡單學會 Python 自動化貨投資比特幣 / 做量化投資會遇到的挑戰？

### 反思菲式思考 Part.3｜站在菲神的肩膀上研發策略｜預判恢復信用交易有用嗎？

- URL: https://www.finlab.tw/https-www-finlab-tw-phcebus-thinking-report-part3-credit-transaction-recovery/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 可能恢復信用交易的個股 / 書中選股條件 / FinLab 回測驗證 / 程式碼 / 回測結果 / 報酬率與波動 / 流動性風險 / 回測交叉比對

### 探討進出時機的處置股策略 | 我跳進來了，我又跳出去了，打我啊笨蛋XD

- URL: https://www.finlab.tw/alerting_stock/
- Topic: screener
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 什麼是注意股? / 什麼是處置股? / 資料選取&切割 / 確認資料量 / 處置條件 / 處置措施 / 分時交易

### 成長飆股怎麼找？超級績效選股法大解密

- URL: https://www.finlab.tw/%e6%88%90%e9%95%b7%e9%a3%86%e8%82%a1%e6%80%8e%e9%ba%bc%e6%89%be-%e8%b6%85%e7%b4%9a%e7%b8%be%e6%95%88%e9%81%b8%e8%82%a1%e6%b3%95%e5%a4%a7%e8%a7%a3%e5%af%86/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 這位投資冠軍是什麼人物 / 論投資心態 / 自我認識 / 自我管理 / 首先要投資自己—有準備，才有機會 / 揮灑你的熱情 / 最好的開始時機 / 你想要的是什麼-判斷正確？還是賺錢？ / 交易是一門事業

### 月營收選股｜股價創新高｜新手必學的雙動能策略

- URL: https://www.finlab.tw/revenue_and_price_engine_strategy/
- Topic: screener
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 月營收選股策略 – 創高基礎型態 / 程式範例 / 營收股價雙創高的渦輪效應 / 股價創新高動能 / 雙渦輪 / 結論 / YOU MIGHT ALSO LIKE

### 研發費用率選股策略

- URL: https://www.finlab.tw/research_expense_ratio_strategy/
- Topic: screener
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 研發費用相關財務指標 / 研究發展費 / 研發費用率 / 研發費用佔營業費用比 / 全市場回測 / 燒錢企業 / 研發費用率分群

### 合約負債 | 營建業選股策略

- URL: https://www.finlab.tw/building-contingent-liability-strategy/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 營建建材類股走勢 / 營建業產業特性 / 什麼是流動合約負債？ / 策略撰寫 / 條件: / 策略範例 / 回測結果 / 結論

### 年報酬30％的泡沫選股策略秘技大公開 | 實際下單做實驗 | FinLab 財經實驗室

- URL: https://www.finlab.tw/bitcoin-stock-bubble-analysis-lppl-strategy/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: AI/ML 類文章適合做 research benchmark，不直接進 production decision。
- Useful datasets: FinLab normalized factors; price/chip/fundamental feature panels
- Possible feature: model_confidence_delta; feature_importance_stability; regime_conditioned_prediction
- Cleaning rule: 模型特徵必須走同一套 feature freshness / leakage 檢查。
- Backtest design: 只和現有 ML pool 做 challenger shadow test。
- Production risk: 範例模型若未處理時序切分與交易摩擦，容易高估效果。
- Outline markers: LPPLS 如何幫助我們選股呢？ / 用 LPPLS 分析 0050 / LPPLS 台股總體分析 / 平時如何應用泡沫選股指標獲利呢？ / 實單做實驗 / 結語 / YOU MIGHT ALSO LIKE / 威廉．納葛維茲-價值型選股策略

### 台股籌碼策略1-董監改選行情的江湖傳說

- URL: https://www.finlab.tw/directors-and-supervisors-re-election-strategy/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 籌碼訊號應轉成主題/產業層級流向與個股異常，而不是只看單日買賣超。
- Useful datasets: institutional net buy/sell; margin balance; broker branch flow; stock tags
- Possible feature: theme_institutional_flow; foreign_trust_alignment; margin_heat; broker_concentration
- Cleaning rule: 法人與券商資料需處理拆分、缺值、興櫃覆蓋差異與極端值 winsorize。
- Backtest design: 分別測個股流、產業流、主題流的 forward return 與 turnover。
- Production risk: 籌碼資料容易追高或反映已發生事件，需要和價格位置/流動性一起 gate。
- Outline markers: 台股籌碼策略策略設計 / 資料範圍 / 策略回測資料前處理 / 策略撰寫 / 雙因子策略 / 多因子策略 / 結語 / Reference

### 創新高有多高？

- URL: https://www.finlab.tw/%e5%89%b5%e6%96%b0%e9%ab%98%e6%9c%89%e5%a4%9a%e9%ab%98%ef%bc%9f/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 勝率分析 / 選到飆股機率 / 平均獲利比較 / YOU MIGHT ALSO LIKE / 加速度指標選股：免費Python實做教學看這裡！ / FinLab x Google雲端平台 | 3步驟實現Python全自動交易，從今以後躺著都能賺！(下) / 如何定義KD鈍化？ / 論文導讀：利用CNN神經網路來交易ETF

### 月營收這樣看！三種月營收選股法 - Python實作教學

- URL: https://www.finlab.tw/python-%e7%b0%a1%e5%96%ae%e7%94%a8%e6%9c%88%e7%87%9f%e6%94%b6%e9%81%b8%e8%82%a1%ef%bc%81/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 下載近12個月的月報 / 數據處理 – 合成時間序列 / 開始選股 / 平均線法 / 成長法 / 創新高法 / 使用方法 / YOU MIGHT ALSO LIKE

### 威廉．納葛維茲-價值型選股策略

- URL: https://www.finlab.tw/%e5%a8%81%e5%bb%89%ef%bc%8e%e7%b4%8d%e8%91%9b%e7%b6%ad%e8%8c%b2-%e5%83%b9%e5%80%bc%e5%9e%8b%e9%81%b8%e8%82%a1%e7%ad%96%e7%95%a5/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 營運合格的小市值股票 / 營收高是王道！ / 稅後淨利要考慮！ / 思路總結： / 回測結果 / 買股數量 / 跌幅 / 總結：

### 財報狗選股策略實作 -  讓你免費取得價值4000元/年的選股策略

- URL: https://www.finlab.tw/%e8%b2%a1%e5%a0%b1%e7%8b%97%e9%81%b8%e8%82%a1%e6%a2%9d%e4%bb%b6%e6%9c%80%e4%bd%b3%e5%8c%96/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 免費的東西最貴？ / 回測的心得 / 回測方法 / 小提醒 / 結語 / YOU MIGHT ALSO LIKE / 選股策略分析：運用意圖因子衡量主力的方向 / FRED總體經濟指標輕鬆抓|美國汽車指標|美股回測外掛教學

### 教你用財報狗巴菲特免費選股

- URL: https://www.finlab.tw/%e6%95%99%e4%bd%a0%e7%94%a8%e8%b2%a1%e5%a0%b1%e7%8b%97%e5%b7%b4%e8%8f%b2%e7%89%b9%e5%85%8d%e8%b2%bb%e9%81%b8%e8%82%a1/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 總共有九種條件、三個三個一組 / 回測方法 / 結論 / YOU MIGHT ALSO LIKE / 揭秘庫藏股：庫藏股投資策略再優化，股市條件探勘（Part 2） / 合約負債 | 營建業選股策略 / 使用 Python 進行股票分析指南：入門篇 / 台積電如何買？用 Python 研發投資策略

### 用杜邦分析加強你的選股技巧（下）回測

- URL: https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%8b%ef%bc%89%e5%9b%9e%e6%b8%ac/
- Topic: screener
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 選股條件： / 歷史績效 / 適用於IFRS制度開始後 / YOU MIGHT ALSO LIKE / 別買 ETF 因為存在根本性的缺陷！| 程式交易特別企劃 – 建構出自己的ETF (前導篇) / 建構出自己的 Smart ETF 00905 2.0 ! Part1 – 公開說明書內容解析 / 事件交易分析法：減資事件是我的印鈔機 / 使用 Python 進行股票分析指南：入門篇

### 投信買賣超選股策略｜時空序列分析的秘招｜停損怎麼設？

- URL: https://www.finlab.tw/time_series_analysis_of_investment_trust_strategy/
- Topic: chips / institutional flow
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 時間分析 / 空間分析 / 勝敗手MAE分佈圖 / 停損回測集 / 大盤時空 / 結論 / YOU MIGHT ALSO LIKE

### 低波動本益成長比策略 | MAE_MFE 機器學習選股

- URL: https://www.finlab.tw/low_volatility_stratgy_by_mae_mfe_ml/
- Topic: chips / institutional flow
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 此文章為VIP限定 / 選定待優化的策略 / 製作波動性 Labels / MAE & MFE / Kmeans 分群 / 決策樹-探索低波動因子 / 製作 Features / 模型測試結果

### 國安基金與庫藏股應用教學｜政府軍急了嗎？

- URL: https://www.finlab.tw/treasury_stock_national_security_fund/
- Topic: chips / institutional flow
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 庫藏股資料處理 / 程式範例 / 程式說明 / 取得國安基金資料 / 趨勢繪圖 / 程式範例 / 救市趨勢分析 / 政府救市三步

### 大盤融資維持率｜融資融券主力板塊Treemap｜DashBoard製作教學(4)

- URL: https://www.finlab.tw/%e8%9e%8d%e8%b3%87%e8%9e%8d%e5%88%b8%e4%b8%bb%e5%8a%9b%e6%9d%bf%e5%a1%8atreemap%e5%a4%a7%e7%9b%a4%e8%9e%8d%e8%b3%87%e7%b6%ad%e6%8c%81%e7%8e%87/
- Topic: chips / institutional flow
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 投資靈感的魔鏡 / 股癌節目的啟示 / 驗證大神觀點 / Treemap應用 / 融資板塊圖 / 融券板塊圖 / 結論 / YOU MIGHT ALSO LIKE

### 大盤融資維持率｜Plotly-多重圖組｜DashBoard製作教學(3)

- URL: https://www.finlab.tw/plotly-%e5%a4%9a%e9%87%8d%e5%9c%96%e7%b5%84%e8%9e%8d%e8%b3%87%e7%b6%ad%e6%8c%81%e7%8e%87dashboard%e8%a3%bd%e4%bd%9c%e6%95%99%e5%ad%b83/
- Topic: chips / institutional flow
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 生成融資維持率 / 台股大盤融資指標圖組繪製 / 目標結果 / 程式範例 / 多重子圖 / 融資維持率折線圖 / 餘額區域圖 / 買賣超長條圖

### 大盤融資維持率｜地板指標幫你搶長線反彈｜0050擇時策略優化？

- URL: https://www.finlab.tw/mt_rate_strategy/
- Topic: chips / institutional flow
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 融資維持率 / 大盤融資維持率(mt_rate) / 策略開發 / 條件設定 / 回測 / 2009-2021 / 2018-2021 / 結論

### 庫藏股實施家數｜崩盤後的長線抄底訊號｜左側交易

- URL: https://www.finlab.tw/treasury-stock-signal/
- Topic: chips / institutional flow
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 此文章為VIP限定 / 近期事件 / 金管會救市三步 / 程式驗證 / 爬蟲 / 清理資料及繪圖 / 結論： / YOU MIGHT ALSO LIKE

### 三大法人爬蟲：Python實作教學

- URL: https://www.finlab.tw/%e4%b8%89%e5%a4%a7%e6%b3%95%e4%ba%ba%e7%88%ac%e8%9f%b2/
- Topic: chips / institutional flow
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / 3 行 code 自動輸入帳密 Fugle API – 全自動交易 Fugle 篇 / Python 財報月報股價爬蟲，台股資料庫終極解決之道！ / 如何用Python獲得上市上櫃股票清單? / 用Python投資加密貨幣：入金加密貨幣 (Part 9) / 用深度學習幫你解析K線圖！ / Machine Learning 表示：看季線最無用！ / 創新高有多高？

### 新年賀禮 - 投信跟盤法！

- URL: https://www.finlab.tw/%e6%8a%95%e4%bf%a1%e8%b7%9f%e7%9b%a4%e6%b3%95%ef%bc%81/
- Topic: chips / institutional flow
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 投信就是基金 / 投信買賣資料 / 策略思路 / 結果 / 策略再優化 / 結論 / 謝謝大家的支持！2018繼續努力！ / YOU MIGHT ALSO LIKE

### 腦力激盪的外資策略！

- URL: https://www.finlab.tw/%e8%85%a6%e5%8a%9b%e6%bf%80%e7%9b%aa%e7%9a%84%e5%a4%96%e8%b3%87%e7%ad%96%e7%95%a5%ef%bc%81/
- Topic: chips / institutional flow
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: P大： / 我： / P大： / 我： / P 大 / 歡迎大家跟我討論策略喔！ / YOU MIGHT ALSO LIKE / 簡單又有效：股價加速度選股指標

### 外資大賣，反而要買！？

- URL: https://www.finlab.tw/%e8%b7%9f%e8%91%97%e5%a4%96%e8%b3%87%e8%b2%b7%e8%82%a1%e7%a5%a8/
- Topic: chips / institutional flow
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 最佳化外資買賣策略 / 外資大買大賣，跟著操作？ / YOU MIGHT ALSO LIKE / 買股票只考慮ROE是不夠的！ / 新年賀禮 – 投信跟盤法！ / 月營收這樣看！三種月營收選股法 – Python實作教學 / 使用月營收與動能策略選股的完整介紹 / 如何用machine learning學習 總體經濟？

### 只要 3 個財報指標，報酬率高得驚人

- URL: https://www.finlab.tw/fundamental-3-indicators/
- Topic: fundamentals / revenue
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 1. 策略的核心邏輯分析 / 2. 相關財務指標的解釋與應用 / 研發費用率與管理費用率的比值 / 淨值除資產（股東權益比率） / 價格與成交量篩選標準 / 3. 策略的歷史回測與表現分析 / 4. 如何改進與優化該策略

### 現金流量表超簡單策略開發

- URL: https://www.finlab.tw/cashflow_backtest_easy/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 現金流量表快速上手 / 回測 / 其他回測結果 / 策略範例 / 參考資源 / YOU MIGHT ALSO LIKE / 小資族也可以使用的選股法！ / 生命週期投資法則：眾多諾貝爾經濟學獎得主同聲讚譽的長期投資方法！

### 爬蟲 Python 新手教學(Part 1)：簡單程式碼，爬全球的股票!

- URL: https://www.finlab.tw/%e7%94%a8%e7%88%ac%e8%9f%b2%e7%88%ac%e5%85%a8%e4%b8%96%e7%95%8c%e8%82%a1%e5%83%b9/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 從頭開始學 python / 使用 Google Colab 來寫 Python / 用 Python 製作爬蟲爬取歷史股價 / 顯示爬蟲下載數據 / 全球股價爬蟲 / YOU MIGHT ALSO LIKE / 用Machine learning 學習看技術指標 / 股價淨值比能找到好股票？用歷史數據讓你感受它的厲害！

### 三種看月營收的進階方法！

- URL: https://www.finlab.tw/%e4%b8%89%e7%a8%ae%e6%9c%88%e7%87%9f%e6%94%b6%e9%80%b2%e9%9a%8e%e7%9c%8b%e6%b3%95/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 1. 均線法 / 2. 突破法 / 3. 成長法 / 最後還有MOM、QOQ、YOY / 傳統指標普遍效果較差 / 第三名：均線法（average） / 第二名：突破法（break through） / 第一名：我發明的成長法（increase）

### 市值營收比-幫你找到便宜獲利股

- URL: https://www.finlab.tw/%e5%b8%82%e5%80%bc%e7%87%9f%e6%94%b6%e6%af%94/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: YOU MIGHT ALSO LIKE / 本益成長比真的越低越好！？ / 財報爬蟲超簡單 – 用Python一次抓綜合損益、資產負債、營利分析 / 坊間沒在教的RSI選股技巧 / Machine Learning 表示：看季線最無用！ / 利用Pandas輕鬆選股 – Python實作教學 / 探討進出時機的處置股策略 | 我跳進來了，我又跳出去了，打我啊笨蛋XD / 威廉．納葛維茲-價值型選股策略

### 超簡單用python抓取每月營收

- URL: https://www.finlab.tw/%e8%b6%85%e7%b0%a1%e5%96%ae%e7%94%a8python%e6%8a%93%e5%8f%96%e6%af%8f%e6%9c%88%e7%87%9f%e6%94%b6/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / 使用月營收與動能策略選股的完整介紹 / 爬蟲 Python 新手教學(Part 1)：簡單程式碼，爬全球的股票! / 庫藏股實施家數｜崩盤後的長線抄底訊號｜左側交易 / Python新手教學(Part 5)：如何衡量風險與報酬？夏普比率告訴你 / 用Python投資加密貨幣：比特幣操作最強指標(原理篇) (Part 5) / 2021 交易聖杯初體驗 / 用Python超簡單計算：158種常見技術指標

### 買股票只考慮ROE是不夠的！

- URL: https://www.finlab.tw/%e8%b2%b7%e8%82%a1%e7%a5%a8%e5%8f%aa%e8%80%83%e6%85%aeroe%e6%98%af%e4%b8%8d%e5%a4%a0%e7%9a%84%ef%bc%81/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 公式推導 / 歷史回測 / 金融海嘯資產少60％！ / 策略二今天持股 / YOU MIGHT ALSO LIKE / 股票入門SOP懶人包 / 台積電如何買？用 Python 研發投資策略 / 給投資新手的理財規劃 | 小資族投資0050滾出千萬可能嗎？少看這集晚10年退休（免費工具分享）

### 策略狗。績優股獵犬2。何時買股才對？

- URL: https://www.finlab.tw/%e7%ad%96%e7%95%a5%e7%8b%97%e3%80%82%e7%b8%be%e5%84%aa%e8%82%a1%e7%8d%b5%e7%8a%ac2%e3%80%82%e4%bd%95%e6%99%82%e8%b2%b7%e8%82%a1%e6%89%8d%e5%b0%8d%ef%bc%9f/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / 策略狗『績優股獵犬3』- 簡單回測 / 策略狗。績優股獵犬1。如何找到優質股？ / FinLab - 韓承佑

### 策略狗。績優股獵犬1。如何找到優質股？

- URL: https://www.finlab.tw/%e7%ad%96%e7%95%a5%e7%8b%97%e3%80%82%e7%b8%be%e5%84%aa%e8%82%a1%e7%8d%b5%e7%8a%ac1%e3%80%82%e5%a6%82%e4%bd%95%e6%89%be%e5%88%b0%e5%84%aa%e8%b3%aa%e8%82%a1%ef%bc%9f/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / 策略狗。績優股獵犬2。何時買股才對？ / 策略狗『績優股獵犬3』- 簡單回測 / FinLab - 韓承佑

### 復刻與優化 00919：玩轉高股息 ETF

- URL: https://www.finlab.tw/%e5%be%a9%e5%88%bb%e8%88%87%e5%84%aa%e5%8c%96-00919%ef%bc%9a%e7%8e%a9%e8%bd%89%e9%ab%98%e8%82%a1%e6%81%af-etf/
- Topic: fundamentals / revenue
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 前言 / 一、00919 三大「精準」拆解 / 二、復刻 00919：研究流程 / 三、復刻 00919 的關鍵步驟 / 四、復刻結果 / 五、進階優化： / 六、優化後的成績單

### 如何復刻0056高股息ETF，並打造超越市場的進階策略！

- URL: https://www.finlab.tw/%e5%a6%82%e4%bd%95%e5%be%a9%e5%88%bb0056%e9%ab%98%e8%82%a1%e6%81%afetf%ef%bc%8c%e4%b8%a6%e6%89%93%e9%80%a0%e8%b6%85%e8%b6%8a%e5%b8%82%e5%a0%b4%e7%9a%84%e9%80%b2%e9%9a%8e%e7%ad%96%e7%95%a5%ef%bc%81/
- Topic: fundamentals / revenue
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 復刻 0056 的關鍵步驟 / 相關性分析： / 復刻 0056 報酬： / 長期持有 0056 報酬： / 因子 IC / IR 分析： / 獲利能力分析： / 抗風險能力分析：

### 建構出自己的 Smart ETF 00905 2.0！ Part3 – 優化策略實作

- URL: https://www.finlab.tw/%e5%bb%ba%e6%a7%8b%e5%87%ba%e8%87%aa%e5%b7%b1%e7%9a%84-smart-etf-00905-2-0-part3-%e5%84%aa%e5%8c%96%e7%ad%96%e7%95%a5%e5%af%a6%e4%bd%9c/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 前情提要 / 簡介 / 不同市場表現 / 組合有效單因子 / 限縮持股數目 / 不同市場表現 / 程式碼 / 回測結果

### 建構出自己的 Smart ETF 00905 2.0 ! Part2 – 12 個獲利因子程式碼懶人包大公開

- URL: https://www.finlab.tw/smart-etf-00905-%e7%a8%8b%e5%bc%8f%e9%a9%97%e8%ad%89%e5%af%a6%e4%bd%9c/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 流動性檢驗 / 指標篩選 / 價值因子指標 / 多因子分數 / 多因子權重係數 / 排序方式 / 候選名單 / 成分股集合一

### ROE到底高或低才好？

- URL: https://www.finlab.tw/roe%e5%88%b0%e5%ba%95%e9%ab%98%e6%88%96%e4%bd%8e%e6%89%8d%e5%a5%bd%ef%bc%9f/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: FinLab說：為何ROE越高越好？ / 財報狗說：為何ROE越高不會越好，甚至越低越好？ / 所以到底誰說的對？ / 所以FinLab跟財報狗誰的故事是對的？ / 正解： / YOU MIGHT ALSO LIKE / 2021股票、比特幣崩盤確切時間點 ?! 免費工具大揭密 (附程式碼) | FinLab 財經實驗室 / 只要 3 個財報指標，報酬率高得驚人

### 拆解ROE用杜邦分析加強你的選股技巧（中）權益乘數

- URL: https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%ad%ef%bc%89%e6%ac%8a%e7%9b%8a%e4%b9%98%e6%95%b8/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 權益乘數 / 負債沒想像中的這麼不好！ / 會善用槓桿的人更厲害 / YOU MIGHT ALSO LIKE / 用杜邦分析加強你的選股技巧（中）淨利率 / 用杜邦分析加強你的選股技巧（下）回測 / 用杜邦分析加強你的選股技巧（中）總資產週轉率 / 如何用Python獲得上市上櫃股票清單?

### EPS跟ROE哪個比較好用？

- URL: https://www.finlab.tw/eps%e8%b7%9froe%e5%93%aa%e5%80%8b%e6%af%94%e8%bc%83%e5%a5%bd%e7%94%a8%ef%bc%9f/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: EPS 介紹 / EPS低到高的歷史回測 / 跟ROE做比較 / ROE歷史回測 / YOU MIGHT ALSO LIKE / 超短線上影黑密技！ / 股票入門SOP懶人包 / 外資大賣，反而要買！？

### 如何超越 00733，台股最強 ETF？

- URL: https://www.finlab.tw/%e5%a6%82%e4%bd%95%e8%b6%85%e8%b6%8a00733%e5%8f%b0%e8%82%a1%e6%9c%80%e5%bc%b7-etf/
- Topic: fundamentals / revenue
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 導言 / 什麼是ETF 00733富邦台灣中小ETF / ETF 00733的股價表現與報酬率 / 與同類型ETF的比較 / 選股與回測 / 選股邏輯與策略 / ETF 00733的選股條件 / 動能因子與Alpha、Beta的解釋

### V轉指標：台股市場 ATR 波動率指標

- URL: https://www.finlab.tw/tw-stock-market-atr/
- Topic: regime / macro
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 波動率的定義 / 測試結果 / 附檔 / YOU MIGHT ALSO LIKE / ATR指標應用 | 肯特納通道（Keltner Channel） / 揭開策略的波動面紗｜MAE&MFE分析圖組使用指南 / Ben

### 用Python回測總經指標(3)｜台灣景氣燈號｜加減碼策略

- URL: https://www.finlab.tw/tw_business_indicator_changed_weight_strategy/
- Topic: regime / macro
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 景氣燈號如何撰寫加減碼？ / 景氣燈號加減碼訊號曲線變化 / 回測程式 / YOU MIGHT ALSO LIKE / 用Python回測總經指標(2)｜美國失業率 vs S&P 500指數 / 用Python回測總經指標(1)｜M1B & M2 年增率 / Python爬蟲教學｜美國勞動部統計局API｜失業率 / 利用 0050 的概念，優化選股的績效

### 如何利用主力買賣超張數預測台灣股市趨勢：深入分析與策略指南

- URL: https://www.finlab.tw/main-force-indicator-for-0051/
- Topic: regime / macro
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 介紹 / 指標公式 / 相關性分析與大盤比較 / 相關係數的計算 / 主力買賣超與大盤的比較 / 回測結果摘要 / YOU MIGHT ALSO LIKE / Finlab 量化平台徵稿活動得獎作品 集技術面和籌碼面於一身的的AI選股策略-陳士謀

### Python爬蟲教學｜美國勞動部統計局API｜失業率

- URL: https://www.finlab.tw/us_unemployment_rate_seasonally_adjusted_crawler/
- Topic: regime / macro
- Access: public_visible
- StockVision priority: P1
- Key idea: 回測文章主要價值在驗證框架與防過擬合 checklist。
- Useful datasets: price; benchmark; transaction cost assumptions
- Possible feature: strategy_robustness_score; turnover_penalty; parameter_stability
- Cleaning rule: 所有策略需記錄資料可得日、再平衡日、交易假設。
- Backtest design: walk-forward、rolling window、不同成本假設、容量壓力測試。
- Production risk: 文章中的漂亮績效不能直接進 pending buy，必須 shadow test。
- Outline markers: API 註冊 / API 規範 / 如何使用 API ? / 失業率發布日 / 小結 / YOU MIGHT ALSO LIKE / 用Python回測總經指標(2)｜美國失業率 vs S&P 500指數 / 用Python回測總經指標(1)｜M1B & M2 年增率

### 2021股票、比特幣崩盤確切時間點 ?! 免費工具大揭密 (附程式碼) | FinLab 財經實驗室

- URL: https://www.finlab.tw/bitcoin-stock-bubble-analysis-lppl/
- Topic: regime / macro
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 金融波動大，要如何高買低賣？ / 全市場通用的泡沫模型 / LPPL 數學原理 / 跟我們一起來做實驗吧！ / YOU MIGHT ALSO LIKE / 復刻與優化 00900 ：使用 IC Decay 優化高股息策略成「長跑軍火庫」 / 利用機器學習預測漲跌-優化方式 / 用數學計算日馳何時崩盤！

### 利用Pandas輕鬆取得股價並回測

- URL: https://www.finlab.tw/%e5%88%a9%e7%94%a8pandas%e8%bc%95%e9%ac%86%e5%8f%96%e5%be%97%e6%ad%b7%e5%8f%b2%e8%82%a1%e5%83%b9/
- Topic: regime / macro
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 跟之前股價爬蟲的比較 / 首先先用 pandas_datareader 取得資料 / 用 pandas 計算 60日收盤價格 / 用pandas算出買入訊號 / 小總結 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：實做回測策略 (Part 4) / python新手教學(Part 6)：避開危險的投資時機 – 夏普指數策略

### 避開大盤大跌的方法！

- URL: https://www.finlab.tw/%e9%81%8e%e6%bf%be%e5%a4%a7%e7%9b%a4%e7%9a%84%e7%b0%a1%e5%96%ae%e6%96%b9%e6%b3%95%ef%bc%81/
- Topic: regime / macro
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 何時該用大盤過濾？ / 大盤過濾的優劣得失 / 範例 / YOU MIGHT ALSO LIKE / 新年賀禮 – 投信跟盤法！ / 客製化選股策略的回測價格序列 | 比較進出場的時間點特性 / 威廉．納葛維茲-價值型選股策略 / 小型股噴發的日子結束了？ADLs 指標顯示：接下來是決定性的時刻！

### 僅用財報製作 30% 年報酬的美股多空對沖策略

- URL: https://www.finlab.tw/financial-report-strategy-long-short/
- Topic: backtest
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 美股策略研究簡單嗎？ / 台股美股的差異？ / 美股的財報指標還有用嗎？ / 資料分析 / 市值衝吧！ / 小心獲利太多啦！ / 數據所代表的含意，跟常識不符合時，如何是好？ / 去除相似的資料

### 客製化流動性風險檢測 | 策略可以實戰嗎?

- URL: https://www.finlab.tw/customized_liquidityanalysis/
- Topic: backtest
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 流動性風險檢測API教學 / 檢測方法 / 如何打造自己的流動性檢測？ / 程式範例 / 客製化display_liquidity_risk 參數設定 / 檢測項目 / 檢測實際演練

### 加速度指標：歷史年報酬20％的策略

- URL: https://www.finlab.tw/%e5%8a%a0%e9%80%9f%e5%ba%a6%e6%8c%87%e6%a8%99-%e5%8a%a0%e9%80%9f%e4%bd%a0%e7%9a%84%e7%8d%b2%e5%88%a9/
- Topic: backtest
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 加速度指標回顧 / 加速度指標的癥結1：初始速度 / 解決方法 / 加速度指標的癥結2：採樣點太少 / 解決方法：多增加條件 / 加速度指標的癥結3：沒有考慮公司營運狀況 / 解決辦法 / 總結

### 策略狗『績優股獵犬3』- 簡單回測

- URL: https://www.finlab.tw/%e7%ad%96%e7%95%a5%e7%8b%97%e3%80%82%e7%b8%be%e5%84%aa%e8%82%a1%e7%8d%b5%e7%8a%ac3%e3%80%82%e7%b0%a1%e5%96%ae%e5%9b%9e%e6%b8%ac/
- Topic: backtest
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: YOU MIGHT ALSO LIKE / 創新高有多高？ / 外資大賣，反而要買！？ / 避開大盤大跌的方法！ / 策略狗。績優股獵犬1。如何找到優質股？ / 股價淨值比有這麼神？ / 客製化流動性風險檢測 | 策略可以實戰嗎? / 加速度指標：歷史年報酬20％的策略

### 事件研究法上：找到異常報酬率

- URL: https://www.finlab.tw/event-study-1/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 異常報酬率 / 第一步：移除已知的干擾資訊 / 第二步：研究股價的反應特性 / YOU MIGHT ALSO LIKE / FinLab x Google雲端平台 | 3步驟實現全自動交易，從今以後躺著都能賺！(上) / 復刻與優化 00900 ：使用 IC Decay 優化高股息策略成「長跑軍火庫」 / 把「靈感」煉成「因子」：從感覺到證據的逆襲 / Qlib 與 FinLab 整合，展現 AI 選股的神蹟。

### 生命週期投資法則：眾多諾貝爾經濟學獎得主同聲讚譽的長期投資方法！

- URL: https://www.finlab.tw/lifecycle-investing/
- Topic: backtest
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 此文章為VIP限定 / 設定投資股市的總金額 / 實施三階段投資法 / 現實例子: 住房貸款 / 投資策略大比拼：生命週期投資法的卓越表現 / 回測方法與結果分析 / Lifecycle Investing 模擬器 / 評估未來資產的折現價值：建立個人財富藍圖

### 資產配置：獲得年報酬 40% 的穩健投資組合 (腳本公開)

- URL: https://www.finlab.tw/portfolio_optimization/
- Topic: backtest
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 此文章為VIP限定 / 為什麼要做資產配置? / 許多觀眾詢問的問題 / 介紹什麼是資產配置、怎麼靠資產配置解決上述問題 / 分析即將使用的FinLab策略 / 將選股策略視為資產 / 介紹FinLab的策略 / 分析FinLab策略

### 選股回測系統豆知識 (1)｜報酬率計算

- URL: https://www.finlab.tw/backtest_system_rule/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 回測報價 / 還原股價 / 報酬率計算 / 訊號產生日與實際進出場日 / 交易成本設定與計算 / 策略權益曲線 / 小結 / Ben

### 台股超簡單 Python 技巧，三行程式碼：打造年報酬 +20% 的選股策略！

- URL: https://www.finlab.tw/%e5%8f%b0%e7%81%a3%e8%82%a1%e5%b8%82%e6%9c%80%e5%bc%b7%e7%9a%84-python-package/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 為什麼要做 FinLab Python Package？ / 目標是做出改變台灣投資環境生態的 Python Package / 三步驟：台股創造 20% 年化報酬策略 / 1. 獲取資料 / 選股策略 / 歷史回測 / YOU MIGHT ALSO LIKE / 用數學計算日馳何時崩盤！

### Python 低風險高報酬投資組合

- URL: https://www.finlab.tw/low-risk-fft-spy-strategy/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 將資產分兩半：SPY 跟 20年公債 / 安裝 ffn： / 獲取資料 / 將資產分一半，投資回測 / YOU MIGHT ALSO LIKE / FinLab 1.2 支援全自動下單！ / 利用機器學習預測漲跌-優化方式 / 超簡單台股每日爬蟲教學

### python新手教學(Part 6)：避開危險的投資時機 - 夏普指數策略

- URL: https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b8%ef%bc%9a%e5%a4%8f%e6%99%ae%e6%8c%87%e6%95%b8%e7%ad%96%e7%95%a5/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 為何Sharpe ratio幾乎都小於一 / 利用Python研發一個策略 / 利用Python快速編寫 / 夏普曲線的斜率 / 找轉折點 / 找出持有的時段 / 回測 / YOU MIGHT ALSO LIKE

### Python新手教學(Part 5)：如何衡量風險與報酬？夏普比率告訴你

- URL: https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b8%ef%bc%9a%e9%a2%a8%e9%9a%aa%e8%88%87%e5%a0%b1%e9%85%ac/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: sharp ratio 簡單講，就是「報酬 / 風險」！ / 如何定義獲利？ / 如何衡量風險 / 計算sharpe ratio / 台股竟然倒數第三名！ / 移動窗格 / 做圖看端倪 / YOU MIGHT ALSO LIKE

### 如何做回測績效檢討？

- URL: https://www.finlab.tw/%e5%9b%9e%e6%b8%ac%e7%b8%be%e6%95%88%e6%aa%a2%e8%a8%8e/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 一個有趣的問題 / ——公佈答案—— / YOU MIGHT ALSO LIKE / 探討一個全局有效的因子優化方法 / 2021年投資股票？請買一檔標的叫做比特幣。 / 復刻與優化 00900 ：使用 IC Decay 優化高股息策略成「長跑軍火庫」 / 投資組合(1)來打造專屬的投資組合吧！ / 用杜邦分析加強你的選股技巧（下）回測

### 策略最佳化是有效的嗎？（附程式碼）

- URL: https://www.finlab.tw/backtesting-key-optimization/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 就連學術期刊都如此！ / 舉一個例子 / 但方案一真的那麼好嗎？ / 我們將用更客觀的角度，量化上述兩個最佳化的實驗，哪一個比較好！ / Perfornace degradation / 感覺沒有差很多，有沒有更好的判斷法？ / 待改進之處 / YOU MIGHT ALSO LIKE

### 用Python投資加密貨幣：三年20倍的策略參數最佳化 (Part 7)

- URL: https://www.finlab.tw/btc-backtesting-optimization/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 暴力枚舉 / 策略參數最佳化的結果 / YOU MIGHT ALSO LIKE / 飆股可以賺更多？| 台股賣出的技術 / 只用一行程式碼分析數據!? – 實用的 Python Package / 利用Machine Learning 選股新手教學 / Alpha Arena 背後的技術解析、缺陷與潛力 / 好用Package：用ffn分析時間序列

### 用Python投資加密貨幣：實做回測策略 (Part 4)

- URL: https://www.finlab.tw/btc-simple-sma-backtesting/
- Topic: backtest
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 複習前幾篇用Python投資加密貨幣相關的知識 / YOU MIGHT ALSO LIKE / 生技股如何安全買？逆勢爆賺策略分享 / Python 股票 5 分鐘超簡單選股與回測 – 讓你投資股票少繳學費！ / 財報爬蟲超簡單 – 用Python一次抓綜合損益、資產負債、營利分析 / Bokeh 探索頻道(1)~Python互動式圖表函數庫初體驗 / 用程式分析房地產可行嗎？房價分析看這裡！ / 用Python超簡單計算：158種常見技術指標

### FinLab 1.2 支援全自動下單！

- URL: https://www.finlab.tw/finlab-1-2-portfolio-publish/
- Topic: execution
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 有什麼功能呢？ / 管理投資組合：PortfolioSyncManager / 絕對不超過本金 / 績效監控 / 未來目標 / YOU MIGHT ALSO LIKE / 機器學習 Python 做比特幣交易，如何找到好的特徵？增進模型的有效工具 / 別再錯過的選股策略！

### 用 Python 超簡單自動下單

- URL: https://www.finlab.tw/%e9%80%9a%e7%94%a8%e8%87%aa%e5%8b%95%e4%b8%8b%e5%96%ae%e6%b3%95%ef%bc%88%e4%b8%8b%ef%bc%89/
- Topic: execution
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 不負責聲明 / 使用Selenium / 自動登入 / 但事情沒那麼簡單… / 下漲停單 / YOU MIGHT ALSO LIKE / 用深度學習幫你解析K線圖！ / 用Python投資加密貨幣：如何投資加密貨幣 (Part 8)

### 自動下單(Part 1)：用Python爬取交易記錄

- URL: https://www.finlab.tw/%e7%94%a8python%e7%8d%b2%e5%8f%96%e6%8c%81%e8%82%a1%e6%90%8d%e7%9b%8a%e8%a1%a8/
- Topic: execution
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 打開券商看盤軟體（網站） / 打開網頁，監控network / 查看 Request 內容 / 寫code時間 / 寫信封的內容 / 下載持股部位 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：為什麼是比特幣？ (Part 1)

### 每天只要15分鐘 - 超簡單學會 Python 自動化貨投資比特幣

- URL: https://www.finlab.tw/btc-summary/
- Topic: execution
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 為什麼要投資加密貨幣 / 買入時機： Miner Capitulation 指標 / 用 Python 做自動化投資（量化投資） / 加密貨幣入金 / 策略雲端交易 / 用最科學的方式，投資最先進的貨幣 / YOU MIGHT ALSO LIKE / Python新手教學(Part 4)：台股的好兄弟是？台股相關性研究

### 用Python投資加密貨幣：手機監控與自動下單 (Part 12)

- URL: https://www.finlab.tw/btc-aws-signal-trigger-condition/
- Topic: execution
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 1. 連上網監控 / 2. 時間間格、自動下單 / YOU MIGHT ALSO LIKE / 台北最抗跌公寓在哪？ Python 告訴你 (Part 3) / 使用月營收與動能策略選股的完整介紹 / 只用一行程式碼分析數據!? – 實用的 Python Package / 復刻與優化 00919：玩轉高股息 ETF / 如何用Python獲得上市上櫃股票清單?

### Alpha Arena 背後的技術解析、缺陷與潛力

- URL: https://www.finlab.tw/alpha-arena-%e8%83%8c%e5%be%8c%e7%9a%84%e6%8a%80%e8%a1%93%e8%a7%a3%e6%9e%90%e3%80%81%e7%bc%ba%e9%99%b7%e8%88%87%e6%bd%9b%e5%8a%9b/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 一、 運作機制：當 LLM 成為量化交易員 / 輸入：將市場「文本化」的提示詞 / 處理：模型的「思考鏈」 (Chain of Thought) / 輸出：結構化的 JSON 交易決策 / 二、 方法論缺陷：是「策略」還是「幻覺」？ / 缺陷一：策略是「幻覺」，而非「回測」的產物 / 缺陷二：缺乏一致性與可重複性 / 缺陷三：不科學的「自信度」評分

### Information Coefficient 是什麼，要如何使用？

- URL: https://www.finlab.tw/information-coefficient/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 多樣本 / 驗證有效性 / 監控模型穩定性 / 組合效應評估 / 最重要的：避免過擬合 / IC的使用方法 / IC的應用場景 / 結論

### 飆股可以賺更多？| 台股賣出的技術

- URL: https://www.finlab.tw/%e9%a3%86%e8%82%a1%e5%8f%af%e4%bb%a5%e8%b3%ba%e6%9b%b4%e5%a4%9a%ef%bc%9f-%e5%8f%b0%e8%82%a1%e8%b3%a3%e5%87%ba%e7%9a%84%e6%8a%80%e8%a1%93/
- Topic: execution
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 知道買是徒弟，知道賣才是師傅 / 運用賣出指標的三個重點 / 不執著於賣在最高點 / 了解何時是用什麼指標 / 避免放空 / 閃崩賣出指標 – 賣出轉換線 / 指標意義

### 反思菲式思考 Part.1｜關鍵交易思維的啟發

- URL: https://www.finlab.tw/phcebus-thinking-report-part1/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 菲比斯的崛起 / 股票期貨的推薦 / 成為全職投資人的標準 / 菲式交易邏輯的啟發 / 產業面選股的解析 / 撰寫交易日誌 / 結論 / YOU MIGHT ALSO LIKE

### FinLab 量化交易線上研討會：講者徵選(延至2023/8/31)

- URL: https://www.finlab.tw/finlab-2023-fall-speaker_hiring/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: AI/ML 類文章適合做 research benchmark，不直接進 production decision。
- Useful datasets: FinLab normalized factors; price/chip/fundamental feature panels
- Possible feature: model_confidence_delta; feature_importance_stability; regime_conditioned_prediction
- Cleaning rule: 模型特徵必須走同一套 feature freshness / leakage 檢查。
- Backtest design: 只和現有 ML pool 做 challenger shadow test。
- Production risk: 範例模型若未處理時序切分與交易摩擦，容易高估效果。
- Outline markers: FinLab 量化交易線上研討會：講者徵選 / 徵件辦法 / 二、格式 / 三、獎勵 / 四、時程安排 / 五、評審標準 / 激起觀眾興趣的程度 / 主題新穎創新的程度

### 我的量化交易工作環境之 D43-720 4K 桌上型護眼大型螢幕

- URL: https://www.finlab.tw/benq-d43-720-4k/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 心得總結 / YOU MIGHT ALSO LIKE / 小型股噴發的日子結束了？ADLs 指標顯示：接下來是決定性的時刻！ / 市值營收比-幫你找到便宜獲利股 / 台股研究室實作風險因子Beta｜單因子選股｜風險因子Beta｜Ep.1 / 如何用指標計分來選股? | Python 資料分級處理 / 資產配置：獲得年報酬 40% 的穩健投資組合 (腳本公開) / 合約負債 | 營建業選股策略

### 好用Package：用ffn分析時間序列

- URL: https://www.finlab.tw/ffn-intro/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 籌碼訊號應轉成主題/產業層級流向與個股異常，而不是只看單日買賣超。
- Useful datasets: institutional net buy/sell; margin balance; broker branch flow; stock tags
- Possible feature: theme_institutional_flow; foreign_trust_alignment; margin_heat; broker_concentration
- Cleaning rule: 法人與券商資料需處理拆分、缺值、興櫃覆蓋差異與極端值 winsorize。
- Backtest design: 分別測個股流、產業流、主題流的 forward return 與 turnover。
- Production risk: 籌碼資料容易追高或反映已發生事件，需要和價格位置/流動性一起 gate。
- Outline markers: 但是DataFrame就夠了嗎？ / 救星：ffn (Financial Functions for Python) / 利用ffn取得股價 / ffn提供的functions / 下跌幅度 / YOU MIGHT ALSO LIKE / Python爬蟲教學｜ 財經數據｜台灣貨幣總計數 M1B & M2 / 3 行 code 自動輸入帳密 Fugle API – 全自動交易 Fugle 篇

### Python新手教學(Part 0)： 用Python投資？你想不到的好處!

- URL: https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b80%e7%82%ba%e4%bd%95%e7%94%a8python%e6%8a%95%e8%b3%87/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 程式化投資並不新奇，已經有各種解決方案，MT4、XQ、Multicharts… / 雖然使用上輕鬆簡單，然而大部分是必須要付費的！ / MT4 不用錢呀，但程式碼複雜 / 商用軟體自由度不夠 / Python 與 R 程式語言崛起 / 程式碼簡單、功能強大 / 免費且開源 / 不只拿來交易

### Python新手教學(Part 7)：策略再進化

- URL: https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b8%ef%bc%9a%e7%ad%96%e7%95%a5%e5%84%aa%e5%8c%96/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 先回顧上次的策略 / 1. 下載台股大盤資料 / 2. 編寫台股的sharpe ratio / 3. 編寫台股sharpe ratio策略 / 別轉台，終於要開始參數最佳化了 / 參數枚舉優化 / YOU MIGHT ALSO LIKE / 飆股可以賺更多？| 台股賣出的技術

### Python新手教學(Part 4)：台股的好兄弟是？台股相關性研究

- URL: https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b84%e7%9b%b8%e9%97%9c%e6%80%a7%e5%88%86%e6%9e%90/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 相關性 / 相關性稍微數學一點 / correlation coefficient （相關性係數） / 所以相關性跟投資有什麼關係？ / 程式碼撰寫 / 歷史數據回顧 / 比對歷史數據，發現close價格不一樣？ / 簡單的例子

### Python新手教學(Part 3)：全球指數歷史數據下載大全

- URL: https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b83%e5%85%a8%e7%90%83%e6%8c%87%e6%95%b8%e6%ad%b7%e5%8f%b2%e6%95%b8%e6%93%9a/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 1. for 迴圈 / 使用zip / dictionary / 繪製指數 / 有了指數，接下來要做什麼呢？ / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：如何投資加密貨幣 (Part 8) / 資產配置：獲得年報酬 40% 的穩健投資組合 (腳本公開)

### Python新手教學(Part 2)：全球指數一次抓

- URL: https://www.finlab.tw/python%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b82%e5%85%a8%e7%90%83%e6%8c%87%e6%95%b8%e4%b8%80%e6%ac%a1%e6%8a%93/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 籌碼訊號應轉成主題/產業層級流向與個股異常，而不是只看單日買賣超。
- Useful datasets: institutional net buy/sell; margin balance; broker branch flow; stock tags
- Possible feature: theme_institutional_flow; foreign_trust_alignment; margin_heat; broker_concentration
- Cleaning rule: 法人與券商資料需處理拆分、缺值、興櫃覆蓋差異與極端值 winsorize。
- Backtest design: 分別測個股流、產業流、主題流的 forward return 與 turnover。
- Production risk: 籌碼資料容易追高或反映已發生事件，需要和價格位置/流動性一起 gate。
- Outline markers: 上次的程式碼爬取台積電 / 將上述程式碼打包成function / 使用function / 國際重要指數清單 / 最後，終於要爬取全球股價了！ / YOU MIGHT ALSO LIKE / 台灣股市選股策略 Python 起手勢 / 選股策略分析：運用意圖因子衡量主力的方向

### VIX美股大跌投資法：Python實作教學看這裡！

- URL: https://www.finlab.tw/python%ef%bc%9avix%e7%be%8e%e8%82%a1%e5%a4%a7%e8%b7%8c%e6%8a%95%e8%b3%87%e6%b3%95/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 什麼是VIX / 獲取歷史資料 / 目錄 / 1. 利用pandas匯入歷史資料 / 大盤歷史績效分析 / VIX大於40，買入一年大盤能賺錢嗎？ / 繪圖 / 報酬率計算

### 超簡單用Python預測股價

- URL: https://www.finlab.tw/%e8%b6%85%e7%b0%a1%e5%96%ae-machine-learning-%e9%a0%90%e6%b8%ac%e8%82%a1%e5%83%b9/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 什麼是model（模型） / 用什麼模型預測股價呢？ / 以每週來檢視 / 以每年來檢視 / 傳統模型的限制 / 預言家模型 / 用預言家預測股票 / 超簡單環境設定

### 超簡單安裝Python教學

- URL: https://www.finlab.tw/python%e8%82%a1%e7%a5%a8%e6%8a%95%e8%b3%87/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 重點是全部都免費！ / 安裝 Python3 / 開啟 Python IDE / 尋找 packages / 方法1：google / 方法2：官網 / 使用 pip 來安裝 packages / YOU MIGHT ALSO LIKE

### Qlib 與 FinLab 整合，展現 AI 選股的神蹟。

- URL: https://www.finlab.tw/qlib-finlab-implementation-source-code/
- Topic: ML / AI
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 此文章為VIP限定 / YOU MIGHT ALSO LIKE / 選股策略回測有新功能！包含權重多空對沖、Sunburst 產業分析、PandasTA 技術指標 – FinLab 0.3.2.dev 再進化！ / 超短線上影黑密技！ / 用KD值選股：你還需搭配這三種指標 / FinLab x Google雲端平台 | 3步驟實現Python全自動交易，從今以後躺著都能賺！(下) / 低波動本益成長比策略 | MAE_MFE 機器學習選股 / 好用Package：用ffn分析時間序列

### Qlib-巨人級的AI量化投資平台

- URL: https://www.finlab.tw/qlib-intro/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: AI/ML 類文章適合做 research benchmark，不直接進 production decision。
- Useful datasets: FinLab normalized factors; price/chip/fundamental feature panels
- Possible feature: model_confidence_delta; feature_importance_stability; regime_conditioned_prediction
- Cleaning rule: 模型特徵必須走同一套 feature freshness / leakage 檢查。
- Backtest design: 只和現有 ML pool 做 challenger shadow test。
- Production risk: 範例模型若未處理時序切分與交易摩擦，容易高估效果。
- Outline markers: Qlib 特色 / AI 演算法模型 / 特徵資料集 / Workflow 架構 / 結論 / Ben

### 機器學習 Python 做比特幣交易，如何找到好的特徵？增進模型的有效工具

- URL: https://www.finlab.tw/python-machine-learning-bitcoin-feature-engineering/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: Tuneta 介紹 / Tuneta 的效果 / 實驗設計 / 下載歷史資料和 feature 建構 / 使用 Pandas_ta 產生 features / 使用 Tuneta 產生 features / 模型訓練 / 小節

### ROE怎麼看? 機器學習告訴你！

- URL: https://www.finlab.tw/roe%e6%80%8e%e9%ba%bc%e7%9c%8b-%e6%a9%9f%e5%99%a8%e5%ad%b8%e7%bf%92%e5%91%8a%e8%a8%b4%e4%bd%a0/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 什麼是SVM？ / SVM 的 Kernel Trick / 使用線性的kernel / 機器學習：市值越高的股票，ROE也要越高 / 假如有一檔股票「市值高，但是ROE低」，不會被選進來 / 對於「市值低，ROE低」的公司，SVM會比較寬容 / 使用曲線的kernel / 市值高的股票 ROE 不要太高

### 利用機器學習預測漲跌-優化方式

- URL: https://www.finlab.tw/generate-labels-stop-loss-stop-profit/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 缺點 / Triple Barrier / 程式碼 / YOU MIGHT ALSO LIKE / 能夠升級所有策略的指標：F-Score / Bokeh 探索頻道(2)~客製化技術圖表升級 / 用Python投資加密貨幣：實做回測策略 (Part 4) / python新手教學(Part 6)：避開危險的投資時機 – 夏普指數策略

### 論文導讀：利用MI-LSTM預測股價

- URL: https://www.finlab.tw/%e5%88%a9%e7%94%a8mi-lstm%e9%a0%90%e6%b8%ac%e8%82%a1%e5%83%b9/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 動機 / 此篇文章的貢獻 / MI-LSTM / 選股策略 / YOU MIGHT ALSO LIKE / 2021 交易聖杯初體驗 / 生命週期投資法則：眾多諾貝爾經濟學獎得主同聲讚譽的長期投資方法！ / 超簡單用Python預測股價

### 用Machine learning 學習看技術指標

- URL: https://www.finlab.tw/machine-learning%ef%bc%9a%e4%bd%bf%e7%94%a8%e6%8a%80%e8%a1%93%e6%8c%87%e6%a8%99%e9%a0%90%e6%b8%ac%e5%a4%a7%e7%9b%a4/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 選擇模型 / 選擇traning data / 結論 / YOU MIGHT ALSO LIKE / Python 時間序列實做！ / 把「靈感」煉成「因子」：從感覺到證據的逆襲 / Python新手教學(Part 5)：如何衡量風險與報酬？夏普比率告訴你 / 低波動本益成長比策略 | MAE_MFE 機器學習選股

### 如何用machine learning學習 總體經濟？

- URL: https://www.finlab.tw/%e6%a9%9f%e5%99%a8%e5%ad%b8%e7%bf%92-%e7%b8%bd%e9%ab%94%e7%b6%93%e6%bf%9f/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 建構features / 分析features / 三個維度的 cross-correlation / 預測明天的價格 / 預測N天後的價格 / 測試 w 的大小 / 回測績效 / 總結

### 論文導讀：機器學習與基因演算法選股

- URL: https://www.finlab.tw/%e6%a9%9f%e5%99%a8%e5%ad%b8%e7%bf%92%e8%88%87%e5%9f%ba%e5%9b%a0%e6%bc%94%e7%ae%97%e6%b3%95%e9%81%b8%e8%82%a1/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 第一步：決定染色體 / 第二步：決定染色體的成績 / 第三步：交叉遺傳 / 第四步：變異 / 回到第二步，開始生物演化的循環 / 機器學習 / 總結 / YOU MIGHT ALSO LIKE

### 用深度學習幫你解析K線圖！

- URL: https://www.finlab.tw/%e7%94%a8%e6%b7%b1%e5%ba%a6%e5%ad%b8%e7%bf%92%e5%b9%ab%e4%bd%a0%e8%a7%a3%e6%9e%90k%e7%b7%9a%e5%9c%96%ef%bc%81/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 長短期記憶 (Long Short-Term Memory, LSTM) 神經網路 / LSTM 實作股價預測 / LSTM 預測股價結果 / 參考資料 / 附註：現在就開始AI選股，免費取得訓練資料 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：入金加密貨幣 (Part 9) / 台灣股市選股策略 Python 起手勢

### 利用Machine Learning 選股新手教學

- URL: https://www.finlab.tw/%e5%88%a9%e7%94%a8machine-learning-%e9%81%b8%e8%82%a1%e6%96%b0%e6%89%8b%e6%95%99%e5%ad%b8/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 1. 免費取得資料 / 2. 架設環境 / 為何要安裝pip呢？ / 為何要安裝 virtualenv 呢？ / 3. 建置project / 4. 開工！ / A. 讀入資料 / B.處理資料

### 讓Machine Learning幫你看財報！

- URL: https://www.finlab.tw/%e8%ae%93machine-learning%e5%b9%ab%e4%bd%a0%e7%9c%8b%e8%b2%a1%e5%a0%b1%ef%bc%81/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 免費訓練資料 / 資料 / 訓練model的方式 / 結果太好了，我不敢相信… / 附註：免費取得訓練資料 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：實做回測策略 (Part 4) / 用深度學習幫你解析K線圖！

### Machine Learning 表示：看季線最無用！

- URL: https://www.finlab.tw/machine-learning-%e8%a1%a8%e7%a4%ba%ef%bc%9a%e7%9c%8b%e5%ad%a3%e7%b7%9a%e6%9c%80%e7%84%a1%e7%94%a8%ef%bc%81/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: Machine Learning：季線無用！ / 重要的財報數據 / 機器學習評分財報 / 回測！ / 財報好的公司，抗跌！ / 穩定的報酬率 / 別用這個策略亂放空！ / 附註：現在就開始AI選股，免費取得訓練資料和教程

### 機器學習真的無法預測股價嗎？

- URL: https://www.finlab.tw/ml-can-not-predict-price/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 但有時候真的稍微有那麼一點激烈 / 嗯… / 可以長期穩定獲利的就是好工具。 / 機器學習無法預測價格 / 難道想獲利一定要預測股價嗎？ / 通常撰寫策略，從來不用預測股價 / 不要用機器學習預測股價，而是用來直接產生交易訊號！ / 最為人所知的機器學習障礙 – 預測延遲

### AI讀書心得：人工智慧在台灣 - 產業轉型的契機與挑戰

- URL: https://www.finlab.tw/ai-in-taiwan/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 前言： / AI進程 / 機器學習簡單分 / AI產業化的難題 / 技術債-資料處理基礎建設: / AI人材困境 / 團隊工作流 / 產業案例

### 論文導讀：利用CNN神經網路來交易ETF

- URL: https://www.finlab.tw/cnn-time-series-image-conversion-approach/
- Topic: ML / AI
- Access: public_visible
- StockVision priority: P2
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / Python新手教學(Part 3)：全球指數歷史數據下載大全 / 毛利率的選股潛力：一種數據驅動的方法 / 用程式分析房地產可行嗎？房地產爬蟲教學在這裡！ / AI讀書心得：人工智慧在台灣 – 產業轉型的契機與挑戰 / 用 Python 超簡單自動下單 / 用Python投資加密貨幣：交易策略訊號實做 (Part 3) / Python 財報月報股價爬蟲，台股資料庫終極解決之道！

### 分散風險的迷思？當心「攤薄」效應！

- URL: https://www.finlab.tw/risk-of-diversification/
- Topic: risk / portfolio
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 過度分散：當所有股票「一個樣」，報酬/風險變成大盤的模樣 / 最優策略：集中優勢，搭配多元類型 Alpha / 結語：聰明的分散，才能兼顧收益與風險 / YOU MIGHT ALSO LIKE / 揭秘庫藏股：智慧投資策略與市場動態的完美結合（Part 1） / 合約負債 | 營建業選股策略 / 大跌後的底氣 – 獨家主力波動指標 / 進化後的本益比｜本益成長比選股策略

### 台股突破21,000，居高思危，用選擇權未平倉量避開股市潛在下跌風險

- URL: https://www.finlab.tw/%e5%8f%b0%e8%82%a1%e7%aa%81%e7%a0%b421000%ef%bc%8c%e5%b1%85%e9%ab%98%e6%80%9d%e5%8d%b1%ef%bc%8c%e7%94%a8%e9%81%b8%e6%93%87%e6%ac%8a%e6%9c%aa%e5%b9%b3%e5%80%89%e9%87%8f%e9%81%bf%e9%96%8b%e8%82%a1/
- Topic: risk / portfolio
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: YOU MIGHT ALSO LIKE / 自動下單(Part 1)：用Python爬取交易記錄 / 如何用machine learning學習 總體經濟？ / 進化後的本益比｜本益成長比選股策略 / 業外收入比例：用3個財報數據，選出年化報酬率 22％ 以上的投資組合！ / 用Python投資加密貨幣：實做回測策略 (Part 4) / 徵稿送 FinLab VIP 量化平台會員 / ROE怎麼看? 機器學習告訴你！

### 脫離韭菜命運的關鍵：利用MAE分析實踐正確的停損

- URL: https://www.finlab.tw/mae-distribution-stop-loss-setting/
- Topic: risk / portfolio
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 如何將虧損控制在可控的範圍？ / 歷史波動視覺化 / 其他 MAE 分析要注意的重點 / 結論 / YOU MIGHT ALSO LIKE / 揭開策略的波動面紗｜MAE&MFE分析圖組使用指南 / Ben

### Python爬蟲教學｜台股數據｜集保戶股權分散表

- URL: https://www.finlab.tw/python_crawler_tdcc_inventory/
- Topic: risk / portfolio
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 資料源 / Python爬蟲程式範例 / 輸出格式 / 未來開發 / YOU MIGHT ALSO LIKE / 如何用Python獲得上市上櫃股票清單? / 自動下單(Part 1)：用Python爬取交易記錄 / 爬蟲 Python 新手教學(Part 1)：簡單程式碼，爬全球的股票!

### Python 財報月報股價爬蟲，台股資料庫終極解決之道！

- URL: https://www.finlab.tw/python-%e8%b2%a1%e5%a0%b1%e6%9c%88%e5%a0%b1%e8%82%a1%e5%83%b9%e7%88%ac%e8%9f%b2%ef%bc%8c%e5%8f%b0%e8%82%a1%e8%b3%87%e6%96%99%e5%ba%ab%e7%b5%82%e6%a5%b5%e8%a7%a3%e6%b1%ba%e4%b9%8b%e9%81%93%ef%bc%81/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 財經資料庫比較 / CMoeny 貓頭鷹 / TEJ 資料庫 / 坊間 Python 教學 / FinMind / 資料庫的掙扎 / FinLab：從今天起，你有不同的選擇 / YOU MIGHT ALSO LIKE

### 本益比河流圖｜Python Plotly 應用教學

- URL: https://www.finlab.tw/pepb-river-chart/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 本益比河流圖的用途 / 如何繪製? / 生成資料 / 繪圖 / 封裝函數與多元應用 / 總結 / YOU MIGHT ALSO LIKE

### 進化後的本益比｜本益成長比選股策略

- URL: https://www.finlab.tw/finlab-tw-stock-peg-strategy/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 此文章為VIP限定 / PEG定義 / 公式重構 / PEG單因子策略回測 / 雙因子策略 / 月營收成長策略回測 / 雙因子策略回測 / 總結

### 本益比選股策略 | 產業因子分析

- URL: https://www.finlab.tw/finlab-tw-stock-pe-strategy/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 開發環境安裝 / 本益比定義 / PE單因子回測 / 全市場PE區間倍率回測 / 全市場策略範例 / 產業PE回測 / PE&產業因子策略範例

### 小型股噴發的日子結束了？ADLs 指標顯示：接下來是決定性的時刻！

- URL: https://www.finlab.tw/adls-stock-indicator/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: ADLs 指標 / ADLs + 均線的意義 / 指標與指數對照 / 回測結果 / 夏普值如何看？ / 總結 / YOU MIGHT ALSO LIKE / ADL指標幫你判斷台股盤勢｜順勢為王｜教你走出拉G盤的迷霧｜

### 台股研究室實作風險因子Beta｜單因子選股｜風險因子Beta｜Ep.1

- URL: https://www.finlab.tw/%e5%8f%b0%e8%82%a1%e7%a0%94%e7%a9%b6%e5%ae%a4%e5%af%a6%e4%bd%9c%ef%bd%9c%e5%96%ae%e5%9b%a0%e5%ad%90%e9%81%b8%e8%82%a1%ef%bd%9c%e9%a2%a8%e9%9a%aa%e5%9b%a0%e5%ad%90beta%ef%bd%9cep-1/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 風險因子理論基礎 / 投資組合Beta實作 / Beta 選股策略 / 回測結果 / 結論 / colab程式連結 / YOU MIGHT ALSO LIKE / 別再錯過的選股策略！

### ADL指標幫你判斷台股盤勢｜順勢為王｜教你走出拉G盤的迷霧｜

- URL: https://www.finlab.tw/adl-in-tw-stock/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: ADL(Advance/Decline line)定義 / ADL與大盤指數趨勢相關性 / ADL策略 / 策略假設 / 驗證回測 / 主動和被動投資擇時應用 / 結論 / 如何製作ADL圖表？

### 股價淨值比能找到好股票？用歷史數據讓你感受它的厲害！

- URL: https://www.finlab.tw/pb-data-analysis-explain/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 股價淨值比 PB 是什麼？ / 股價淨值比也透露股票的「未來價值」 / 用數據驗證坊間的謠傳 / 實驗素材 / 回測設計 / 究竟股價淨值比選多少比較安全呢？ / 選股價淨值比低的股票，報酬會不會不穩定呢？ / 照理說不被看好的股票應該會跌的更嚴重吧？

### 加速度指標選股：免費Python實做教學看這裡！

- URL: https://www.finlab.tw/%e5%8a%a0%e9%80%9f%e5%ba%a6%e6%8c%87%e6%a8%99%e5%af%a6%e5%81%9a/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 製作時間序列 / 撰寫加速度指標 / 試用看看 / 組裝策略 / 選股個股概覽 / 今天的重點整理 / YOU MIGHT ALSO LIKE / 用股價淨值比來判斷大盤漲跌

### 用KD值選股：你還需搭配這三種指標

- URL: https://www.finlab.tw/%e7%94%a8kd%e5%80%bc%e9%81%b8%e8%82%a1%ef%bc%9a%e9%82%84%e9%9c%80%e6%90%ad%e9%85%8d%e9%80%99%e4%b8%89%e7%a8%ae%e6%8c%87%e6%a8%99/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: KD值 / 長期趨勢漲，可能會買在高點！ / 股價必須高於年線 / 增加一些常用的財務指標 / 三種條件依序加上後的結果 / YOU MIGHT ALSO LIKE / 如何復刻0056高股息ETF，並打造超越市場的進階策略！ / 僅用財報製作 30% 年報酬的美股多空對沖策略

### 簡單又有效：股價加速度選股指標

- URL: https://www.finlab.tw/%e7%b0%a1%e6%98%93%e7%9a%84%e5%a4%96%e8%b3%87-%e5%9f%ba%e6%9c%ac%e9%9d%a2%e7%ad%96%e7%95%a5/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 究竟是如何完成一個策略的？ / 如何快速建構出一個好策略？ / 這是個誤打誤撞的策略 / 漲跌加減速指標 / 如何寫成條件式？ / 簡單，但是有效果！ / 先來看一下回測的結果 / YOU MIGHT ALSO LIKE

### 「外資買入成本指標」選股 - Python教學看這裡

- URL: https://www.finlab.tw/python%ef%bc%9a%e8%a8%88%e7%ae%97%e5%a4%96%e8%b3%87%e8%b2%b7%e5%85%a5%e6%88%90%e6%9c%ac/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 計算指標前，先整理好財務數據 / 好麻煩喔！有沒有更快的方式？(利用課堂的工具) / 接下來我們就可以來計算指標了，首先：外資買入成本 / 外資賣出成本 / 畫出曲線 / 選股 / YOU MIGHT ALSO LIKE / 用KD值選股：你還需搭配這三種指標

### 本益比能幫你選出優質股？

- URL: https://www.finlab.tw/%e6%9c%ac%e7%9b%8a%e6%af%94%e8%83%bd%e5%b9%ab%e4%bd%a0%e9%81%b8%e5%87%ba%e5%84%aa%e8%b3%aa%e8%82%a1%ef%bc%9f/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / 如何定義KD鈍化？ / 用杜邦分析加強你的選股技巧（下）回測 / 2021股票、比特幣崩盤確切時間點 ?! 免費工具大揭密 (附程式碼) | FinLab 財經實驗室 / 創新高有多高？ / 每天看外資買賣超卻不知道怎麼解讀嗎?外資避險指標大公開，讓你提前避開股市大幅回落 / 買股票只考慮ROE是不夠的！ / 反思菲式思考 Part.2｜策略回測探討

### 股價淨值比有這麼神？

- URL: https://www.finlab.tw/%e8%82%a1%e5%83%b9%e6%b7%a8%e5%80%bc%e6%af%94%e6%9c%89%e9%80%99%e9%ba%bc%e7%a5%9e%ef%bc%9f/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / 客製化選股策略的回測價格序列 | 比較進出場的時間點特性 / 台灣股市選股策略 Python 起手勢 / 生命週期投資法則：眾多諾貝爾經濟學獎得主同聲讚譽的長期投資方法！ / 給投資新手的理財規劃 | 小資族投資0050滾出千萬可能嗎？少看這集晚10年退休（免費工具分享） / 資產配置：獲得年報酬 40% 的穩健投資組合 (腳本公開) / 事件研究法（中）使用事件交易模組 / 現金流量表超簡單策略開發

### 創新高股票，你還少看了這個因子！

- URL: https://www.finlab.tw/break-new-high-roe-stock/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P0
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 1. 心理因素 / 2. 選到亂漲一通的股票 / 總結以上兩點 製作創新高策略 / 1. 動態調整 Portfolio / 2. 基本面篩選 / 3. 新因子研發 / 賣出策略 / 回測結果

### 復刻與優化 00900 ：使用 IC Decay 優化高股息策略成「長跑軍火庫」

- URL: https://www.finlab.tw/%e5%be%a9%e5%88%bb%e8%88%87%e5%84%aa%e5%8c%96-00900-%ef%bc%9a%e4%bd%bf%e7%94%a8-ic-decay-%e5%84%aa%e5%8c%96%e9%ab%98%e8%82%a1%e6%81%af%e7%ad%96%e7%95%a5%e6%88%90%e3%80%8c%e9%95%b7%e8%b7%91%e8%bb%8d/
- Topic: screener
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 前言 / 00900 特色整理 / 復刻 00900：研究流程全解析 / 資料來源與規則拆解 / 初始採樣母體 / 流動性條件 / 財務健全性與指標篩選

### 量化交易完整指南：策略、實施與風險管理

- URL: https://www.finlab.tw/%e9%87%8f%e5%8c%96%e4%ba%a4%e6%98%93%e5%ae%8c%e6%95%b4%e6%8c%87%e5%8d%97%ef%bc%9a%e7%ad%96%e7%95%a5%e3%80%81%e5%af%a6%e6%96%bd%e8%88%87%e9%a2%a8%e9%9a%aa%e7%ae%a1%e7%90%86/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 量化交易的基本概念 / 常見的量化交易策略 / 1. 多因子選股策略 / 範例：月營收策略 / 2. 市場中性策略 / 3. 趨勢跟隨策略 / 創新高延續動能策略 / 4. 高頻交易策略

### 揭開 OpenFE 在量化交易中的神秘面紗：高效自動化特徵生成的原理與實踐

- URL: https://www.finlab.tw/openfe-auto-gene-feature/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 此文章為VIP限定 / 一、OpenFE 簡介 / OpenFE 原理 / 程式實做 / 安裝相關套件 / 下載資料並且定義函數 / 生成特徵 / 計算預測標籤

### 市場短線過熱新聞滿天飛，技術指標達到超買階段，究竟該不該賣股票呢?!

- URL: https://www.finlab.tw/%e5%b8%82%e5%a0%b4%e7%9f%ad%e7%b7%9a%e9%81%8e%e7%86%b1%e6%96%b0%e8%81%9e%e6%bb%bf%e5%a4%a9%e9%a3%9b%ef%bc%8c%e6%8a%80%e8%a1%93%e6%8c%87%e6%a8%99%e9%81%94%e5%88%b0%e8%b6%85%e8%b2%b7%e9%9a%8e%e6%ae%b5/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 回測 / 回測 / 回測 / YOU MIGHT ALSO LIKE / 你最該避開的三個疲勞陷阱！ / 用Python回測總經指標(2)｜美國失業率 vs S&P 500指數 / 利用Pandas輕鬆取得股價並回測 / 為什麼要開這堂課程？用 Python 理財 – 打造加密貨幣實戰策略

### 槓桿動態調控策略的量化分析

- URL: https://www.finlab.tw/leverage-dynamic-adjustment-strategy/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 相關概念 / 最大下跌 / 動機 / 方法 / 數字範例 / 初始狀態 / 第 1 天 / 第 2 天

### 使用 Python 和 finlab 庫優化台灣股市投資策略

- URL: https://www.finlab.tw/%e4%bd%bf%e7%94%a8-python-%e5%92%8c-finlab-%e5%ba%ab%e5%84%aa%e5%8c%96%e5%8f%b0%e7%81%a3%e8%82%a1%e5%b8%82%e6%8a%95%e8%b3%87%e7%ad%96%e7%95%a5/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 引言：投資於台灣股市的機會 / 一、0056.TW ETF的投資吸引力與挑戰 / 投資吸引力 / 潛在挑戰 / 二、比較 0056.TW 與策略性投資的表現 / 三、使用 Python 和 finlab 庫實施投資策略 / 數據獲取 / 撰寫策略條件

### 利用 0050 的概念，優化選股的績效

- URL: https://www.finlab.tw/0050%e7%9a%84%e5%84%aa%e5%8c%96%e4%bb%a5%e5%8f%8a%e5%8f%b0%e7%81%a3%e5%b8%82%e5%a0%b4%e5%b8%82%e5%80%bc%e7%a0%94%e7%a9%b6/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 簡介 / ETF 的起源 / ETF 衍生的問題 / 0050 介紹 / 究竟要不要買 0050 ？ / 0050 實做 / 關於市值的分析 / 0050 優化：步驟一，小市值成交量

### 台灣股市選股策略 Python 起手勢

- URL: https://www.finlab.tw/python-taiwan-stock-market-selection/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 台灣股市與Python的融合 / 台灣股市概況 / Python於股市分析的應用 / 選股策略基礎概念 / 數據獲取與處理 / 低波動的計算與回測 / 台股市場的動能分析 / 組合條件設定與調整

### 毛利率的選股潛力：一種數據驅動的方法

- URL: https://www.finlab.tw/margin-new-high-event-analysis/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 準備工具 / 數據搜集 / 分析事件 / 對比基準 / 結論 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：架設一個簡易的AWS交易系統 (Part 10) / 用Python投資加密貨幣：比特幣操作最強指標(原理篇) (Part 5)

### 事件交易：現金增資放空

- URL: https://www.finlab.tw/followup-offering-short/
- Topic: screener
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: AI/ML 類文章適合做 research benchmark，不直接進 production decision。
- Useful datasets: FinLab normalized factors; price/chip/fundamental feature panels
- Possible feature: model_confidence_delta; feature_importance_stability; regime_conditioned_prediction
- Cleaning rule: 模型特徵必須走同一套 feature freshness / leakage 檢查。
- Backtest design: 只和現有 ML pool 做 challenger shadow test。
- Production risk: 範例模型若未處理時序切分與交易摩擦，容易高估效果。
- Outline markers: 此文章為VIP限定 / YOU MIGHT ALSO LIKE / Python新手教學(Part 4)：台股的好兄弟是？台股相關性研究 / 每天看外資買賣超卻不知道怎麼解讀嗎?外資避險指標大公開，讓你提前避開股市大幅回落 / 本益比選股策略 | 產業因子分析 / 如何用machine learning學習 總體經濟？ / 加速度指標選股：免費Python實做教學看這裡！ / 事件交易分析法：減資事件是我的印鈔機

### 反思菲式思考 Part.4｜站在菲神的肩膀上研發策略｜預判法說會有用嗎？

- URL: https://www.finlab.tw/investor-conference/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 書中選股條件 / 程式碼 / 回測結果 / 加入季營收增長率 / 營收的 YoY, QoQ, MoM 必須都要增長才行 / 營收 YoY, QoQ, MoM 至少要有一個亮眼才行 / MAE/MFE 分析 / 最終策略

### 反思菲式思考 Part.2｜策略回測探討

- URL: https://www.finlab.tw/phcebus-thinking-report-part2-backtest-sop/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 為什麼要回測? / 什麼是好的策略？ / 回測的侷限性 / 回測 V.S. 實際下單 / 資料難題 / 回測要注意的細節 / 好想上線賺錢 / YOU MIGHT ALSO LIKE

### 客製化選股策略的回測價格序列 | 比較進出場的時間點特性

- URL: https://www.finlab.tw/customed-tw-stock-backtest-price/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 進出場價格序列的比較 / 客製化 MarketInfo / 客製化回測價格套入策略 / 範例代碼 / 回測結果 / 多重比較各種回測價格序列 / 範例代碼 / 回測結果

### 美股探險記第4課:美股選股池分類器使用教學｜本益成長比最適合用在哪些產業？

- URL: https://www.finlab.tw/us_stock_industry_peg/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 美股選股池分類 / 參數說明 / 使用範例 / 限定在美股普通股中的科技類股 / 限定在美股特別股中的基礎原物料和能源類股 / 限定在美股 NASDAQ 交易所普通股中的軟體類股 / 檢視有哪些細產業可選擇

### 美股探險記第3課:1分鐘上手美股回測｜股價淨值比在美股策略還有效嗎？

- URL: https://www.finlab.tw/us_start_build_pb_strategy_backtest/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 建立你第一個美股策略 / 複製策略 / 執行策略 / 分析策略 / 報酬分析 / 風險分析 / 台股的股價淨值比策略表現 / 報酬分析

### 美股探險記第2課:美股資料庫使用者指南

- URL: https://www.finlab.tw/us_database_doc/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: FinLab 美股資料的超值之處 / 關鍵資料說明指南 / 技術面資料 / 美股成交資訊 / 基本面資料 / 美股財報 / 美股常用估值指標 / 美股企業基本資訊

### 美股探險記第1課:為什麼要投資美股？

- URL: https://www.finlab.tw/why_invest_in_us_stocks/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 地緣政治風險 / 台股的優點 / 台股的缺點 / 美股的優點 / 美股的缺點 / 結論 / YOU MIGHT ALSO LIKE / 美股探險記第4課:美股選股池分類器使用教學｜本益成長比最適合用在哪些產業？

### 新手看價，老手看量，高手看波動率

- URL: https://www.finlab.tw/low_volatility_research/
- Topic: screener
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 前情回顧 / 最強大的技術指標？K線波動率 / 創新高選股與股價波動 / 波動率的概念 / K 線波動率的定義與公式 / 單日股價漲跌幅幅度公式 / 飆股的長相 – 自創K線波動率算法

### 給小資族的禮物｜低價股量化策略的實戰訣竅

- URL: https://www.finlab.tw/low_price_strategy_tw_stock/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 不可能的任務?! 小資族 30 歲達到資產 500 萬！ / 財務曲線的理想大夢 / 小資族的翻身計畫 / 資金少該怎麼辦？ / 低價股的樂透效應 / 關鍵策略條件 / 定義低價股 / 定義動能突破

### 建構出自己的 Smart ETF 00905 2.0 ! Part1 - 公開說明書內容解析

- URL: https://www.finlab.tw/smart-etf-00905-%e5%85%ac%e9%96%8b%e8%aa%aa%e6%98%8e%e6%9b%b8%e5%85%a7%e5%ae%b9%e8%a7%a3%e6%9e%90/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: ETF的介紹與憂患 / 程式選股也能寫出ETF ! / ETF 就是選股策略 ! / 取得公開說明書 / 公開說明書內容解析 / 範例1 – 00905 公開說明書 / 範例2 – 0050 公開說明書 / YOU MIGHT ALSO LIKE

### 別買 ETF 因為存在根本性的缺陷！| 程式交易特別企劃 - 建構出自己的ETF (前導篇)

- URL: https://www.finlab.tw/etf-defect/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 起源 / 現況 / 與超額報酬之間的悖論 / 實例：00905 / 持股狀況 / 指數表現 / 自己建構ETF的好處 / YOU MIGHT ALSO LIKE

### 現金及約當現金：如何評估企業的現金流？

- URL: https://www.finlab.tw/%e7%8f%be%e9%87%91%e5%8f%8a%e7%b4%84%e7%95%b6%e7%8f%be%e9%87%91%e5%a6%82%e4%bd%95%e8%a9%95%e4%bc%b0%e4%bc%81%e6%a5%ad%e7%9a%84%e7%8f%be%e9%87%91%e6%b5%81/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: AI/ML 類文章適合做 research benchmark，不直接進 production decision。
- Useful datasets: FinLab normalized factors; price/chip/fundamental feature panels
- Possible feature: model_confidence_delta; feature_importance_stability; regime_conditioned_prediction
- Cleaning rule: 模型特徵必須走同一套 feature freshness / leakage 檢查。
- Backtest design: 只和現有 ML pool 做 challenger shadow test。
- Production risk: 範例模型若未處理時序切分與交易摩擦，容易高估效果。
- Outline markers: 現金及約當現金的用處 / 現金及約當現金有哪些不同的算法嗎？ / 現值法 / 市場價值法 / 現金及約當現金舉一個試算範例？ / 現金及約當現金高和低代表什麼意思？多少算是合理？ / 使用現金及約當現金的三個注意事項 / 選擇合適的計算方法

### 使用 Python 進行股票分析指南：入門篇

- URL: https://www.finlab.tw/python-quantitative-trading-introduction/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: Python 基礎語法入手 / 使用Python庫來獲取股票數據 / 財經資料處理工具 / 如何使用Python進行股票預測 / YOU MIGHT ALSO LIKE / 坊間沒在教的RSI選股技巧 / Python新手教學(Part 5)：如何衡量風險與報酬？夏普比率告訴你 / 用 Python 超簡單自動下單

### FinLab 開發與研究月報 (2022-11)

- URL: https://www.finlab.tw/finlab_monthly_dev_report_202211/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 影音教學 / 新策略上架 / 關鍵研究報告 / 新手上路 / 開發事項 / 未來開發 / Ben

### 選股回測系統豆知識 (2)｜持股比例上限設定

- URL: https://www.finlab.tw/backtest_system_position_limit/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 持股檔數設定 / 單檔持股比例上限 / 回測分析 / 結論 / YOU MIGHT ALSO LIKE / 月營收選股｜股價創新高｜新手必學的雙動能策略 / 美股探險記第3課:1分鐘上手美股回測｜股價淨值比在美股策略還有效嗎？ / FRED總體經濟指標輕鬆抓|美國汽車指標|美股回測外掛教學

### 選股策略系統性學習(1)｜新手初訪

- URL: https://www.finlab.tw/stock_strategy_learning_system_for_beginner/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 新手開胃策略 / 新手雙主菜策略 / 新手甜點策略 / 小結 / YOU MIGHT ALSO LIKE / 揭秘庫藏股：庫藏股投資策略再優化，股市條件探勘（Part 2） / 台灣股市選股策略 Python 起手勢 / 進化後的本益比｜本益成長比選股策略

### 產業面選股策略｜同業本益比比較法

- URL: https://www.finlab.tw/industry_pe_strategy/
- Topic: data / factor
- Access: vip_visible_or_unlocked
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 此文章為VIP限定 / 產業資料 / 簡單回測範例 / 產業因子篩選 / 取樣統計樣本 / 產業面回測比較 / 多產業策略 / 策略優化

### 突破策略豆知識 | 如何避免假突破?

- URL: https://www.finlab.tw/breakthrough_stock_picking_strategies/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 股價創新高策略範例 / 程式碼 / 選股條件 / 回測結果 / 策略優化 / 程式範例 / 選股條件 / 回測結果

### 3 行 code 自動輸入帳密 Fugle API - 全自動交易 Fugle 篇

- URL: https://www.finlab.tw/auto-trading-fugle/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 本機端自動交易測試 / 策略生成 / 計算買賣張數 / 使用FinLab套件下委託單 / 雲端版本測試 / 上傳憑證 / 環境變數設定 / 程式碼設定

### FinLab x Google雲端平台 | 3步驟實現Python全自動交易，從今以後躺著都能賺！(下)

- URL: https://www.finlab.tw/auto-trading-part2/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: AI/ML 類文章適合做 research benchmark，不直接進 production decision。
- Useful datasets: FinLab normalized factors; price/chip/fundamental feature panels
- Possible feature: model_confidence_delta; feature_importance_stability; regime_conditioned_prediction
- Cleaning rule: 模型特徵必須走同一套 feature freshness / leakage 檢查。
- Backtest design: 只和現有 ML pool 做 challenger shadow test。
- Production risk: 範例模型若未處理時序切分與交易摩擦，容易高估效果。
- Outline markers: 流程圖 / GCP 要收費嗎? / 註冊帳號 / 新增專案 / 上傳交易憑證 / 部署 Cloud Function / 啟用API / 基本設定

### FinLab x Google雲端平台 | 3步驟實現全自動交易，從今以後躺著都能賺！(上)

- URL: https://www.finlab.tw/auto-trading-part1/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 完整流程圖 / 開永豐/Fugle證券戶 / 簽署API證券下單同意書 / 申請下單憑證 / 小提醒 / 永豐模擬測試 (2022/09/22 更新) / 撰寫策略 / 將策略打包成函式

### 1 分鐘學會！使用 Lux API 自動視覺化 Pandas 資料

- URL: https://www.finlab.tw/lux-api-tutorial/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 安裝 Lux Package / 撰寫策略 / 顯示逐筆歷史交易 / Lux 資料視覺化 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：三年20倍的策略參數最佳化 (Part 7) / FRED總體經濟指標輕鬆抓|美國汽車指標|美股回測外掛教學 / 用Python投資加密貨幣：比特幣操作最強指標(原理篇) (Part 5)

### 史上最強大的台股板塊圖 | 操作說明書

- URL: https://www.finlab.tw/%e5%8f%b2%e4%b8%8a%e6%9c%80%e5%bc%b7%e5%a4%a7%e7%9a%84%e5%8f%b0%e8%82%a1%e6%9d%bf%e5%a1%8a%e5%9c%96-%e6%93%8d%e4%bd%9c%e8%aa%aa%e6%98%8e%e6%9b%b8/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 台股板塊圖操作說明 / 什麼是板塊圖 / 簡易互動 / 盤後資料模式 / 產業模式 / 板塊大小指標 / 顏色深淺指標 / 技術面

### Plotly-Sunburst｜輕鬆監控多策略部位｜DashBoard 應用教學(5)

- URL: https://www.finlab.tw/plotly-sunburst-dashboard/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 開發動機 / Sunburst 是怎樣的圖表？ / Plotly-Sunburst 基礎教學 / 圖例 / 程式解構 / StrategySunburst 物件教學 / 獲取多策略資料 / 獲取繪圖資料

### 護國神山抄底策略

- URL: https://www.finlab.tw/2330_bband_rebound/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 護國神山抄底抄起來？ / 布林通道逆勢策略 / 策略實作 / 回測數據分析 / 優勢比率分析 / 結論 / 程式碼範例 / YOU MIGHT ALSO LIKE

### 揭開策略的波動面紗｜MAE&MFE分析圖組使用指南

- URL: https://www.finlab.tw/display_mae_mfe_analysis/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 如何顯示MAE&MFE分析圖組 / 程式範例 / 輸出圖組範例 / 名詞定義 / 波幅 / Edge ratio / 如何解讀圖組 / 報酬率統計圖

### Finlab 量化平台徵稿活動得獎作品 集技術面和籌碼面於一身的的AI選股策略-陳士謀

- URL: https://www.finlab.tw/finlab_submit1/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 標的池 / 訓練、驗證、測試資料切分 / 技術面特徵 / 籌碼面特徵 / 預測標籤 / 資料處理 / 模型訓練 / 特徵重要性

### 2021 交易聖杯初體驗

- URL: https://www.finlab.tw/2021-trading-and-learning/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 交易聖杯是存在的 / 跳脫現有的框架 / 把研究當成興趣，賺錢是附屬的 / 相信自己 / 總結 / YOU MIGHT ALSO LIKE / 大跌後：用python找出強勢股！ / 用深度學習幫你解析K線圖！

### 5 個步驟設定選股條件，股票爆發力更上一層樓！

- URL: https://www.finlab.tw/5-%e5%80%8b%e6%ad%a5%e9%a9%9f%e8%a8%ad%e5%ae%9a%e9%81%b8%e8%82%a1%e6%a2%9d%e4%bb%b6%ef%bc%8c%e8%82%a1%e7%a5%a8%e7%88%86%e7%99%bc%e5%8a%9b%e6%9b%b4%e4%b8%8a%e4%b8%80%e5%b1%a4%e6%a8%93%ef%bc%81/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 1. 尋找因子 / 2. 判定效果 / 3. 決定是否棄用因子 / 4. 篩選條件 / 5. 重複 1~4 步驟 / 進階：非線性 / 進階：N 階因子 / 總結

### 投資組合(1)來打造專屬的投資組合吧！

- URL: https://www.finlab.tw/portfolio-theories-1-intro/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 投資組合模型？ / 有哪些投資組合模型？ / 需要的數學工具？ / YOU MIGHT ALSO LIKE / 股票投資組合系列（一） / 機器學習真的無法預測股價嗎？ / 復刻與優化 00919：玩轉高股息 ETF / 別買 ETF 因為存在根本性的缺陷！| 程式交易特別企劃 – 建構出自己的ETF (前導篇)

### 生技股如何安全買？逆勢爆賺策略分享

- URL: https://www.finlab.tw/python-biotech-stock-portfolio/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 生技股 ，漲停又跌停，如何判斷？ / 要如何判斷對的時機加碼呢？ / 生技股策略研發 / 優化歷史不等於優化未來？ / 要如何避免優化失敗呢？ / 生技股策略實做 / 安裝 Packages / 回測生技股

### 台積電如何買？用 Python 研發投資策略

- URL: https://www.finlab.tw/twii-2330-invest/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 3步驟帶你分析台積電 / 1. 使用 Colab 並下載環境 / 安裝 Package / 2. 下載台積電股價，研發買賣訊號！ / 策略訊號研發 / 3. 回測和參數優化 / 策略效果不夠好？尋找最佳參數！ / YOU MIGHT ALSO LIKE

### 別再錯過的選股策略！

- URL: https://www.finlab.tw/%e4%bd%a0%e9%8c%af%e9%81%8e%e7%9a%84%e9%81%b8%e8%82%a1%e7%ad%96%e7%95%a5%e6%80%9d%e8%b7%af/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 「錯過不是錯了，而是過了」 / 你錯過的一個策略 / 「假如你知道行情過熱，就休息個一年半載，放個長假」 / 到底為什麼總是跟策略擦身而過？ / 1. 不確定該策略的效果，不敢使用 / 2. 策略當時沒有篩選出股票，漸漸忘記 / 3. 追蹤了但是不敢使用 / 如何不要錯過獲利？

### 如何用Python獲得上市上櫃股票清單?

- URL: https://www.finlab.tw/python%ef%bc%9a%e5%a6%82%e4%bd%95%e7%8d%b2%e5%be%97%e4%b8%8a%e5%b8%82%e4%b8%8a%e6%ab%83%e8%82%a1%e7%a5%a8%e6%b8%85%e5%96%ae/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: AI/ML 類文章適合做 research benchmark，不直接進 production decision。
- Useful datasets: FinLab normalized factors; price/chip/fundamental feature panels
- Possible feature: model_confidence_delta; feature_importance_stability; regime_conditioned_prediction
- Cleaning rule: 模型特徵必須走同一套 feature freshness / leakage 檢查。
- Backtest design: 只和現有 ML pool 做 challenger shadow test。
- Production risk: 範例模型若未處理時序切分與交易摩擦，容易高估效果。
- Outline markers: 爬取網頁 / 將網頁轉成 DataFrame / 整理資料 1 整理column名稱 / 整理資料 2 刪除冗餘行列 / 設定index / YOU MIGHT ALSO LIKE / 年報酬30％的泡沫選股策略秘技大公開 | 實際下單做實驗 | FinLab 財經實驗室 / Python新手教學(Part 4)：台股的好兄弟是？台股相關性研究

### 股票投資組合系列（一）

- URL: https://www.finlab.tw/%e8%82%a1%e7%a5%a8%e6%8a%95%e8%b3%87%e7%b5%84%e5%90%88%e7%b3%bb%e5%88%97%ef%bc%88%e4%b8%80%ef%bc%89/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 報酬率模型 / 風險模型 / 同時比較報酬率跟風險 / 實做報酬率風險圖 / YOU MIGHT ALSO LIKE / 台灣股市選股策略 Python 起手勢 / 投資組合(1)來打造專屬的投資組合吧！ / 分散風險的迷思？當心「攤薄」效應！

### 我的量化投資史

- URL: https://www.finlab.tw/%e6%88%91%e7%9a%84%e9%87%8f%e5%8c%96%e6%8a%95%e8%b3%87%e9%bb%91%e6%ad%b7%e5%8f%b2/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 我錯了，量化投資不是聖杯 / 於是，我開始主觀交易，但後果是？ / 有了好策略，還是高買低賣 / 終於，下定決心每天投資 / 於是，下定決心按表操課？ / 人與量化條件搭配，相輔相成 / YOU MIGHT ALSO LIKE / 反思菲式思考 Part.4｜站在菲神的肩膀上研發策略｜預判法說會有用嗎？

### python上櫃資料爬蟲輕鬆做

- URL: https://www.finlab.tw/%e7%b0%a1%e5%96%aepython%e4%b8%8a%e6%ab%83%e8%b3%87%e6%96%99%e7%88%ac%e8%9f%b2%e5%af%a6%e5%81%9a/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / 復刻與優化 00900 ：使用 IC Decay 優化高股息策略成「長跑軍火庫」 / 如何復刻0056高股息ETF，並打造超越市場的進階策略！ / Python爬蟲教學｜ 財經數據｜台灣貨幣總計數 M1B & M2 / Python新手教學(Part 2)：全球指數一次抓 / Python新手教學(Part 4)：台股的好兄弟是？台股相關性研究 / 生技股如何安全買？逆勢爆賺策略分享 / 事件交易：現金增資放空

### 大跌後：用python找出強勢股！

- URL: https://www.finlab.tw/%e5%a4%a7%e8%b7%8c%e5%be%8c%ef%bc%9a%e6%89%be%e5%87%ba%e5%bc%b7%e5%8b%a2%e8%82%a1%ef%bc%81/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 災情分享 / 持之以恒 / 程式 / 結語 / YOU MIGHT ALSO LIKE / 14年14倍的選股策略！ / 年報酬30％的泡沫選股策略秘技大公開 | 實際下單做實驗 | FinLab 財經實驗室 / 每天看外資買賣超卻不知道怎麼解讀嗎?外資避險指標大公開，讓你提前避開股市大幅回落

### 股票入門SOP懶人包

- URL: https://www.finlab.tw/%e8%82%a1%e7%a5%a8%e5%85%a5%e9%96%80%e6%87%b6%e4%ba%ba%e5%8c%85/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 初學者投資SOP / 1. 第一步：基礎知識建立 / 任務：養成閱讀理財知識的習慣 / 2. 第二步：策略實驗階段（一個月到半年） / 任務：找到至少5種被動的選股策略 / 要選擇適合的策略 / 先不要自創選股方法 / 任務：實做5種策略的選股功能

### 用數學計算日馳何時崩盤！

- URL: https://www.finlab.tw/%e7%94%a8%e6%95%b8%e5%ad%b8%e8%a8%88%e7%ae%97%e6%97%a5%e9%a6%b3%e4%bd%95%e6%99%82%e5%b4%a9%e7%9b%a4%ef%bc%81/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 預防針 / LPPL / 取得日馳股價 / 最佳化 / 結論 / YOU MIGHT ALSO LIKE / 好用Package：用ffn分析時間序列 / 揭開 OpenFE 在量化交易中的神秘面紗：高效自動化特徵生成的原理與實踐

### 坊間沒在教的RSI選股技巧

- URL: https://www.finlab.tw/%e5%9d%8a%e9%96%93%e6%b2%92%e5%9c%a8%e6%95%99%e7%9a%84rsi-%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: RSI 超直覺介紹！ / RSI 用在選股上的難題 / 所以靠 RSI 選股就是個玄學！？ / 在每個股票之間找尋統一的 n，實現 RSI 追漲策略 / 小結論 / YOU MIGHT ALSO LIKE / Machine Learning 表示：看季線最無用！ / 使用月營收與動能策略選股的完整介紹

### Python 股票 5 分鐘超簡單選股與回測 - 讓你投資股票少繳學費！

- URL: https://www.finlab.tw/python-%e7%b0%a1%e5%96%ae%e9%81%b8%e8%82%a1%e5%92%8c%e5%9b%9e%e6%b8%ac/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 安裝 finlab 套件 / 匯入套件 / 取得股票數據 / 選擇投資策略 / 回測投資策略 / 完整的範例 / YOU MIGHT ALSO LIKE / Plotly-TreeMap｜台股版塊地圖｜DashBoard製作教學(2)

### 用Python超簡單計算：158種常見技術指標

- URL: https://www.finlab.tw/python-%e7%b0%a1%e5%96%ae158%e7%a8%ae%e6%8a%80%e8%a1%93%e6%8c%87%e6%a8%99%e8%a8%88%e7%ae%97/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: KD 值計算 / MACD 計算 / OBV計算 / 威廉指數計算 / ATR 計算 / 改變參數 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：三年20倍的策略參數最佳化 (Part 7)

### Python 時間序列實做！

- URL: https://www.finlab.tw/python-%e6%99%82%e9%96%93%e5%ba%8f%e5%88%97%e5%af%a6%e4%bd%9c%ef%bc%81/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 每日爬蟲 / 呼叫每日爬蟲，連續爬 n 天 / 整理 data 轉成 收盤價 time series / YOU MIGHT ALSO LIKE / Python新手教學(Part 4)：台股的好兄弟是？台股相關性研究 / 利用Pandas輕鬆選股 – Python實作教學 / 5種低波動因子，高效策略快速實踐 / 用程式分析房地產可行嗎？房地產爬蟲教學在這裡！

### 如何定義KD鈍化？

- URL: https://www.finlab.tw/kd1/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: KD 的意義 / KD 的參數 / KD 坊間策略 / KD 鈍化 / YOU MIGHT ALSO LIKE / 揭秘庫藏股：智慧投資策略與市場動態的完美結合（Part 1） / 創新高股票，你還少看了這個因子！ / 事件研究法上：找到異常報酬率

### 利用Pandas輕鬆選股 - Python實作教學

- URL: https://www.finlab.tw/python%ef%bc%9a%e5%88%a9%e7%94%a8pandas%e8%bc%95%e9%ac%86%e9%81%b8%e8%82%a1/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 資料處理 / 資料處理一行版 / 簡單的取出行列： / 數值分析 / 毛利率分佈圖 / 選股 / YOU MIGHT ALSO LIKE / 機器學習真的無法預測股價嗎？

### 超短線上影黑密技！

- URL: https://www.finlab.tw/%e8%b6%85%e7%9f%ad%e7%b7%9a%e4%b8%8a%e5%bd%b1%e9%bb%91%e5%af%86%e6%8a%80%ef%bc%81/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 超短線 / 上影 / 黑 / 密技 / 策略人多口雜，沒有回測看看就好 / 回測的重要性 / 策略 / YOU MIGHT ALSO LIKE

### 財報爬蟲超簡單 - 用Python一次抓綜合損益、資產負債、營利分析

- URL: https://www.finlab.tw/python-%e8%b2%a1%e5%a0%b1%e7%88%ac%e8%9f%b2-1-%e7%b6%9c%e5%90%88%e6%90%8d%e7%9b%8a%e8%a1%a8/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / 用程式分析房地產可行嗎？房價分析看這裡！ / 外資大賣，反而要買！？ / 坊間沒在教的RSI選股技巧 / 年報酬30％的泡沫選股策略秘技大公開 | 實際下單做實驗 | FinLab 財經實驗室 / 論文導讀：利用CNN神經網路來交易ETF / 毛利率的選股潛力：一種數據驅動的方法 / 復刻與優化 00919：玩轉高股息 ETF

### 超簡單台股每日爬蟲教學

- URL: https://www.finlab.tw/%e8%b6%85%e7%b0%a1%e5%96%ae%e5%8f%b0%e8%82%a1%e6%af%8f%e6%97%a5%e7%88%ac%e8%9f%b2%e6%95%99%e5%ad%b8/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / Qlib 與 FinLab 整合，展現 AI 選股的神蹟。 / 用Python投資加密貨幣：實做回測策略 (Part 4) / 事件研究法（中）使用事件交易模組 / Plotly-TreeMap｜台股版塊地圖｜DashBoard製作教學(2) / 使用月營收與動能策略選股的完整介紹 / 用Python投資加密貨幣：為什麼是比特幣？ (Part 1) / 用KD值選股：你還需搭配這三種指標

### 本益成長比真的越低越好！？

- URL: https://www.finlab.tw/%e6%af%94%e6%9c%ac%e7%9b%8a%e6%af%94%e6%9b%b4%e5%a5%bd%e7%94%a8%e7%9a%84%e6%9c%ac%e7%9b%8a%e6%af%94%e6%88%90%e9%95%b7%e7%8e%87%ef%bc%81/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: YOU MIGHT ALSO LIKE / 絕無僅有的超強指標！ / 簡單又有效：股價加速度選股指標 / 14年14倍的選股策略！ / 進化後的本益比｜本益成長比選股策略 / 七七四十九種PEG本益成長比，找出潛力成長股，製作年報酬率 30% 的選股策略！ / 探討進出時機的處置股策略 | 我跳進來了，我又跳出去了，打我啊笨蛋XD / 威廉．納葛維茲-價值型選股策略

### 絕無僅有的超強指標！

- URL: https://www.finlab.tw/%e7%b5%95%e7%84%a1%e5%83%85%e6%9c%89%e7%9a%84%e8%b6%85%e5%bc%b7%e6%8c%87%e6%a8%99%ef%bc%81/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: YOU MIGHT ALSO LIKE / 創新高有多高？ / 本益成長比真的越低越好！？ / Machine Learning 表示：看季線最無用！ / 市值營收比-幫你找到便宜獲利股 / 論文導讀：利用CNN神經網路來交易ETF / 財報爬蟲超簡單 – 用Python一次抓綜合損益、資產負債、營利分析 / 簡單又有效：股價加速度選股指標

### 基礎回測框架介紹

- URL: https://www.finlab.tw/%e5%9b%9e%e6%b8%ac%e6%a1%86%e6%9e%b6%e4%bb%8b%e7%b4%b9/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 目前所知道的缺點 / YOU MIGHT ALSO LIKE / 5種低波動因子，高效策略快速實踐 / 七七四十九種PEG本益成長比，找出潛力成長股，製作年報酬率 30% 的選股策略！ / 財報狗選股策略實作 – 讓你免費取得價值4000元/年的選股策略 / Python爬蟲教學｜ 財經數據｜台灣貨幣總計數 M1B & M2 / 資產配置：獲得年報酬 40% 的穩健投資組合 (腳本公開) / 超簡單用Python預測股價

### 價值股策略

- URL: https://www.finlab.tw/%e5%83%b9%e5%80%bc%e8%82%a1%e5%9b%9e%e6%b8%ac/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 富貴滿盈價值股 / 廢話不多說，看結果 / 回測好，沒辦法用，看這個blog做啥？ / 希望能做友善且功能強大的平台 / 之後再寫跟machine learning有關的策略 / YOU MIGHT ALSO LIKE / 事件研究法（中）使用事件交易模組 / 威廉．納葛維茲-價值型選股策略

### 用杜邦分析加強你的選股技巧（中）淨利率

- URL: https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%ad%ef%bc%89%e6%b7%a8%e5%88%a9%e7%8e%87/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 分佈圖 / 淨利率高的企業股價更容易成長！ / 杜邦分析的指標終於說完了！ / YOU MIGHT ALSO LIKE / 用杜邦分析加強你的選股技巧（中）總資產週轉率 / 股票入門SOP懶人包 / 如何用Python獲得上市上櫃股票清單? / 用杜邦分析加強你的選股技巧（下）回測

### 小資族也可以使用的選股法！

- URL: https://www.finlab.tw/%e5%b0%8f%e8%b3%87%e6%97%8f%e4%b9%9f%e5%8f%af%e4%bb%a5%e4%bd%bf%e7%94%a8%e7%9a%84%e9%81%b8%e8%82%a1%e6%b3%95%ef%bc%81/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 附上每天操作紀錄，證明沒在虎爛XD / 為何一次買這麼多股票？ / Q&A 時間 / 1.這個策略是上市上櫃大於100家時，只挑選上市收盤大於10元的買，上櫃的不考慮對嗎? / 2.假設上市上櫃的便宜股大於100家公司，選擇收盤價10元以上的上市公司，100萬真的夠嗎? / 3.若是像2008年一樣，一堆便宜股票100萬如何足以購買符合條件的股票呢? / 接下來就回答關鍵問題：2009年這麼多股票，錢那麼少，怎麼買呢？ / 4.能否列出在符合條件的年度，各買一張需要多少本金，根據此策略計算結果是符合條件的上市公司各買一張嗎?或是根據您的統計是以資金平均分配在各家公司的結果?

### 用杜邦分析加強你的選股技巧（中）總資產週轉率

- URL: https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%ad%ef%bc%89%e7%b8%bd%e8%b3%87%e7%94%a2%e8%bd%89%e6%8f%9b%e7%8e%87/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 分佈圖 / 回測 / 人即是公司 / 從總資產週轉率看買房這件事 / 總之提高個人總資產週轉率的好方法 / YOU MIGHT ALSO LIKE / 股票入門SOP懶人包 / 用杜邦分析加強你的選股技巧（中）淨利率

### 用杜邦分析加強你的選股技巧（上）

- URL: https://www.finlab.tw/%e7%94%a8%e6%9d%9c%e9%82%a6%e5%88%86%e6%9e%90%e5%8a%a0%e5%bc%b7%e4%bd%a0%e7%9a%84%e9%81%b8%e8%82%a1%e6%8a%80%e5%b7%a7%ef%bc%88%e4%b8%8a%ef%bc%89/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 學習回顧 / 更深入一點點 / 杜邦分析超無腦介紹 / YOU MIGHT ALSO LIKE / 用杜邦分析加強你的選股技巧（下）回測 / 如何用Python獲得上市上櫃股票清單? / 股票入門SOP懶人包 / 用杜邦分析加強你的選股技巧（中）淨利率

### 14年14倍的選股策略！

- URL: https://www.finlab.tw/%e6%af%94%e7%ad%96%e7%95%a5%e7%8b%97%e9%82%84%e8%a6%81%e5%ae%89%e5%85%a8%e7%9a%84%e9%81%b8%e8%82%a1%e7%ad%96%e7%95%a5%ef%bc%81/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 從統計的角度帶你一步一步設計量化策略 / 此篇是前幾篇的一個小統整 / 策略就是這麼簡單：找便宜且會賺錢的公司 / 還必須去除大盤大跌的時刻 / 常常休息的策略，卻可以有如此高的績效！ / 策略是否持股也是一種指標～ / 比績優股獵犬的虧損還小，但還是要注意虧損！ / 光看這兩種數據，就有這樣的功效了，更何況是考慮更多因素！

### 大盤要跌了嗎？利用企業本益比分佈來判斷！

- URL: https://www.finlab.tw/%e5%a4%a7%e7%9b%a4%e8%a6%81%e8%b7%8c%e4%ba%86%e5%97%8e%ef%bc%9f%e5%88%a9%e7%94%a8%e4%bc%81%e6%a5%ad%e6%9c%ac%e7%9b%8a%e6%af%94%e5%88%86%e4%bd%88%e4%be%86%e5%88%a4%e6%96%b7%ef%bc%81/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 回測文章主要價值在驗證框架與防過擬合 checklist。
- Useful datasets: price; benchmark; transaction cost assumptions
- Possible feature: strategy_robustness_score; turnover_penalty; parameter_stability
- Cleaning rule: 所有策略需記錄資料可得日、再平衡日、交易假設。
- Backtest design: walk-forward、rolling window、不同成本假設、容量壓力測試。
- Production risk: 文章中的漂亮績效不能直接進 pending buy，必須 shadow test。
- Outline markers: 本益比中位數介紹 / 利用本益比中位數來判斷大盤大趨勢 / 反面例子：GOOGLE TREND / YOU MIGHT ALSO LIKE / 避開大盤大跌的方法！ / 年報酬30％的泡沫選股策略秘技大公開 | 實際下單做實驗 | FinLab 財經實驗室 / 本益比能幫你選出優質股？ / 加速度指標選股：免費Python實做教學看這裡！

### 用股價淨值比來判斷大盤漲跌

- URL: https://www.finlab.tw/%e7%94%a8%e8%82%a1%e5%83%b9%e6%b7%a8%e5%80%bc%e6%af%94%e4%be%86%e5%88%a4%e6%96%b7%e5%a4%a7%e7%9b%a4%e6%bc%b2%e8%b7%8c/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: YOU MIGHT ALSO LIKE / 小資族也可以使用的選股法！ / 別再錯過的選股策略！ / 外資大賣，反而要買！？ / 美股探險記第3課:1分鐘上手美股回測｜股價淨值比在美股策略還有效嗎？ / 加速度指標：歷史年報酬20％的策略 / Python 低風險高報酬投資組合 / 大跌後：用python找出強勢股！

### 只用一行程式碼分析數據!? - 實用的 Python Package

- URL: https://www.finlab.tw/one-line-info-dataframe/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 1. 用舊的方法來分析資料 / 2. 酷炫的方法資料分析 / 找出資料的缺漏或問題 / 輕鬆檢視每一個 column 的資料 / 檢視資料相關性 / YOU MIGHT ALSO LIKE / 超簡單用Python預測股價 / Plotly-TreeMap｜台股版塊地圖｜DashBoard製作教學(2)

### 投資組合 Paper Trading 1分鐘就上手 - Cmoney 大富翁股票 API 教學

- URL: https://www.finlab.tw/cmoney-paper-trading/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 為什麼要用 Paper Trading / 為什麼不用回測就好了？ / 幫助投資人檢視策略的「微觀效果」 / 1. 安裝 / 2. 申請帳號 / 3. 用程式操控 / 課程同學 Bonus! / YOU MIGHT ALSO LIKE

### 用Python投資加密貨幣：交易策略訊號實做 (Part 3)

- URL: https://www.finlab.tw/btc-trading-signal/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: Pandas 操作介紹 / 製作簡易的加密貨幣均線策略 / 不等式條件 / 調用「昨天」的價格 pd.Series.shift / 結合上述的範例，產生策略訊號 / 製作策略 / YOU MIGHT ALSO LIKE / 生技股如何安全買？逆勢爆賺策略分享

### Bokeh 探索頻道(2)~客製化技術圖表升級

- URL: https://www.finlab.tw/bokeh-stock-chart-with-technical-analysis/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 改造動機 / github:https://github.com/benbilly3/bokeh_explore / 繪圖技巧說明 / 1. figure圖紙設定，bokeh各種models應用 / 2. 處理假日日期造成的資料不連續問題，x_range overwrite技巧 / 3. hover互動資料顯示 / 4. legend物件控制，從label控制線圖開關。將legend移到圖表外，讓版面清晰。 / 5. 位移、縮放、十字線、重置、存檔工具

### 策略優化 - 如何避免過擬合？

- URL: https://www.finlab.tw/backtesting-overfitting-probability/
- Topic: screener
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 我們很有可能是優化雜訊，而非優化價格的規律。 / 回到策略的角度，如何驗證「貨真價實的策略」？ / 所以比較好的方法是？ / 1. 確定參數效果真的比較好 / 2. 產生多重的 IS 跟 OOS / 實驗結果： / YOU MIGHT ALSO LIKE / 小型股噴發的日子結束了？ADLs 指標顯示：接下來是決定性的時刻！

### Bokeh 探索頻道(1)~Python互動式圖表函數庫初體驗

- URL: https://www.finlab.tw/python-bokeh1-setup-and-first-impression/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: Python 視覺化套件使用經驗 / 厲害在哪裡？ / 開箱試玩時間 / 投資圖表試玩 / 檢查蘋果電腦範例資料(json) / ColumnDataSource物件為Bokeh資料驅動渲染核心 / HoverTool / Click_policy

### 用Python投資加密貨幣：用AWS Lambda即時更新交易訊號 (Part 11)

- URL: https://www.finlab.tw/btc-aws-lambda-signal-update/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: YOU MIGHT ALSO LIKE / 建構出自己的 Smart ETF 00905 2.0 ! Part1 – 公開說明書內容解析 / 只用一行程式碼分析數據!? – 實用的 Python Package / 能夠升級所有策略的指標：F-Score / Python新手教學(Part 3)：全球指數歷史數據下載大全 / 利用Machine Learning 選股新手教學 / Python爬蟲教學｜ 財經數據｜台灣貨幣總計數 M1B & M2 / 利用Pandas輕鬆選股 – Python實作教學

### 用Python投資加密貨幣：架設一個簡易的AWS交易系統 (Part 10)

- URL: https://www.finlab.tw/aws-lambda-initial-setup/
- Topic: execution
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 如何架設AWS加密貨幣交易系統 / YOU MIGHT ALSO LIKE / 1 分鐘學會！使用 Lux API 自動視覺化 Pandas 資料 / Python 時間序列實做！ / Python 股票 5 分鐘超簡單選股與回測 – 讓你投資股票少繳學費！ / 台北最抗跌公寓在哪？ Python 告訴你 (Part 3) / 能夠升級所有策略的指標：F-Score / 策略最佳化是有效的嗎？（附程式碼）

### 用Python投資加密貨幣：比特幣操作最強指標(看盤篇) (Part 6)

- URL: https://www.finlab.tw/btc-tradingview-intro/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: TradingView / 非常推薦的比特幣指標 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：如何投資加密貨幣 (Part 8) / 利用機器學習預測漲跌-優化方式 / ADL指標幫你判斷台股盤勢｜順勢為王｜教你走出拉G盤的迷霧｜ / 復刻與優化 00919：玩轉高股息 ETF / 用深度學習幫你解析K線圖！

### 用Python投資加密貨幣：比特幣操作最強指標(原理篇) (Part 5)

- URL: https://www.finlab.tw/best-indicator-bitcoin/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 比特幣最強指摽：Hash Ribbons 指標 / 1. Miner 挖礦機 / 2. 為何要找 s ？ 感覺很沒意義 / 3. Miner Capitulation 礦機的投降 / 4. Miner Capitulation 是好的買入機會 / 5. 如何判斷 Miner Capitulation？ / 6. 我們可以藉由 n 來推算 hash rate / YOU MIGHT ALSO LIKE

### 用 Python 打造投資網站(1) - 開啟地圖

- URL: https://www.finlab.tw/financial-website-building-part1/
- Topic: data / factor
- Access: public_visible
- StockVision priority: P1
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 動機： / Python能打造網站嗎？ / Python寫網站難嗎？ / 如何開始大冒險？ / YOU MIGHT ALSO LIKE / Alpha Arena 背後的技術解析、缺陷與潛力 / 史上最強大的台股板塊圖 | 操作說明書 / Python新手教學(Part 5)：如何衡量風險與報酬？夏普比率告訴你

### 冰風暴概念股季節效應｜老王是對的嗎？

- URL: https://www.finlab.tw/winter_storm_industry_index_backtest/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 籌碼訊號應轉成主題/產業層級流向與個股異常，而不是只看單日買賣超。
- Useful datasets: institutional net buy/sell; margin balance; broker branch flow; stock tags
- Possible feature: theme_institutional_flow; foreign_trust_alignment; margin_heat; broker_concentration
- Cleaning rule: 法人與券商資料需處理拆分、缺值、興櫃覆蓋差異與極端值 winsorize。
- Backtest design: 分別測個股流、產業流、主題流的 forward return 與 turnover。
- Production risk: 籌碼資料容易追高或反映已發生事件，需要和價格位置/流動性一起 gate。
- Outline markers: 冰風暴概念股有哪些？ / 編製概念股指數 / 統計結果 / 結論 / YOU MIGHT ALSO LIKE / 美股探險記第4課:美股選股池分類器使用教學｜本益成長比最適合用在哪些產業？ / 產業資料庫的基礎應用 / 研發費用率選股策略

### Python爬蟲教學｜ 財經數據｜台灣貨幣總計數 M1B & M2

- URL: https://www.finlab.tw/tw_monetary_aggregates_m1b_crawler/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 財經數據資料源 / 主計處Python爬蟲 / Python爬蟲程式範例 / Python爬蟲輸出結果 / 中央銀行Python爬蟲 / Python爬蟲程式範例 / 結論 / YOU MIGHT ALSO LIKE

### 彈性進出場的判斷 ｜ 優勢比率應用

- URL: https://www.finlab.tw/edge-ratio-follow-application/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 優勢比率定義 / 優勢比率時序分析 / 如何使用 FinLab Package 顯示策略的優勢比率? / 分析案例 / 營收動能瘋狗策略 / 投信大哥跟屁蟲策略 / 藏獒策略 / 結論

### 遇到「神準」的狙擊｜如何超越散戶?

- URL: https://www.finlab.tw/the_behavior_of_individual_investors/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 散戶行為學 / 過度自信 / 專注力不足 / 處置效應 / 錨定效應 / 賭徒性格 / 如何超越散戶？ / 參考資源

### Finlab 量化平台徵稿活動得獎作品 營業利益率選股-安正

- URL: https://www.finlab.tw/finlab_submit2/
- Topic: screener
- Access: public_visible
- StockVision priority: P2
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 營業利益率選股 / 原理 / 計算營業利益率 / 如何評估營業利益率 / 營業利益率 v.s. 股價 / 進一步過濾：好中選好 / 後續探討 / Colab 範例程式碼

### Python 實作：現在該不該買山寨幣？

- URL: https://www.finlab.tw/python-%e5%af%a6%e4%bd%9c%ef%bc%9a%e7%8f%be%e5%9c%a8%e8%a9%b2%e4%b8%8d%e8%a9%b2%e8%b2%b7%e5%b1%b1%e5%af%a8%e5%b9%a3%ef%bc%9f/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 山寨幣的風險 / 山寨幣與比特幣比較 / 宏觀趨勢和信仰分析 / 現在是買入時機嗎？ / 2021，2022，不應該用一樣的投資方式 / 2022 金融氾濫行情即將結束 / 買賣山寨幣的時機點 / YOU MIGHT ALSO LIKE

### 加密貨幣的貪婪與恐懼

- URL: https://www.finlab.tw/%e5%8a%a0%e5%af%86%e8%b2%a8%e5%b9%a3%e7%9a%84%e8%b2%aa%e5%a9%aa%e8%88%87%e6%81%90%e6%87%bc/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 如何分辨專案好壞？ / 投資報酬率真的這麼高嗎？ / 明星項目就不會 Out？ / 明牌真的有這麼香嗎？ / 你需要的不是信仰，而是系統！ / 最後：投資而非投機 / YOU MIGHT ALSO LIKE / 2021年投資股票？請買一檔標的叫做比特幣。

### 徵稿送 FinLab VIP 量化平台會員

- URL: https://www.finlab.tw/finlab_platform_solicit_article_activity/
- Topic: screener
- Access: public_visible
- StockVision priority: P2
- Key idea: AI/ML 類文章適合做 research benchmark，不直接進 production decision。
- Useful datasets: FinLab normalized factors; price/chip/fundamental feature panels
- Possible feature: model_confidence_delta; feature_importance_stability; regime_conditioned_prediction
- Cleaning rule: 模型特徵必須走同一套 feature freshness / leakage 檢查。
- Backtest design: 只和現有 ML pool 做 challenger shadow test。
- Production risk: 範例模型若未處理時序切分與交易摩擦，容易高估效果。
- Outline markers: 徵文辦法 / 徵文主題 / 想不到主題嗎？ / 獎勵方式與名額 / 收件及截稿日期 / 得獎名單揭曉及頒獎日期 / 收件方式 / 徵文規定

### FinLab量化策略平台入門者操作指南

- URL: https://www.finlab.tw/finlab_platform_intro/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 模組文件 / 資料庫 / 教學內容 / Discord 交流群組 / 入門 colab 範例檔 / YOU MIGHT ALSO LIKE / 合約負債 | 營建業選股策略 / 選股策略系統性學習(1)｜新手初訪

### ETH 2.0的崛起｜超越比特幣市值的潛力？

- URL: https://www.finlab.tw/sdb-report-ethereum-investor-guide/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: AI/ML 類文章適合做 research benchmark，不直接進 production decision。
- Useful datasets: FinLab normalized factors; price/chip/fundamental feature panels
- Possible feature: model_confidence_delta; feature_importance_stability; regime_conditioned_prediction
- Cleaning rule: 模型特徵必須走同一套 feature freshness / leakage 檢查。
- Backtest design: 只和現有 ML pool 做 challenger shadow test。
- Production risk: 範例模型若未處理時序切分與交易摩擦，容易高估效果。
- Outline markers: 導文 / ETH 1.0 vs BTC / ETH 2.0 / PoW vs PoS / Sharding Chain / EVM vs eWASM / ETH供給發行的改變 / ETH 需求指標分析

### Plotly-TreeMap｜台股版塊地圖｜DashBoard製作教學(2)

- URL: https://www.finlab.tw/dashboard2-plotly-treemap/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 開發動機 / Plotly範例解析 / 台股版塊程式撰寫 / 主程式 / 資料處理邏輯 / 繪圖程式修改 / 繪圖輸出 / Colab程式碼連結

### Plotly＆Dash初體驗｜已實現損益儀表板｜DashBoard製作教學(1)

- URL: https://www.finlab.tw/realizedprofitloss_dashboard_plotly/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: Plotly與Dash介紹 / 範例目標 / 程式重點 / 整理對帳單格式 / 繪圖物件 / Plot function / Run Dash / colab連結

### 給投資新手的理財規劃 | 小資族投資0050滾出千萬可能嗎？少看這集晚10年退休（免費工具分享）

- URL: https://www.finlab.tw/financial-planning/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 市面上理財規劃工具不準確的三個原因 / 假如不投資的情況下，退休後會有多少存款呢？ / 在另外一種人生中 / YOU MIGHT ALSO LIKE / 股票投資組合系列（一） / FinLab x Google雲端平台 | 3步驟實現全自動交易，從今以後躺著都能賺！(上) / 如何復刻0056高股息ETF，並打造超越市場的進階策略！ / EPS跟ROE哪個比較好用？

### 2021年投資股票？請買一檔標的叫做比特幣。

- URL: https://www.finlab.tw/202-1invest-bitcoin-as-a-stock/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 為什麼「買了要忘記」？ / 只剩不到一年的時間，適合投資加密貨幣 / 除了「買了忘記」還有別招嗎？ / 那短線交易呢？ / 比技術指標更好訊號 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：用AWS Lambda即時更新交易訊號 (Part 11) / 別買 ETF 因為存在根本性的缺陷！| 程式交易特別企劃 – 建構出自己的ETF (前導篇)

### 做量化投資會遇到的挑戰？

- URL: https://www.finlab.tw/quantitative-trading/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 評估策略績效 / 失效的策略 / 避免研發失效策略 / YOU MIGHT ALSO LIKE / 把「靈感」煉成「因子」：從感覺到證據的逆襲 / 使用 Python 和 finlab 庫優化台灣股市投資策略 / 論文導讀：利用MI-LSTM預測股價 / 機器學習 Python 做比特幣交易，如何找到好的特徵？增進模型的有效工具

### IBM-Q 量子電腦黑客松比賽心得

- URL: https://www.finlab.tw/quantum-computing-hackathon/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: YOU MIGHT ALSO LIKE / 月營收選股｜股價創新高｜新手必學的雙動能策略 / 我的量化投資史 / 策略狗。績優股獵犬2。何時買股才對？ / 用杜邦分析加強你的選股技巧（中）淨利率 / 產業資料庫的基礎應用 / EPS跟ROE哪個比較好用？ / 5種低波動因子，高效策略快速實踐

### 為什麼要開這堂課程？用 Python 理財 - 打造加密貨幣實戰策略

- URL: https://www.finlab.tw/why-crypto-currency-python-course/
- Topic: execution
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 為什麼要加密貨幣交易呢？ / 1. 多元資產配置 / 2. 市場效率低 / 3. 經濟週期末稍 / 4. 國際機構參與 / 5. 未來財富轉移 / 6. 目前市值 / 科技的發明與普及

### Pandas 魔法筆記(1)-常用招式總覽

- URL: https://www.finlab.tw/pandas-%e9%ad%94%e6%b3%95%e7%ad%86%e8%a8%981-%e5%b8%b8%e7%94%a8%e6%8b%9b%e5%bc%8f%e7%b8%bd%e8%a6%bd/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: pandas資料結構 / series / dataframe(簡稱df) / 資料篩選 / 資料數值處理 / apply / astypes / drop

### 用程式分析房地產可行嗎？房價分析看這裡！

- URL: https://www.finlab.tw/real-estate-analasys-histograms/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 每年房價走勢圖 / 那總體來說呢？ / 不是有人說2019年房價回升了嗎？ / 但是 / 分佈圖 / 買房使用 Python 簡單的範例 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：比特幣操作最強指標(原理篇) (Part 5)

### 用程式分析房地產可行嗎？房地產爬蟲教學在這裡！

- URL: https://www.finlab.tw/real-estate-analysis1/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: YOU MIGHT ALSO LIKE / Plotly-TreeMap｜台股版塊地圖｜DashBoard製作教學(2) / Machine Learning 表示：看季線最無用！ / 把「靈感」煉成「因子」：從感覺到證據的逆襲 / 用Python投資加密貨幣：為什麼是比特幣？ (Part 1) / 2021股票、比特幣崩盤確切時間點 ?! 免費工具大揭密 (附程式碼) | FinLab 財經實驗室 / Python 低風險高報酬投資組合 / 生技股如何安全買？逆勢爆賺策略分享

### 如何判斷投資理財課程的好壞？

- URL: https://www.finlab.tw/%e6%8a%95%e8%b3%87%e7%90%86%e8%b2%a1%e8%aa%b2%e7%a8%8b%e7%9a%84%e5%a5%bd%e5%a3%9e/
- Topic: screener
- Access: public_visible
- StockVision priority: P2
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 該買哪些書 / 該相信哪些老師 / 不要相信老師，相信你的代碼和策略吧！ / 歷史回測績效，比對帳單好 / 投資課程究竟該便宜該貴 / 為何這堂課程這麼便宜 / YOU MIGHT ALSO LIKE / 爬蟲 Python 新手教學(Part 1)：簡單程式碼，爬全球的股票!

### 為何時間管理總是失敗？

- URL: https://www.finlab.tw/%e7%82%ba%e4%bd%95%e6%99%82%e9%96%93%e7%ae%a1%e7%90%86%e7%b8%bd%e6%98%af%e5%a4%b1%e6%95%97%ef%bc%9f/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 低直接採納價值；保留為研究背景或產品參考。
- Useful datasets: N/A
- Possible feature: N/A
- Cleaning rule: N/A
- Backtest design: N/A
- Production risk: 與 StockVision 前段資料清洗、因子或交易風控關聯較低。
- Outline markers: 1.對於重要且緊急的事 / 2.緊急但是不重要的事 / 3.不緊急不重要 / 4.重要但是不緊急 / YOU MIGHT ALSO LIKE / 你最該避開的三個疲勞陷阱！ / FinLab - 韓承佑

### 你最該避開的三個疲勞陷阱！

- URL: https://www.finlab.tw/%e4%bd%a0%e6%9c%80%e8%a9%b2%e9%81%bf%e9%96%8b%e7%9a%84%e4%b8%89%e5%80%8b%e7%96%b2%e5%8b%9e%e9%99%b7%e9%98%b1%ef%bc%81/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 低直接採納價值；保留為研究背景或產品參考。
- Useful datasets: N/A
- Possible feature: N/A
- Cleaning rule: N/A
- Backtest design: N/A
- Production risk: 與 StockVision 前段資料清洗、因子或交易風控關聯較低。
- Outline markers: 1.短時間不斷在不同工作間切換 / 2.辨別或安排某個項目 / 3.飲食攝取問題-咖啡戒斷帶來的注意力渙散 / 總結 / YOU MIGHT ALSO LIKE / 為何時間管理總是失敗？ / FinLab - 韓承佑

### 用Python投資加密貨幣：爬蟲下載歷史數據 (Part 2)

- URL: https://www.finlab.tw/btc-crawler-py/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 獲取 python 函式庫 / 安裝一些必要的packages / 加密貨幣命名方法 / 使用幫大家寫好的加密貨幣爬蟲函式庫 / YOU MIGHT ALSO LIKE / 5種低波動因子，高效策略快速實踐 / 把「靈感」煉成「因子」：從感覺到證據的逆襲 / 使用月營收與動能策略選股的完整介紹

### 用Python投資加密貨幣：為什麼是比特幣？ (Part 1)

- URL: https://www.finlab.tw/python-bitcoin-trading-why-bitcoin/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 時間推移 – 科技的進步很快 / 3. 比特幣價值正反方分析 / 正方 / 反方 / 綜合優缺點 / 所以綜合以上的結論 / YOU MIGHT ALSO LIKE / 2021年投資股票？請買一檔標的叫做比特幣。

### 台北最抗跌公寓在哪？ Python 告訴你 (Part 3)

- URL: https://www.finlab.tw/real-state-best-district-old-buildings-taipei/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 基本面與 ETF 復刻文章可轉成可解釋因子模板，但不應直接複製成交易策略。
- Useful datasets: monthly revenue; financial_statement; dividend; index constituents/weights; valuation
- Possible feature: revenue_momentum; quality_growth_composite; dividend_stability; fundamental_rank_delta
- Cleaning rule: 財報與月營收需用公告可得日對齊，避免 look-ahead。
- Backtest design: 用 walk-forward 排名與成分股回溯，測不同再平衡頻率。
- Production risk: ETF 復刻策略容易受成分調整、流動性與稅費摩擦影響。
- Outline markers: 1. 用區域來選 / 總結 / YOU MIGHT ALSO LIKE / 用程式分析房地產可行嗎？房地產爬蟲教學在這裡！ / 選股策略回測有新功能！包含權重多空對沖、Sunburst 產業分析、PandasTA 技術指標 – FinLab 0.3.2.dev 再進化！ / Python 股票 5 分鐘超簡單選股與回測 – 讓你投資股票少繳學費！ / 用Python投資加密貨幣：實做回測策略 (Part 4) / 超簡單用Python預測股價

### 用Python投資加密貨幣：入金加密貨幣 (Part 9)

- URL: https://www.finlab.tw/btc-deposit-ways/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 把回測績效和實戰可成交性拆開評估；交易前需要流動性、漲跌停、處置與交割約束。
- Useful datasets: daily price/volume; turnover; 注意股/處置股/全額交割; order feasibility preview
- Possible feature: liquidity_risk_score; limit_lock_risk; estimated_fillability; settlement_cash_pressure
- Cleaning rule: 低成交金額或長期量縮標的不得只靠報酬排序進入候選池。
- Backtest design: 回測需加入成交量容量、漲跌停無法成交、交易成本與換手率懲罰。
- Production risk: 若直接照理論持股下單，可能產生排不到、滑價、資金卡 T+2 或處置股交易限制。
- Outline markers: 簡單入金加密貨幣 / 擇時買賣 / Binance P2P 直接購買 BTC / 為什麼要提供多家呢？ / 這四家都辦好了，要買什麼幣呢？ / 如何自動交易呢？ / 1. 買入 USDT / 2. 存入 Binance

### 用Python投資加密貨幣：如何投資加密貨幣 (Part 8)

- URL: https://www.finlab.tw/btc-deposit-how/
- Topic: other
- Access: public_visible
- StockVision priority: P2
- Key idea: 賣出訊號應比基本面更新頻率更快，尤其動能股要有技術性轉弱與市場寬度的退出條件。
- Useful datasets: OHLCV; market breadth; new-high/new-low count
- Possible feature: sell_transition_line; rci_exhaustion; macd_divergence; adl_breadth
- Cleaning rule: 高波動突破訊號要與低流動性/極端跳空分開處理。
- Backtest design: 比較原策略、加技術退出、加市場寬度退出的 turnover / drawdown / missed-upside。
- Production risk: 退出規則太敏感會把中期趨勢洗出去，需按 regime 調整。
- Outline markers: 1. 長線投資 / 買入的原因 / 我的買入原因 / 出場條件 / 買入條件 / 2. 量化投資 / YOU MIGHT ALSO LIKE / 用Python投資加密貨幣：比特幣操作最強指標(看盤篇) (Part 6)

## Step 4 StockVision Adoption Recommendations

### P0: Direct Adoption

- **FinLab article-to-feature registry**: 建立 `finlab_research_hypotheses` 或等價 markdown/DB backlog，把每篇文章只保留 `idea -> dataset -> feature candidate -> cleaning rule -> backtest design -> production risk -> promotion gate`。不得保存文章全文，也不得把文章策略直接接進 Decision Engine。
- **Factor lake sidecar**: 先把 FinLab 的 `security_categories`、`security_industry_themes`、財報、月營收、基本面、籌碼、融資融券、世界指數、美股資料接成 sidecar，再映射到現有 106-feature schema。FinLab 是補廣度與研究速度，不是替換 feature contract。
- **資料清洗前置規則**: 導入可得日對齊、財報/月營收公告日、興櫃/上市櫃/ETF market lane、低流動性、漲跌停鎖死、處置/注意/全額交割、極端值 winsorize、缺值 freshness 與多標籤去重。
- **Backtest reality checks**: 回測升級必須加入交易成本、滑價、容量、流動性風險、MAE/MFE、換手率、最大回落、regime split、walk-forward。FinLab 回測只做外部 benchmark；StockVision backtest 保持 production truth。
- **Regime feature expansion**: 將 ADL/市場寬度、ATR V-turn、大盤融資維持率、估值分布、M1B/M2、景氣燈號、FRED/BLS、VIX/世界指數納入 regime shadow features，提供 HMM/adaptive regime 的外部證據，不直接覆蓋 `ml:regime`。
- **Theme and chip flow upgrade**: 將外資、投信、融資、庫藏股、政府/國安基金、券商分點等文章概念轉成 `industry / subindustry / concept` 三層法人輪動與異常籌碼特徵。
- **Execution feasibility adapter**: 自動下單文章只採納「preview / feasibility / transaction log」觀念。StockVision 保留 quote、盤中分析、risk、paper trade；FinLab 僅作 order preview / broker abstraction / eventual submit adapter。

### P1: Shadow Test

- **Fundamental factor templates**: 月營收動能、營收+價格雙動能、F-Score、杜邦 ROE、現金流、業外收入比例、市值營收比、PEG/PBR/PE 產業相對值、R&D 費用率、合約負債、股利穩定性。
- **Technical / breadth templates**: 低波動、加速度、ARoon、Keltner、均線防大跌、KD/RSI 鈍化、突破真假濾網、ADL/new-high breadth、ATR V-turn。
- **Chip templates**: 外資避險、投信跟盤、三大法人同向、融資維持率地板、主力波動、券商/分點集中度、庫藏股實施家數、董監改選/法說會/恢復信用交易事件。
- **Event modules**: 減資、現金增資放空、處置股進出場、庫藏股、法說會、恢復信用交易，先作 event study / shadow scoring。
- **Dashboard patterns**: 借 FinLab 文章中的 treemap、sunburst、MAE/MFE、板塊圖產品概念，用 Lightweight Charts/自有資料重做，不嵌 TradingView 或複製 FinLab UI。

### P2: Research Benchmark

- **ML/AI**: Qlib、OpenFE、基因演算法、MI-LSTM、CNN K 線、財報 ML、總經 ML，只進 research benchmark / ML pool challenger，不進大盤或 pending-buy 主線。
- **ETF / Smart ETF replication**: 0056、00919、00905、00900、00733 類文章可當因子組合與權重約束研究，不作直接交易策略。
- **US / global data research**: 美股資料庫、世界指數、FRED/BLS 文章可補 morning setup 的 cross-market context，但需先確認 FinLab dataset 欄位、延遲、授權與回補範圍。
- **Crypto / real estate / beginner Python**: 只留方法論，例如 API 抓取、回測框架、雲端排程，原標的不進 StockVision 台股 production。

### Reject

- 不採用文章中的單一漂亮績效、年化報酬或參數作為 production 依據。
- 不直接複製 FinLab 策略、程式碼或 VIP 文章內容成內部知識庫。
- 不讓 FinLab 全自動下單接管 StockVision 的 decision / risk / paper trade / quote owner。
- 不把活動、徵稿、課程、工作環境、一般投資理財文章轉成系統邏輯，除非它提供明確 data / cleaning / backtest / risk control idea。
