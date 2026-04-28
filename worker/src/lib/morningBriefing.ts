import type { Bindings } from '../types'
import { sendReportToChannels, type DiscordEmbed } from './notify'
import { loadPendingBuySnapshot } from './pendingBuyStore'
import { formatPendingBuyBriefing } from './pendingBuyBriefingSummary'
import { buildPendingBuyStateSummary } from './pendingBuyStateSummary'

const RISK_COLORS: Record<string, number> = {
  low: 0x2ecc71,
  green: 0x2ecc71,
  medium: 0xf1c40f,
  yellow: 0xf1c40f,
  high: 0xe67e22,
  orange: 0xe67e22,
  extreme: 0xe74c3c,
  red: 0xe74c3c,
}

const RISK_EMOJI: Record<string, string> = {
  low: '🟢',
  green: '🟢',
  medium: '🟡',
  yellow: '🟡',
  high: '🟠',
  orange: '🟠',
  extreme: '🔴',
  red: '🔴',
}

export async function generateMorningBriefing(env: Bindings): Promise<string> {
  const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  const usSignal = await env.KV.get(`us:leading:${twToday}`, 'json') as any
  const usYesterday = await env.KV.get(`us:leading:${getPrevDate(twToday)}`, 'json') as any
  const us = usSignal ?? usYesterday

  const risk = await env.DB.prepare(
    'SELECT risk_level, risk_score, risk_summary FROM market_risk ORDER BY date DESC LIMIT 1',
  ).first<any>()

  const pendingSnapshot = await loadPendingBuySnapshot(env, twToday, { allowFallbackRecent: false })
  const pending = pendingSnapshot.pendingBuys ?? []
  const pendingState = buildPendingBuyStateSummary(pending, pendingSnapshot.meta)

  const riskLevel = String(risk?.risk_level ?? 'medium').toLowerCase()
  const riskEmoji = RISK_EMOJI[riskLevel] ?? '🟡'
  const riskColor = RISK_COLORS[riskLevel] ?? 0xf1c40f

  const usLine = us
    ? `SOX ${fmtPct(us.sox_return)} | S&P ${fmtPct(us.gspc_return)} | VIX ${us.vix_close?.toFixed(1) ?? 'N/A'} | ${us.sentiment ?? 'N/A'}`
    : '尚無最新美股前導訊號'

  const pendingText = formatPendingBuyBriefing(pending, pendingState)

  const embeds: DiscordEmbed[] = [
    {
      title: `盤前簡報 ${twToday}`,
      color: riskColor,
      fields: [
        { name: '美股前導訊號', value: usLine, inline: false },
        { name: `${riskEmoji} 市場風險`, value: `**${riskLevel.toUpperCase()}** (${risk?.risk_score ?? '?'}/100)`, inline: true },
        { name: '待買清單', value: pendingText, inline: false },
      ],
      footer: { text: 'StockVision | Morning Briefing' },
      timestamp: new Date().toISOString(),
    },
  ]

  if (risk?.risk_summary) {
    embeds.push({
      description: `風險摘要：${risk.risk_summary}`,
      color: riskColor,
    })
  }

  const channel = await sendReportToChannels(env as any, embeds, `盤前簡報 ${twToday}`)
  return `盤前簡報已送出到 ${channel}，state=${pendingState.state} active=${pendingState.active_count}/${pendingState.total_count}`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  const pct = (v * 100).toFixed(1)
  return v >= 0 ? `+${pct}%` : `${pct}%`
}

function getPrevDate(dateStr: string): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}
