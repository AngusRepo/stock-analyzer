import * as fs from 'fs'

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const migration = fs.readFileSync('migration_v4_3_d1_cost_indexes.sql', 'utf8')

for (const indexName of [
  'idx_canonical_market_date_stock',
  'idx_canonical_chip_date_segment_stock',
  'idx_canonical_revenue_month_stock',
  'idx_margin_data_date_stock',
  'idx_news_published_id',
  'idx_news_created_id',
]) {
  assert(
    migration.includes(`CREATE INDEX IF NOT EXISTS ${indexName}`),
    `D1 cost index migration must include ${indexName}`,
  )
}

assert(
  migration.includes('canonical_market_daily(date DESC, stock_id)') &&
    migration.includes('canonical_chip_daily(date DESC, market_segment, stock_id)') &&
    migration.includes('canonical_revenue_monthly(revenue_month DESC, stock_id)'),
  'canonical FinLab indexes must be date/month-first because canonical primary keys are stock-first',
)

assert(
  migration.includes('margin_data(date, stock_id)'),
  'margin_data must have a date-first index for snapshot, retention, and freshness scans',
)

assert(
  migration.includes('news(published_at DESC, id DESC)') &&
    migration.includes('news(created_at DESC, id DESC)'),
  'news must have time-first indexes for buzz and cleanup paths',
)
