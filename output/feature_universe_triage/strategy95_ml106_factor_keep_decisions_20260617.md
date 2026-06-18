# Strategy95 + ML106 Factor Keep Decisions

- total registered rows: 201
- current eligible candidates: 179
- policy: remove high-overlap duplicates only; do not pre-filter by Sharpe/CAGR/MDD before feature selection or pymoo/novelty.

| pool | feature | Sharpe | CAGR | MDD | corr | status | reason_code |
|---|---|---:|---:|---:|---:|---|---|
| ml106 | `atr14` | 1.669697 | 62.11% | -14.83% | 0.994128 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `bb_upper_raw` | 1.444791 | 51.27% | -15.12% | 0.907507 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `vwap_5d` | 1.376625 | 47.62% | -14.32% | 0.896557 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `WVMA` | 1.339321 | 46.26% | -14.97% | 0.897994 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `bb_lower_raw` | 1.321299 | 46.16% | -13.46% | 0.872051 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `margin_balance` | 1.226963 | 50.64% | -21.26% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `macdHist` | 1.163388 | 34.14% | -27.70% | 0.992777 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `VSTD_10` | 1.122306 | 45.21% | -29.88% | 0.758148 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `BETA_20` | 1.117169 | 42.56% | -30.10% | 0.879272 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `linear_factor` | 1.106196 | 18.55% | -17.40% | 0.632098 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `CNTP_20` | 1.099234 | 30.59% | -25.39% | 0.772944 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `RSQR_20` | 1.036054 | 19.98% | -18.16% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `VSTD_20` | 0.986393 | 37.78% | -38.57% | 0.767830 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `margin_change_5d_ts` | 0.982293 | 17.50% | -12.93% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `CNTD_20` | 0.980732 | 24.73% | -25.63% | 0.699252 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `dealer_5d` | 0.970931 | 28.94% | -20.93% | 0.989554 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `RESI_5` | 0.935718 | 26.43% | -36.23% | 0.669808 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `BETA_10` | 0.912285 | 27.13% | -34.18% | 0.859545 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `foreign_5d` | 0.900288 | 25.11% | -32.64% | 0.680631 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `BETA_60` | 0.896890 | 30.88% | -36.71% | 0.783834 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `KMID` | 0.894774 | 24.83% | -33.53% | 0.707255 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `rsi5_dulling` | 0.888052 | 20.60% | -27.43% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `dealer_ratio_5d` | 0.883238 | 18.07% | -11.70% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `rsi14` | 0.859142 | 23.75% | -24.00% | 0.999393 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `chip_5d` | 0.858789 | 24.39% | -34.27% | 0.717882 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `return_1d` | 0.828110 | 21.24% | -25.69% | 0.832578 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `institutional_net` | 0.802818 | 19.22% | -29.74% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `RESI_20` | 0.753592 | 25.30% | -41.05% | 0.769171 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `bb_position` | 0.712218 | 14.84% | -27.58% | 0.999944 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `RESI_10` | 0.696141 | 20.16% | -34.02% | 0.743458 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `RSQR_60` | 0.659179 | 14.46% | -19.05% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `vwap_bias` | 0.654828 | 18.59% | -45.15% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `IMXD_20` | 0.617580 | 14.99% | -28.00% | 0.741112 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `RESI_60` | 0.616139 | 19.34% | -44.10% | 0.782814 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `KLEN` | 0.606869 | 17.05% | -38.74% | 0.667004 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `IMIN_20` | 0.602873 | 10.60% | -18.27% | 0.627137 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `KSFT` | 0.601646 | 15.90% | -46.77% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `vwap_bias_5d` | 0.596290 | 15.67% | -39.67% | 0.942783 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `RSQR_10` | 0.549232 | 10.64% | -12.66% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `KLOW` | 0.520836 | 11.51% | -29.92% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `vol_ratio_20d` | 0.517039 | 7.48% | -13.28% | 0.737587 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `KUP` | 0.504293 | 13.23% | -36.24% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `ma5_bias` | 0.492591 | 12.35% | -44.93% | 0.954574 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `keltner_position` | 0.476744 | 11.08% | -32.76% | 0.970339 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `KUP2` | 0.464293 | 7.51% | -19.78% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `CNTP_5` | 0.451656 | 10.36% | -24.81% | 0.637020 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `BETA_5` | 0.450158 | 11.58% | -45.41% | 0.867898 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `CORR_10` | 0.405964 | 6.30% | -21.56% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `ma10_bias` | 0.392417 | 9.47% | -38.63% | 0.961527 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `CNTD_5` | 0.378087 | 8.41% | -24.88% | 0.636038 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `return_3d` | 0.343043 | 7.63% | -30.00% | 0.788181 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `ma20_bias` | 0.336626 | 7.58% | -26.91% | 0.811253 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `volatility_5d` | 0.325325 | 6.95% | -20.06% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `CNTP_10` | 0.319404 | 7.12% | -26.24% | 0.900998 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `vol_ratio_5d` | 0.317761 | 5.02% | -19.03% | 0.942353 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `CNTN_20` | 0.288667 | 5.31% | -12.79% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `CORD_10` | 0.270996 | 5.27% | -22.98% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `CNTD_10` | 0.237917 | 5.04% | -32.85% | 0.817282 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `margin_ratio` | 0.220730 | 4.18% | -21.53% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `short_squeeze_proxy` | 0.191591 | 3.58% | -44.32% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `volatility_20d` | 0.158612 | 3.33% | -40.73% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `CNTN_5` | 0.044269 | 1.58% | -24.26% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `ma60_bias` | 0.017353 | -0.23% | -36.54% | 0.758394 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `RSQR_5` | -0.002095 | -0.09% | -39.03% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `return_10d` | -0.006059 | -1.49% | -35.43% | 0.826088 | alias | ml106_alias_high_overlap_to_strategy95_not_active_candidate |
| ml106 | `return_5d` | -0.039206 | -1.13% | -33.77% | 0.785783 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `short_change_5d` | -0.068341 | -0.74% | -27.64% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `KLOW2` | -0.079895 | 0.63% | -13.61% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `KMID2` | -0.184554 | -1.03% | -20.23% | 0.669663 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `IMAX_20` | -0.185556 | -2.80% | -42.15% | 0.635959 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `CNTN_10` | -0.195648 | -2.60% | -27.85% | 0.623756 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `adl_trend_numeric` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `adl_value` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `advance_ratio` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `avg_volume_bucket` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `bull_alignment_pct` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `foreign_consecutive_sell` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `foreign_net_5d_market` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `has_sentiment` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `limit_down_count` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `limit_down_pct` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `margin_change_5d` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `market_bias_20d` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `market_cap_bucket` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `market_return_1d` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `market_return_5d` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `market_risk_level` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `market_risk_score` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `retail_pct` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `revenue_yoy` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `sector_encoded` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `sector_peer_return_1d` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `sector_peer_return_5d` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `sentiment` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `sentiment_3d` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `short_ratio` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `stock_vs_sector` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `us_dxy_return` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `us_gspc_return` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `us_hy_spread` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `us_hy_spread_chg` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `us_sentiment_score` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `us_sox_return` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `us_vix` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `stock_vs_market` | -0.314719 | -3.01% | -26.97% | 0.707826 | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| ml106 | `KSFT2` | -0.741151 | -6.60% | -21.94% |  | candidate | ml106_supplement_keep_after_cross_pool_dedupe |
| strategy95 | `size_log_mktcap` | 1.761839 | 45.22% | -8.29% | 0.560976 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_atr_14` | 1.624492 | 58.85% | -14.83% | 0.994128 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `val_sp` | 1.566795 | 31.71% | -12.43% | 0.229842 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_brokerNetAmount5d` | 1.537327 | 53.60% | -13.59% | 0.494702 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_hl52` | 1.528967 | 40.28% | -26.65% | 0.605973 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_macd_trend_10` | 1.451122 | 50.59% | -24.25% | 0.753522 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `liq_amihud_21d` | 1.389454 | 42.30% | -20.47% | 0.767830 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_dma_10_50` | 1.387178 | 48.72% | -25.41% | 0.723711 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_eps` | 1.384570 | 40.86% | -11.67% | 0.691406 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `vol_share_turnover_21d` | 1.318524 | 45.93% | -30.90% | 0.762401 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `vola_cv_90d` | 1.287991 | 51.34% | -34.14% | 0.555516 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_reversal_6m` | 1.248047 | 40.35% | -32.68% | 0.579270 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_close_to_52w_high` | 1.197085 | 26.76% | -23.90% | 0.519934 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_trix_12` | 1.195942 | 43.76% | -23.45% | 0.800764 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_squeezeMomentum` | 1.188171 | 39.07% | -29.13% | 0.832133 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_macdHist` | 1.177486 | 34.54% | -27.32% | 0.992777 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_9m` | 1.169341 | 41.47% | -34.43% | 0.464161 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_mtm_10` | 1.155349 | 36.72% | -25.07% | 0.777310 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_ma50_200_ratio` | 1.152921 | 33.82% | -40.86% | 0.477745 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_emv_14` | 1.139119 | 38.09% | -16.93% | 0.569074 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_vol_adj_12m` | 1.121496 | 37.86% | -35.18% | 0.418358 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_roe` | 1.116157 | 25.80% | -25.26% | 0.573686 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_foreignTrustNet5d` | 1.105985 | 27.79% | -18.55% | 0.717882 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_reversal_1m` | 1.094517 | 32.62% | -25.20% | 0.850436 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_brokerConcentration` | 1.087945 | 24.13% | -12.20% | 0.556578 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_volumeMomentumDivergence132710` | 1.078882 | 30.75% | -29.74% | 0.314754 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_granville_score` | 1.074795 | 35.10% | -45.65% | 0.320789 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_closeAboveMa60Pct` | 1.067961 | 34.40% | -40.18% | 0.783834 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_revenueGrowthYoY` | 1.042526 | 23.10% | -23.88% | 0.182032 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_sectorTurnoverShareDelta` | 0.991763 | 31.27% | -26.05% | 0.129587 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_return20d` | 0.988715 | 33.75% | -35.38% | 0.879272 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_dealerNet5d` | 0.966359 | 28.76% | -20.93% | 0.989554 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `val_bp` | 0.960608 | 33.45% | -23.38% | 0.697575 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_slow_kd_14` | 0.943802 | 26.86% | -19.64% | 0.876376 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_roc_10` | 0.939215 | 30.84% | -38.64% | 0.859545 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_ma_convergence` | 0.938777 | 30.11% | -28.55% | 0.584500 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_12m_1m` | 0.916037 | 29.88% | -25.73% | 0.316039 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `mom_rsi_14` | 0.897542 | 25.13% | -26.62% | 0.999393 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_cmo_14` | 0.897542 | 25.13% | -26.62% | 0.999393 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_adx_14` | 0.895103 | 23.09% | -28.68% | 0.344297 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_kd9_k` | 0.891340 | 24.76% | -29.68% | 0.827449 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_bestFvgStrength` | 0.862161 | 22.07% | -43.58% | 0.437796 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_obv` | 0.852430 | 20.36% | -29.93% | 0.593554 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `vol_money_flow_5d` | 0.822708 | 24.06% | -39.24% | 0.954574 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_bbBandwidthPct` | 0.811167 | 25.82% | -37.40% | 0.595918 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_monthlyRevenueMoM` | 0.811051 | 17.64% | -26.10% | 0.134952 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_williams_r_14` | 0.795133 | 16.98% | -23.84% | 0.868186 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_keltner_pos_20` | 0.789413 | 20.92% | -30.07% | 0.970339 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_vr_26` | 0.776538 | 20.12% | -33.13% | 0.608571 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_bias_20` | 0.755247 | 22.41% | -34.98% | 0.945089 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_sma_20_pos` | 0.755247 | 22.41% | -34.98% | 0.945089 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_bestOrderBlockStrength` | 0.726727 | 19.52% | -38.70% | 0.829664 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_bbands_pctb_20` | 0.721127 | 14.84% | -27.75% | 0.999944 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_donchian_pos_20` | 0.720112 | 16.45% | -29.88% | 0.910774 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_bbi` | 0.715048 | 20.48% | -42.72% | 0.932619 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_bosBullish` | 0.704578 | 17.16% | -33.47% | 0.341837 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_displacementPct` | 0.697023 | 19.92% | -41.80% | 0.832578 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_smcNetScore` | 0.691111 | 17.63% | -35.00% | 0.686871 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_locked_open_up_10` | 0.673263 | 13.67% | -17.30% | 0.085369 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_limit_up_streak_10` | 0.672769 | 19.60% | -37.62% | 0.332949 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_sectorRsRatio` | 0.650434 | 17.18% | -20.56% | 0.292651 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_bullish_streak_5` | 0.627465 | 11.75% | -19.95% | 0.594421 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_psy_12` | 0.625398 | 14.71% | -26.64% | 0.900998 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_diTrend` | 0.617437 | 15.26% | -28.87% | 0.811991 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_ema_12_pos` | 0.614151 | 16.78% | -40.26% | 0.944142 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_smcBullishScore` | 0.612255 | 15.46% | -39.55% | 0.823187 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_gap_up` | 0.583947 | 12.28% | -26.33% | 0.228006 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `vol_cv_volprice_20d` | 0.570571 | 9.97% | -20.36% | 0.366385 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_sectorFlowCore` | 0.565218 | 13.77% | -33.75% | 0.214197 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `vola_realized_12m` | 0.504057 | 11.57% | -25.71% | 0.572280 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_sar` | 0.496717 | 12.82% | -40.81% | 0.784036 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_limit_down_count_10` | 0.489162 | 14.12% | -46.41% | 0.132009 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `vola_min_130d` | 0.484705 | 4.47% | -5.75% | 0.394072 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_kdj_j_9` | 0.465468 | 9.56% | -32.94% | 0.838437 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_wma_10_pos` | 0.460121 | 11.94% | -38.58% | 0.961527 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_sectorRsMomentum` | 0.408743 | 9.93% | -28.09% | 0.242066 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_cci_20` | 0.383627 | 8.16% | -33.20% | 0.976723 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `vola_realized_1m` | 0.318364 | 7.48% | -39.79% | 0.667004 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_monthlyRevenueYoY` | 0.299080 | 6.93% | -42.03% | 0.195823 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_volumeExpansion20` | 0.298814 | 6.91% | -26.36% | 0.538497 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_volume_ratio_5` | 0.293427 | 6.38% | -32.47% | 0.942353 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_mfi_14` | 0.292498 | 6.51% | -31.58% | 0.788998 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_disposal_active` | 0.223350 | 4.71% | -46.12% | 0.109857 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `vol_signal_5d` | 0.207664 | 4.27% | -28.16% | 0.509531 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_squeezeRelease` | 0.132016 | 2.93% | -25.11% | 0.074945 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_locked_open_down_10` | 0.095260 | 2.33% | -21.91% | 0.068510 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `vol_chg_turnover_1y` | 0.083406 | 0.90% | -43.47% | 0.492478 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_chochBullish` | 0.015349 | 1.64% | -16.97% | 0.278795 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `val_ep` | -0.081939 | -1.04% | -26.59% | 0.232679 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_gap_down` | -0.132703 | 0.32% | -15.22% | 0.180814 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_liquiditySweepBullish` | -0.153634 | 0.05% | -15.88% | 0.166597 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_brokerCount` | -0.232864 | -0.74% | -18.05% | 0.767160 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `tech_tower_3` | -0.243894 | -0.90% | -18.95% | 0.611636 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `val_dp` | -0.244621 | -2.31% | -31.03% | 0.308197 | candidate | strategy95_base_keep_all_selection_owned_downstream |
| strategy95 | `l1_smcBiasBearish` | -0.358268 | -2.63% | -24.59% | 0.719201 | candidate | strategy95_base_keep_all_selection_owned_downstream |