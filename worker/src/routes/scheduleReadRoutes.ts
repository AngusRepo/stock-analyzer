import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'

export const scheduleReadRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

scheduleReadRoutes.get('/api/cron/schedule', (c) => {
  const schedule = [
    { task: 'us-leading', tw_time: '06:30', description: '美股與期貨領先訊號整理' },
    { task: 'news-analyst', tw_time: '06:45', description: '新聞與事件摘要，不直接下單' },
    { task: 'morning-setup', tw_time: '07:15', description: '產生 debate 後的 pending buys' },
    { task: 'morning-briefing', tw_time: '07:50', description: '輸出 morning briefing 與通知' },
    { task: 'pre-market-warmup', tw_time: '08:50', description: '盤前 quote / pending buy debate finalize' },
    { task: 'intraday-check', tw_time: '09:00-13:30', description: '盤中 quote sanity、掛單與持倉監控' },
    { task: 'eod-exit', tw_time: '13:25', description: '收盤前停利停損與 EOD exit 檢查' },
    { task: 'daily-snapshot', tw_time: '14:20', description: 'paper account / position / PnL snapshot' },
    { task: 'ml-warmup', tw_time: '17:30 chain', description: 'Evening chain warmup，不是 production 決策 owner' },
    { task: 'market-data-update', tw_time: '17:30 chain', description: '更新價格、籌碼、技術指標與 snapshot manifest' },
    { task: 'screener', tw_time: '17:30 chain', description: '更新 screener seed 與上市櫃 / 興櫃分流' },
    { task: 'regime-compute', tw_time: 'before pipeline', description: 'HMM regime 必須先寫入 ml:regime，pipeline 才能啟動' },
    { task: 'pipeline', tw_time: 'after readiness', description: 'LangGraph pipeline v2；只在 data / screener / regime ready 後執行' },
    { task: 'ml-predict', tw_time: 'after pipeline', description: '批次 ML prediction 與 ensemble merge' },
    { task: 'recommendation', tw_time: 'after ml-predict', description: '產生 daily recommendations，不產生 pending buys' },
    { task: 'verify-v2', tw_time: 'post-pipeline', description: 'Verify v2 feedback pipeline' },
    { task: 'adapt', tw_time: '18:20 / weekly closure', description: 'Adaptive params 與 GA / LinUCB evidence closure' },
    { task: 'daily-report', tw_time: '18:25', description: '每日風險與交易摘要' },
    { task: 'weekly-audit', tw_time: 'weekly', description: 'Weekly audit report' },
    { task: 'obsidian-daily', tw_time: '18:40', description: 'Obsidian daily notes + progress sync' },
    { task: 'model-ic-tracker', tw_time: 'after verify', description: 'Model IC tracker 與 live gate evidence' },
    { task: 'weekly-cleanup', tw_time: 'weekly', description: 'D1 / KV / runtime cleanup + lifecycle check；不 retrain' },
    { task: 'weekly-backtest', tw_time: 'weekly', description: 'Lightweight validation：Backtest + Monte Carlo + PBO' },
    { task: 'alpha-quality', tw_time: 'weekly', description: 'Alpha bucket / regime quality monitor' },
    { task: 'weekly-optuna', tw_time: 'weekly', description: '受控 parallelism 的 weekly Optuna / GA calibration' },
    { task: 'optuna-queue', tw_time: 'queue-driven', description: '只處理已入 queue 的 Optuna item' },
  ]

  return c.json({ schedule })
})
