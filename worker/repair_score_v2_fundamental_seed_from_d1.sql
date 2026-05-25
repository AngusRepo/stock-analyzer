-- Score V2 Phase 5 production seed repair.
--
-- Purpose:
--   Populate canonical_fundamental_features from existing D1 structured data so
--   Score V2 fundamentalQuality can leave zero while the paid FinLab factor map
--   is finalized.
--
-- Safety:
--   - INSERT OR REPLACE into canonical_fundamental_features only.
--   - No DROP/DELETE/UPDATE/TRUNCATE.
--   - source='d1.financials_seed' keeps these rows separate from future
--     source='finlab.fundamental_features' rows.
--   - available_date is no-lookahead guarded as max(quarter_end + 60 days,
--     financials.created_at date) and must be <= date('now').

INSERT OR REPLACE INTO canonical_fundamental_features (
  stock_id,
  period,
  market_segment,
  report_date,
  available_date,
  revenue_growth_yoy,
  gross_margin,
  operating_margin,
  roe,
  eps,
  pe,
  pb,
  dividend_yield,
  debt_ratio,
  current_ratio,
  operating_cash_flow,
  industry_quality_percentile,
  source,
  lineage_json,
  as_of_date
)
WITH quarterly AS (
  SELECT
    CAST(f.stock_id AS TEXT) AS stock_symbol,
    f.period,
    f.revenue,
    f.revenue_growth_yoy,
    f.eps,
    f.roe,
    f.pe,
    f.pb,
    f.dividend_yield,
    f.operating_income,
    f.total_assets,
    f.total_liabilities,
    date(
      substr(f.period, 1, 4) ||
      CASE substr(f.period, 6, 1)
        WHEN '1' THEN '-03-31'
        WHEN '2' THEN '-06-30'
        WHEN '3' THEN '-09-30'
        WHEN '4' THEN '-12-31'
      END
    ) AS quarter_end_date,
    date(f.created_at) AS d1_created_date
  FROM financials f
  WHERE f.period_type = 'quarterly'
    AND f.period GLOB '[0-9][0-9][0-9][0-9]Q[1-4]'
),
latest_revenue AS (
  SELECT
    stock_id,
    market_segment,
    yoy,
    revenue_month,
    ROW_NUMBER() OVER (
      PARTITION BY stock_id
      ORDER BY revenue_month DESC
    ) AS rn
  FROM canonical_revenue_monthly
),
computed AS (
  SELECT
    q.stock_symbol AS stock_id,
    q.period,
    lr.market_segment,
    q.quarter_end_date AS report_date,
    CASE
      WHEN q.d1_created_date IS NOT NULL
       AND q.d1_created_date > date(q.quarter_end_date, '+60 days')
      THEN q.d1_created_date
      ELSE date(q.quarter_end_date, '+60 days')
    END AS available_date,
    COALESCE(q.revenue_growth_yoy, lr.yoy) AS revenue_growth_yoy,
    NULL AS gross_margin,
    CASE
      WHEN q.revenue IS NOT NULL AND q.revenue > 0 AND q.operating_income IS NOT NULL
      THEN ROUND(q.operating_income * 100.0 / q.revenue, 4)
      ELSE NULL
    END AS operating_margin,
    q.roe,
    q.eps,
    q.pe,
    q.pb,
    q.dividend_yield,
    CASE
      WHEN q.total_assets IS NOT NULL AND q.total_assets > 0 AND q.total_liabilities IS NOT NULL
      THEN ROUND(q.total_liabilities * 100.0 / q.total_assets, 4)
      ELSE NULL
    END AS debt_ratio,
    NULL AS current_ratio,
    NULL AS operating_cash_flow,
    NULL AS industry_quality_percentile,
    json_object(
      'schema_version', 'score-v2-fundamental-seed-v1',
      'source_table', 'financials',
      'revenue_source_table', 'canonical_revenue_monthly',
      'source_period', q.period,
      'latest_revenue_month', lr.revenue_month,
      'no_lookahead', 'available_date=max(quarter_end+60d, financials.created_at_date)'
    ) AS lineage_json
  FROM quarterly q
  LEFT JOIN latest_revenue lr
    ON lr.stock_id = q.stock_symbol
   AND lr.rn = 1
  WHERE q.quarter_end_date IS NOT NULL
)
SELECT
  stock_id,
  period,
  market_segment,
  report_date,
  available_date,
  revenue_growth_yoy,
  gross_margin,
  operating_margin,
  roe,
  eps,
  pe,
  pb,
  dividend_yield,
  debt_ratio,
  current_ratio,
  operating_cash_flow,
  industry_quality_percentile,
  'd1.financials_seed' AS source,
  lineage_json,
  date('now') AS as_of_date
FROM computed
WHERE available_date <= date('now');
