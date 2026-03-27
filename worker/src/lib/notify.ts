/**
 * notify.ts — Cron 失敗通知
 *
 * 寫入 D1 system_logs 表（前端 SystemStatusBar 可讀）
 *
 * 使用方式：
 *   await notifyCronFailure(env, 'runMLAndRisk', error, { stock: '2330' })
 *   await notifyCronSuccess(env, 'runDailyUpdate', { stocks_processed: 10 })
 */

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
  env: { KV: KVNamespace; RESEND_API_KEY?: string; ADMIN_EMAIL?: string; DISCORD_WEBHOOK_URL?: string },
  embeds: DiscordEmbed[],
  emailSubject: string,
): Promise<string> {
  const webhookUrl = await env.KV.get('discord:webhook:reports') ?? env.DISCORD_WEBHOOK_URL
  if (webhookUrl) {
    await sendDiscordEmbeds(webhookUrl, embeds)
    return 'discord'
  }
  // Fallback: email
  if (env.RESEND_API_KEY && env.ADMIN_EMAIL) {
    await sendEmailReport(env.RESEND_API_KEY, env.ADMIN_EMAIL, emailSubject, embeds)
    return 'email'
  }
  console.warn('[Report] No Discord webhook AND no email config — report not sent')
  return 'none'
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
