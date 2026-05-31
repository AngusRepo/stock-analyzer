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
    candidate_id?: string
    promotion_packet_id?: string
    override_reason?: string
    evidence_packet?: Record<string, unknown>
    gate?: { decision?: string; passed?: boolean; failed_gates?: string[]; validation_packet?: Record<string, unknown> }
  }>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const { getSandboxEntry, setChallenger } = await import('../lib/tradingConfig')
  const {
    candidateIdFromSandbox,
    evidenceDecision,
    isExplicitProductionOverride,
    recordParameterCandidateEvidence,
    recordParameterCandidateFromSandbox,
    recordParameterCandidateEvent,
    validateParameterCandidateEvidencePacket,
  } = await import('../lib/parameterCandidateRegistry')

  let config: any
  let source: string
  let sourceId: string | undefined
  let candidateId = typeof body.candidate_id === 'string' ? body.candidate_id : undefined
  let evidencePacket: Record<string, unknown> | null = body.evidence_packet ?? null

  if (body.sandbox_id) {
    const entry = await getSandboxEntry(c.env.KV, body.sandbox_id)
    if (!entry) return c.json({ error: 'sandbox entry not found' }, 404)
    candidateId = candidateId ?? candidateIdFromSandbox(entry.source, body.sandbox_id)
    if (!evidencePacket && body.gate) {
      evidencePacket = {
        ...body.gate,
        candidate_id: candidateId,
        promotion_packet_id: body.promotion_packet_id ?? null,
      }
    }
    await recordParameterCandidateFromSandbox(c.env.DB, {
      source: entry.source,
      sandboxId: body.sandbox_id,
      candidateId,
      configHash: entry.hash,
      cadence: typeof entry.metadata?.cadence === 'string' ? entry.metadata.cadence : undefined,
      runId: typeof entry.metadata?.run_id === 'string' ? entry.metadata.run_id : entry.push_id,
      metadata: {
        sandbox_pushed_at: entry.pushed_at,
        note: entry.note ?? null,
        metadata: entry.metadata ?? null,
      },
    })
    const validation = await validateParameterCandidateEvidencePacket(c.env.DB, {
      candidateId,
      promotionPacketId: body.promotion_packet_id,
      evidencePacket,
    })
    if (!validation.ok) {
      return c.json({
        error: 'parameter_candidate_requires_evidence_packet',
        reason: validation.error,
        hint: 'Attach candidate_id + PASS evidence_packet from /config_pool/parameter_candidates/validation_chain before moving any parameter source to challenger.',
        failed_gates: body.gate?.failed_gates ?? null,
      }, 400)
    }
    if (evidencePacket) {
      await recordParameterCandidateEvidence(c.env.DB, {
        candidateId,
        evidence: evidencePacket,
        decision: evidenceDecision(evidencePacket),
        promotionPacketId: body.promotion_packet_id ?? (String(evidencePacket.promotion_packet_id ?? '') || null),
        evidenceType: 'challenger_gate',
      })
    }
    config = entry.config
    source = `sandbox:${entry.source}`
    sourceId = body.sandbox_id
  } else if (body.config) {
    const overrideReason = String(body.override_reason ?? body.note ?? '').trim()
    if (!isExplicitProductionOverride(c.req.header('X-Confirm-Config-Override'), overrideReason)) {
      return c.json({
        error: 'manual_challenger_requires_candidate_evidence_or_config_override',
        hint: 'Use a sandbox candidate with evidence, or add X-Confirm-Config-Override: true and override_reason.',
      }, 400)
    }
    config = body.config
    source = 'manual'
    await recordParameterCandidateEvent(c.env.DB, null, 'manual_challenger_override', {
      reason: overrideReason,
      note: body.note ?? null,
    })
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
    JSON.stringify({
      source_id: sourceId,
      candidate_id: candidateId ?? null,
      promotion_packet_id: body.promotion_packet_id ?? null,
      note: body.note,
      shadow_since: state.shadow_since,
      gate: body.gate ?? null,
      evidence_packet: evidencePacket ?? null,
    }),
  ).run()

  return c.json({
    success: true,
    candidate_id: candidateId ?? null,
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

adminConfigLifecycleRoutes.get('/api/admin/config/parameter-candidates', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const { ensureParameterCandidateTables } = await import('../lib/parameterCandidateRegistry')
  await ensureParameterCandidateTables(c.env.DB)
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50))
  const rows = await c.env.DB.prepare(
    `SELECT candidate_id, source, config_hash, sandbox_id, cadence, run_id, status,
            metadata_json, latest_evidence_json, promotion_packet_id, created_at, updated_at
     FROM parameter_candidate_registry
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).bind(limit).all<any>()

  const parse = (raw: any) => {
    if (!raw) return null
    try { return JSON.parse(String(raw)) } catch { return raw }
  }
  return c.json({
    success: true,
    states: [
      'NO_CANDIDATE',
      'SHADOW_COLLECTING',
      'VALIDATION_BLOCKED',
      'EVIDENCE_INSUFFICIENT',
      'NOT_PROMOTION_READY',
      'INFRA_BLOCKED',
      'PROMOTION_READY',
      'APPROVAL_REQUIRED',
      'PROD_ACTIVE',
    ],
    count: rows.results?.length ?? 0,
    candidates: (rows.results || []).map((row: any) => ({
      ...row,
      metadata: parse(row.metadata_json),
      latest_evidence: parse(row.latest_evidence_json),
      metadata_json: undefined,
      latest_evidence_json: undefined,
    })),
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

  const body = await c.req.json<{
    reason?: string
    candidate_id?: string
    promotion_packet_id?: string
    override_reason?: string
  }>().catch(() => null) ?? {} as {
    reason?: string
    candidate_id?: string
    promotion_packet_id?: string
    override_reason?: string
  }

  const { getChallenger, setTradingConfig, retireChallenger } = await import('../lib/tradingConfig')
  const {
    PRODUCTION_OVERRIDE_HEADER,
    candidateIdFromSandbox,
    isExplicitProductionOverride,
    recordProductionOverride,
    validatePromotionPacketForProd,
  } = await import('../lib/parameterCandidateRegistry')
  const ch = await getChallenger(c.env.KV)
  if (!ch) return c.json({ error: 'no active challenger to promote' }, 404)
  const sourceName = ch.source.startsWith('sandbox:') ? ch.source.slice('sandbox:'.length) : ch.source
  const candidateId = body.candidate_id
    ?? (ch.source_id ? candidateIdFromSandbox(sourceName, ch.source_id) : undefined)
  const promotionGate = await validatePromotionPacketForProd(c.env.DB, {
    candidateId,
    promotionPacketId: body.promotion_packet_id,
  })
  const overrideReason = String(body.override_reason ?? body.reason ?? '').trim()
  const override = isExplicitProductionOverride(c.req.header(PRODUCTION_OVERRIDE_HEADER), overrideReason)
  if (!promotionGate.ok && !override) {
    return c.json({
      error: 'prod_promote_requires_promotion_packet_or_override',
      reason: promotionGate.error,
      hint: `Attach promotion_packet_id + candidate_id, or use ${PRODUCTION_OVERRIDE_HEADER}: true with override_reason.`,
    }, 400)
  }
  const overrideAudit = !promotionGate.ok
    ? await recordProductionOverride(c.env.DB, {
      route: '/api/admin/config/challenger/promote_to_prod',
      reason: overrideReason,
      candidateId,
      promotionPacketId: body.promotion_packet_id,
      detail: { challenger_hash: ch.hash, challenger_source: ch.source },
    })
    : null

  const snap = await setTradingConfig(c.env.KV, ch.config, {
    source: overrideAudit ? 'manual_override' : 'parameter_promotion',
    push_id: body.promotion_packet_id ?? ch.hash,
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
      reason: body?.reason ?? 'parameter promotion controller',
      promoted_at: new Date().toISOString(),
      new_snapshot_id: snap.snapshotId,
      snapshot_skipped: snap.skipped,
      candidate_id: candidateId ?? null,
      promotion_packet_id: body.promotion_packet_id ?? null,
      override_audit_id: overrideAudit?.audit_id ?? null,
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
    candidate_id: candidateId ?? null,
    promotion_packet_id: body.promotion_packet_id ?? null,
    override_audit_id: overrideAudit?.audit_id ?? null,
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
