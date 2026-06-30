ALTER TABLE canonical_revenue_monthly ADD COLUMN previous_month_revenue REAL;
ALTER TABLE canonical_revenue_monthly ADD COLUMN last_year_month_revenue REAL;
ALTER TABLE canonical_revenue_monthly ADD COLUMN cumulative_revenue REAL;
ALTER TABLE canonical_revenue_monthly ADD COLUMN last_year_cumulative_revenue REAL;
ALTER TABLE canonical_revenue_monthly ADD COLUMN previous_comparison_pct REAL;
