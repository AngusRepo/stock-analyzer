/**
 * morningBriefing.ts — 盤前攻略推送
 *
 * 07:50 TW 執行，整合：
 *   1. 美股前夜（SOX/S&P/VIX/HY）
 *   2. 大盤風險等級
 *   3. Debate 後的今日掛單清單
 * 推送到 Discord Embed。
 */

import type { Bindings } from '../types'
import { sendReportToChannels, type DiscordEmbed } from './notify'

const RISK_COLORS: Record<string, number> = {
  green: 0x2ecc71,
  yellow: 0xf1c40f,
  orange: 0xe67e22,
  red: 0xe74c3c,
  medium: 0xf1c40f,
  high: 0xe67e22,
  extreme: 0xe74c3c,
  low: 0x2ecc71,
}

const RISK_EMOJI: Record<string, string> = {
  green: '🟢', low: '🟢',
  yellow: '🟡', medium: '🟡',
  orange: '🟠', high: '🟠',
  red: '🔴', extreme: '🔴',
}

export async function generateMorningBriefing(env: Bindings): Promise<string> {
  const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  // 1. 美股先行指標
  const usSignal = await env.KV.get(`us:leading:${twToday}`, 'json') as any
  const usYesterday = await env.KV.get(`us:leading:${getPrevDate(twToday)}`, 'json') as any
  const us = usSignal ?? usYesterday

  // 2. 大盤風險
  const risk = await env.DB.prepare(
    'SELECT risk_level, risk_score, risk_summary FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<any>()

  // 3. 今日掛單（Debate 結果）
  const pendingRaw = await env.KV.get(`paper:pending_buys:${twToday}`, 'json') as any[]
  const pending = pendingRaw ?? []

  // 4. 組裝 Embed
  const riskLevel = risk?.risk_level ?? 'medium'
  const riskEmoji = RISK_EMOJI[riskLevel] ?? '🟡'
  const riskColor = RISK_COLORS[riskLevel] ?? 0xf1c40f

  const embeds: DiscordEmbed[] = []

  // ── 主 Embed ──
  const usLine = us
    ? `SOX ${fmtPct(us.sox_return)} | S&P ${fmtPct(us.gspc_return)} | VIX ${us.vix_close?.toFixed(1) ?? '?'} | ${us.sentiment ?? 'N/A'}`
    : '資料尚未抓取'

  let pendingText = ''
  if (pending.length === 0) {
    pendingText = '_無掛單（Circuit Breaker 或無 BUY signal）_'
  } else {
    for (const p of pending) {
      const icon = p.debateVerdict === 'APPROVE' ? '✅'
        : p.debateVerdict === 'DOWNGRADE' ? '⬇️'
        : p.debateVerdict === 'REJECT' ? '❌' : '⏳'
      const sizeNote = p.debateVerdict === 'DOWNGRADE' ? '（半倉）' : ''
      pendingText += `${icon} **${p.symbol} ${p.name}** | 限價 ${p.entryPrice} | 停損 ${p.stopLoss} | ${p.debateVerdict ?? 'PENDING'}${sizeNote}\n`
    }
  }

  embeds.push({
    title: `🌅 盤前攻略 — ${twToday}`,
    color: riskColor,
    fields: [
      { name: '🌐 美股前夜', value: usLine, inline: false },
      { name: `${riskEmoji} 大盤環境`, value: `**${riskLevel.toUpperCase()}** (${risk?.risk_score ?? '?'}/100)`, inline: true },
      { name: '📋 今日掛單', value: pendingText.trim() || '_無_', inline: false },
    ],
    footer: { text: 'StockVision | 投資有風險，本報告僅供參考' },
    timestamp: new Date().toISOString(),
  })

  // ── 風險提示 Embed（如有）──
  if (risk?.risk_summary) {
    embeds.push({
      description: `⚠️ ${risk.risk_summary}`,
      color: riskColor,
    })
  }

  // 推送（Discord 優先，無 webhook 則 fallback 到 email）
  const channel = await sendReportToChannels(env as any, embeds, `🌅 盤前攻略 — ${twToday}`)

  return `盤前攻略已推送 via ${channel}（${pending.length} 支掛單）`
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
