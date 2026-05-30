export type R2Bucket = any

export type Bindings = {
  DB: D1Database
  KV: KVNamespace
  ARTIFACTS?: R2Bucket
  JWT_SECRET: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  ANTHROPIC_API_KEY: string
  GEMINI_API_KEY: string
  ML_SERVICE_URL: string
  UPDATE_QUEUE: Queue<UpdateQueueMsg>
  NEWS_QUEUE: Queue<UpdateQueueMsg>
  ML_QUEUE?:    Queue<any>       // Phase 4 移除（Phase 3 保留 UPDATE_QUEUE 使用）
  ENVIRONMENT: string
  // ML Controller (Cloud Run) — Phase 3 MVC
  ML_CONTROLLER_URL?: string
  ML_CONTROLLER_SECRET?: string
  // 管理員 Email（Bootstrap 第一個 admin，透過環境變數控制，不寫在 source code）
  ADMIN_EMAIL: string
  // Resend API Key（免費 100 封/天）
  RESEND_API_KEY: string
  // ML Service 服務間共享密鑰
  ML_SERVICE_SECRET?: string
  // 前端 Pages URL（精確 CORS 白名單）
  PAGES_ORIGIN?: string
  // AI Team 服務間共享 token（Paper Trading auth）
  STOCKVISION_AUTH_TOKEN?: string
  // Discord Webhook URL（Paper Trading 事件推送）
  DISCORD_WEBHOOK_URL?: string
  LINE_CHANNEL_ACCESS_TOKEN?: string
  LINE_USER_ID?: string
  // 本地 Cloudflare Tunnel URL（Claude Opus proxy，Max Plan 免費呼叫）
  LOCAL_TUNNEL_URL?: string
  // Shioaji 即時報價 Proxy（Cloud Run）
  SHIOAJI_PROXY_URL?: string
  DAILY_PRICE_SOURCE?: string
  FINLAB_DAILY_PRICE_PRIMARY_ENABLED?: string
  FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED?: string
  FINLAB_V4_BACKFILL_MODAL_TRIGGER_ENABLED?: string
  FINLAB_BACKFILL_YEARS?: string
  FINLAB_BACKFILL_CANONICAL_WINDOW_DAYS?: string
  FINLAB_BACKFILL_GCS_BUCKET?: string
  FINLAB_BACKFILL_GCS_PREFIX?: string
  FINLAB_BACKFILL_CANONICAL_START_DATE?: string
  FINLAB_BACKFILL_CANONICAL_END_DATE?: string
  FINLAB_BACKFILL_CANONICAL_DATASETS?: string
  FINLAB_BACKFILL_CANONICAL_LIMIT_PER_DATASET?: string
  FINLAB_BACKFILL_CANONICAL_D1_CHUNK_SIZE?: string
  FINLAB_BACKFILL_LANES?: string
  FINLAB_BACKFILL_SKIP_DIFF_COUNTS?: string
  FINLAB_DAILY_PRICE_CANONICAL_DATASETS?: string
  FINLAB_DAILY_PRICE_LANES?: string
  FINLAB_DAILY_PRICE_KEEP_DIFF_COUNTS?: string
  // FRED API Key（HY OAS 信用利差）
  FRED_API_KEY?: string
  // Cloudflare Workers AI binding
  AI?: any
}

export type Variables = {
  userId: number
  userEmail: string
  userRole: string
  userName: string
}

// ─── DB Row Types ─────────────────────────────────────────────────────────────
export interface DbUser {
  id: number
  google_id: string
  email: string
  name: string | null
  avatar: string | null
  role: 'user' | 'admin'
  approval_status: 'approved' | 'pending' | 'rejected'
  created_at: string
  last_login: string
}

export interface DbStock {
  id: number
  symbol: string
  name: string
  market: 'TWSE' | 'OTC' | 'US'
  sector: string | null
  in_current_watchlist: number
  added_at: string
  updated_at: string
}

export interface DbStockPrice {
  id: number
  stock_id: number
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  adj_close: number | null
  volume: number | null
}

export interface DbTechnicalIndicator {
  id: number
  stock_id: number
  date: string
  ma5: number | null; ma10: number | null; ma20: number | null; ma60: number | null
  rsi14: number | null
  macd: number | null; macd_signal: number | null; macd_hist: number | null
  atr14: number | null
  bb_upper: number | null; bb_mid: number | null; bb_lower: number | null
}

export interface DbFinancial {
  id: number
  stock_id: number
  period: string
  period_type: string
  revenue: number | null
  revenue_growth_yoy: number | null
  eps: number | null
  roe: number | null
  pe: number | null
  pb: number | null
  dividend_yield: number | null
  dividend_per_share: number | null
  book_value_per_share: number | null
  price_at_record: number | null
}

export interface DbChipData {
  id: number
  stock_id: number
  date: string
  foreign_net: number | null
  trust_net: number | null
  dealer_net: number | null
  margin_balance: number | null
  short_balance: number | null
}

export interface DbNews {
  id: number
  stock_id: number
  title: string
  summary: string | null
  url: string | null
  source: string | null
  sentiment: 'positive' | 'neutral' | 'negative'
  published_at: string
}

export interface DbPrediction {
  id: number
  stock_id: number
  model_name: string
  generated_at: string
  horizon: number
  rmse: number | null
  mape: number | null
  direction_accuracy: number | null
  best_model: number
  forecast_data: string | null
  entry_price: number | null
  stop_loss: number | null
  target1: number | null
  target2: number | null
  trade_signal: 'buy' | 'sell' | 'hold'
}

export interface DbFactorScore {
  id: number
  stock_id: number
  date: string
  composite_score: number | null
  quantile: number | null
  z_momentum: number | null
  z_value: number | null
  z_quality: number | null
}

export interface DbRiskMetric {
  id: number
  stock_id: number
  period: string
  sharpe_ratio: number | null
  sortino_ratio: number | null
  beta: number | null
  max_drawdown: number | null
  var95: number | null
  cvar95: number | null
  annual_return: number | null
  annual_volatility: number | null
}

// ─── Paper Trading DB Types ───────────────────────────────────────────────────
export interface DbPaperAccount {
  id: number
  name: string
  cash: number
  initial_cash: number
  created_at: string
  updated_at: string
}

export interface DbPaperOrder {
  id: number
  account_id: number
  symbol: string
  name: string
  side: 'buy' | 'sell'
  shares: number
  price: number
  commission: number
  tax: number
  total_cost: number
  source: string
  signal: string | null
  confidence: number | null
  note: string | null
  created_at: string
}

export interface DbPaperPosition {
  id: number
  account_id: number
  symbol: string
  name: string
  shares: number
  avg_cost: number
  updated_at: string
}

export interface DbPaperDailySnapshot {
  id: number
  account_id: number
  date: string
  cash: number
  positions_value: number
  total_value: number
  pnl: number
  pnl_pct: number
  created_at: string
}

export interface DbAlertRule {
  id: number
  user_id: number
  stock_id: number
  rule_type: string
  threshold: number | null
  is_active: number
  last_triggered: string | null
}

// ─── Queue Message Types ──────────────────────────────────────────────────────
export interface UpdateQueueMsg {
  type: 'update_batch' | 'finalize_update' | 'post_screener_pipeline' | 'news_batch' | 'source_readiness_retry'
  newsStocks?: Array<{
    id: number
    symbol: string
    market?: string | null
    name?: string | null
    in_current_watchlist?: number | null
  }>
  cursor: number      // 從哪個 stock_id 繼續；finalize_update 固定 0
  triggerTime: string // 原始觸發時間，防止跨天的 cursor 汙染
  runId?: string      // 同一次 queue fan-out 的識別碼
  shardIndex?: number // 多 shard 平行更新時的 shard index
  shardCount?: number // 多 shard 平行更新時的總 shard 數
  attempt?: number    // finalize watchdog retry count
}

// MLQueueMsg removed in Phase 3 — ML batch predict now goes through Controller
