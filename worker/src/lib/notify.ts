/**
 * notify.ts — Cron 失敗通知
 *
 * 寫入 D1 system_logs 表（前端 SystemStatusBar 可讀）
 *
 * 使用方式：
 *   await notifyCronFailure(env, 'runMLAndRisk', error, { stock: '2330' })
 *   await notifyCronSuccess(env, 'runDailyUpdate', { stocks_processed: 10 })
 */

import { resolveReportDeliveryChannel } from './reportDeliveryChannel'
import { readScoreV2Snapshot, type ScoreV2StorageRow } from './scoreV2Taxonomy'

interface Env {
  DB: any
  KV: any
}

export type LogLevel = 'info' | 'warn' | 'error'

export async function writeSystemLog(
  db: any,
  level: LogLevel,
  cron: string,
  message: string,
  meta?: Record<string, any>,
): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO system_logs (level, cron_name, message, meta, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).bind(level, cron, message, meta ? JSON.stringify(meta) : null).run()
  } catch {
    // system_logs 表可能還不存在（舊版部署），靜默忽略
  }
}

export async function notifyCronFailure(
  env: Env,
  cronName: string,
  error: unknown,
  meta?: Record<string, any>,
): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error)
  const fullMeta = { ...meta, error: msg, timestamp: new Date().toISOString() }

  console.error(`[CronFail] ${cronName}: ${msg}`, meta)
  await writeSystemLog(env.DB, 'error', cronName, `Cron 失敗: ${msg}`, fullMeta)
}

export async function notifyCronSuccess(
  env: Env,
  cronName: string,
  meta?: Record<string, any>,
): Promise<void> {
  const summary = meta ? JSON.stringify(meta) : 'OK'
  await writeSystemLog(env.DB, 'info', cronName, `Cron 完成: ${summary}`, meta)
}


// ─── Discord Webhook 推送（Paper Trading 事件通知）───────────────────────────

export async function sendDiscordNotification(
  webhookUrl: string | undefined,
  message: string,
): Promise<void> {
  if (!webhookUrl) return
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    })
  } catch (e) {
    console.warn(`[Discord] webhook failed: ${e}`)
  }
}

export async function sendLinePush(
  channelAccessToken: string | undefined,
  userId: string | undefined,
  message: string,
): Promise<boolean> {
  if (!channelAccessToken || !userId) return false
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: message.slice(0, 4500) }],
      }),
    })
    if (!res.ok) {
      console.warn(`[LINE] push failed: HTTP ${res.status}`)
      return false
    }
    return true
  } catch (e) {
    console.warn(`[LINE] push failed: ${e}`)
    return false
  }
}

export async function sendOperatorNotification(
  env: {
    LINE_CHANNEL_ACCESS_TOKEN?: string
    LINE_USER_ID?: string
    DISCORD_WEBHOOK_URL?: string
    RESEND_API_KEY?: string
    ADMIN_EMAIL?: string
  },
  message: string,
): Promise<'line' | 'discord' | 'email' | 'not_sent:no_channel_configured'> {
  const channel = resolveReportDeliveryChannel(env)
  if (channel === 'line') {
    const sent = await sendLinePush(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_USER_ID, message)
    return sent ? 'line' : 'not_sent:no_channel_configured'
  }
  if (channel === 'discord') {
    await sendDiscordNotification(env.DISCORD_WEBHOOK_URL, message)
    return 'discord'
  }
  if (channel === 'email' && env.RESEND_API_KEY && env.ADMIN_EMAIL) {
    await sendEmailReport(env.RESEND_API_KEY, env.ADMIN_EMAIL, 'StockVision notification', [{
      title: 'StockVision notification',
      description: message,
      timestamp: new Date().toISOString(),
    }])
    return 'email'
  }
  return 'not_sent:no_channel_configured'
}

/** Paper Trading 交易事件推送 */
export function formatTradeNotification(
  action: 'buy' | 'sell',
  symbol: string,
  name: string,
  shares: number,
  price: number,
  reason: string,
  pnlPct?: number,
): string {
  const emoji = action === 'buy' ? '🟢' : '🔴'
  const actionText = action === 'buy' ? '買入' : '賣出'
  const pnlText = pnlPct != null ? ` (${pnlPct > 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%)` : ''
  const value = Math.round(price * shares).toLocaleString()

  return `${emoji} **${actionText} ${name}(${symbol})**\n` +
    `> 📊 ${shares} 股 @ NT$${price.toFixed(1)}（NT$${value}）${pnlText}\n` +
    `> 📋 ${reason}`
}

// ─── Discord Embed 推送（結構化報告用）──────────────────────────────────────

export interface DiscordEmbed {
  title?: string
  description?: string
  color?: number  // decimal color (e.g. 0x2ecc71 = green)
  fields?: { name: string; value: string; inline?: boolean }[]
  footer?: { text: string }
  timestamp?: string  // ISO 8601
}

/**
 * 發送 Discord Embed（支援多個 embed，上限 10）。
 * 用於盤前攻略、收盤報告等結構化推送。
 */
export async function sendDiscordEmbeds(
  webhookUrl: string | undefined,
  embeds: DiscordEmbed[],
  content?: string,
): Promise<void> {
  if (!webhookUrl) return
  try {
    // Discord 一次最多 10 embeds，超過分批
    for (let i = 0; i < embeds.length; i += 10) {
      const batch = embeds.slice(i, i + 10)
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: i === 0 ? content : undefined,
          embeds: batch,
        }),
      })
      if (i + 10 < embeds.length) await new Promise(r => setTimeout(r, 500))
    }
  } catch (e) {
    console.warn(`[Discord] embed webhook failed: ${e}`)
  }
}

// ─── Email 報告推送（Resend API，Discord 未設定時的 fallback）────────────────

/**
 * 將 Discord Embeds 轉換成 HTML email 並透過 Resend 寄出。
 * 用於 Discord webhook 尚未設定時的 fallback。
 */
export async function sendEmailReport(
  resendApiKey: string,
  to: string,
  subject: string,
  embeds: DiscordEmbed[],
): Promise<void> {
  if (!resendApiKey || !to) return
  try {
    // 將 Discord embeds 轉成簡潔 HTML
    let html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:16px;">`
    for (const embed of embeds) {
      const color = embed.color ? `#${embed.color.toString(16).padStart(6, '0')}` : '#3498db'
      html += `<div style="border-left:4px solid ${color};padding:12px 16px;margin:12px 0;background:#f9f9f9;border-radius:4px;">`
      if (embed.title) html += `<h3 style="margin:0 0 8px;color:#1a1a1a;">${embed.title}</h3>`
      if (embed.description) html += `<p style="margin:0 0 8px;white-space:pre-line;">${embed.description}</p>`
      if (embed.fields) {
        html += `<table style="width:100%;border-collapse:collapse;">`
        for (const f of embed.fields) {
          const width = f.inline ? 'width:33%;' : 'width:100%;'
          html += `<tr><td style="${width}vertical-align:top;padding:4px 8px 4px 0;">`
          html += `<strong style="color:#555;font-size:0.85em;">${f.name}</strong><br/>`
          html += `<span style="white-space:pre-line;">${f.value}</span></td></tr>`
        }
        html += `</table>`
      }
      if (embed.footer) html += `<p style="margin:8px 0 0;font-size:0.75em;color:#999;">${embed.footer.text}</p>`
      html += `</div>`
    }
    html += `</div>`

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendApiKey}` },
      body: JSON.stringify({
        from: 'StockVision <noreply@stockvision.app>',
        to,
        subject,
        html,
      }),
    })
  } catch (e) {
    console.warn(`[Email] report send failed: ${e}`)
  }
}

/**
 * 報告推送：Discord 優先，無 webhook 則 fallback 到 email。
 */
export async function sendReportToChannels(
  env: {
    KV: KVNamespace
    RESEND_API_KEY?: string
    ADMIN_EMAIL?: string
    DISCORD_WEBHOOK_URL?: string
    LINE_CHANNEL_ACCESS_TOKEN?: string
    LINE_USER_ID?: string
  },
  embeds: DiscordEmbed[],
  emailSubject: string,
): Promise<string> {
  // P0 資安：webhook URL 只從 Worker secret 讀取，不存 KV（防洩漏後被推送假消息）
  const channel = resolveReportDeliveryChannel(env)
  if (channel === 'line' && env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_USER_ID) {
    const text = embeds.map((embed) => {
      const fields = embed.fields?.map((field) => `${field.name}: ${field.value}`).join('\n') ?? ''
      return [embed.title, embed.description, fields].filter(Boolean).join('\n')
    }).join('\n\n')
    await sendLinePush(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_USER_ID, text || emailSubject)
    return 'line'
  }
  const webhookUrl = env.DISCORD_WEBHOOK_URL
  if (channel === 'discord' && webhookUrl) {
    await sendDiscordEmbeds(webhookUrl, embeds)
    return 'discord'
  }
  // Fallback: email
  if (channel === 'email' && env.RESEND_API_KEY && env.ADMIN_EMAIL) {
    await sendEmailReport(env.RESEND_API_KEY, env.ADMIN_EMAIL, emailSubject, embeds)
    return 'email'
  }
  console.warn('[Report] No Discord webhook AND no email config — report not sent')
  return channel
}

/** 每日摘要推送 */
export function formatDailySummary(
  totalValue: number,
  pnlPct: number,
  trades: number,
  maxDrawdown: number | null,
  sharpe: number | null,
): string {
  const pnlEmoji = pnlPct >= 0 ? '📈' : '📉'
  const ddText = maxDrawdown != null ? `${(maxDrawdown * 100).toFixed(1)}%` : 'N/A'
  const sharpeText = sharpe != null ? sharpe.toFixed(2) : 'N/A'

  return `${pnlEmoji} **Paper Trading 日報**\n` +
    `> 💰 總資產 NT$${Math.round(totalValue).toLocaleString()}\n` +
    `> ${pnlEmoji} 累計報酬 ${pnlPct > 0 ? '+' : ''}${(pnlPct * 100).toFixed(2)}%\n` +
    `> 📊 今日交易 ${trades} 筆\n` +
    `> ⚠️ 最大回撤 ${ddText} | Sharpe ${sharpeText}`
}

// ─── Three-section daily embed (actionable / holdings / summary) ─────────────
//
// Rationale: existing `formatDailySummary()` is a single markdown blob that
// mixes P/L, holdings and trade events. For fast scan-ability (see Sweller 1988
// on cognitive load, and F-pattern reading research), the daily digest should
// separate:
//   1. Actionable Signals — new buy candidates you might want to act on
//   2. Holdings            — current positions and their P/L
//   3. Summary             — account totals + momentum zone
//
// Embed color reflects the momentum zone (RED/YELLOW/GREEN), so a glance at
// the webhook tells you the risk posture before you read a single number.

export interface ActionableSignal {
  symbol: string
  name: string
  signal: string             // e.g. 'BUY', 'STRONG_BUY'
  score_v2?: unknown
  confidence: number | null  // model confidence [0, 1]
  reason: string
}

export interface HoldingSnapshot {
  symbol: string
  name: string
  shares: number
  entry_price: number
  current_price: number
  pnl_pct: number
  trailing_stop: number | null
  tp1_price: number | null
  days_held: number | null
}

export interface DailySummaryMetrics {
  total_value: number
  cash: number
  daily_pnl_pct: number
  cumulative_pnl_pct: number
  trades_today: number
  max_drawdown: number | null
  sharpe: number | null
  momentum_zone?: 'RED' | 'YELLOW' | 'GREEN'
  momentum_percentile?: number | null
}

/** Discord embed color per momentum zone. */
const ZONE_COLOR: Record<'RED' | 'YELLOW' | 'GREEN', number> = {
  RED: 0xe74c3c,
  YELLOW: 0xf1c40f,
  GREEN: 0x2ecc71,
}

/** Pad a symbol string to fixed width for fixed-width column alignment. */
function pad(s: string, width: number): string {
  const len = [...s].length
  return len >= width ? s : s + ' '.repeat(width - len)
}

export function actionableSignalDisplayScore(signal: ActionableSignal): number | null {
  return readScoreV2Snapshot({ score_components: signal.score_v2 } as ScoreV2StorageRow)?.finalScore ?? null
}

export function actionableSignalScoreSummary(signal: ActionableSignal): string {
  const snapshot = readScoreV2Snapshot({ score_components: signal.score_v2 } as ScoreV2StorageRow)
  if (!snapshot) return ''
  return `Score V2 ${Math.round(snapshot.finalScore)} ` +
    `(ML ${Math.round(snapshot.components.mlEdge)}, 籌 ${Math.round(snapshot.components.chipFlow)}, 技 ${Math.round(snapshot.components.technicalStructure)})`
}

/** Build a single Discord Embed with 3 fields: actionable / holdings / summary. */
export function buildTripartiteDailyEmbed(args: {
  date: string
  actionable: ActionableSignal[]
  holdings: HoldingSnapshot[]
  summary: DailySummaryMetrics
}): DiscordEmbed {
  const { date, actionable, holdings, summary } = args
  const zone = summary.momentum_zone ?? 'GREEN'
  const color = ZONE_COLOR[zone]

  // ── Actionable section ────────────────────────────────────────────────────
  const actionableText = actionable.length === 0
    ? '_No actionable signals_'
    : actionable.slice(0, 8).map(s => {
        const score = actionableSignalScoreSummary(s)
        const conf = s.confidence != null ? ` ${Math.round(s.confidence * 100)}%` : ''
        return '`' + pad(s.symbol, 6) + '` ' + s.signal +
               (score ? ` ${score}` : '') + conf +
               (s.reason ? ` - ${s.reason.slice(0, 40)}` : '')
      }).join('\n')

  // ── Holdings section ──────────────────────────────────────────────────────
  const holdingsText = holdings.length === 0
    ? '_目前空倉_'
    : holdings.map(h => {
        const pnlSign = h.pnl_pct >= 0 ? '+' : ''
        const pnlStr = `${pnlSign}${(h.pnl_pct * 100).toFixed(1)}%`
        const tsStr = h.trailing_stop != null ? ` 停 ${h.trailing_stop.toFixed(1)}` : ''
        const tpStr = h.tp1_price != null ? ` T1 ${h.tp1_price.toFixed(1)}` : ''
        const dStr = h.days_held != null ? ` (${h.days_held}d)` : ''
        return '`' + pad(h.symbol, 6) + '` ' +
               `${h.shares}股 @ ${h.entry_price.toFixed(1)}→${h.current_price.toFixed(1)} ` +
               `${pnlStr}${tsStr}${tpStr}${dStr}`
      }).join('\n')

  // ── Summary section ───────────────────────────────────────────────────────
  const todaySign = summary.daily_pnl_pct >= 0 ? '+' : ''
  const cumSign = summary.cumulative_pnl_pct >= 0 ? '+' : ''
  const ddStr = summary.max_drawdown != null
    ? `${(summary.max_drawdown * 100).toFixed(1)}%`
    : 'N/A'
  const sharpeStr = summary.sharpe != null ? summary.sharpe.toFixed(2) : 'N/A'
  const zoneEmoji = zone === 'RED' ? '🔴' : zone === 'YELLOW' ? '🟡' : '🟢'
  const zoneLine = `${zoneEmoji} Momentum Zone: ${zone}` +
    (summary.momentum_percentile != null
      ? ` (P${(summary.momentum_percentile * 100).toFixed(0)})`
      : '')

  const summaryText = [
    `💰 總資產 NT$${Math.round(summary.total_value).toLocaleString()} ` +
      `(現金 NT$${Math.round(summary.cash).toLocaleString()})`,
    `📈 今日 ${todaySign}${(summary.daily_pnl_pct * 100).toFixed(2)}% | ` +
      `累計 ${cumSign}${(summary.cumulative_pnl_pct * 100).toFixed(2)}%`,
    `📊 今日交易 ${summary.trades_today} 筆 | MDD ${ddStr} | Sharpe ${sharpeStr}`,
    zoneLine,
  ].join('\n')

  return {
    title: `📊 StockVision Daily — ${date}`,
    color,
    fields: [
      { name: '🎯 Actionable Signals', value: actionableText.slice(0, 1024), inline: false },
      { name: '📦 Holdings',           value: holdingsText.slice(0, 1024),   inline: false },
      { name: '📈 Summary',            value: summaryText.slice(0, 1024),    inline: false },
    ],
    footer: { text: 'StockVision • 三段式 v1 (zone-aware)' },
    timestamp: new Date().toISOString(),
  }
}
