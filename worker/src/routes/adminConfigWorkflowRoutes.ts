import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'

export const adminConfigWorkflowRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminConfigWorkflowRoutes.get('/api/admin/config/snapshots', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const { listSnapshots } = await import('../lib/tradingConfig')
  const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 20))
  const snapshots = await listSnapshots(c.env.KV, limit)
  return c.json({ success: true, count: snapshots.length, snapshots })
})

adminConfigWorkflowRoutes.get('/api/admin/config/snapshots/:id{.+}', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const { getSnapshot } = await import('../lib/tradingConfig')
  const id = c.req.param('id')
  if (!id || !id.startsWith('trading:config:snapshot:')) {
    return c.json({ error: 'snapshot id must start with trading:config:snapshot:' }, 400)
  }

  const snap = await getSnapshot(c.env.KV, id)
  if (!snap) return c.json({ error: 'snapshot not found (expired or never existed)' }, 404)
  return c.json({ success: true, id, ...snap })
})

adminConfigWorkflowRoutes.post('/api/admin/config/restore', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<{
    snapshot_id?: string
    dry_run?: boolean
    reason?: string
  }>().catch(() => null)
  if (!body?.snapshot_id) {
    return c.json({ error: 'Body requires { snapshot_id, dry_run?, reason? }' }, 400)
  }

  const dryRun = body.dry_run !== false
  const { getSnapshot, getTradingConfig, restoreSnapshot } = await import('../lib/tradingConfig')
  const { diffConfig, summarizeDiff } = await import('../lib/configDiff')

  const target = await getSnapshot(c.env.KV, body.snapshot_id)
  if (!target) return c.json({ error: 'snapshot not found (expired or never existed)' }, 404)

  const current = await getTradingConfig(c.env.KV)
  const diff = diffConfig(current, target.config)

  if (dryRun) {
    return c.json({
      success: true,
      mode: 'dry_run',
      snapshot_id: body.snapshot_id,
      target_pushed_at: target.pushed_at,
      target_source: target.meta.source,
      diff_summary: summarizeDiff(diff),
      diff,
      hint: 'Re-POST with dry_run=false + header X-Confirm-Restore: true to apply.',
    })
  }

  if (c.req.header('X-Confirm-Restore') !== 'true') {
    return c.json({
      error: 'Real restore requires header X-Confirm-Restore: true',
      hint: 'Run with dry_run=true first to preview diff, then re-POST with header.',
    }, 400)
  }

  const result = await restoreSnapshot(c.env.KV, body.snapshot_id, {
    restore_reason: body.reason,
  })
  if (!result) return c.json({ error: 'restore target vanished mid-operation' }, 409)

  const auditKey = `audit:config-restore:${twToday()}`
  await c.env.KV.put(auditKey, JSON.stringify({
    restored_from: body.snapshot_id,
    new_snapshot_id: result.snapshotId,
    skipped: result.skipped,
    reason: body.reason ?? null,
    diff_summary: summarizeDiff(diff),
    restored_at: new Date().toISOString(),
  }), { expirationTtl: 90 * 86400 })

  return c.json({
    success: true,
    mode: 'restored',
    restored_from: body.snapshot_id,
    new_snapshot_id: result.snapshotId,
    skipped: result.skipped,
    audit_key: auditKey,
    diff_summary: summarizeDiff(diff),
  })
})

adminConfigWorkflowRoutes.get('/api/admin/config/sandbox', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const { listSandbox } = await import('../lib/tradingConfig')
  const limit = Math.max(1, Math.min(50, Number(c.req.query('limit')) || 20))
  const source = c.req.query('source') || undefined
  const entries = await listSandbox(c.env.KV, limit, source)
  return c.json({ success: true, count: entries.length, source_filter: source ?? null, entries })
})

adminConfigWorkflowRoutes.get('/api/admin/config/sandbox/:id{.+}', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const id = c.req.param('id')
  if (!id || !id.startsWith('trading:config:sandbox:')) {
    return c.json({ error: 'sandbox id must start with trading:config:sandbox:' }, 400)
  }

  const { getSandboxEntry } = await import('../lib/tradingConfig')
  const entry = await getSandboxEntry(c.env.KV, id)
  if (!entry) return c.json({ error: 'sandbox entry not found (expired or never existed)' }, 404)
  return c.json({ success: true, id, ...entry })
})

adminConfigWorkflowRoutes.post('/api/admin/config/promote', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<{
    sandbox_id?: string
    dry_run?: boolean
    reason?: string
    candidate_id?: string
    promotion_packet_id?: string
    override_reason?: string
  }>().catch(() => null)
  if (!body?.sandbox_id) {
    return c.json({ error: 'Body requires { sandbox_id, dry_run?, reason? }' }, 400)
  }

  const dryRun = body.dry_run !== false
  const { getSandboxEntry, getTradingConfig, promoteSandbox } = await import('../lib/tradingConfig')
  const { diffConfig, summarizeDiff } = await import('../lib/configDiff')
  const {
    PRODUCTION_OVERRIDE_HEADER,
    candidateIdFromSandbox,
    isExplicitProductionOverride,
    recordProductionOverride,
    validatePromotionPacketForProd,
  } = await import('../lib/parameterCandidateRegistry')

  const sandbox = await getSandboxEntry(c.env.KV, body.sandbox_id)
  if (!sandbox) return c.json({ error: 'sandbox entry not found (expired or never existed)' }, 404)

  const current = await getTradingConfig(c.env.KV)
  const diff = diffConfig(current, sandbox.config)

  if (dryRun) {
    return c.json({
      success: true,
      mode: 'dry_run',
      sandbox_id: body.sandbox_id,
      sandbox_source: sandbox.source,
      sandbox_pushed_at: sandbox.pushed_at,
      diff_summary: summarizeDiff(diff),
      diff,
      hint: 'Re-POST with dry_run=false + X-Confirm-Prod: true plus promotion_packet_id, or explicit X-Confirm-Production-Override: true with override_reason.',
    })
  }

  if (c.req.header('X-Confirm-Prod') !== 'true') {
    return c.json({
      error: 'Real promote requires header X-Confirm-Prod: true',
      hint: 'Run with dry_run=true first to preview diff.',
    }, 400)
  }
  const candidateId = body.candidate_id ?? candidateIdFromSandbox(sandbox.source, body.sandbox_id)
  const promotionGate = await validatePromotionPacketForProd(c.env.DB, {
    candidateId,
    promotionPacketId: body.promotion_packet_id,
  })
  const overrideReason = String(body.override_reason ?? body.reason ?? '').trim()
  const override = isExplicitProductionOverride(c.req.header(PRODUCTION_OVERRIDE_HEADER), overrideReason)
  if (!promotionGate.ok && !override) {
    return c.json({
      error: 'config_promote_requires_promotion_packet_or_override',
      reason: promotionGate.error,
      hint: `Attach promotion_packet_id + candidate_id, or use ${PRODUCTION_OVERRIDE_HEADER}: true with override_reason.`,
    }, 400)
  }
  const overrideAudit = !promotionGate.ok
    ? await recordProductionOverride(c.env.DB, {
      route: '/api/admin/config/promote',
      reason: overrideReason,
      candidateId,
      promotionPacketId: body.promotion_packet_id,
      detail: {
        sandbox_id: body.sandbox_id,
        sandbox_source: sandbox.source,
        diff_summary: summarizeDiff(diff),
      },
    })
    : null

  const result = await promoteSandbox(c.env.KV, body.sandbox_id, {
    reason: body.reason,
    push_id: body.promotion_packet_id,
  })
  if (!result) return c.json({ error: 'sandbox entry vanished mid-operation' }, 409)

  const auditKey = `audit:config-promote:${twToday()}`
  await c.env.KV.put(auditKey, JSON.stringify({
    promoted_from: body.sandbox_id,
    source: sandbox.source,
    new_snapshot_id: result.snapshotId,
    skipped: result.skipped,
    reason: body.reason ?? null,
    diff_summary: summarizeDiff(diff),
    candidate_id: candidateId,
    promotion_packet_id: body.promotion_packet_id ?? null,
    override_audit_id: overrideAudit?.audit_id ?? null,
    promoted_at: new Date().toISOString(),
  }), { expirationTtl: 90 * 86400 })

  return c.json({
    success: true,
    mode: 'promoted',
    promoted_from: body.sandbox_id,
    candidate_id: candidateId,
    promotion_packet_id: body.promotion_packet_id ?? null,
    override_audit_id: overrideAudit?.audit_id ?? null,
    new_snapshot_id: result.snapshotId,
    skipped: result.skipped,
    audit_key: auditKey,
    diff_summary: summarizeDiff(diff),
  })
})
