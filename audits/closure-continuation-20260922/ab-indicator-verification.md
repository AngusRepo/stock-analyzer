# 2026-09-23 A/B allocation and indicator finalizer repair

- Source baseline: 6240714e095cc68ad7079663d5ab9ca194530a10.
- A/B model files: TabM (14), GNN (8), PatchTST (74), iTransformer (38) checkpoint tensors are byte-identical. Outer checksum differences are packaging/metadata, not different learned weights. The three tree artifact checksums also match. Actual recipe changes are price vs exogenous TimeXer and the B EV residual MLP.
- Frozen 9/22 allocation context: f19fac870fc25b33db07775956c1e874c915ae71599d05d23232e930fbb431b3. Local A allocation replay matched all recorded weights with maximum absolute error 0.
- B reused verified identical seven-model observations, ran only immutable B TimeXer inference (fc-01M3635TKGWA77H4ZQ7FZVE39A), then used production recommendation and allocator functions with the frozen account/history. No fitting. Redundant CPU inference canceled.
- ab-recommendations-0922.json contains the compact result and input/model checksums. This is retrospective research, no orders and no native NAV maturity credit. Weights are portfolio targets, not fills.
- Indicator runtime evidence: all four shards were done at the first 13:45Z watchdog check; six finalizer enqueues occurred at 20-minute intervals through15:25Z. D1 overload occurred at14:33:44Z. Finalizer errors retained a20-minute lease, while retries and watchdog consumed recovery budget. Handled completion/failure now releases only the owning lease; live finalizers suppress watchdog duplicates. Retries preserve first successful indicator completion time.
- Reward pagination uses a lexicographic tuple lower bound with existing indexes. Local230000-row fixture: identical1000 returned rows, median23.4655ms ->0.8734ms. Not a production latency claim.
- Verification: strategyAbRecommendations (including missing/corrupt cold data), indicatorFinalizeLease, indicatorQueueRecovery (including live lease with exhausted retry budget), strategyRewardMatureCompatibility, strategyFormalLabelerConsumerContract, strategySelectionEdgeV4Contract, eveningChainContract; Worker TypeScript;13 paired_nav_cold tests; frontend build.
- Ten-year storage remains incomplete: Learning historical readers and safe deletion eligibility are still unresolved. No general deletion enabled by this release.
- 9/22 original pipeline remains failed/late; a retrospective result cannot convert it into a successful prospective run.

## Published/readback verification
- Worker f9a4b352: version43e19f78-fa3f-4a2c-8ef5-ff2df1f551fd. Pages provenance f9a4b352 and deployment112a3bd4.
- Research archive POST200 and GET200; returned packet exactly equals the accepted local comparison. API latency0.328seconds for this read, not an SLA.
- Isolated React component verified with the real production-readback fixture:9 stock codes/weights, desktop and390px mobile, no overflow, B unavailable remains unavailable. The service token is not a Google primary-admin browser session; authenticated production UI end-to-end was not verified or bypassed.
- A/B execution-separation frontend contract, chart wiring,6 candidate comparison tests and13 native storage/sandbox tests passed. Native settlement and equity cases preserve all state/checksum/receipt fields.
- Two inherited source-string tests already fail against baseline6240714e: botDashboardStrategyPortfolioHealthContract expects absent strategy_portfolio_intelligence_health text; botDashboardPendingBuyPolicyContract expects absent 'L4 selected rows can enter pending buys.' text. Those baseline failures were not introduced or suppressed by this change.
- The native equivalence certificate is committed as a367795b; final ML-stack deployment verification follows in runtime receipt.
