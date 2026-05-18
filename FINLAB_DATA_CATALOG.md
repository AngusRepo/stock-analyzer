# FinLab API Data Catalog for StockVision

Generated: 2026-05-15T14:15:05.445029+00:00
FinLab SDK: 2.0.7

## Scope

- Source: FinLab SDK `data.search(...)` and selected read-only `data.get(...)` probes.
- Purpose: list API-returned fields and evaluate StockVision replacement plus data-diversity value.
- Secret handling: `FINLAB_API_KEY` was injected into env and was not printed.
- Trading safety: no order API was called.
- Auth note: token env login is kept for read-only catalog generation; production promotion must migrate to FinLab's newer auth flow.

## Counts

```json
{
  "data_search_all_count": 2150,
  "catalog_rows": 2150,
  "by_market": {
    "tw": 742,
    "us": 292,
    "hk": 279,
    "jp": 279,
    "kr": 279,
    "uk": 279
  },
  "by_group": {
    "price / OHLCV": 131,
    "monthly revenue": 17,
    "fundamentals": 213,
    "other": 203,
    "broker / branch flow": 6,
    "chips / institutional flow": 48,
    "derivatives / positioning": 30,
    "taiwan macro": 88,
    "world market": 6,
    "security master / taxonomy": 2,
    "us market": 290,
    "non-US global market": 1116
  },
  "by_priority": {
    "P0": 418,
    "P2": 1319,
    "P1": 413
  },
  "by_mode": {
    "replace": 130,
    "augment": 701,
    "benchmark": 1319
  },
  "by_dataset_lane": {
    "daily_price": 121,
    "revenue": 8,
    "fundamental_factor_diversity": 213,
    "research": 1319,
    "chip_diversity": 53,
    "regime_context": 118,
    "emerging_revenue_diversity": 9,
    "emerging_price_diversity": 10,
    "global_context": 296,
    "emerging_chip_diversity": 1,
    "security_master": 1,
    "taxonomy_expansion": 1
  },
  "parallel_diff_plan": {
    "parity_field_count": 389,
    "diversity_field_count": 701,
    "research_field_count": 1319,
    "rejected_field_count": 0,
    "parity_by_lane": {
      "daily_price": 119,
      "revenue": 8,
      "fundamental_factor_diversity": 213,
      "chip_diversity": 48,
      "security_master": 1
    },
    "diversity_by_lane": {
      "fundamental_factor_diversity": 213,
      "chip_diversity": 53,
      "regime_context": 118,
      "emerging_revenue_diversity": 9,
      "emerging_price_diversity": 10,
      "global_context": 296,
      "emerging_chip_diversity": 1,
      "taxonomy_expansion": 1
    },
    "research_by_lane": {
      "research": 1319
    }
  }
}
```

## V4 Data Diversity Decision

FinLab adoption is not only a TWSE/TPEX replacement. V4 must split catalog usage into two live lanes:

- `parity lane`: fields that replace or verify current TWSE/TPEX / StockVision equivalents.
- `diversity lane`: FinLab-native fields that add coverage, factor breadth, taxonomy depth, or market context even when StockVision has no current field.

The current 106-feature contract remains the downstream stable interface. New FinLab fields land in a feature-lake sidecar first, with provenance, freshness, schema, and promotion-gate metadata.

### Parity Lane

| dataset_lane | fields |
| --- | --- |
| fundamental_factor_diversity | 213 |
| daily_price | 119 |
| chip_diversity | 48 |
| revenue | 8 |
| security_master | 1 |

### Diversity Lane

| dataset_lane | fields | StockVision use |
| --- | --- | --- |
| global_context | 296 | US leading, world index, morning setup, regime context |
| fundamental_factor_diversity | 213 | quality, value, growth, profitability, leverage, cash-flow factor expansion |
| regime_context | 118 | derivatives, macro, hedge pressure, low-frequency context |
| chip_diversity | 53 | three-party flow, margin/lending, broker concentration, theme rotation |
| emerging_price_diversity | 10 | emerging-stock price, liquidity, quote-spread, watchlist context |
| emerging_revenue_diversity | 9 | emerging-stock revenue momentum and IPO/transfer watchlist context |
| emerging_chip_diversity | 1 | emerging-stock broker flow proxy, watchlist-only chip context |
| taxonomy_expansion | 1 | industry_theme/subindustry labels, supply-chain grouping, cleaner sector flow |

## Taxonomy Contract

```text
industry: FinLab security_categories.category
industry_theme: parent theme parsed from FinLab security_industry_themes
subindustry: cleaned child tag or standalone theme from FinLab security_industry_themes
concept: StockVision self-built concept JSON and semantic theme signals
```

Institutional/theme flow must aggregate each layer separately. Do not sum all tags into one score, because multi-tag stocks would be double-counted.

## Selected Read-Only Dataset Probes

```json
{
  "security_categories": {
    "type": "FinlabDataFrame",
    "shape": [
      3403,
      5
    ],
    "columns": [
      "symbol",
      "name",
      "category",
      "market",
      "stock_id"
    ],
    "index_name": "None",
    "last_index": "3402",
    "samples": {
      "7820": [
        {
          "symbol": "7820",
          "name": "立盈",
          "category": "綠能環保",
          "market": "otc",
          "stock_id": "7820"
        }
      ],
      "6682": [
        {
          "symbol": "6682",
          "name": "華旭先進",
          "category": "光電業",
          "market": "rotc",
          "stock_id": "6682"
        }
      ]
    }
  },
  "security_industry_themes": {
    "type": "FinlabDataFrame",
    "shape": [
      1964,
      5
    ],
    "columns": [
      "symbol",
      "name",
      "category",
      "key_date",
      "stock_id"
    ],
    "index_name": "None",
    "last_index": "1963",
    "samples": {
      "7820": [
        {
          "symbol": "7820",
          "name": "立盈",
          "category": "['►其他', '►其他:環保潔能服務產業']",
          "key_date": "2026-04-24 09:51:30.221554",
          "stock_id": "7820"
        }
      ],
      "6682": []
    }
  },
  "price:收盤價": {
    "type": "FinlabDataFrame",
    "shape": [
      4685,
      2740
    ],
    "columns": [
      "0015",
      "00400A",
      "00401A",
      "00403A",
      "0050",
      "0051",
      "0052",
      "0053",
      "0054",
      "0055",
      "0056",
      "0057",
      "0058",
      "0059",
      "0060",
      "0061",
      "006201",
      "006202",
      "006203",
      "006204",
      "006205",
      "006206",
      "006207",
      "006208",
      "00625K",
      "00631L",
      "00632R",
      "00633L",
      "00634R",
      "00635U"
    ],
    "index_name": "date",
    "last_index": "2026-05-15 00:00:00",
    "samples": {
      "7820": [
        {
          "7820": "141.0"
        },
        {
          "7820": "139.5"
        },
        {
          "7820": "134.0"
        }
      ]
    }
  },
  "etl:adj_close": {
    "type": "FinlabDataFrame",
    "shape": [
      4685,
      2740
    ],
    "columns": [
      "0015",
      "00400A",
      "00401A",
      "00403A",
      "0050",
      "0051",
      "0052",
      "0053",
      "0054",
      "0055",
      "0056",
      "0057",
      "0058",
      "0059",
      "0060",
      "0061",
      "006201",
      "006202",
      "006203",
      "006204",
      "006205",
      "006206",
      "006207",
      "006208",
      "00625K",
      "00631L",
      "00632R",
      "00633L",
      "00634R",
      "00635U"
    ],
    "index_name": "date",
    "last_index": "2026-05-15 00:00:00",
    "samples": {
      "7820": [
        {
          "7820": "141.0"
        },
        {
          "7820": "139.5"
        },
        {
          "7820": "134.0"
        }
      ]
    }
  },
  "rotc_price:收盤價": {
    "type": "FinlabDataFrame",
    "shape": [
      4756,
      1526
    ],
    "columns": [
      "1240",
      "1258",
      "1259",
      "1260",
      "1264",
      "1268",
      "1269",
      "1271",
      "1293",
      "1294",
      "1295",
      "1336",
      "1337",
      "1338",
      "1339",
      "1340",
      "1342",
      "1343",
      "1480",
      "1558",
      "1563",
      "1566",
      "1568",
      "1573",
      "1575",
      "1577",
      "1580",
      "1582",
      "1583",
      "1584"
    ],
    "index_name": "date",
    "last_index": "2026-05-15 00:00:00",
    "samples": {
      "7820": [
        {
          "7820": "205.0"
        },
        {
          "7820": "200.0"
        },
        {
          "7820": "188.0"
        }
      ],
      "6682": [
        {
          "6682": "53.9"
        },
        {
          "6682": "50.1"
        },
        {
          "6682": "49.3"
        }
      ]
    }
  },
  "monthly_revenue:當月營收": {
    "type": "FinlabDataFrame",
    "shape": [
      256,
      2288
    ],
    "columns": [
      "000116",
      "000930",
      "000960",
      "0009A0",
      "1101",
      "1102",
      "1103",
      "1104",
      "1107",
      "1108",
      "1109",
      "1110",
      "1201",
      "1203",
      "1207",
      "1210",
      "1213",
      "1215",
      "1216",
      "1217",
      "1218",
      "1219",
      "1220",
      "1221",
      "1224",
      "1225",
      "1227",
      "1229",
      "1231",
      "1232"
    ],
    "index_name": "date",
    "last_index": "2026-05-11 00:00:00",
    "samples": {
      "7820": [
        {
          "7820": "33506.0"
        }
      ]
    }
  },
  "rotc_monthly_revenue:當月營收": {
    "type": "FinlabDataFrame",
    "shape": [
      293,
      1535
    ],
    "columns": [
      "1239",
      "1260",
      "1269",
      "1271",
      "1293",
      "1294",
      "1295",
      "1333",
      "1336",
      "1343",
      "1480",
      "1553",
      "1557",
      "1558",
      "1560",
      "1563",
      "1565",
      "1566",
      "1568",
      "1569",
      "1570",
      "1571",
      "1572",
      "1573",
      "1575",
      "1577",
      "1580",
      "1582",
      "1583",
      "1585"
    ],
    "index_name": "date",
    "last_index": "2026-05-11 00:00:00",
    "samples": {
      "7820": [
        {
          "7820": "33941.0"
        },
        {
          "7820": "30290.0"
        },
        {
          "7820": "33714.0"
        }
      ],
      "6682": [
        {
          "6682": "110307.0"
        },
        {
          "6682": "126685.0"
        },
        {
          "6682": "132154.0"
        }
      ]
    }
  },
  "fundamental_features:營業利益": {
    "type": "FinlabDataFrame",
    "shape": [
      53,
      2832
    ],
    "columns": [
      "000116",
      "000538",
      "000616",
      "000700",
      "000779",
      "000815",
      "000888",
      "000930",
      "000960",
      "000980",
      "0009A0",
      "010002",
      "1101",
      "1102",
      "1103",
      "1104",
      "1108",
      "1109",
      "1110",
      "1111",
      "1115",
      "1201",
      "1203",
      "1210",
      "1213",
      "1215",
      "1216",
      "1217",
      "1218",
      "1219"
    ],
    "index_name": "date",
    "last_index": "2026-Q1",
    "samples": {
      "7820": [
        {
          "7820": "17788.0"
        },
        {
          "7820": "19585.0"
        },
        {
          "7820": "33372.0"
        }
      ],
      "6682": [
        {
          "6682": "-179499.0"
        },
        {
          "6682": "-64527.0"
        },
        {
          "6682": "32867.0"
        }
      ]
    }
  },
  "financial_statement:現金及約當現金": {
    "type": "FinlabDataFrame",
    "shape": [
      53,
      2832
    ],
    "columns": [
      "000116",
      "000538",
      "000616",
      "000700",
      "000779",
      "000815",
      "000888",
      "000930",
      "000960",
      "000980",
      "0009A0",
      "010002",
      "1101",
      "1102",
      "1103",
      "1104",
      "1108",
      "1109",
      "1110",
      "1111",
      "1115",
      "1201",
      "1203",
      "1210",
      "1213",
      "1215",
      "1216",
      "1217",
      "1218",
      "1219"
    ],
    "index_name": "date",
    "last_index": "2026-Q1",
    "samples": {
      "7820": [
        {
          "7820": "12305.0"
        },
        {
          "7820": "16000.0"
        },
        {
          "7820": "19327.0"
        }
      ],
      "6682": [
        {
          "6682": "80774.0"
        },
        {
          "6682": "148065.0"
        },
        {
          "6682": "328464.0"
        }
      ]
    }
  },
  "institutional_investors_trading_summary:外陸資買進股數(不含外資自營商)": {
    "type": "FinlabDataFrame",
    "shape": [
      3433,
      2660
    ],
    "columns": [
      "0015",
      "00400A",
      "00401A",
      "00403A",
      "0050",
      "0051",
      "0052",
      "0053",
      "0054",
      "0055",
      "0056",
      "0057",
      "0058",
      "0059",
      "0060",
      "0061",
      "006201",
      "006202",
      "006203",
      "006204",
      "006205",
      "006206",
      "006207",
      "006208",
      "00625K",
      "00631L",
      "00632R",
      "00633L",
      "00634R",
      "00635U"
    ],
    "index_name": "date",
    "last_index": "2026-05-15 00:00:00",
    "samples": {
      "7820": [
        {
          "7820": "2000.0"
        },
        {
          "7820": "9000.0"
        },
        {
          "7820": "7000.0"
        }
      ]
    }
  },
  "margin_transactions:融資買進": {
    "type": "FinlabDataFrame",
    "shape": [
      4260,
      2424
    ],
    "columns": [
      "0015",
      "00400A",
      "00401A",
      "00403A",
      "0050",
      "0051",
      "0052",
      "0053",
      "0054",
      "0055",
      "0056",
      "0057",
      "0058",
      "0059",
      "0060",
      "0061",
      "006201",
      "006202",
      "006203",
      "006204",
      "006205",
      "006206",
      "006207",
      "006208",
      "00631L",
      "00632R",
      "00633L",
      "00634R",
      "00635U",
      "00636"
    ],
    "index_name": "date",
    "last_index": "2026-05-15 00:00:00"
  },
  "broker_transactions": {
    "type": "FinlabDataFrame",
    "shape": [
      104578145,
      7
    ],
    "columns": [
      "date",
      "symbol",
      "broker",
      "buy",
      "sell",
      "key_date",
      "stock_id"
    ],
    "index_name": "None",
    "last_index": "104578144",
    "samples": {
      "7820": [
        {
          "date": "2026-04-27",
          "symbol": "7820",
          "broker": "(牛牛牛)亞-鑫豐",
          "buy": "60",
          "sell": "1",
          "key_date": "2026-04-27 11:04:02.680944",
          "stock_id": "7820"
        },
        {
          "date": "2026-04-27",
          "symbol": "7820",
          "broker": "中國信託-嘉義",
          "buy": "13",
          "sell": "0",
          "key_date": "2026-04-27 11:04:02.680944",
          "stock_id": "7820"
        },
        {
          "date": "2026-04-27",
          "symbol": "7820",
          "broker": "中國信託-永康",
          "buy": "1",
          "sell": "54",
          "key_date": "2026-04-27 11:04:02.680944",
          "stock_id": "7820"
        },
        {
          "date": "2026-04-27",
          "symbol": "7820",
          "broker": "元大-三民",
          "buy": "0",
          "sell": "32",
          "key_date": "2026-04-27 11:04:02.680944",
          "stock_id": "7820"
        },
        {
          "date": "2026-04-27",
          "symbol": "7820",
          "broker": "元大-中和",
          "buy": "56",
          "sell": "1",
          "key_date": "2026-04-27 11:04:02.680944",
          "stock_id": "7820"
        }
      ],
      "6682": []
    }
  },
  "rotc_broker_transactions": {
    "type": "FinlabDataFrame",
    "shape": [
      20668245,
      9
    ],
    "columns": [
      "symbol",
      "date",
      "證券商代號",
      "買進股數",
      "賣出股數",
      "買進成本",
      "賣出成本",
      "key_date",
      "stock_id"
    ],
    "index_name": "None",
    "last_index": "20668244",
    "samples": {
      "7820": [],
      "6682": []
    }
  },
  "world_index:close": {
    "type": "FinlabDataFrame",
    "shape": [
      2834,
      35
    ],
    "columns": [
      "000001.SS",
      "399001.SZ",
      "IMOEX.ME",
      "^AORD",
      "^AXJO",
      "^BFX",
      "^BSESN",
      "^BUK100P",
      "^BVSP",
      "^DJI",
      "^FCHI",
      "^FTSE",
      "^GDAXI",
      "^GSPC",
      "^GSPTSE",
      "^HSI",
      "^IPSA",
      "^IXIC",
      "^JKSE",
      "^JN0U.JO",
      "^KLSE",
      "^KS11",
      "^MERV",
      "^MXX",
      "^N100",
      "^N225",
      "^NYA",
      "^NZ50",
      "^RUT",
      "^STI"
    ],
    "index_name": "date",
    "last_index": "2026-05-15 00:00:00"
  },
  "us_price:close": {
    "type": "FinlabDataFrame",
    "shape": [
      2607,
      8224
    ],
    "columns": [
      "A",
      "AA",
      "AAC",
      "AACB",
      "AACG",
      "AACI",
      "AACO",
      "AACOU",
      "AACOW",
      "AACPU",
      "AACT",
      "AADI",
      "AAIC",
      "AAIN",
      "AAL",
      "AAM",
      "AAMC",
      "AAME",
      "AAMI",
      "AAN",
      "AAOI",
      "AAON",
      "AAP",
      "AAPG",
      "AAPL",
      "AAQC",
      "AARD",
      "AAT",
      "AAU",
      "AAUC"
    ],
    "index_name": "date",
    "last_index": "2026-05-14 00:00:00"
  },
  "us_key_metrics:market_cap": {
    "type": "FinlabDataFrame",
    "shape": [
      60,
      28449
    ],
    "columns": [
      "0P00000SXJ",
      "A",
      "AA",
      "AAALF",
      "AAALY",
      "AABA",
      "AABB",
      "AABPX",
      "AABVF",
      "AAC",
      "AAC-UN",
      "AAC-WT",
      "AACAF",
      "AACAY",
      "AACB",
      "AACBR",
      "AACBU",
      "AACG",
      "AACI",
      "AACIU",
      "AACIW",
      "AACOU",
      "AACQ",
      "AACQU",
      "AACQW",
      "AACS",
      "AACT",
      "AACT-UN",
      "AACT-WT",
      "AACTF"
    ],
    "index_name": "date",
    "last_index": "2026-05-15 00:00:00"
  }
}
```

## Namespace Summary

### hk

| namespace | fields |
| --- | --- |
| hk_balance_sheet | 58 |
| hk_ratios | 58 |
| hk_cash_flow | 45 |
| hk_key_metrics | 42 |
| hk_income_statement | 38 |
| hk_fund_price | 10 |
| hk_price | 10 |
| hk_stock_rating | 7 |
| hk_analyst_consensus | 6 |
| hk_dcf | 2 |
| hk_earnings_surprises | 2 |
| hk_company_profile | 1 |

### jp

| namespace | fields |
| --- | --- |
| jp_balance_sheet | 58 |
| jp_ratios | 58 |
| jp_cash_flow | 45 |
| jp_key_metrics | 42 |
| jp_income_statement | 38 |
| jp_fund_price | 10 |
| jp_price | 10 |
| jp_stock_rating | 7 |
| jp_analyst_consensus | 6 |
| jp_dcf | 2 |
| jp_earnings_surprises | 2 |
| jp_company_profile | 1 |

### kr

| namespace | fields |
| --- | --- |
| kr_balance_sheet | 58 |
| kr_ratios | 58 |
| kr_cash_flow | 45 |
| kr_key_metrics | 42 |
| kr_income_statement | 38 |
| kr_fund_price | 10 |
| kr_price | 10 |
| kr_stock_rating | 7 |
| kr_analyst_consensus | 6 |
| kr_dcf | 2 |
| kr_earnings_surprises | 2 |
| kr_company_profile | 1 |

### tw

| namespace | fields |
| --- | --- |
| financial_statement | 158 |
| etl | 109 |
| fundamental_features | 53 |
| tw_business_indicators_details | 24 |
| dividend_otc | 19 |
| margin_transactions | 16 |
| institutional_investors_trading_summary | 15 |
| treasury_stock | 15 |
| internal_equity_insufficient | 13 |
| dividend_tse | 13 |
| tw_industry_nmi | 13 |
| tw_total_nmi | 13 |
| futures_institutional_investors_trading_summary | 12 |
| tw_industry_pmi | 12 |
| tw_total_pmi | 12 |
| price | 11 |
| intraday_odd_lot_trade | 11 |
| internal_equity_pledge | 10 |
| rotc_price | 10 |
| capital_reduction_otc | 9 |
| capital_reduction_tse | 9 |
| futures_price | 9 |
| rotc_monthly_revenue | 9 |
| monthly_revenue | 8 |
| internal_equity_changes | 8 |
| after_market_odd_lot_trade | 8 |
| cb_price | 7 |
| foreign_investors_shareholding | 7 |
| par_value_change_otc | 7 |
| par_value_change_tse | 7 |
| tw_business_indicators | 7 |
| intraday_trading_stat | 6 |
| etf_split | 6 |
| world_index | 6 |
| security_lending | 5 |
| intraday_trading | 4 |
| margin_balance | 4 |
| market_transaction_info | 4 |
| security_lending_sell | 4 |
| taiex_total_index | 4 |
| price_earning_ratio | 3 |
| cb_converted_status | 3 |
| institutional_investors_trading_all_market_summary | 3 |
| quality_factor_z_score | 3 |
| stock_index_vol | 3 |
| change_transaction | 2 |
| financial_statements_upload_detail | 2 |
| stock_index_price | 2 |
| tw_etf_nav_daily | 2 |
| benchmark_return | 1 |
| broker_transactions | 1 |
| inventory | 1 |
| tw_monetary_aggregates | 1 |
| board_dividend_announcement | 1 |
| cb_published_info | 1 |
| company_basic_info | 1 |
| company_main_business | 1 |
| day_trade_short_suspension | 1 |
| delisted_companies | 1 |
| delisted_companies_otc | 1 |
| delisted_companies_tse | 1 |
| disposal_information | 1 |
| dividend_announcement | 1 |
| important_info_announcement | 1 |
| important_subsidiary | 1 |
| insider_shareholding_transfer_declaration | 1 |
| intraday_lending_fee | 1 |
| investors_conference | 1 |
| lawsuit_info | 1 |
| margin_short_sale_suspension | 1 |
| national_security_fund | 1 |
| oversea_investment | 1 |
| reference_price | 1 |
| rotc_broker_transactions | 1 |
| security_categories | 1 |
| security_industry_themes | 1 |
| shareholders_meeting | 1 |
| single_stock_futures_and_equity_options_underlying | 1 |
| trading_attention | 1 |
| tw_etf_basic_info | 1 |
| tw_etf_beneficiary_stats | 1 |
| tw_etf_dividend_events | 1 |
| tw_news_cnyes | 1 |
| tw_option_daily_delta | 1 |
| tw_option_daily_summary | 1 |
| tw_option_put_call_ratio | 1 |
| tw_option_recent_trades | 1 |
| tw_taifex_futures_large_trader | 1 |
| tw_taifex_option_institutional_breakdown | 1 |
| tw_taifex_option_large_trader | 1 |
| tw_taifex_option_liquidity | 1 |

### uk

| namespace | fields |
| --- | --- |
| uk_balance_sheet | 58 |
| uk_ratios | 58 |
| uk_cash_flow | 45 |
| uk_key_metrics | 42 |
| uk_income_statement | 38 |
| uk_fund_price | 10 |
| uk_price | 10 |
| uk_stock_rating | 7 |
| uk_analyst_consensus | 6 |
| uk_dcf | 2 |
| uk_earnings_surprises | 2 |
| uk_company_profile | 1 |

### us

| namespace | fields |
| --- | --- |
| us_balance_sheet | 58 |
| us_ratios | 58 |
| us_cash_flow | 45 |
| us_key_metrics | 42 |
| us_income_statement | 38 |
| us_fund_price | 10 |
| us_price | 10 |
| us_price_target_summary | 9 |
| us_stock_rating | 7 |
| us_analyst_consensus | 6 |
| us_dcf | 2 |
| us_earnings_surprises | 2 |
| us_index_constituents | 2 |
| etl | 2 |
| us_company_profile | 1 |

## Full Field Catalog

Machine-readable full catalog: `data/finlab_research/api_fields.json`

| market | namespace | field | group | priority | mode | dataset lane | quality gate | replace TWSE/TPEX | StockVision use |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tw | price | 成交股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 成交筆數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 成交金額 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 收盤價 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 開盤價 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 最低價 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 最高價 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 最後揭示買價 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 最後揭示賣價 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 最後揭示買量 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price | 最後揭示賣量 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | adj_open | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | adj_close | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | adj_high | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | adj_low | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | monthly_revenue | 當月營收 | monthly revenue | P0 | replace | revenue | announcement_date_alignment, restatement_check | yes | revenue momentum, revenue-price double momentum, announcement freshness checks |
| tw | monthly_revenue | 上月營收 | monthly revenue | P0 | replace | revenue | announcement_date_alignment, restatement_check | yes | revenue momentum, revenue-price double momentum, announcement freshness checks |
| tw | monthly_revenue | 去年當月營收 | monthly revenue | P0 | replace | revenue | announcement_date_alignment, restatement_check | yes | revenue momentum, revenue-price double momentum, announcement freshness checks |
| tw | monthly_revenue | 上月比較增減(%) | monthly revenue | P0 | replace | revenue | announcement_date_alignment, restatement_check | yes | revenue momentum, revenue-price double momentum, announcement freshness checks |
| tw | monthly_revenue | 去年同月增減(%) | monthly revenue | P0 | replace | revenue | announcement_date_alignment, restatement_check | yes | revenue momentum, revenue-price double momentum, announcement freshness checks |
| tw | monthly_revenue | 當月累計營收 | monthly revenue | P0 | replace | revenue | announcement_date_alignment, restatement_check | yes | revenue momentum, revenue-price double momentum, announcement freshness checks |
| tw | monthly_revenue | 去年累計營收 | monthly revenue | P0 | replace | revenue | announcement_date_alignment, restatement_check | yes | revenue momentum, revenue-price double momentum, announcement freshness checks |
| tw | monthly_revenue | 前期比較增減(%) | monthly revenue | P0 | replace | revenue | announcement_date_alignment, restatement_check | yes | revenue momentum, revenue-price double momentum, announcement freshness checks |
| tw | fundamental_features | 營業利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | EBITDA | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 營運現金流 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 歸屬母公司淨利 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 折舊 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 流動資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 流動負債 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 取得不動產廠房及設備 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 經常稅後淨利 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | ROA稅後息前 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | ROA綜合損益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | ROE稅後 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | ROE綜合損益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 稅前息前折舊前淨利率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 營業毛利率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 營業利益率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 稅前淨利率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 稅後淨利率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 業外收支營收率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 貝里比率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 營業費用率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 推銷費用率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 管理費用率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 研究發展費用率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 現金流量比率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 稅率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 每股營業額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 每股營業利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 每股現金流量 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 每股稅前淨利 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 每股綜合損益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 每股稅後淨利 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 總負債除總淨值 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 負債比率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 淨值除資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 營收成長率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 營業毛利成長率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 營業利益成長率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 稅前淨利成長率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 稅後淨利成長率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 經常利益成長率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 資產總額成長率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 淨值成長率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 流動比率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 速動比率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 利息支出率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 營運資金 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 總資產週轉次數 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 應收帳款週轉率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 存貨週轉率 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 固定資產週轉次數 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 淨值週轉率次數 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | fundamental_features | 自由現金流量 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | price_earning_ratio | 殖利率(%) | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price_earning_ratio | 本益比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | price_earning_ratio | 股價淨值比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | financial_statement | 現金及約當現金 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 透過損益按公允價值衡量之金融資產_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 透過其他綜合損益按公允價值衡量之金融資產_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 按攤銷後成本衡量之金融資產_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 避險之金融資產_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 合約資產_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應收帳款及票據 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 其他應收款 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 存貨 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 待出售非流動資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 當期所得稅資產_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 其他流動資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 流動資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 透過損益按公允價值衡量之金融資產_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 透過其他綜合損益按公允價值衡量之金融資產_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 按攤銷後成本衡量之金融資產_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 避險之金融資產_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 合約資產_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 採權益法之長期股權投資 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 預付投資款 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 不動產廠房及設備 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 商譽及無形資產合計 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 遞延所得稅資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 遞延資產合計 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 使用權資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 投資性不動產淨額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 其他非流動資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 非流動資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 資產總額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 短期借款 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應付商業本票∕承兌匯票 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 透過損益按公允價值衡量之金融負債_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 避險之金融負債_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 按攤銷後成本衡量之金融負債_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 合約負債_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應付帳款及票據 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 其他應付款 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 當期所得稅負債 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 負債準備_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 與待出售非流動資產直接相關之負債 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 租賃負債─流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 一年內到期長期負債 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 特別股負債_流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 流動負債 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 透過損益按公允價值衡量之金融負債_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 避險之金融負債_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 按攤銷後成本衡量之金融負債_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 合約負債_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 特別股負債_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應付公司債_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 銀行借款_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 租賃負債_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 負債準備_非流動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 遞延貸項 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應計退休金負債 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 遞延所得稅 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 非流動負債 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 負債總額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 普通股股本 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 特別股股本 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 預收股款 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 待分配股票股利 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 換股權利證書 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 股本 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 資本公積合計 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 法定盈餘公積 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 未分配盈餘 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 保留盈餘 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 其他權益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 庫藏股票帳面值 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 母公司股東權益合計 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 共同控制下前手權益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 合併前非屬共同控制股權 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 非控制權益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 股東權益總額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 負債及股東權益總額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 營業收入淨額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 營業成本 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 營業毛利 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 營業費用 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 研究發展費 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 推銷費用 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 管理費用 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 預期信用減損_損失_利益_營業費用 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 其他收益及費損淨額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 營業利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 財務成本 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 採權益法之關聯企業及合資損益之份額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 營業外收入及支出 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 稅前淨利 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 所得稅費用 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 繼續營業單位損益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 停業單位損益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 合併前非屬共同控制股權損益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 合併總損益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 本期綜合損益總額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 歸屬母公司淨利_損 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 歸屬非控制權益淨利_損 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 歸屬共同控制下前手權益淨利_損 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 綜合損益歸屬母公司 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 綜合損益歸屬非控制權益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 綜合損益歸屬共同控制下前手權益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 每股盈餘 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 繼續營業單位稅前淨利_淨損 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 本期稅前淨利_淨損 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 折舊費用 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 攤銷費用 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 呆帳費用提列_轉列收入_數 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 透過損益按公允價值衡量金融資產及負債之淨損失_利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 利息費用 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 利息收入 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 股利收入 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 採用權益法認列之關聯企業及合資損失_利益_之份額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 處分及報廢不動產_廠房及設備損失_利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 處分無形資產損失_利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 處分投資損失_利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 非金融資產減損迴轉利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 未實現銷貨利益_損失 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 已實現銷貨損失_利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 未實現外幣兌換損失_利益 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 收益費損項目合計 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應收帳款_增加_減少 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應收帳款_關係人_增加_減少 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 存貨_增加_減少 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 與營業活動相關之資產之淨變動合計 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應付帳款增加_減少 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應付帳款_關係人增加_減少 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 與營業活動相關之負債之淨變動合計 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 營運產生之現金流入_流出 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 退還_支付_之所得稅 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 營業活動之淨現金流入_流出 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 取得透過其他綜合損益按公允價值衡量之金融資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 處分透過其他綜合損益按公允價值衡量之金融資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 取得不動產_廠房及設備 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 處分不動產_廠房及設備 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 取得無形資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 處分無形資產 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 收取之利息 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 收取之股利 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 其他投資活動 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 投資活動之淨現金流入_流出 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 短期借款增加 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 短期借款減少 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應付短期票券增加 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 應付短期票券減少 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 發行公司債 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 償還公司債 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 舉借長期借款 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 償還長期借款 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 存入保證金增加 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 存入保證金減少 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 發放現金股利 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 支付之利息 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 籌資活動之淨現金流入_流出 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 本期現金及約當現金增加_減少_數 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 期初現金及約當現金餘額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 期末現金及約當現金餘額 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statement | 資產負債表帳列之現金及約當現金 | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | etl | market_value | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | kr_market_value | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | us_market_value | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | financial_statements_deadline | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | hk_market_value | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | financial_statements_disclosure_dates | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | jp_market_value | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | uk_market_value | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | benchmark_return | 發行量加權股價報酬指數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etl | finlab_tw_stock_market_ind | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | broker_transactions |  | broker / branch flow | P1 | augment | chip_diversity | turnover, crowding, price_location_gate | no | broker concentration, branch flow anomaly, emerging-stock chip proxy |
| tw | etl | broker_transactions:top15_buy | broker / branch flow | P1 | augment | chip_diversity | turnover, crowding, price_location_gate | no | broker concentration, branch flow anomaly, emerging-stock chip proxy |
| tw | etl | broker_transactions:top15_sell | broker / branch flow | P1 | augment | chip_diversity | turnover, crowding, price_location_gate | no | broker concentration, branch flow anomaly, emerging-stock chip proxy |
| tw | etl | broker_transactions:buy_sell_ratio | broker / branch flow | P1 | augment | chip_diversity | turnover, crowding, price_location_gate | no | broker concentration, branch flow anomaly, emerging-stock chip proxy |
| tw | etl | broker_transactions:balance_index | broker / branch flow | P1 | augment | chip_diversity | turnover, crowding, price_location_gate | no | broker concentration, branch flow anomaly, emerging-stock chip proxy |
| tw | inventory |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etl | inventory:零股股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:零股人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:零股佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於五張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於五張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於五張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於一張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於一張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於一張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於五張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於五張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於五張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於十五張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於十五張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於十五張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於二十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於二十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於二十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於十五張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於十五張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於十五張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於三十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於三十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於三十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於二十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於二十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於二十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於四十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於四十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於四十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於三十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於三十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於三十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於五十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於五十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於五十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於四十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於四十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於四十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於一百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於一百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於一百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於五十張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於五十張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於五十張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於二百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於二百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於二百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於一百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於一百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於一百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於四百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於四百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於四百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於二百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於二百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於二百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於六百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於六百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於六百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於四百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於四百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於四百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於八百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於八百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於八百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於六百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於六百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於六百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於一千張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於一千張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:小於一千張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於八百張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於八百張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於八百張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於一千張股數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於一千張人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:大於一千張佔比 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | inventory:全部人數 | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | margin_transactions | 融資買進 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融資賣出 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融資現金償還 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融資前日餘額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融資今日餘額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融資限額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融券買進 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融券賣出 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融券現券償還 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融券前日餘額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融券今日餘額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融券限額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 資券互抵 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 註記 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融資使用率 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_transactions | 融券使用率 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | internal_equity_changes | 發行股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_changes | 董監增加股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_changes | 董監減少股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_changes | 董監持有股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_changes | 董監持有股數占比 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_changes | 經理人持有股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_changes | 百分之十以上大股東持有股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_changes | 市場別 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 發行股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 全體董事(不包含獨立董事)應持有股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 全體董事(不包含獨立董事)實際持有股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 全體董事(不包含獨立董事)法人代表人分戶集保股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 全體董事(不包含獨立董事)保留運用決定權信託股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 全體董事(不包含獨立董事)不足股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 監察人應持有股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 監察人應持有股數實際持有股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 監察人應持有股數法人代表人分戶集保股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 監察人應持有股數保留運用決定權信託股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 監察人應持有股數不足股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 持股不足已通知其董監 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_insufficient | 市場別 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading | 當日沖銷交易成交股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading | 當日沖銷交易買進成交金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading | 當日沖銷交易賣出成交金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading | 得先賣後買當沖 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading_stat | 當日沖銷交易總成交股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading_stat | 當日沖銷交易總成交股數占市場比重 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading_stat | 當日沖銷交易總買進成交金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading_stat | 當日沖銷交易總買進成交金額占市場比重 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading_stat | 當日沖銷交易總賣出成交金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_trading_stat | 當日沖銷交易總賣出成交金額占市場比重 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | after_market_odd_lot_trade | 成交股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | after_market_odd_lot_trade | 成交筆數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | after_market_odd_lot_trade | 成交金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | after_market_odd_lot_trade | 成交價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | after_market_odd_lot_trade | 最後揭示買價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | after_market_odd_lot_trade | 最後揭示賣價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | after_market_odd_lot_trade | 最後揭示買量 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | after_market_odd_lot_trade | 最後揭示賣量 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_otc | 恢復買賣日期 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_otc | 減資原因 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_otc | 開始交易基準價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_otc | 最後交易之收盤價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_otc | 減資恢復買賣開始日參考價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_otc | 漲停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_otc | 跌停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_otc | 除權參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_otc | otc_cap_divide_ratio | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_tse | 恢復買賣日期 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_tse | 減資原因 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_tse | 恢復買賣參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_tse | 停止買賣前收盤價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_tse | 漲停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_tse | 跌停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_tse | 開盤競價基準 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_tse | 除權參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | capital_reduction_tse | twse_cap_divide_ratio | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_converted_status | 本月轉換張數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_converted_status | 轉(交)換或認股價格(元) | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_converted_status | 債券轉(交)換或認購普通股 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_price | 成交張數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_price | 成交筆數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_price | 成交金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_price | 收盤價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_price | 開盤價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_price | 最低價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_price | 最高價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | change_transaction | 變更交易 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | change_transaction | 分盤交易 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etl | full_cash_delivery_stock_filter | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | dividend_otc | 除權息前收盤價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 除權息參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 權值 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 息值 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 權+息值 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 權息 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 漲停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 跌停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 開盤競價基準 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 減除股利參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 現金股利 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 每千股無償配股 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 現金增資股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 現金增資認購價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 公開承銷股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 員工認購股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 原股東認購數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | 按持股比例千股認購 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_otc | otc_divide_ratio | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 除權息前收盤價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 除權息參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 權值+息值 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 權息 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 漲停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 跌停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 開盤競價基準 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 減除股利參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 詳細資料 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 最近一次申報資料 季別日期 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 最近一次申報每股 (單位)淨值 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | 最近一次申報每股 (單位)盈餘 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | dividend_tse | twse_divide_ratio | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etf_split | 名稱 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etf_split | 分割(反分割) | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etf_split | 恢復買賣日期 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etf_split | 分割(反分割)比率 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etf_split | 參考價試算 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etf_split | 恢復買賣參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | financial_statements_upload_detail | upload_date | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | financial_statements_upload_detail | correction | fundamentals | P0 | augment | fundamental_factor_diversity | report_date_availability, no_lookahead, sector_normalization | yes | quality, value, growth, profitability, balance-sheet factors |
| tw | foreign_investors_shareholding | 發行股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | foreign_investors_shareholding | 外資及陸資尚可投資股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | foreign_investors_shareholding | 全體外資及陸資持有股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | foreign_investors_shareholding | 外資及陸資尚可投資比率 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | foreign_investors_shareholding | 全體外資及陸資持股比率 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | foreign_investors_shareholding | 外資及陸資共用法令投資上限比率 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | foreign_investors_shareholding | 陸資法令投資上限比率 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | futures_institutional_investors_trading_summary | 多方交易口數 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 空方交易口數 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 多空交易口數淨額 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 多方未平倉口數 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 空方未平倉口數 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 多空未平倉口數淨額 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 多方交易契約金額(千元) | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 空方交易契約金額(千元) | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 多空交易契約金額淨額(千元) | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 多方未平倉契約金額(千元) | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 空方未平倉契約金額(千元) | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_institutional_investors_trading_summary | 多空未平倉契約金額淨額(千元) | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_price | 到期月份(週別) | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_price | 開盤價 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_price | 最高價 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_price | 最低價 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_price | 收盤價 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_price | 漲跌價 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_price | 漲跌幅 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_price | 成交量 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | futures_price | 未沖銷契約數 | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | institutional_investors_trading_all_market_summary | 買進金額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_all_market_summary | 賣出金額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_all_market_summary | 買賣超 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 外陸資買進股數(不含外資自營商) | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 外陸資賣出股數(不含外資自營商) | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 外陸資買賣超股數(不含外資自營商) | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 外資自營商買進股數 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 外資自營商賣出股數 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 外資自營商買賣超股數 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 投信買進股數 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 投信賣出股數 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 投信買賣超股數 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 自營商買進股數(自行買賣) | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 自營商賣出股數(自行買賣) | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 自營商買賣超股數(自行買賣) | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 自營商買進股數(避險) | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 自營商賣出股數(避險) | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | institutional_investors_trading_summary | 自營商買賣超股數(避險) | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | internal_equity_pledge | 董監持股 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_pledge | 董監設質 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_pledge | 董監解質 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_pledge | 董監累計設質 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_pledge | 董監設質股數占比 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_pledge | 經理人持股 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_pledge | 百分之十以上大股東持有股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_pledge | 經理人及百分之十以上大股東設質股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_pledge | 經理人及百分之十以上大股東設質股數占比 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | internal_equity_pledge | 市場別 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 成交股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 成交筆數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 成交金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 收盤價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 開盤價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 最低價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 最高價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 最後揭示買價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 最後揭示賣價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 最後揭示買量 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_odd_lot_trade | 最後揭示賣量 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | margin_balance | 融資券總買進 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_balance | 融資券總賣出 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_balance | 現金(券)總償還 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | margin_balance | 融資券總餘額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | market_transaction_info | 成交股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | market_transaction_info | 成交金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | market_transaction_info | 成交筆數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | market_transaction_info | 收盤指數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_otc | 恢復買賣日期 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_otc | 最後交易日之收盤價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_otc | 恢復買賣開始日參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_otc | 漲停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_otc | 跌停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_otc | 開始交易基準價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_otc | otc_par_value_change_divide_ratio | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_tse | 恢復買賣日期 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_tse | 停止買賣前收盤價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_tse | 恢復買賣參考價 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_tse | 漲停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_tse | 跌停價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_tse | 開盤競價基準 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | par_value_change_tse | twse_par_value_change_divide_ratio | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | quality_factor_z_score | profitability | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | quality_factor_z_score | growth | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | quality_factor_z_score | safety | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | rotc_monthly_revenue | 當月營收 | monthly revenue | P0 | augment | emerging_revenue_diversity | publication_alignment, restatement_check, no_pending_buy | no | emerging-stock revenue momentum and watchlist context |
| tw | rotc_monthly_revenue | 上月營收 | monthly revenue | P0 | augment | emerging_revenue_diversity | publication_alignment, restatement_check, no_pending_buy | no | emerging-stock revenue momentum and watchlist context |
| tw | rotc_monthly_revenue | 去年當月營收 | monthly revenue | P0 | augment | emerging_revenue_diversity | publication_alignment, restatement_check, no_pending_buy | no | emerging-stock revenue momentum and watchlist context |
| tw | rotc_monthly_revenue | 上月比較增減(%) | monthly revenue | P0 | augment | emerging_revenue_diversity | publication_alignment, restatement_check, no_pending_buy | no | emerging-stock revenue momentum and watchlist context |
| tw | rotc_monthly_revenue | 去年同月增減(%) | monthly revenue | P0 | augment | emerging_revenue_diversity | publication_alignment, restatement_check, no_pending_buy | no | emerging-stock revenue momentum and watchlist context |
| tw | rotc_monthly_revenue | 當月累計營收 | monthly revenue | P0 | augment | emerging_revenue_diversity | publication_alignment, restatement_check, no_pending_buy | no | emerging-stock revenue momentum and watchlist context |
| tw | rotc_monthly_revenue | 去年累計營收 | monthly revenue | P0 | augment | emerging_revenue_diversity | publication_alignment, restatement_check, no_pending_buy | no | emerging-stock revenue momentum and watchlist context |
| tw | rotc_monthly_revenue | 前期比較增減(%) | monthly revenue | P0 | augment | emerging_revenue_diversity | publication_alignment, restatement_check, no_pending_buy | no | emerging-stock revenue momentum and watchlist context |
| tw | rotc_monthly_revenue | 備註 | monthly revenue | P0 | augment | emerging_revenue_diversity | publication_alignment, restatement_check, no_pending_buy | no | emerging-stock revenue momentum and watchlist context |
| tw | rotc_price | 成交股數 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | rotc_price | 成交金額 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | rotc_price | 開盤價 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | rotc_price | 收盤價 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | rotc_price | 最高價 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | rotc_price | 最低價 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | rotc_price | 日均價 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | rotc_price | 成交筆數 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | rotc_price | 最後揭示買價 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | rotc_price | 最後揭示賣價 | price / OHLCV | P0 | augment | emerging_price_diversity | rotc_market_lane, liquidity_bounds, no_pending_buy | no | emerging-stock price, liquidity, quote-spread, and watchlist context |
| tw | security_lending | 前日借券餘額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | security_lending | 借券 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | security_lending | 借券還券 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | security_lending | 借券增減 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | security_lending | 借券餘額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | security_lending_sell | 借券賣出 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | security_lending_sell | 借券賣出還券 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | security_lending_sell | 借券賣出餘額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | security_lending_sell | 借券賣出限額 | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | stock_index_price | 收盤指數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | stock_index_price | 漲跌百分比(%) | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | stock_index_vol | 成交股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | stock_index_vol | 成交金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | stock_index_vol | 成交筆數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | taiex_total_index | 開盤指數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | taiex_total_index | 最高指數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | taiex_total_index | 最低指數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | taiex_total_index | 收盤指數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 買回目的 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 買回股份總金額上限 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 預定買回股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 買回價格區間-最低 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 買回價格區間-最高 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 預定買回期間-起 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 預定買回期間-迄 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 是否執行完畢 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 本次已買回股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 本次執行完畢已註銷或轉讓股數 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 本次已買回股數佔預定買回股數比例(%) | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 本次已買回總金額 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 本次平均每股買回價格 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 本次買回股數佔公司已發行股份總數比例(%) | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | treasury_stock | 本次未執行完畢之原因 | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | tw_business_indicators | 景氣對策信號(分) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators | 領先指標綜合指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators | 領先指標不含趨勢指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators | 同時指標綜合指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators | 同時指標不含趨勢指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators | 落後指標綜合指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators | 落後指標不含趨勢指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 領先指標綜合指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 領先指標不含趨勢指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 外銷訂單動向指數(以家數計) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 貨幣總計數 M1B(百萬元) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 股價指數(Index 1966=100) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 工業及服務業受僱員工淨進入率 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 建築物開工樓地板面積(千平方公尺) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 半導體設備進口值(新台幣百萬元) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 同時指標綜合指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 同時指標不含趨勢指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 工業生產指數(Index 2016=100) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 電力(企業)總用電量(十億度) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 製造業銷售量指數(Index 2016=100) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 批發、零售及餐飲業營業額(十億元) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 非農業部門就業人數(千人) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 海關出口值(十億元) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 機械及電機設備進口值(十億元) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 落後指標綜合指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 落後指標不含趨勢指數(點) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 失業率 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 製造業單位產出勞動成本指數(Index 2016=100) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 金融業隔夜拆款利率(年息百分比) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 全體金融機構放款與投資(10億元) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_business_indicators_details | 製造業存貨價值(千元) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_etf_nav_daily | 淨值 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_etf_nav_daily | 折溢價(%) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 非製造業NMI | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 商業活動 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 新增訂單 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 人力僱用 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 供應商交貨時間 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 存貨 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 採購價格 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 未完成訂單 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 服務輸出出口 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 服務輸入進口 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 服務收費價格 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 存貨觀感 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_nmi | 未來六個月展望 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 製造業PMI | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 新增訂單數量 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 生產數量 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 人力僱用數量 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 供應商交貨時間 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 存貨 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 客戶存貨 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 原物料價格 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 未完成訂單 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 新增出口訂單 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 進口原物料數量 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_industry_pmi | 未來六個月展望 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_monetary_aggregates | 年增率(%) | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 臺灣非製造業NMI | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 商業活動 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 新增訂單 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 人力僱用 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 供應商交貨時間 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 存貨 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 採購價格 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 未完成訂單 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 服務輸出出口 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 服務輸入進口 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 服務收費價格 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 存貨觀感 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_nmi | 未來六個月展望 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 製造業PMI | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 新增訂單數量 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 生產數量 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 人力僱用數量 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 供應商交貨時間 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 存貨 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 客戶存貨 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 原物料價格 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 未完成訂單 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 新增出口訂單 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 進口原物料數量 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_total_pmi | 未來六個月展望 | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | world_index | open | world market | P0 | augment | global_context | coverage, delay, holiday_calendar_alignment | no | morning setup, cross-market context, regime evidence |
| tw | world_index | high | world market | P0 | augment | global_context | coverage, delay, holiday_calendar_alignment | no | morning setup, cross-market context, regime evidence |
| tw | world_index | low | world market | P0 | augment | global_context | coverage, delay, holiday_calendar_alignment | no | morning setup, cross-market context, regime evidence |
| tw | world_index | close | world market | P0 | augment | global_context | coverage, delay, holiday_calendar_alignment | no | morning setup, cross-market context, regime evidence |
| tw | world_index | adj_close | world market | P0 | augment | global_context | coverage, delay, holiday_calendar_alignment | no | morning setup, cross-market context, regime evidence |
| tw | world_index | volume | world market | P0 | augment | global_context | coverage, delay, holiday_calendar_alignment | no | morning setup, cross-market context, regime evidence |
| tw | board_dividend_announcement |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | cb_published_info |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | company_basic_info |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | company_main_business |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | day_trade_short_suspension |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | delisted_companies |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | delisted_companies_otc |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | delisted_companies_tse |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | disposal_information |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etl | disposal_stock_filter | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | dividend_announcement |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | important_info_announcement |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | important_subsidiary |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | insider_shareholding_transfer_declaration |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | intraday_lending_fee |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etl | lending_fee_volume | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | lending_fee_rate_simple_avg | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | lending_fee_rate_weighted_avg | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | etl | lending_fee_rate_max | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | investors_conference |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | lawsuit_info |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | margin_short_sale_suspension |  | chips / institutional flow | P0 | augment | chip_diversity | price_location, liquidity, crowding, extreme_value_winsorization | yes | foreign/trust/dealer flow, margin heat, lending pressure, theme rotation |
| tw | national_security_fund |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | oversea_investment |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | reference_price |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | rotc_broker_transactions |  | broker / branch flow | P0 | augment | emerging_chip_diversity | emerging_symbol_coverage, branch_concentration_bounds | no | broker concentration, branch flow anomaly, emerging-stock chip proxy |
| tw | security_categories |  | security master / taxonomy | P0 | replace | security_master | row_count, market_enum, known_symbol_checks | yes | primary market lane and formal industry normalization |
| tw | security_industry_themes |  | security master / taxonomy | P0 | augment | taxonomy_expansion | alias_cleaning, duplicate_tag_rate, coverage_by_symbol | no | subindustry, supply-chain, and industry-theme expansion |
| tw | shareholders_meeting |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | single_stock_futures_and_equity_options_underlying |  | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | trading_attention |  | other | P2 | benchmark | research | manual_review | no | research reference |
| tw | etl | noticed_stock_filter | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | yes | daily price, adjusted price, liquidity, backtest base panel |
| tw | tw_etf_basic_info |  | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_etf_beneficiary_stats |  | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_etf_dividend_events |  | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_news_cnyes |  | taiwan macro | P1 | augment | regime_context | freshness, low_frequency_alignment | no | regime and macro context |
| tw | tw_option_daily_delta |  | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | tw_option_daily_summary |  | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | tw_option_put_call_ratio |  | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | tw_option_recent_trades |  | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | tw_taifex_futures_large_trader |  | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | tw_taifex_option_institutional_breakdown |  | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | tw_taifex_option_large_trader |  | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| tw | tw_taifex_option_liquidity |  | derivatives / positioning | P1 | augment | regime_context | market_level_only, no_direct_alpha_gate | no | market regime, hedge pressure, risk dashboard |
| us | us_analyst_consensus | strong_buy | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_analyst_consensus | buy | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_analyst_consensus | hold | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_analyst_consensus | sell | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_analyst_consensus | strong_sell | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_analyst_consensus | consensus | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | reported_currency | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | cik | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | filing_date | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | accepted_date | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | fiscal_year | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | cash_and_cash_equivalents | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | short_term_investments | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | cash_and_short_term_investments | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | net_receivables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | accounts_receivables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | other_receivables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | inventory | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | prepaids | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | other_current_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_current_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | property_plant_equipment_net | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | goodwill | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | intangible_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | goodwill_and_intangible_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | long_term_investments | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | tax_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | other_non_current_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_non_current_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | other_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_payables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | account_payables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | other_payables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | accrued_expenses | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | short_term_debt | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | capital_lease_obligations_current | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | tax_payables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | deferred_revenue | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | other_current_liabilities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_current_liabilities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | long_term_debt | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | deferred_revenue_non_current | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | deferred_tax_liabilities_non_current | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | other_non_current_liabilities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_non_current_liabilities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | other_liabilities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | capital_lease_obligations | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_liabilities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | treasury_stock | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | preferred_stock | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | common_stock | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | retained_earnings | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | additional_paid_in_capital | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | accumulated_other_comprehensive_income_loss | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | other_total_stockholders_equity | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_stockholders_equity | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_equity | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | minority_interest | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_liabilities_and_total_equity | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_investments | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | total_debt | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | net_debt | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_balance_sheet | original_date | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | reported_currency | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | cik | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | filing_date | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | accepted_date | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | fiscal_year | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_income | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | depreciation_and_amortization | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | deferred_income_tax | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | stock_based_compensation | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | change_in_working_capital | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | accounts_receivables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | inventory | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | accounts_payables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | other_working_capital | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | other_non_cash_items | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_cash_provided_by_operating_activities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | investments_in_property_plant_and_equipment | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | acquisitions_net | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | purchases_of_investments | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | sales_maturities_of_investments | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | other_investing_activities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_cash_provided_by_investing_activities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_debt_issuance | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | long_term_net_debt_issuance | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | short_term_net_debt_issuance | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_stock_issuance | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_common_stock_issuance | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | common_stock_issuance | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | common_stock_repurchased | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_preferred_stock_issuance | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_dividends_paid | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | common_dividends_paid | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | preferred_dividends_paid | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | other_financing_activities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_cash_provided_by_financing_activities | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | effect_of_forex_changes_on_cash | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | net_change_in_cash | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | cash_at_end_of_period | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | cash_at_beginning_of_period | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | operating_cash_flow | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | capital_expenditure | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | free_cash_flow | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | income_taxes_paid | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | interest_paid | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_cash_flow | original_date | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_dcf | dcf | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_dcf | stock_price | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_earnings_surprises | eps_actual | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_earnings_surprises | eps_estimated | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | open | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | high | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | low | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | close | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | adj_close | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | adj_open | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | adj_high | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | adj_low | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | adj_pct_change | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_fund_price | volume | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | reported_currency | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | cik | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | filing_date | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | accepted_date | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | calendar_year | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | fiscal_year | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | revenue | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | cost_of_revenue | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | gross_profit | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | research_and_development_expenses | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | general_and_administrative_expenses | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | selling_and_marketing_expenses | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | other_expenses | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | selling_general_and_administrative_expenses | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | operating_expenses | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | cost_and_expenses | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | depreciation_and_amortization | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | operating_income | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | ebitda | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | ebit | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | non_operating_income_excluding_interest | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | net_interest_income | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | interest_income | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | interest_expense | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | total_other_income_expenses_net | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | income_before_tax | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | income_tax_expense | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | net_income_from_continuing_operations | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | net_income_from_discontinued_operations | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | other_adjustments_to_net_income | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | net_income | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | net_income_deductions | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | bottom_line_net_income | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | eps | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | eps_diluted | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | weighted_average_shs_out | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | weighted_average_shs_out_dil | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_income_statement | original_date | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_index_constituents | sp500 | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_index_constituents | nasdaq100 | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | market_cap | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | enterprise_value | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | ev_to_sales | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | ev_to_operating_cash_flow | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | ev_to_free_cash_flow | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | ev_to_ebitda | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | net_debt_to_ebitda | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | current_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | income_quality | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | graham_number | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | graham_net_net | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | tax_burden | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | interest_burden | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | working_capital | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | invested_capital | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | return_on_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | operating_return_on_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | return_on_tangible_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | return_on_equity | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | return_on_invested_capital | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | return_on_capital_employed | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | earnings_yield | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | free_cash_flow_yield | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | capex_to_operating_cash_flow | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | capex_to_depreciation | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | capex_to_revenue | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | sales_general_and_administrative_to_revenue | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | research_and_developement_to_revenue | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | stock_based_compensation_to_revenue | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | intangibles_to_total_assets | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | average_receivables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | average_payables | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | average_inventory | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | days_of_sales_outstanding | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | days_of_payables_outstanding | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | days_of_inventory_outstanding | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | operating_cycle | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | cash_conversion_cycle | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | free_cash_flow_to_equity | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | free_cash_flow_to_firm | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | tangible_asset_value | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_key_metrics | net_current_asset_value | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | open | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | high | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | low | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | close | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | adj_close | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | adj_open | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | adj_high | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | adj_low | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | adj_pct_change | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price | volume | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | etl | us_liquid_stock_filter | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | no | daily price, adjusted price, liquidity, backtest base panel |
| us | us_price_target_summary | last_month_count | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price_target_summary | last_month_avg_price_target | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price_target_summary | last_quarter_count | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price_target_summary | last_quarter_avg_price_target | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price_target_summary | last_year_count | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price_target_summary | last_year_avg_price_target | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price_target_summary | all_time_count | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price_target_summary | all_time_avg_price_target | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_price_target_summary | publishers | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | gross_profit_margin | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | ebit_margin | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | ebitda_margin | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | operating_profit_margin | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | pretax_profit_margin | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | continuous_operations_profit_margin | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | net_profit_margin | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | bottom_line_profit_margin | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | receivables_turnover | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | payables_turnover | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | inventory_turnover | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | fixed_asset_turnover | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | asset_turnover | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | current_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | quick_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | solvency_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | cash_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | price_to_earnings_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | price_to_earnings_growth_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | forward_price_to_earnings_growth_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | price_to_book_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | price_to_sales_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | price_to_free_cash_flow_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | price_to_operating_cash_flow_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | debt_to_assets_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | debt_to_equity_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | debt_to_capital_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | long_term_debt_to_capital_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | financial_leverage_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | working_capital_turnover_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | operating_cash_flow_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | operating_cash_flow_sales_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | free_cash_flow_operating_cash_flow_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | debt_service_coverage_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | interest_coverage_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | short_term_operating_cash_flow_coverage_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | operating_cash_flow_coverage_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | capital_expenditure_coverage_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | dividend_paid_and_capex_coverage_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | dividend_payout_ratio | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | dividend_yield | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | dividend_yield_percentage | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | revenue_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | net_income_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | interest_debt_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | cash_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | book_value_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | tangible_book_value_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | shareholders_equity_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | operating_cash_flow_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | capex_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | free_cash_flow_per_share | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | net_income_per_ebt | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | ebt_per_ebit | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | price_to_fair_value | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | debt_to_market_cap | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | effective_tax_rate | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_ratios | enterprise_value_multiple | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_stock_rating | rating | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_stock_rating | dcf_score | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_stock_rating | roe_score | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_stock_rating | roa_score | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_stock_rating | de_score | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_stock_rating | pe_score | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_stock_rating | pb_score | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | us_company_profile |  | us market | P1 | augment | global_context | coverage, delay, license, survivorship_check | no | US leading / morning setup replacement candidate, global risk context |
| us | etl | us_common_stock_filter | price / OHLCV | P0 | replace | daily_price | 20_30_day_parity, split_adjustment, missing_rate | no | daily price, adjusted price, liquidity, backtest base panel |
| hk | hk_analyst_consensus | strong_buy | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_analyst_consensus | buy | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_analyst_consensus | hold | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_analyst_consensus | sell | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_analyst_consensus | strong_sell | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_analyst_consensus | consensus | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | cash_and_cash_equivalents | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | short_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | cash_and_short_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | net_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | accounts_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | other_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | prepaids | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | other_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | property_plant_equipment_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | goodwill | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | intangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | goodwill_and_intangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | long_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | tax_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | other_non_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_non_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | other_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | account_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | other_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | accrued_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | short_term_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | capital_lease_obligations_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | tax_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | deferred_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | other_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | long_term_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | deferred_revenue_non_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | deferred_tax_liabilities_non_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | other_non_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_non_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | other_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | capital_lease_obligations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | treasury_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | preferred_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | common_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | retained_earnings | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | additional_paid_in_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | accumulated_other_comprehensive_income_loss | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | other_total_stockholders_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_stockholders_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | minority_interest | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_liabilities_and_total_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | total_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | net_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_balance_sheet | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | depreciation_and_amortization | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | deferred_income_tax | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | stock_based_compensation | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | change_in_working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | accounts_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | accounts_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | other_working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | other_non_cash_items | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_cash_provided_by_operating_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | investments_in_property_plant_and_equipment | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | acquisitions_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | purchases_of_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | sales_maturities_of_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | other_investing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_cash_provided_by_investing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | long_term_net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | short_term_net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_common_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | common_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | common_stock_repurchased | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_preferred_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | common_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | preferred_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | other_financing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_cash_provided_by_financing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | effect_of_forex_changes_on_cash | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | net_change_in_cash | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | cash_at_end_of_period | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | cash_at_beginning_of_period | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | capital_expenditure | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | free_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | income_taxes_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | interest_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_cash_flow | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_dcf | dcf | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_dcf | stock_price | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_earnings_surprises | eps_actual | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_earnings_surprises | eps_estimated | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | adj_close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | adj_open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | adj_high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | adj_low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | adj_pct_change | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_fund_price | volume | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | calendar_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | cost_of_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | gross_profit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | research_and_development_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | general_and_administrative_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | selling_and_marketing_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | other_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | selling_general_and_administrative_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | operating_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | cost_and_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | depreciation_and_amortization | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | operating_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | ebit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | non_operating_income_excluding_interest | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | net_interest_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | interest_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | interest_expense | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | total_other_income_expenses_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | income_before_tax | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | income_tax_expense | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | net_income_from_continuing_operations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | net_income_from_discontinued_operations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | other_adjustments_to_net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | net_income_deductions | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | bottom_line_net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | eps | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | eps_diluted | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | weighted_average_shs_out | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | weighted_average_shs_out_dil | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_income_statement | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | market_cap | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | enterprise_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | ev_to_sales | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | ev_to_operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | ev_to_free_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | ev_to_ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | net_debt_to_ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | current_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | income_quality | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | graham_number | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | graham_net_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | tax_burden | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | interest_burden | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | invested_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | return_on_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | operating_return_on_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | return_on_tangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | return_on_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | return_on_invested_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | return_on_capital_employed | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | earnings_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | free_cash_flow_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | capex_to_operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | capex_to_depreciation | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | capex_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | sales_general_and_administrative_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | research_and_developement_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | stock_based_compensation_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | intangibles_to_total_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | average_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | average_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | average_inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | days_of_sales_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | days_of_payables_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | days_of_inventory_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | operating_cycle | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | cash_conversion_cycle | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | free_cash_flow_to_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | free_cash_flow_to_firm | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | tangible_asset_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_key_metrics | net_current_asset_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | adj_close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | adj_open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | adj_high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | adj_low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | adj_pct_change | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_price | volume | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | gross_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | ebit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | ebitda_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | operating_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | pretax_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | continuous_operations_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | net_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | bottom_line_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | receivables_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | payables_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | inventory_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | fixed_asset_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | asset_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | current_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | quick_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | solvency_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | cash_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | price_to_earnings_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | price_to_earnings_growth_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | forward_price_to_earnings_growth_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | price_to_book_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | price_to_sales_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | price_to_free_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | price_to_operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | debt_to_assets_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | debt_to_equity_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | debt_to_capital_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | long_term_debt_to_capital_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | financial_leverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | working_capital_turnover_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | operating_cash_flow_sales_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | free_cash_flow_operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | debt_service_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | interest_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | short_term_operating_cash_flow_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | operating_cash_flow_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | capital_expenditure_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | dividend_paid_and_capex_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | dividend_payout_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | dividend_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | dividend_yield_percentage | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | revenue_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | net_income_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | interest_debt_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | cash_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | book_value_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | tangible_book_value_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | shareholders_equity_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | operating_cash_flow_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | capex_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | free_cash_flow_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | net_income_per_ebt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | ebt_per_ebit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | price_to_fair_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | debt_to_market_cap | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | effective_tax_rate | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_ratios | enterprise_value_multiple | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_stock_rating | rating | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_stock_rating | dcf_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_stock_rating | roe_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_stock_rating | roa_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_stock_rating | de_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_stock_rating | pe_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_stock_rating | pb_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| hk | hk_company_profile |  | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_analyst_consensus | strong_buy | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_analyst_consensus | buy | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_analyst_consensus | hold | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_analyst_consensus | sell | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_analyst_consensus | strong_sell | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_analyst_consensus | consensus | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | cash_and_cash_equivalents | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | short_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | cash_and_short_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | net_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | accounts_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | other_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | prepaids | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | other_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | property_plant_equipment_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | goodwill | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | intangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | goodwill_and_intangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | long_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | tax_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | other_non_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_non_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | other_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | account_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | other_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | accrued_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | short_term_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | capital_lease_obligations_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | tax_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | deferred_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | other_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | long_term_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | deferred_revenue_non_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | deferred_tax_liabilities_non_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | other_non_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_non_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | other_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | capital_lease_obligations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | treasury_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | preferred_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | common_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | retained_earnings | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | additional_paid_in_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | accumulated_other_comprehensive_income_loss | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | other_total_stockholders_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_stockholders_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | minority_interest | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_liabilities_and_total_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | total_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | net_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_balance_sheet | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | depreciation_and_amortization | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | deferred_income_tax | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | stock_based_compensation | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | change_in_working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | accounts_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | accounts_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | other_working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | other_non_cash_items | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_cash_provided_by_operating_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | investments_in_property_plant_and_equipment | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | acquisitions_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | purchases_of_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | sales_maturities_of_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | other_investing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_cash_provided_by_investing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | long_term_net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | short_term_net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_common_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | common_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | common_stock_repurchased | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_preferred_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | common_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | preferred_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | other_financing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_cash_provided_by_financing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | effect_of_forex_changes_on_cash | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | net_change_in_cash | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | cash_at_end_of_period | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | cash_at_beginning_of_period | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | capital_expenditure | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | free_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | income_taxes_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | interest_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_cash_flow | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_dcf | dcf | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_dcf | stock_price | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_earnings_surprises | eps_actual | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_earnings_surprises | eps_estimated | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | adj_close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | adj_open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | adj_high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | adj_low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | adj_pct_change | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_fund_price | volume | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | calendar_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | cost_of_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | gross_profit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | research_and_development_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | general_and_administrative_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | selling_and_marketing_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | other_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | selling_general_and_administrative_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | operating_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | cost_and_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | depreciation_and_amortization | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | operating_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | ebit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | non_operating_income_excluding_interest | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | net_interest_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | interest_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | interest_expense | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | total_other_income_expenses_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | income_before_tax | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | income_tax_expense | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | net_income_from_continuing_operations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | net_income_from_discontinued_operations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | other_adjustments_to_net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | net_income_deductions | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | bottom_line_net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | eps | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | eps_diluted | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | weighted_average_shs_out | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | weighted_average_shs_out_dil | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_income_statement | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | market_cap | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | enterprise_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | ev_to_sales | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | ev_to_operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | ev_to_free_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | ev_to_ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | net_debt_to_ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | current_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | income_quality | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | graham_number | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | graham_net_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | tax_burden | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | interest_burden | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | invested_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | return_on_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | operating_return_on_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | return_on_tangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | return_on_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | return_on_invested_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | return_on_capital_employed | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | earnings_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | free_cash_flow_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | capex_to_operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | capex_to_depreciation | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | capex_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | sales_general_and_administrative_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | research_and_developement_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | stock_based_compensation_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | intangibles_to_total_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | average_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | average_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | average_inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | days_of_sales_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | days_of_payables_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | days_of_inventory_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | operating_cycle | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | cash_conversion_cycle | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | free_cash_flow_to_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | free_cash_flow_to_firm | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | tangible_asset_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_key_metrics | net_current_asset_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | adj_close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | adj_open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | adj_high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | adj_low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | adj_pct_change | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_price | volume | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | gross_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | ebit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | ebitda_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | operating_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | pretax_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | continuous_operations_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | net_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | bottom_line_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | receivables_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | payables_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | inventory_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | fixed_asset_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | asset_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | current_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | quick_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | solvency_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | cash_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | price_to_earnings_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | price_to_earnings_growth_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | forward_price_to_earnings_growth_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | price_to_book_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | price_to_sales_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | price_to_free_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | price_to_operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | debt_to_assets_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | debt_to_equity_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | debt_to_capital_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | long_term_debt_to_capital_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | financial_leverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | working_capital_turnover_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | operating_cash_flow_sales_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | free_cash_flow_operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | debt_service_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | interest_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | short_term_operating_cash_flow_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | operating_cash_flow_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | capital_expenditure_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | dividend_paid_and_capex_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | dividend_payout_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | dividend_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | dividend_yield_percentage | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | revenue_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | net_income_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | interest_debt_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | cash_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | book_value_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | tangible_book_value_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | shareholders_equity_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | operating_cash_flow_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | capex_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | free_cash_flow_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | net_income_per_ebt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | ebt_per_ebit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | price_to_fair_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | debt_to_market_cap | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | effective_tax_rate | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_ratios | enterprise_value_multiple | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_stock_rating | rating | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_stock_rating | dcf_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_stock_rating | roe_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_stock_rating | roa_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_stock_rating | de_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_stock_rating | pe_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_stock_rating | pb_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| jp | jp_company_profile |  | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_analyst_consensus | strong_buy | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_analyst_consensus | buy | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_analyst_consensus | hold | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_analyst_consensus | sell | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_analyst_consensus | strong_sell | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_analyst_consensus | consensus | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | cash_and_cash_equivalents | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | short_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | cash_and_short_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | net_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | accounts_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | other_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | prepaids | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | other_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | property_plant_equipment_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | goodwill | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | intangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | goodwill_and_intangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | long_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | tax_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | other_non_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_non_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | other_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | account_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | other_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | accrued_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | short_term_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | capital_lease_obligations_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | tax_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | deferred_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | other_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | long_term_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | deferred_revenue_non_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | deferred_tax_liabilities_non_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | other_non_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_non_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | other_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | capital_lease_obligations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | treasury_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | preferred_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | common_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | retained_earnings | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | additional_paid_in_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | accumulated_other_comprehensive_income_loss | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | other_total_stockholders_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_stockholders_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | minority_interest | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_liabilities_and_total_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | total_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | net_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_balance_sheet | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | depreciation_and_amortization | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | deferred_income_tax | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | stock_based_compensation | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | change_in_working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | accounts_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | accounts_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | other_working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | other_non_cash_items | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_cash_provided_by_operating_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | investments_in_property_plant_and_equipment | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | acquisitions_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | purchases_of_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | sales_maturities_of_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | other_investing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_cash_provided_by_investing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | long_term_net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | short_term_net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_common_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | common_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | common_stock_repurchased | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_preferred_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | common_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | preferred_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | other_financing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_cash_provided_by_financing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | effect_of_forex_changes_on_cash | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | net_change_in_cash | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | cash_at_end_of_period | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | cash_at_beginning_of_period | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | capital_expenditure | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | free_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | income_taxes_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | interest_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_cash_flow | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_dcf | dcf | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_dcf | stock_price | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_earnings_surprises | eps_actual | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_earnings_surprises | eps_estimated | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | adj_close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | adj_open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | adj_high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | adj_low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | adj_pct_change | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_fund_price | volume | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | calendar_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | cost_of_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | gross_profit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | research_and_development_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | general_and_administrative_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | selling_and_marketing_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | other_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | selling_general_and_administrative_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | operating_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | cost_and_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | depreciation_and_amortization | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | operating_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | ebit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | non_operating_income_excluding_interest | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | net_interest_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | interest_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | interest_expense | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | total_other_income_expenses_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | income_before_tax | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | income_tax_expense | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | net_income_from_continuing_operations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | net_income_from_discontinued_operations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | other_adjustments_to_net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | net_income_deductions | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | bottom_line_net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | eps | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | eps_diluted | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | weighted_average_shs_out | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | weighted_average_shs_out_dil | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_income_statement | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | market_cap | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | enterprise_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | ev_to_sales | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | ev_to_operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | ev_to_free_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | ev_to_ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | net_debt_to_ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | current_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | income_quality | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | graham_number | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | graham_net_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | tax_burden | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | interest_burden | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | invested_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | return_on_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | operating_return_on_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | return_on_tangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | return_on_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | return_on_invested_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | return_on_capital_employed | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | earnings_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | free_cash_flow_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | capex_to_operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | capex_to_depreciation | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | capex_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | sales_general_and_administrative_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | research_and_developement_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | stock_based_compensation_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | intangibles_to_total_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | average_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | average_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | average_inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | days_of_sales_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | days_of_payables_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | days_of_inventory_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | operating_cycle | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | cash_conversion_cycle | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | free_cash_flow_to_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | free_cash_flow_to_firm | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | tangible_asset_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_key_metrics | net_current_asset_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | adj_close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | adj_open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | adj_high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | adj_low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | adj_pct_change | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_price | volume | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | gross_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | ebit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | ebitda_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | operating_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | pretax_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | continuous_operations_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | net_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | bottom_line_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | receivables_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | payables_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | inventory_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | fixed_asset_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | asset_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | current_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | quick_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | solvency_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | cash_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | price_to_earnings_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | price_to_earnings_growth_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | forward_price_to_earnings_growth_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | price_to_book_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | price_to_sales_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | price_to_free_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | price_to_operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | debt_to_assets_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | debt_to_equity_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | debt_to_capital_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | long_term_debt_to_capital_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | financial_leverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | working_capital_turnover_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | operating_cash_flow_sales_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | free_cash_flow_operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | debt_service_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | interest_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | short_term_operating_cash_flow_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | operating_cash_flow_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | capital_expenditure_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | dividend_paid_and_capex_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | dividend_payout_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | dividend_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | dividend_yield_percentage | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | revenue_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | net_income_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | interest_debt_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | cash_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | book_value_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | tangible_book_value_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | shareholders_equity_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | operating_cash_flow_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | capex_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | free_cash_flow_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | net_income_per_ebt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | ebt_per_ebit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | price_to_fair_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | debt_to_market_cap | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | effective_tax_rate | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_ratios | enterprise_value_multiple | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_stock_rating | rating | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_stock_rating | dcf_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_stock_rating | roe_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_stock_rating | roa_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_stock_rating | de_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_stock_rating | pe_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_stock_rating | pb_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| kr | kr_company_profile |  | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_analyst_consensus | strong_buy | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_analyst_consensus | buy | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_analyst_consensus | hold | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_analyst_consensus | sell | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_analyst_consensus | strong_sell | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_analyst_consensus | consensus | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | cash_and_cash_equivalents | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | short_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | cash_and_short_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | net_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | accounts_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | other_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | prepaids | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | other_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | property_plant_equipment_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | goodwill | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | intangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | goodwill_and_intangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | long_term_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | tax_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | other_non_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_non_current_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | other_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | account_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | other_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | accrued_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | short_term_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | capital_lease_obligations_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | tax_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | deferred_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | other_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | long_term_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | deferred_revenue_non_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | deferred_tax_liabilities_non_current | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | other_non_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_non_current_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | other_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | capital_lease_obligations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_liabilities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | treasury_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | preferred_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | common_stock | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | retained_earnings | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | additional_paid_in_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | accumulated_other_comprehensive_income_loss | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | other_total_stockholders_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_stockholders_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | minority_interest | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_liabilities_and_total_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | total_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | net_debt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_balance_sheet | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | depreciation_and_amortization | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | deferred_income_tax | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | stock_based_compensation | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | change_in_working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | accounts_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | accounts_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | other_working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | other_non_cash_items | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_cash_provided_by_operating_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | investments_in_property_plant_and_equipment | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | acquisitions_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | purchases_of_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | sales_maturities_of_investments | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | other_investing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_cash_provided_by_investing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | long_term_net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | short_term_net_debt_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_common_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | common_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | common_stock_repurchased | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_preferred_stock_issuance | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | common_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | preferred_dividends_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | other_financing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_cash_provided_by_financing_activities | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | effect_of_forex_changes_on_cash | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | net_change_in_cash | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | cash_at_end_of_period | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | cash_at_beginning_of_period | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | capital_expenditure | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | free_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | income_taxes_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | interest_paid | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_cash_flow | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_dcf | dcf | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_dcf | stock_price | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_earnings_surprises | eps_actual | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_earnings_surprises | eps_estimated | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | adj_close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | adj_open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | adj_high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | adj_low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | adj_pct_change | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_fund_price | volume | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | reported_currency | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | cik | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | filing_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | accepted_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | calendar_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | fiscal_year | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | cost_of_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | gross_profit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | research_and_development_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | general_and_administrative_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | selling_and_marketing_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | other_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | selling_general_and_administrative_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | operating_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | cost_and_expenses | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | depreciation_and_amortization | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | operating_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | ebit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | non_operating_income_excluding_interest | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | net_interest_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | interest_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | interest_expense | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | total_other_income_expenses_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | income_before_tax | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | income_tax_expense | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | net_income_from_continuing_operations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | net_income_from_discontinued_operations | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | other_adjustments_to_net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | net_income_deductions | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | bottom_line_net_income | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | eps | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | eps_diluted | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | weighted_average_shs_out | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | weighted_average_shs_out_dil | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_income_statement | original_date | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | market_cap | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | enterprise_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | ev_to_sales | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | ev_to_operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | ev_to_free_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | ev_to_ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | net_debt_to_ebitda | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | current_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | income_quality | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | graham_number | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | graham_net_net | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | tax_burden | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | interest_burden | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | working_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | invested_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | return_on_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | operating_return_on_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | return_on_tangible_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | return_on_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | return_on_invested_capital | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | return_on_capital_employed | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | earnings_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | free_cash_flow_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | capex_to_operating_cash_flow | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | capex_to_depreciation | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | capex_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | sales_general_and_administrative_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | research_and_developement_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | stock_based_compensation_to_revenue | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | intangibles_to_total_assets | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | average_receivables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | average_payables | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | average_inventory | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | days_of_sales_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | days_of_payables_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | days_of_inventory_outstanding | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | operating_cycle | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | cash_conversion_cycle | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | free_cash_flow_to_equity | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | free_cash_flow_to_firm | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | tangible_asset_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_key_metrics | net_current_asset_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | adj_close | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | adj_open | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | adj_high | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | adj_low | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | adj_pct_change | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_price | volume | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | gross_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | ebit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | ebitda_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | operating_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | pretax_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | continuous_operations_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | net_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | bottom_line_profit_margin | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | receivables_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | payables_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | inventory_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | fixed_asset_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | asset_turnover | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | current_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | quick_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | solvency_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | cash_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | price_to_earnings_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | price_to_earnings_growth_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | forward_price_to_earnings_growth_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | price_to_book_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | price_to_sales_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | price_to_free_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | price_to_operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | debt_to_assets_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | debt_to_equity_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | debt_to_capital_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | long_term_debt_to_capital_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | financial_leverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | working_capital_turnover_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | operating_cash_flow_sales_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | free_cash_flow_operating_cash_flow_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | debt_service_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | interest_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | short_term_operating_cash_flow_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | operating_cash_flow_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | capital_expenditure_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | dividend_paid_and_capex_coverage_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | dividend_payout_ratio | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | dividend_yield | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | dividend_yield_percentage | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | revenue_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | net_income_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | interest_debt_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | cash_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | book_value_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | tangible_book_value_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | shareholders_equity_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | operating_cash_flow_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | capex_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | free_cash_flow_per_share | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | net_income_per_ebt | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | ebt_per_ebit | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | price_to_fair_value | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | debt_to_market_cap | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | effective_tax_rate | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_ratios | enterprise_value_multiple | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_stock_rating | rating | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_stock_rating | dcf_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_stock_rating | roe_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_stock_rating | roa_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_stock_rating | de_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_stock_rating | pe_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_stock_rating | pb_score | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
| uk | uk_company_profile |  | non-US global market | P2 | benchmark | research | research_only | no | future global context, not V4 production core |
