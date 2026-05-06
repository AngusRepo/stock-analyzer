import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'

export const scheduleReadRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

scheduleReadRoutes.get('/api/cron/schedule', (c) => {
  const schedule = [
    { task: 'us-leading', tw_time: '06:30', description: '美股與國際領先訊號' },
    { task: 'news-analyst', tw_time: '06:45', description: '每日新聞偏向與風險摘要' },
    { task: 'morning-setup', tw_time: '07:15', description: '建立 pending buys，等待 morning debate' },
    { task: 'morning-briefing', tw_time: '07:50', description: '發送早盤 briefing 到 Discord' },
    { task: 'pre-market-warmup', tw_time: '08:50', description: '控制平面健康檢查與 pending buy debate finalize' },
    { task: 'intraday-check', tw_time: '09:00-13:30', description: '盤中限價買入與停損停利檢查' },
    { task: 'eod-exit', tw_time: '13:25', description: '收盤前出場檢查' },
    { task: 'daily-snapshot', tw_time: '14:20', description: '每日 paper account / position / PnL snapshot' },
    { task: 'ml-warmup', tw_time: '17:15', description: 'ML Controller health warmup' },
    { task: 'pipeline', tw_time: '17:30', description: 'LangGraph pipeline v2：fetch / screener / ML / recommendation / verify' },
    { task: 'adapt', tw_time: '18:20', description: 'Adaptive params 更新' },
    { task: 'daily-report', tw_time: '18:25', description: '每日報告與 risk trigger 檢查' },
    { task: 'weekly-audit', tw_time: '週五 18:30', description: 'Weekly audit report' },
    { task: 'obsidian-daily', tw_time: '18:40', description: 'Obsidian daily notes + progress sync' },
    { task: 'regime-compute', tw_time: '18:50', description: 'HMM regime compute' },
    { task: 'verify-v2', tw_time: '19:00', description: 'Verify v2 feedback pipeline' },
    { task: 'model-ic-tracker', tw_time: '週五 19:30', description: 'Model IC tracker 與 promotion gate' },
    { task: 'weekly-cleanup', tw_time: '週日 04:00', description: 'D1 / KV / runtime cleanup + retrain bundle' },
    { task: 'weekly-backtest', tw_time: '週日 06:00', description: 'Backtest + Monte Carlo + PBO' },
    { task: 'alpha-quality', tw_time: '週日 06:00', description: 'Alpha bucket / regime quality monitor' },
    { task: 'weekly-optuna', tw_time: '週日 06:30', description: 'Weekly Optuna parameter search' },
    { task: 'optuna-queue', tw_time: '每 6 小時', description: '處理 Optuna queue 中的待執行項目' },
  ]

  return c.json({ schedule })
})
