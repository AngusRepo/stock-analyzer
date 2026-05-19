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

const RISK_LABELS: Record<string, string> = {
  low: 'LOW',
  green: 'LOW',
  medium: 'MEDIUM',
  yellow: 'MEDIUM',
  high: 'HIGH',
  orange: 'HIGH',
  extreme: 'EXTREME',
  red: 'EXTREME',
}

type MorningEvidence = {
  usSignal: any | null
  newsReport: any | null
  notes: string[]
}

async function ensureMorningEvidence(env: Bindings, twToday: string): Promise<MorningEvidence> {
  const notes: string[] = []
  let usSignal = await env.KV.get(`us:leading:${twToday}`, 'json') as any

  if (usSignal) {
    notes.push('us-leading:kv')
  } else {
    try {
      const { fetchAndStoreUSLeading } = await import('./usLeading')
      usSignal = await fetchAndStoreUSLeading(env)
      notes.push(usSignal ? 'us-leading:refreshed' : 'us-leading:missing')
    } catch (error) {
      notes.push(`us-leading:error:${truncate(String(error), 60)}`)
    }
  }

  if (!usSignal) {
    const previous = await env.KV.get(`us:leading:${getPrevDate(twToday)}`, 'json') as any
    if (previous) {
      usSignal = previous
      notes.push('us-leading:previous-day')
    }
  }

  let newsReport: any | null = null
  try {
    const { readCurrentNewsReport, runDailyNewsAnalysis } = await import('./newsAnalyst')
    newsReport = await readCurrentNewsReport(env.KV, twToday)
    if (newsReport) {
      notes.push('news-analyst:kv')
    } else {
      newsReport = await runDailyNewsAnalysis(env as any)
      notes.push(newsReport ? 'news-analyst:refreshed' : 'news-analyst:missing')
    }
  } catch (error) {
    notes.push(`news-analyst:error:${truncate(String(error), 60)}`)
  }

  return { usSignal, newsReport, notes }
}

export async function generateMorningBriefing(env: Bindings): Promise<string> {
  const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const evidence = await ensureMorningEvidence(env, twToday)

  const risk = await env.DB.prepare(
    'SELECT risk_level, risk_score, risk_summary FROM market_risk ORDER BY date DESC LIMIT 1',
  ).first<any>()

  const pendingSnapshot = await loadPendingBuySnapshot(env, twToday, { allowFallbackRecent: false })
  const pending = pendingSnapshot.pendingBuys ?? []
  const pendingState = buildPendingBuyStateSummary(pending, pendingSnapshot.meta)

  const riskLevel = String(risk?.risk_level ?? 'medium').toLowerCase()
  const riskColor = RISK_COLORS[riskLevel] ?? 0xf1c40f
  const riskLabel = RISK_LABELS[riskLevel] ?? 'MEDIUM'

  const usLine = evidence.usSignal
    ? `SOX ${fmtPct(evidence.usSignal.sox_return)} | S&P ${fmtPct(evidence.usSignal.gspc_return)} | VIX ${fmtNumber(evidence.usSignal.vix_close, 1)} | ${evidence.usSignal.sentiment ?? 'N/A'}`
    : 'US leading signal unavailable'

  const newsLine = evidence.newsReport
    ? `${String(evidence.newsReport.bias ?? 'neutral').toUpperCase()} | confidence ${fmtNumber(evidence.newsReport.confidence, 2)} | ${truncate(String(evidence.newsReport.summary ?? ''), 180) || 'no summary'}`
    : 'news analyst unavailable'

  const pendingText = formatPendingBuyBriefing(pending, pendingState)
  const evidenceLine = evidence.notes.length > 0 ? evidence.notes.join(' | ') : 'scheduled evidence ready'

  const embeds: DiscordEmbed[] = [
    {
      title: `Morning briefing ${twToday}`,
      color: riskColor,
      fields: [
        { name: 'US leading / 美股前導', value: usLine, inline: false },
        { name: 'News analyst / 早盤新聞情緒', value: newsLine, inline: false },
        { name: 'Market risk / 大盤風險', value: `**${riskLabel}** (${risk?.risk_score ?? '?'}/100)`, inline: true },
        { name: 'Pending buys / 候選掛單', value: pendingText, inline: false },
        { name: 'Evidence path / 資料閉環', value: evidenceLine, inline: false },
      ],
      footer: { text: 'StockVision | Morning Briefing' },
      timestamp: new Date().toISOString(),
    },
  ]

  if (risk?.risk_summary) {
    embeds.push({
      description: `Market risk summary: ${risk.risk_summary}`,
      color: riskColor,
    })
  }

  const channel = await sendReportToChannels(env as any, embeds, `Morning briefing ${twToday}`)
  return `Morning briefing sent to ${channel}; state=${pendingState.state} active=${pendingState.active_count}/${pendingState.total_count}; evidence=${evidenceLine}`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return 'N/A'
  const pct = (v * 100).toFixed(1)
  return v >= 0 ? `+${pct}%` : `${pct}%`
}

function fmtNumber(v: number | null | undefined, digits: number): string {
  if (v == null || !Number.isFinite(Number(v))) return 'N/A'
  return Number(v).toFixed(digits)
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value
}

function getPrevDate(dateStr: string): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() - 1)
  return d.toISOString().slice(0, 10)
}
