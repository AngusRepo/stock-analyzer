/**
 * dailyReport.ts — 收盤完整報告推送
 *
 * 16:10 TW 執行（所有 Pipeline 完成後），整合：
 *   1. 大盤環境 + 美股 context
 *   2. ML 預測總覽（BUY/HOLD/SELL 分佈）
 *   3. BUY 明細 — 每支含 alpha model 投票 + LinUCB/ARF 修正
 *   4. SELL 警示 — 同上
 *   5. 推薦名單 + 理由
 *   6. 帳戶績效
 * 推送到 Discord Embeds（完整版）。
 */

import type { Bindings } from '../types'
import { sendReportToChannels, type DiscordEmbed } from './notify'
import { formatPendingBuyBriefing } from './pendingBuyBriefingSummary'
import { buildPendingBuyStateSummary } from './pendingBuyStateSummary'
import { loadPendingBuySnapshot } from './pendingBuyStore'

export async function generateDailyReport(env: Bindings): Promise<string> {
  const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const embeds: DiscordEmbed[] = []

  // ── 1. 大盤環境 ──────────────────────────────────────────────────────────
  const risk = await env.DB.prepare(
    'SELECT risk_level, risk_score, risk_summary FROM market_risk WHERE date=?'
  ).bind(twToday).first<any>().catch(() => null)
    ?? await env.DB.prepare('SELECT risk_level, risk_score, risk_summary FROM market_risk ORDER BY date DESC LIMIT 1').first<any>()

  const us = await env.KV.get(`us:leading:${twToday}`, 'json') as any

  const riskLevel = risk?.risk_level ?? 'medium'
  const riskColor = ({ green: 0x2ecc71, low: 0x2ecc71, yellow: 0xf1c40f, medium: 0xf1c40f, orange: 0xe67e22, high: 0xe67e22, red: 0xe74c3c, extreme: 0xe74c3c } as any)[riskLevel] ?? 0x95a5a6
  const riskEmoji = ({ green: '🟢', low: '🟢', yellow: '🟡', medium: '🟡', orange: '🟠', high: '🟠', red: '🔴', extreme: '🔴' } as any)[riskLevel] ?? '⚪'

  const usLine = us
    ? `SOX ${fmtPct(us.sox_return)} | S&P ${fmtPct(us.gspc_return)} | VIX ${us.vix_close?.toFixed(1) ?? '?'} | DXY ${fmtPct(us.dxy_return)} | ${us.sentiment ?? 'N/A'}`
    : '尚未抓取'

  embeds.push({
    title: `📊 StockVision 收盤報告 — ${twToday}`,
    color: riskColor,
    fields: [
      { name: `${riskEmoji} 大盤風險`, value: `**${riskLevel.toUpperCase()}** (${risk?.risk_score ?? '?'}/100)`, inline: true },
      { name: '🌐 美股前夜', value: usLine, inline: false },
    ],
    timestamp: new Date().toISOString(),
  })

  // ── 2. ML 預測總覽 ──────────────────────────────────────────────────────
  const { results: signalCounts } = await env.DB.prepare(`
    SELECT trade_signal, COUNT(*) as cnt, ROUND(AVG(direction_accuracy), 3) as avg_conf
    FROM predictions
    WHERE model_name='ensemble'
      AND COALESCE(prediction_date, date(generated_at, '+8 hours'))=?
    GROUP BY trade_signal
  `).bind(twToday).all<any>()

  const buyCount = signalCounts?.find((r: any) => r.trade_signal === 'buy')
  const holdCount = signalCounts?.find((r: any) => r.trade_signal === 'hold')
  const sellCount = signalCounts?.find((r: any) => r.trade_signal === 'sell')
  const totalStocks = (signalCounts ?? []).reduce((s: number, r: any) => s + r.cnt, 0)

  embeds.push({
    title: '🤖 ML 預測總覽',
    color: 0x3498db,
    description: `**${totalStocks} 支** 分析完成（V2 alpha ensemble + state-space overlay）`,
    fields: [
      { name: '🟢 BUY', value: `${buyCount?.cnt ?? 0} 支\n信心 ${((buyCount?.avg_conf ?? 0) * 100).toFixed(0)}%`, inline: true },
      { name: '⚪ HOLD', value: `${holdCount?.cnt ?? 0} 支`, inline: true },
      { name: '🔴 SELL', value: `${sellCount?.cnt ?? 0} 支\n信心 ${((sellCount?.avg_conf ?? 0) * 100).toFixed(0)}%`, inline: true },
    ],
  })

  // ── 3. BUY 明細（含模型投票）───────────────────────────────────────────
  const { results: buyStocks } = await env.DB.prepare(`
    SELECT s.symbol, s.name, p.direction_accuracy as confidence,
           p.entry_price, p.stop_loss, p.target1, p.target2, p.forecast_data
    FROM predictions p JOIN stocks s ON p.stock_id=s.id
    WHERE p.model_name='ensemble'
      AND COALESCE(p.prediction_date, date(p.generated_at, '+8 hours'))=?
      AND p.trade_signal='buy'
    ORDER BY p.direction_accuracy DESC LIMIT 15
  `).bind(twToday).all<any>()

  if (buyStocks && buyStocks.length > 0) {
    for (const stock of buyStocks) {
      const fd = safeParseJSON(stock.forecast_data)
      const models = fd?.models ?? []
      const conf = ((stock.confidence ?? 0) * 100).toFixed(0)

      // Alpha model vote details.
      let voteText = ''
      for (const m of models) {
        const arrow = m.direction === 'up' ? '↑' : m.direction === 'down' ? '↓' : '→'
        const mConf = m.confidence != null ? `${(m.confidence * 100).toFixed(0)}%` : '?'
        const weight = m.weight != null ? ` w=${m.weight.toFixed(2)}` : ''
        voteText += `${arrow} **${m.model}** ${mConf}${weight}\n`
      }
      if (!voteText) voteText = '_模型明細不可用_'

      // Meta layer
      const signal = fd?.signal ?? 'BUY'
      const metaNote = fd?.meta_learner_used ? '🧠 Meta-Learner 已修正' : ''
      const arfNote = fd?.arf_correction ? `ARF: ${fd.arf_correction}` : ''
      const metaLine = [metaNote, arfNote].filter(Boolean).join(' | ') || 'Ensemble 投票'

      embeds.push({
        title: `🟢 ${stock.symbol} ${stock.name}`,
        color: 0x2ecc71,
        fields: [
          { name: '📊 Ensemble', value: `**${signal}** | 信心 **${conf}%**\n${metaLine}`, inline: false },
          { name: '💰 價位', value: `進場 ${stock.entry_price}\n停損 ${stock.stop_loss}\n目標 ${stock.target1} → ${stock.target2}`, inline: true },
          { name: '🗳️ 模型投票', value: voteText.trim(), inline: true },
        ],
      })
    }
  }

  // ── 4. SELL 警示 ─────────────────────────────────────────────────────────
  const { results: sellStocks } = await env.DB.prepare(`
    SELECT s.symbol, s.name, p.direction_accuracy as confidence,
           p.entry_price, p.stop_loss, p.forecast_data
    FROM predictions p JOIN stocks s ON p.stock_id=s.id
    WHERE p.model_name='ensemble'
      AND COALESCE(p.prediction_date, date(p.generated_at, '+8 hours'))=?
      AND p.trade_signal='sell'
    ORDER BY p.direction_accuracy DESC LIMIT 10
  `).bind(twToday).all<any>()

  if (sellStocks && sellStocks.length > 0) {
    let sellText = ''
    for (const stock of sellStocks) {
      const fd = safeParseJSON(stock.forecast_data)
      const models = fd?.models ?? []
      const downCount = models.filter((m: any) => m.direction === 'down').length
      const conf = ((stock.confidence ?? 0) * 100).toFixed(0)
      sellText += `🔴 **${stock.symbol} ${stock.name}** | 信心 ${conf}% | ${downCount}/${models.length} 模型看跌\n`
    }
    embeds.push({
      title: '⚠️ SELL 警示',
      color: 0xe74c3c,
      description: sellText.trim(),
    })
  }

  // ── 5. 推薦名單 ─────────────────────────────────────────────────────────
  const { results: recs } = await env.DB.prepare(`
    SELECT symbol, name, sector, score, signal, confidence, reason
    FROM daily_recommendations WHERE date=? AND has_buy_signal=1
    ORDER BY score DESC
  `).bind(twToday).all<any>()

  if (recs && recs.length > 0) {
    let recText = ''
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i]
      recText += `**${i + 1}. ${r.symbol} ${r.name}** (${r.sector})\n`
      recText += `> 分數 ${r.score} | 信心 ${((r.confidence ?? 0) * 100).toFixed(0)}%\n`
      recText += `> ${(r.reason ?? '').slice(0, 120)}\n\n`
    }
    embeds.push({
      title: '⭐ 每日推薦',
      color: 0xf39c12,
      description: recText.trim(),
    })
  }

  // ── 6. 帳戶績效 ─────────────────────────────────────────────────────────
  const snapshot = await env.DB.prepare(`
    SELECT total_value, cumulative_return, daily_return, max_drawdown, sharpe_30d, trade_count
    FROM paper_daily_snapshots WHERE date=? LIMIT 1
  `).bind(twToday).first<any>().catch(() => null)

  if (snapshot) {
    const pnlEmoji = (snapshot.cumulative_return ?? 0) >= 0 ? '📈' : '📉'
    embeds.push({
      title: `${pnlEmoji} Paper Trading 績效`,
      color: (snapshot.cumulative_return ?? 0) >= 0 ? 0x27ae60 : 0xc0392b,
      fields: [
        { name: '💰 總資產', value: `NT$${Math.round(snapshot.total_value ?? 0).toLocaleString()}`, inline: true },
        { name: '累計報酬', value: fmtPct(snapshot.cumulative_return), inline: true },
        { name: '今日報酬', value: fmtPct(snapshot.daily_return), inline: true },
        { name: '最大回撤', value: snapshot.max_drawdown != null ? `${(snapshot.max_drawdown * 100).toFixed(1)}%` : 'N/A', inline: true },
        { name: 'Sharpe(30d)', value: snapshot.sharpe_30d?.toFixed(2) ?? 'N/A', inline: true },
        { name: '交易筆數', value: `${snapshot.trade_count ?? 0}`, inline: true },
      ],
    })
  }

  const pendingSnapshot = await loadPendingBuySnapshot(env, twToday, { allowFallbackRecent: false })
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

  // ── 7.5 無標籤股票偵測 ─────────────────────────────────────────────────
  const { results: untaggedStocks } = await env.DB.prepare(`
    SELECT s.symbol, s.name FROM stocks s
    WHERE s.in_current_watchlist = 1
      AND NOT EXISTS (SELECT 1 FROM stock_tags t WHERE t.symbol = s.symbol)
    ORDER BY s.symbol LIMIT 20
  `).all<any>().catch(() => ({ results: [] as any[] }))

  if (untaggedStocks && untaggedStocks.length > 0) {
    const list = untaggedStocks.map((s: any) => `${s.symbol} ${s.name}`).join('\n')
    embeds.push({
      title: `⚠️ ${untaggedStocks.length} 支股票無概念標籤`,
      color: 0xe67e22,
      description: `以下活躍股票尚未分類，可執行 \`reclassify-tags\` 補標：\n${list}`,
    })
  }

  // ── Footer ──
  embeds.push({
    description: '_投資有風險，本報告由 StockVision ML Pipeline 自動產出，僅供參考。_',
    color: 0x95a5a6,
    footer: { text: `StockVision v12 | ${totalStocks} stocks × 8 alpha models × state overlays × governed feature set` },
  })

  // ── 7. 主題輪動 ─────────────────────────────────────────────────────────
  const { results: themeFlows } = await env.DB.prepare(`
    SELECT sector, total_net, stock_count, quadrant, rs_ratio, rs_momentum
    FROM sector_flow WHERE date=? AND classification='theme'
    ORDER BY total_net DESC
  `).bind(twToday).all<any>().catch(() => ({ results: [] as any[] }))

  // ── 持久化到 D1 ──────────────────────────────────────────────────────────
  try {
    const reportData = {
      market_summary: JSON.stringify({
        risk_level: riskLevel, risk_score: risk?.risk_score,
        us_context: us ? { sox: us.sox_return, sp500: us.gspc_return, vix: us.vix_close, sentiment: us.sentiment } : null,
      }),
      ml_overview: JSON.stringify({
        total: totalStocks,
        buy_count: buyCount?.cnt ?? 0, hold_count: holdCount?.cnt ?? 0, sell_count: sellCount?.cnt ?? 0,
        buy_avg_conf: buyCount?.avg_conf, sell_avg_conf: sellCount?.avg_conf,
      }),
      buy_details: JSON.stringify((buyStocks ?? []).map((s: any) => ({
        symbol: s.symbol, name: s.name, confidence: s.confidence,
        entry: s.entry_price, stop: s.stop_loss, target1: s.target1, target2: s.target2,
      }))),
      sell_alerts: JSON.stringify((sellStocks ?? []).map((s: any) => {
        const fd = safeParseJSON(s.forecast_data)
        const models = fd?.models ?? []
        return { symbol: s.symbol, name: s.name, confidence: s.confidence, down_count: models.filter((m: any) => m.direction === 'down').length, total_models: models.length }
      })),
      recommendations: JSON.stringify((recs ?? []).map((r: any) => ({
        symbol: r.symbol, name: r.name, sector: r.sector, score: r.score, confidence: r.confidence, reason: r.reason,
      }))),
      performance: snapshot ? JSON.stringify({
        total_value: snapshot.total_value, cumulative_return: snapshot.cumulative_return,
        daily_return: snapshot.daily_return, max_drawdown: snapshot.max_drawdown,
        sharpe_30d: snapshot.sharpe_30d, trade_count: snapshot.trade_count,
      }) : null,
      theme_flow: JSON.stringify((themeFlows ?? []).slice(0, 20).map((f: any) => ({
        sector: f.sector, total_net: f.total_net, stock_count: f.stock_count,
        quadrant: f.quadrant, rs_ratio: f.rs_ratio, rs_momentum: f.rs_momentum,
      }))),
    }
    await env.DB.prepare(`
      INSERT INTO stock_analysis_reports (date, report_type, market_summary, ml_overview, buy_details, sell_alerts, recommendations, performance, theme_flow)
      VALUES (?, 'daily', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, report_type) DO UPDATE SET
        market_summary=excluded.market_summary, ml_overview=excluded.ml_overview,
        buy_details=excluded.buy_details, sell_alerts=excluded.sell_alerts,
        recommendations=excluded.recommendations, performance=excluded.performance,
        theme_flow=excluded.theme_flow, created_at=datetime('now')
    `).bind(twToday, reportData.market_summary, reportData.ml_overview, reportData.buy_details,
            reportData.sell_alerts, reportData.recommendations, reportData.performance, reportData.theme_flow).run()
    console.log(`[DailyReport] Persisted to D1 for ${twToday}`)
  } catch (e) {
    console.warn(`[DailyReport] D1 persist failed: ${e}`)
  }

  // 推送（Discord 優先，無 webhook 則 fallback 到 email）
  const channel = await sendReportToChannels(env as any, embeds, `📊 StockVision 收盤報告 — ${twToday}`)

  return `收盤報告已推送 via ${channel}（${buyStocks?.length ?? 0} BUY / ${sellStocks?.length ?? 0} SELL）`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  const pct = (v * 100).toFixed(1)
  return v >= 0 ? `+${pct}%` : `${pct}%`
}

function safeParseJSON(str: string | null | undefined): any {
  if (!str) return null
  try { return JSON.parse(str) } catch { return null }
}
