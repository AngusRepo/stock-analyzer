import { Hono } from 'hono'
import { requireServiceToken } from '../lib/auth'
import { databaseForDataDomain } from '../lib/dataDomainRegistry'
import type { Bindings, Variables } from '../types'

export const adminConfigCoreRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminConfigCoreRoutes.get('/api/admin/config', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const learningDb = databaseForDataDomain(c.env, 'learning')

  const { getTradingConfig } = await import('../lib/tradingConfig')
  const { hydrateExpectedReturnConfigFromPointers } = await import('../lib/expectedReturnServingRegistry')
  const config = await getTradingConfig(c.env.KV)
  const hydrated = await hydrateExpectedReturnConfigFromPointers(learningDb, config as any)
  return c.json(hydrated.config)
})

adminConfigCoreRoutes.put('/api/admin/config', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const learningDb = databaseForDataDomain(c.env, 'learning')

  const body = await c.req.json<any>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)

  const { setTradingConfig, getTradingConfig, validateTradingConfig, mergeAlphaFrameworkConfig } = await import('../lib/tradingConfig')
  const current = await getTradingConfig(c.env.KV)
  const requestMeta = body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
    ? body.meta
    : {}
  const snapshotMeta = {
    source: typeof requestMeta.source === 'string' && requestMeta.source.trim()
      ? requestMeta.source.trim().slice(0, 120)
      : 'admin_config_put',
    push_id: typeof requestMeta.push_id === 'string' && requestMeta.push_id.trim()
      ? requestMeta.push_id.trim().slice(0, 240)
      : undefined,
  }
  const mergedPosition = {
    ...current.position,
    ...(body.position ?? {}),
    kelly: { ...current.position.kelly, ...(body.position?.kelly ?? {}) },
    swapWeights: { ...current.position.swapWeights, ...(body.position?.swapWeights ?? {}) },
  }
  const alphaBody = body.alphaFramework ?? body.alpha_framework ?? {}
  const alphaOverlayBody = alphaBody.riskOverlay ?? alphaBody.risk_overlay ?? {}
  const alphaAllocationBody = alphaBody.allocation ?? {}
  const alphaBodyWeights = alphaAllocationBody.weights ?? {}
  const mergedAlphaFramework = mergeAlphaFrameworkConfig({
    ...current.alphaFramework,
    ...alphaBody,
    riskOverlay: {
      ...current.alphaFramework.riskOverlay,
      ...alphaOverlayBody,
    },
    allocation: {
      ...current.alphaFramework.allocation,
      ...alphaAllocationBody,
      weights: {
        bull: { ...current.alphaFramework.allocation.weights.bull, ...(alphaBodyWeights.bull ?? {}) },
        bear: { ...current.alphaFramework.allocation.weights.bear, ...(alphaBodyWeights.bear ?? {}) },
        volatile: { ...current.alphaFramework.allocation.weights.volatile, ...(alphaBodyWeights.volatile ?? {}) },
        sideways: { ...current.alphaFramework.allocation.weights.sideways, ...(alphaBodyWeights.sideways ?? {}) },
      },
    },
  })
  const merged = {
    fees: { ...current.fees, ...body.fees },
    circuit: { ...current.circuit, ...body.circuit },
    exit: { ...current.exit, ...body.exit },
    position: mergedPosition,
    screener: { ...current.screener, ...body.screener },
    rrg: { ...current.rrg, ...body.rrg },
    barrier: { ...current.barrier, ...body.barrier },
    ranking: { ...current.ranking, ...body.ranking },
    ensemble_v2: { ...current.ensemble_v2, ...body.ensemble_v2 },
    mlPool: { ...(current as any).mlPool, ...(body as any).mlPool },
    signal: { ...current.signal, ...body.signal },
    sltp: { ...current.sltp, ...body.sltp },
    L2_formula: { ...current.L2_formula, ...body.L2_formula },
    risk: { ...current.risk, ...(body as any).risk },
    intraday: { ...current.intraday, ...body.intraday },
    momentum: { ...current.momentum, ...body.momentum },
    alphaFramework: mergedAlphaFramework,
  }
  const errors = validateTradingConfig(merged)
  if (errors.length > 0) return c.json({ error: 'Config validation failed', errors }, 400)

  const {
    PRODUCTION_OVERRIDE_HEADER,
    isExplicitProductionOverride,
    recordProductionOverride,
    validatePromotionPacketForProd,
  } = await import('../lib/parameterCandidateRegistry')
  const candidateId = typeof body.candidate_id === 'string' ? body.candidate_id : undefined
  const promotionPacketId = typeof body.promotion_packet_id === 'string' ? body.promotion_packet_id : undefined
  const overrideReason = String(body.override_reason ?? body.reason ?? '').trim()
  const promotionGate = await validatePromotionPacketForProd(learningDb, {
    candidateId,
    promotionPacketId,
  })
  const override = isExplicitProductionOverride(c.req.header(PRODUCTION_OVERRIDE_HEADER), overrideReason)
  if (!promotionGate.ok && !override) {
    return c.json({
      error: 'config_put_requires_promotion_packet_or_override',
      reason: promotionGate.error,
      hint: `Attach promotion_packet_id + candidate_id, or use ${PRODUCTION_OVERRIDE_HEADER}: true with override_reason.`,
    }, 400)
  }
  const overrideAudit = !promotionGate.ok
    ? await recordProductionOverride(learningDb, {
      route: '/api/admin/config',
      reason: overrideReason,
      candidateId,
      promotionPacketId,
      detail: { source: 'direct_put' },
    })
    : null

  const snapshot = await setTradingConfig(c.env.KV, merged, {
    ...snapshotMeta,
    source: overrideAudit ? 'manual_override' : 'parameter_promotion',
    push_id: promotionPacketId ?? snapshotMeta.push_id,
  })
  return c.json({
    success: true,
    config: merged,
    snapshot,
    promotion_packet_id: promotionPacketId ?? null,
    override_audit_id: overrideAudit?.audit_id ?? null,
  })
})

adminConfigCoreRoutes.post('/api/admin/config/expected-return/promote', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const learningDb = databaseForDataDomain(c.env, 'learning')

  const body = await c.req.json<{
    l4_alpha_ev?: Record<string, any>
    allocator_ev_fusion?: Record<string, any>
  }>().catch(() => null)
  if (!body || (!body.l4_alpha_ev && !body.allocator_ev_fusion)) {
    return c.json({ error: 'expected_return_candidate_required' }, 400)
  }

  const { buildExpectedReturnOwnerPromotionPlan } = await import('../lib/expectedReturnArtifactPromotion')
  const { getTradingConfig, setTradingConfig, validateTradingConfig } = await import('../lib/tradingConfig')
  const {
    markParameterCandidatePromoted,
    recordParameterCandidateEvidence,
    recordParameterCandidateFromSandbox,
    validatePromotionPacketForProd,
  } = await import('../lib/parameterCandidateRegistry')

  const rawCurrent = await getTradingConfig(c.env.KV) as unknown as Record<string, any>
  const { hydrateExpectedReturnConfigFromPointers } = await import('../lib/expectedReturnServingRegistry')
  let current = (await hydrateExpectedReturnConfigFromPointers(learningDb, rawCurrent)).config
  const outcomes: Record<string, any> = {}
  const orderedCandidates = [
    ['l4_alpha_ev', body.l4_alpha_ev],
    ['allocator_ev_fusion', body.allocator_ev_fusion],
  ] as const

  for (const [owner, rawCandidate] of orderedCandidates) {
    if (!rawCandidate) continue
    const candidate = {
      artifact_id: String(rawCandidate.artifact_id ?? ''),
      artifact: rawCandidate.artifact ?? {},
      validation_packet: rawCandidate.validation_packet ?? {},
      operational_parity: rawCandidate.operational_parity ?? {},
      cohort_id: String(rawCandidate.cohort_id ?? ''),
      source_run_date: String(rawCandidate.source_run_date ?? ''),
      artifact_path: String(rawCandidate.artifact_path ?? ''),
      artifact_checksum: String(rawCandidate.artifact_checksum ?? ''),
    }
    const plan = buildExpectedReturnOwnerPromotionPlan(current, owner, candidate)
    await recordParameterCandidateFromSandbox(learningDb, {
      source: 'expected_return_oof',
      candidateId: plan.candidate_id,
      cadence: String(rawCandidate.cadence ?? 'oof'),
      runId: candidate.cohort_id,
      status: 'SHADOW_COLLECTING',
      metadata: {
        expected_return_owner: owner,
        model_version: plan.model_version,
        cohort_id: candidate.cohort_id,
        source_run_date: candidate.source_run_date,
        artifact_path: candidate.artifact_path,
        artifact_checksum: candidate.artifact_checksum,
        mutates_trading_config: true,
        production_gate: 'owner_quality_plus_owner_operational_parity',
      },
    })
    const evidence = {
      schema_version: 'expected-return-owner-promotion-evidence-v1',
      candidate_id: plan.candidate_id,
      source: 'active8_oof',
      owner,
      decision: plan.eligible ? 'PASS' : 'FAIL',
      validation_status: plan.eligible ? 'PROMOTION_READY' : 'EVIDENCE_INSUFFICIENT',
      model_version: plan.model_version,
      cohort_id: candidate.cohort_id,
      source_run_date: candidate.source_run_date,
      artifact_path: candidate.artifact_path,
      artifact_checksum: candidate.artifact_checksum,
      blockers: plan.blockers,
      offline_validation: {
        schema_version: candidate.validation_packet.schema_version ?? null,
        decision: candidate.validation_packet.decision ?? null,
        failed_gates: candidate.validation_packet.failed_gates ?? [],
      },
      operational_parity: {
        schema_version: candidate.operational_parity.schema_version ?? null,
        owner_decision: candidate.operational_parity.owner_decisions?.[owner] ?? null,
        native_rows: candidate.operational_parity.native_rows ?? null,
        comparable_rows: candidate.operational_parity.comparable_rows ?? null,
        feature_mismatch_count: candidate.operational_parity.feature_mismatch_count ?? null,
        l4_serving_coverage: candidate.operational_parity.l4_serving_coverage ?? null,
        fusion_serving_coverage: candidate.operational_parity.fusion_serving_coverage ?? null,
      },
      serving_state: plan.serving_state,
      validation_packet: {
        schema_version: 'expected-return-owner-promotion-packet-v1',
        decision: plan.eligible ? 'PASS' : 'FAIL',
        owner,
        model_version: plan.model_version,
        cohort_id: candidate.cohort_id,
        artifact_path: candidate.artifact_path,
        artifact_checksum: candidate.artifact_checksum,
        blockers: plan.blockers,
      },
      gate: {
        decision: plan.eligible ? 'PASS' : 'FAIL',
        validation_packet: { decision: plan.eligible ? 'PASS' : 'FAIL' },
      },
    }
    const recorded = await recordParameterCandidateEvidence(learningDb, {
      candidateId: plan.candidate_id,
      evidenceType: 'expected_return_owner_quality_and_parity',
      decision: plan.eligible ? 'PASS' : 'FAIL',
      evidence,
    })
    if (!plan.eligible || !recorded.promotion_packet_id) {
      outcomes[owner] = {
        promoted: false,
        candidate_id: plan.candidate_id,
        promotion_packet_id: recorded.promotion_packet_id,
        blockers: plan.blockers,
      }
      continue
    }

    const promotionGate = await validatePromotionPacketForProd(learningDb, {
      candidateId: plan.candidate_id,
      promotionPacketId: recorded.promotion_packet_id,
    })
    const configErrors = validateTradingConfig(plan.next_config as any)
    if (!promotionGate.ok || configErrors.length > 0) {
      outcomes[owner] = {
        promoted: false,
        candidate_id: plan.candidate_id,
        promotion_packet_id: recorded.promotion_packet_id,
        blockers: [
          ...(!promotionGate.ok ? [`promotion_packet:${promotionGate.error}`] : []),
          ...configErrors.map((error) => `config_validation:${error}`),
        ],
      }
      continue
    }

    const { commitExpectedReturnChampion } = await import('../lib/expectedReturnServingRegistry')
    let pointerCommit: Awaited<ReturnType<typeof commitExpectedReturnChampion>>
    try {
      pointerCommit = await commitExpectedReturnChampion(learningDb, {
        owner,
        artifact: plan.serving_artifact ?? {},
        artifactId: candidate.artifact_id,
        artifactPath: candidate.artifact_path,
        artifactChecksum: candidate.artifact_checksum,
        promotionPacketId: recorded.promotion_packet_id,
        candidateId: plan.candidate_id,
        sourceRunDate: candidate.source_run_date,
      })
    } catch (error) {
      outcomes[owner] = {
        promoted: false,
        candidate_id: plan.candidate_id,
        promotion_packet_id: recorded.promotion_packet_id,
        blockers: [`champion_pointer_commit:${error instanceof Error ? error.message : String(error)}`],
      }
      continue
    }
    let snapshot: Awaited<ReturnType<typeof setTradingConfig>> | null = null
    let configProjectionError: string | null = null
    try {
      snapshot = await setTradingConfig(c.env.KV, plan.next_config as any, {
        source: 'expected_return_oof_auto_promotion',
        push_id: recorded.promotion_packet_id,
      })
    } catch (error) {
      // D1 pointer + payload is the serving authority. KV is a repairable projection.
      configProjectionError = error instanceof Error ? error.message : String(error)
    }
    await markParameterCandidatePromoted(learningDb, {
      candidateId: plan.candidate_id,
      promotionPacketId: recorded.promotion_packet_id,
      detail: { expected_return_owner: owner, model_version: plan.model_version },
    })
    current = plan.next_config
    outcomes[owner] = {
      promoted: true,
      candidate_id: plan.candidate_id,
      promotion_packet_id: recorded.promotion_packet_id,
      model_version: plan.model_version,
      snapshot,
      serving_state: plan.serving_state,
      pointer_commit: pointerCommit,
      config_projection_error: configProjectionError,
    }
  }

  const promotedOwners = Object.entries(outcomes)
    .filter(([, outcome]) => outcome?.promoted === true)
    .map(([owner]) => owner)
  return c.json({
    success: promotedOwners.length > 0,
    status: promotedOwners.length > 0 ? 'promoted' : 'failed_validation',
    promoted_owners: promotedOwners,
    outcomes,
  })
})

adminConfigCoreRoutes.post('/api/admin/config/push-defaults', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const learningDb = databaseForDataDomain(c.env, 'learning')
  const body = await c.req.json<any>().catch(() => null) ?? {}

  const { getTradingConfig, setTradingConfig, buildChampionTradingConfig } = await import('../lib/tradingConfig')
  let current: Awaited<ReturnType<typeof getTradingConfig>>
  try {
    current = await getTradingConfig(c.env.KV)
  } catch (error: any) {
    return c.json({
      error: 'Current trading config unavailable; refusing to push defaults over an unverified source',
      detail: error?.message ?? String(error),
    }, 409)
  }
  const filled = buildChampionTradingConfig(current as any)

  const overrideReason = String(body.override_reason ?? body.reason ?? '').trim()
  const { PRODUCTION_OVERRIDE_HEADER, isExplicitProductionOverride, recordProductionOverride } = await import('../lib/parameterCandidateRegistry')
  if (!isExplicitProductionOverride(c.req.header(PRODUCTION_OVERRIDE_HEADER), overrideReason)) {
    return c.json({
      error: 'push_defaults_requires_production_override',
      hint: `Use ${PRODUCTION_OVERRIDE_HEADER}: true with override_reason.`,
    }, 400)
  }
  const overrideAudit = await recordProductionOverride(learningDb, {
    route: '/api/admin/config/push-defaults',
    reason: overrideReason,
    detail: { source: 'push_defaults' },
  })

  await setTradingConfig(c.env.KV, filled as any, {
    source: 'manual_override',
    push_id: overrideAudit.audit_id,
  })
  return c.json({
    success: true,
    override_audit_id: overrideAudit.audit_id,
    message: 'Schema defaults 已補齊到 KV，既有值會保留',
    config: filled,
  })
})

adminConfigCoreRoutes.get('/api/admin/config/repair-plan', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const { buildTradingConfigRepairPlan } = await import('../lib/tradingConfig')
  const plan = await buildTradingConfigRepairPlan(c.env.KV)
  return c.json({
    ...plan,
    production_effect: false,
  })
})

adminConfigCoreRoutes.post('/api/admin/config/repair-critical-defaults', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => ({}))
  const dryRun = body?.dry_run !== false
  const { buildTradingConfigRepairPlan, repairTradingConfigOperationalDefaults } = await import('../lib/tradingConfig')

  if (dryRun) {
    const plan = await buildTradingConfigRepairPlan(c.env.KV)
    return c.json({
      success: true,
      mode: 'dry_run',
      production_effect: false,
      would_write: plan.needsRepair,
      ...plan,
    })
  }

  if (c.req.header('X-Confirm-Trading-Config') !== 'true') {
    return c.json({
      error: 'X-Confirm-Trading-Config=true required to write trading:config operational defaults',
      production_effect: false,
    }, 400)
  }

  try {
    const result = await repairTradingConfigOperationalDefaults(c.env.KV)
    return c.json({
      success: true,
      mode: result.written ? 'persisted' : 'no_op',
      production_effect: result.written,
      ...result,
    })
  } catch (error: any) {
    return c.json({
      error: 'trading_config_repair_failed',
      detail: error?.message ?? String(error),
      production_effect: false,
    }, 409)
  }
})

adminConfigCoreRoutes.get('/api/admin/risk-config', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const { buildRiskConfigRepairPlan } = await import('../lib/riskConfig')
  const plan = await buildRiskConfigRepairPlan(c.env.KV)
  return c.json({
    ...plan,
    production_effect: false,
  })
})

adminConfigCoreRoutes.post('/api/admin/risk-config/push-defaults', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => ({}))
  const dryRun = body?.dry_run !== false
  const { buildRiskConfigRepairPlan, seedRiskConfigDefaults } = await import('../lib/riskConfig')

  if (dryRun) {
    const plan = await buildRiskConfigRepairPlan(c.env.KV)
    return c.json({
      success: true,
      mode: 'dry_run',
      production_effect: false,
      would_write: plan.needsRepair,
      ...plan,
    })
  }

  if (c.req.header('X-Confirm-Risk-Config') !== 'true') {
    return c.json({
      error: 'X-Confirm-Risk-Config=true required to write trading:risk_config defaults',
      production_effect: false,
    }, 400)
  }

  try {
    const result = await seedRiskConfigDefaults(c.env.KV)
    return c.json({
      success: true,
      mode: result.written ? 'persisted' : 'no_op',
      production_effect: result.written,
      ...result,
    })
  } catch (error: any) {
    return c.json({
      error: 'risk_config_push_defaults_failed',
      detail: error?.message ?? String(error),
      production_effect: false,
    }, 409)
  }
})

adminConfigCoreRoutes.get('/api/admin/kv-get', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const key = c.req.query('key')
  if (!key) return c.json({ error: 'Missing ?key= param' }, 400)

  const type = (c.req.query('type') ?? 'text').toLowerCase()
  const value = type === 'json'
    ? await c.env.KV.get(key, 'json')
    : await c.env.KV.get(key, 'text')

  if (value === null) return c.json({ key, value: null, exists: false }, 404)
  return c.json({ key, value, exists: true })
})
