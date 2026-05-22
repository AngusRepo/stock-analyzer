import type { Bindings } from '../types'
import { sendReportToChannels, type DiscordEmbed } from './notify'
import { formatPendingBuyBriefing } from './pendingBuyBriefingSummary'
import { buildPendingBuyStateSummary } from './pendingBuyStateSummary'
import { loadPendingBuySnapshot } from './pendingBuyStore'
import {
  readScoreV2Snapshot,
  serializeScoreV2Snapshot,
  type ScoreV2SnapshotSummary,
  type ScoreV2StorageRow,
} from './scoreV2Taxonomy'

function twDateToday(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A'
  const pct = (Number(value) * 100).toFixed(1)
  return Number(value) >= 0 ? `+${pct}%` : `${pct}%`
}

function fmtNumber(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A'
  return Number(value).toFixed(digits)
}

function safeParseJSON(value: string | null | undefined): any {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function hasScoreEvidence(row: Record<string, unknown>): boolean {
  return Boolean(row.score_components)
}

export function recommendationReportScoreV2(row: ScoreV2StorageRow): ScoreV2SnapshotSummary | null {
  if (!hasScoreEvidence(row as Record<string, unknown>)) return null
  const snapshot = readScoreV2Snapshot(row)
  return snapshot ? serializeScoreV2Snapshot(snapshot) : null
}

export function recommendationReportScore(row: ScoreV2StorageRow): number | null {
  return recommendationReportScoreV2(row)?.finalScore ?? null
}

function riskColor(level: string): number {
  const normalized = level.toLowerCase()
  if (['green', 'low'].includes(normalized)) return 0x2ecc71
  if (['yellow', 'medium'].includes(normalized)) return 0xf1c40f
  if (['orange', 'high'].includes(normalized)) return 0xe67e22
  if (['red', 'extreme'].includes(normalized)) return 0xe74c3c
  return 0x95a5a6
}

function riskLabel(level: string): string {
  const normalized = level.toLowerCase()
  if (['green', 'low'].includes(normalized)) return '低風險'
  if (['yellow', 'medium'].includes(normalized)) return '中性'
  if (['orange', 'high'].includes(normalized)) return '偏高風險'
  if (['red', 'extreme'].includes(normalized)) return '高風險'
  return level || '未知'
}

function directionLabel(direction: string | undefined): string {
  if (direction === 'up') return '看多'
  if (direction === 'down') return '看空'
  return '中性'
}

export async function generateDailyReport(env: Bindings): Promise<string> {
  const reportDate = twDateToday()
  const embeds: DiscordEmbed[] = []

  const risk = await env.DB.prepare(
    'SELECT risk_level, risk_score, risk_summary FROM market_risk WHERE date=?',
  ).bind(reportDate).first<any>().catch(() => null)
    ?? await env.DB.prepare(
      'SELECT risk_level, risk_score, risk_summary FROM market_risk ORDER BY date DESC LIMIT 1',
    ).first<any>()

  const us = await env.KV.get(`us:leading:${reportDate}`, 'json') as any
  const level = String(risk?.risk_level ?? 'medium')
  const usLine = us
    ? `SOX ${fmtPct(us.sox_return)} | S&P ${fmtPct(us.gspc_return)} | VIX ${fmtNumber(us.vix_close)} | DXY ${fmtPct(us.dxy_return)} | ${us.sentiment ?? 'N/A'}`
    : '尚未取得美股領先訊號'

  embeds.push({
    title: `StockVision 每日報告 ${reportDate}`,
    color: riskColor(level),
    fields: [
      { name: '市場風險', value: `${riskLabel(level)} (${risk?.risk_score ?? '?'}/100)`, inline: true },
      { name: '風險摘要', value: risk?.risk_summary ?? '尚無摘要', inline: false },
      { name: '美股/匯率背景', value: usLine, inline: false },
    ],
    timestamp: new Date().toISOString(),
  })

  const { results: signalCounts } = await env.DB.prepare(`
    SELECT trade_signal, COUNT(*) AS cnt, ROUND(AVG(direction_accuracy), 3) AS avg_conf
      FROM predictions
     WHERE model_name='ensemble'
       AND prediction_date=?
     GROUP BY trade_signal
  `).bind(reportDate).all<any>()

  const buyCount = signalCounts?.find((row: any) => row.trade_signal === 'buy')
  const holdCount = signalCounts?.find((row: any) => row.trade_signal === 'hold')
  const sellCount = signalCounts?.find((row: any) => row.trade_signal === 'sell')
  const totalStocks = (signalCounts ?? []).reduce((sum: number, row: any) => sum + Number(row.cnt ?? 0), 0)

  embeds.push({
    title: 'ML 訊號總覽',
    color: 0x3498db,
    description: `${totalStocks} 檔完成 ensemble 判斷，採 8 alpha models + state-space overlays 治理。`,
    fields: [
      { name: 'BUY', value: `${buyCount?.cnt ?? 0} 檔 | 平均信心 ${fmtPct(buyCount?.avg_conf)}`, inline: true },
      { name: 'HOLD', value: `${holdCount?.cnt ?? 0} 檔`, inline: true },
      { name: 'SELL', value: `${sellCount?.cnt ?? 0} 檔 | 平均信心 ${fmtPct(sellCount?.avg_conf)}`, inline: true },
    ],
  })

  const { results: buyStocks } = await env.DB.prepare(`
    SELECT s.symbol, s.name, p.direction_accuracy AS confidence,
           p.entry_price, p.stop_loss, p.target1, p.target2, p.forecast_data
      FROM predictions p
      JOIN stocks s ON p.stock_id=s.id
     WHERE p.model_name='ensemble'
       AND p.prediction_date=?
       AND p.trade_signal='buy'
     ORDER BY p.direction_accuracy DESC
     LIMIT 15
  `).bind(reportDate).all<any>()

  for (const stock of buyStocks ?? []) {
    const forecast = safeParseJSON(stock.forecast_data)
    const models = Array.isArray(forecast?.models) ? forecast.models : []
    const voteText = models.length
      ? models.map((model: any) => {
        const confidence = model.confidence != null ? fmtPct(model.confidence) : 'N/A'
        const weight = model.weight != null ? ` | weight=${fmtNumber(model.weight, 2)}` : ''
        return `${directionLabel(model.direction)} ${model.model ?? 'unknown'} | 信心 ${confidence}${weight}`
      }).join('\n')
      : '未提供模型投票明細'
    const metaLine = [
      forecast?.meta_learner_used ? 'Meta learner enabled' : '',
      forecast?.arf_correction ? `ARF: ${forecast.arf_correction}` : '',
    ].filter(Boolean).join(' | ') || 'Ensemble score'

    embeds.push({
      title: `BUY 候選 ${stock.symbol} ${stock.name}`,
      color: 0x2ecc71,
      fields: [
        { name: 'Ensemble', value: `${forecast?.signal ?? 'BUY'} | 信心 ${fmtPct(stock.confidence)}\n${metaLine}`, inline: false },
        { name: '價格計畫', value: `入場 ${stock.entry_price ?? 'N/A'}\n停損 ${stock.stop_loss ?? 'N/A'}\nT1 ${stock.target1 ?? 'N/A'} / T2 ${stock.target2 ?? 'N/A'}`, inline: true },
        { name: '模型投票', value: voteText.slice(0, 1000), inline: true },
      ],
    })
  }

  const { results: sellStocks } = await env.DB.prepare(`
    SELECT s.symbol, s.name, p.direction_accuracy AS confidence, p.forecast_data
      FROM predictions p
      JOIN stocks s ON p.stock_id=s.id
     WHERE p.model_name='ensemble'
       AND p.prediction_date=?
       AND p.trade_signal='sell'
     ORDER BY p.direction_accuracy DESC
     LIMIT 10
  `).bind(reportDate).all<any>()

  if (sellStocks?.length) {
    const sellText = sellStocks.map((stock: any) => {
      const models = safeParseJSON(stock.forecast_data)?.models ?? []
      const downCount = Array.isArray(models) ? models.filter((model: any) => model.direction === 'down').length : 0
      return `${stock.symbol} ${stock.name} | 信心 ${fmtPct(stock.confidence)} | ${downCount}/${models.length ?? 0} 看空`
    }).join('\n')
    embeds.push({ title: 'SELL / 風險提醒', color: 0xe74c3c, description: sellText })
  }

  const { results: recs } = await env.DB.prepare(`
    SELECT symbol, name, sector, signal, confidence, reason,
           score_components
      FROM daily_recommendations
     WHERE date=? AND has_buy_signal=1
     ORDER BY score DESC
  `).bind(reportDate).all<any>()

  if (recs?.length) {
    const recText = recs.slice(0, 15).map((row: any, index: number) => {
      const reason = String(row.reason ?? '').slice(0, 120) || '尚無理由'
      const scoreV2 = recommendationReportScoreV2(row)
      const scoreSource = scoreV2 ? 'Score V2' : 'Score V2 missing'
      return `${index + 1}. ${row.symbol} ${row.name} (${row.sector ?? '未分類'}) | ${scoreSource} ${fmtNumber(scoreV2?.finalScore)} | 信心 ${fmtPct(row.confidence)}\n${reason}`
    }).join('\n\n')
    embeds.push({ title: '每日推薦摘要', color: 0xf39c12, description: recText })
  }

  const snapshot = await env.DB.prepare(`
    SELECT total_value, cumulative_return, daily_return, max_drawdown, sharpe_30d, trade_count
      FROM paper_daily_snapshots
     WHERE date=?
     LIMIT 1
  `).bind(reportDate).first<any>().catch(() => null)

  if (snapshot) {
    embeds.push({
      title: 'Paper Trading 績效',
      color: Number(snapshot.cumulative_return ?? 0) >= 0 ? 0x27ae60 : 0xc0392b,
      fields: [
        { name: '總資產', value: `NT$${Math.round(snapshot.total_value ?? 0).toLocaleString()}`, inline: true },
        { name: '累積報酬', value: fmtPct(snapshot.cumulative_return), inline: true },
        { name: '日報酬', value: fmtPct(snapshot.daily_return), inline: true },
        { name: '最大回撤', value: snapshot.max_drawdown != null ? `${(Number(snapshot.max_drawdown) * 100).toFixed(1)}%` : 'N/A', inline: true },
        { name: 'Sharpe(30d)', value: snapshot.sharpe_30d?.toFixed(2) ?? 'N/A', inline: true },
        { name: '交易次數', value: `${snapshot.trade_count ?? 0}`, inline: true },
      ],
    })
  }

  const pendingSnapshot = await loadPendingBuySnapshot(env, reportDate, { allowFallbackRecent: false })
  const pendingState = buildPendingBuyStateSummary(pendingSnapshot.pendingBuys, pendingSnapshot.meta)
  embeds.push({
    title: 'Pending Buy State',
    color: pendingState.state === 'ready_to_execute' ? 0x2ecc71 : pendingState.state === 'closed' ? 0x95a5a6 : 0xf1c40f,
    description: formatPendingBuyBriefing(pendingSnapshot.pendingBuys, pendingState),
    fields: [
      { name: 'Active / Total', value: `${pendingState.active_count}/${pendingState.total_count}`, inline: true },
      { name: 'Debate', value: JSON.stringify(pendingState.debate_counts), inline: true },
      { name: 'Execution', value: JSON.stringify(pendingState.execution_counts), inline: true },
    ],
  })

  const { results: untaggedStocks } = await env.DB.prepare(`
    SELECT s.symbol, s.name
      FROM stocks s
     WHERE s.in_current_watchlist = 1
       AND NOT EXISTS (SELECT 1 FROM stock_tags t WHERE t.symbol = s.symbol)
     ORDER BY s.symbol
     LIMIT 20
  `).all<any>().catch(() => ({ results: [] as any[] }))

  if (untaggedStocks?.length) {
    const list = untaggedStocks.map((stock: any) => `${stock.symbol} ${stock.name}`).join('\n')
    embeds.push({
      title: `分類待補 ${untaggedStocks.length} 檔`,
      color: 0xe67e22,
      description: `這些候選股尚未有 stock_tags，會影響 sector/RRG/diversity 解釋：\n${list}`,
    })
  }

  const { results: themeFlows } = await env.DB.prepare(`
    SELECT sector, total_net, stock_count, quadrant, rs_ratio, rs_momentum
      FROM sector_flow
     WHERE date=? AND classification='theme'
     ORDER BY total_net DESC
  `).bind(reportDate).all<any>().catch(() => ({ results: [] as any[] }))

  embeds.push({
    description: '_StockVision ML Pipeline | 8 alpha models | state-space overlays | governed feature set_',
    color: 0x95a5a6,
    footer: { text: `StockVision v12 | ${totalStocks} stocks | ${reportDate}` },
  })

  try {
    await env.DB.prepare(`
      INSERT INTO stock_analysis_reports
        (date, report_type, market_summary, ml_overview, buy_details, sell_alerts, recommendations, performance, theme_flow)
      VALUES (?, 'daily', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, report_type) DO UPDATE SET
        market_summary=excluded.market_summary,
        ml_overview=excluded.ml_overview,
        buy_details=excluded.buy_details,
        sell_alerts=excluded.sell_alerts,
        recommendations=excluded.recommendations,
        performance=excluded.performance,
        theme_flow=excluded.theme_flow,
        created_at=datetime('now')
    `).bind(
      reportDate,
      JSON.stringify({
        risk_level: level,
        risk_score: risk?.risk_score,
        risk_summary: risk?.risk_summary,
        us_context: us ? { sox: us.sox_return, sp500: us.gspc_return, vix: us.vix_close, sentiment: us.sentiment } : null,
      }),
      JSON.stringify({
        total: totalStocks,
        buy_count: buyCount?.cnt ?? 0,
        hold_count: holdCount?.cnt ?? 0,
        sell_count: sellCount?.cnt ?? 0,
        buy_avg_conf: buyCount?.avg_conf,
        sell_avg_conf: sellCount?.avg_conf,
      }),
      JSON.stringify((buyStocks ?? []).map((stock: any) => ({
        symbol: stock.symbol,
        name: stock.name,
        confidence: stock.confidence,
        entry: stock.entry_price,
        stop: stock.stop_loss,
        target1: stock.target1,
        target2: stock.target2,
      }))),
      JSON.stringify((sellStocks ?? []).map((stock: any) => {
        const models = safeParseJSON(stock.forecast_data)?.models ?? []
        return {
          symbol: stock.symbol,
          name: stock.name,
          confidence: stock.confidence,
          down_count: Array.isArray(models) ? models.filter((model: any) => model.direction === 'down').length : 0,
          total_models: Array.isArray(models) ? models.length : 0,
        }
      })),
      JSON.stringify((recs ?? []).map((row: any) => {
        const scoreV2 = recommendationReportScoreV2(row)
        return {
          symbol: row.symbol,
          name: row.name,
          sector: row.sector,
          score: scoreV2?.finalScore ?? null,
          score_v2: scoreV2,
          confidence: row.confidence,
          reason: row.reason,
        }
      })),
      snapshot ? JSON.stringify({
        total_value: snapshot.total_value,
        cumulative_return: snapshot.cumulative_return,
        daily_return: snapshot.daily_return,
        max_drawdown: snapshot.max_drawdown,
        sharpe_30d: snapshot.sharpe_30d,
        trade_count: snapshot.trade_count,
      }) : null,
      JSON.stringify((themeFlows ?? []).slice(0, 20).map((flow: any) => ({
        sector: flow.sector,
        total_net: flow.total_net,
        stock_count: flow.stock_count,
        quadrant: flow.quadrant,
        rs_ratio: flow.rs_ratio,
        rs_momentum: flow.rs_momentum,
      }))),
    ).run()
    console.log(`[DailyReport] Persisted to D1 for ${reportDate}`)
  } catch (error) {
    console.warn(`[DailyReport] D1 persist failed: ${error}`)
  }

  const channel = await sendReportToChannels(env as any, embeds, `StockVision 每日報告 ${reportDate}`)
  return `daily report sent via ${channel}: ${buyStocks?.length ?? 0} BUY / ${sellStocks?.length ?? 0} SELL`
}
