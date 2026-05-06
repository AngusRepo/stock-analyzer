import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'

export const adminConfigLifecycleRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminConfigLifecycleRoutes.get('/api/admin/config/challenger', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const { getChallenger } = await import('../lib/tradingConfig')
  const ch = await getChallenger(c.env.KV)
  if (!ch) return c.json({ success: true, challenger: null, message: 'No active challenger.' })

  return c.json({
    success: true,
    challenger: {
      hash: ch.hash,
      shadow_since: ch.shadow_since,
      source: ch.source,
      source_id: ch.source_id,
      note: ch.note,
      config: c.req.query('full') === '1' ? ch.config : '(pass ?full=1 for body)',
    },
  })
})

adminConfigLifecycleRoutes.post('/api/admin/config/challenger', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<{
    sandbox_id?: string
    config?: unknown
    note?: string
    gate?: { decision?: string; passed?: boolean; failed_gates?: string[] }
  }>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const { getSandboxEntry, setChallenger } = await import('../lib/tradingConfig')

  let config: any
  let source: string
  let sourceId: string | undefined

  if (body.sandbox_id) {
    const entry = await getSandboxEntry(c.env.KV, body.sandbox_id)
    if (!entry) return c.json({ error: 'sandbox entry not found' }, 404)
    if (entry.source === 'alpha_framework' && (body.gate?.decision !== 'PASS' || body.gate?.passed !== true)) {
      return c.json({
        error: 'alpha_framework sandbox requires PASS alpha promotion gate before challenger',
        hint: 'Use ml-controller POST /config_pool/alpha_challenger with apply=true and confirm=true.',
        failed_gates: body.gate?.failed_gates ?? null,
      }, 400)
    }
    config = entry.config
    source = `sandbox:${entry.source}`
    sourceId = body.sandbox_id
  } else if (body.config) {
    config = body.config
    source = 'manual'
  } else {
    return c.json({ error: 'Body requires either sandbox_id or config' }, 400)
  }

  const state = await setChallenger(c.env.KV, config, {
    source,
    source_id: sourceId,
    note: body.note,
  })

  await c.env.DB.prepare(
    `INSERT INTO config_lifecycle_events
     (event_date, event_type, challenger_source, challenger_hash, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    twToday(),
    'challenger_set',
    source,
    state.hash,
    JSON.stringify({ source_id: sourceId, note: body.note, shadow_since: state.shadow_since, gate: body.gate ?? null }),
  ).run()

  return c.json({
    success: true,
    challenger: {
      hash: state.hash,
      shadow_since: state.shadow_since,
      source: state.source,
      source_id: state.source_id,
    },
    message: 'Challenger 已設定，週五 19:30 TW 會自動評估。',
  })
})

adminConfigLifecycleRoutes.delete('/api/admin/config/challenger', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const { getChallenger, retireChallenger } = await import('../lib/tradingConfig')
  const existing = await getChallenger(c.env.KV)
  if (!existing) return c.json({ success: true, message: 'No challenger to retire.' })

  await retireChallenger(c.env.KV)

  const reason = c.req.query('reason') || 'manual'
  await c.env.DB.prepare(
    `INSERT INTO config_lifecycle_events
     (event_date, event_type, challenger_source, challenger_hash, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    twToday(),
    'retire',
    existing.source,
    existing.hash,
    JSON.stringify({
      reason,
      shadow_duration_days: Math.round((Date.now() - new Date(existing.shadow_since).getTime()) / 86400_000),
    }),
  ).run()

  return c.json({ success: true, retired: existing.hash, reason })
})

adminConfigLifecycleRoutes.get('/api/admin/config/challenger/state', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const row = await c.env.DB.prepare(
    `SELECT state_json, last_eval_json, updated_at FROM config_lifecycle_state WHERE id = 1`
  ).first<{ state_json: string; last_eval_json: string | null; updated_at: string }>()

  if (!row) {
    return c.json({ success: true, state: null, message: 'No eval data yet (weekly cron not fired).' })
  }

  return c.json({
    success: true,
    updated_at: row.updated_at,
    state: JSON.parse(row.state_json),
    last_eval: row.last_eval_json ? JSON.parse(row.last_eval_json) : null,
  })
})

adminConfigLifecycleRoutes.post('/api/admin/config/challenger/eval_commit', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<{ state: any; event: any }>().catch(() => null)
  if (!body?.state || !body?.event) {
    return c.json({ error: 'Body requires { state, event }' }, 400)
  }

  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO config_lifecycle_state (id, state_json, last_eval_json, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state_json = excluded.state_json,
       last_eval_json = excluded.last_eval_json,
       updated_at = excluded.updated_at`
  ).bind(
    JSON.stringify(body.state),
    JSON.stringify(body.event.detail ?? null),
    now,
  ).run()

  await c.env.DB.prepare(
    `INSERT INTO config_lifecycle_events
     (event_date, event_type, challenger_source, champion_hash, challenger_hash,
      sharpe_delta, win_rate_delta, max_dd_delta, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    twToday(),
    body.event.event_type || 'eval_done',
    body.event.challenger_source ?? null,
    body.event.champion_hash ?? null,
    body.event.challenger_hash ?? null,
    body.event.sharpe_delta ?? null,
    body.event.win_rate_delta ?? null,
    body.event.max_dd_delta ?? null,
    JSON.stringify(body.event.detail ?? {}),
  ).run()

  return c.json({ success: true, committed_at: now })
})

adminConfigLifecycleRoutes.post('/api/admin/config/challenger/promote_to_prod', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  if (c.req.header('X-Confirm-Prod') !== 'true') {
    return c.json({ error: 'requires X-Confirm-Prod: true header' }, 400)
  }

  const body = await c.req.json<{ reason?: string }>().catch(() => null) ?? {} as { reason?: string }

  const { getChallenger, setTradingConfig, retireChallenger } = await import('../lib/tradingConfig')
  const ch = await getChallenger(c.env.KV)
  if (!ch) return c.json({ error: 'no active challenger to promote' }, 404)

  const snap = await setTradingConfig(c.env.KV, ch.config, {
    source: 'auto_promote',
    push_id: ch.hash,
  })

  await retireChallenger(c.env.KV)

  await c.env.DB.prepare(
    `INSERT INTO config_lifecycle_events
     (event_date, event_type, challenger_source, challenger_hash, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    twToday(),
    'promote',
    ch.source,
    ch.hash,
    JSON.stringify({
      reason: body?.reason ?? 'auto-promote from weekly_eval',
      promoted_at: new Date().toISOString(),
      new_snapshot_id: snap.snapshotId,
      snapshot_skipped: snap.skipped,
    }),
  ).run()

  if ((c.env as any).DISCORD_WEBHOOK_URL) {
    try {
      const { sendDiscordNotification } = await import('../lib/notify')
      await sendDiscordNotification(
        (c.env as any).DISCORD_WEBHOOK_URL,
        `Config Challenger PROMOTED\nchallenger=${ch.hash} source=${ch.source}\nreason=${body?.reason ?? 'auto'}\nnew_snapshot=${snap.snapshotId}`,
      )
    } catch (e) {
      console.warn('[config/promote_to_prod] discord alert failed (non-blocking)', e)
    }
  }

  return c.json({
    success: true,
    promoted_hash: ch.hash,
    new_snapshot_id: snap.snapshotId,
    snapshot_skipped: snap.skipped,
    retired_at: new Date().toISOString(),
  })
})

adminConfigLifecycleRoutes.get('/api/admin/config/challenger/events', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 20))
  const rows = await c.env.DB.prepare(
    `SELECT id, event_date, event_type, challenger_source, champion_hash, challenger_hash,
            sharpe_delta, win_rate_delta, max_dd_delta, detail, created_at
     FROM config_lifecycle_events ORDER BY id DESC LIMIT ?`
  ).bind(limit).all<any>()

  const events = (rows.results || []).map((r: any) => ({
    ...r,
    detail: r.detail ? (() => { try { return JSON.parse(r.detail) } catch { return r.detail } })() : null,
  }))
  return c.json({ success: true, count: events.length, events })
})
