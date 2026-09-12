import { Hono } from 'hono'
import { requireServiceToken } from '../lib/auth'
import { databaseForDataDomain } from '../lib/dataDomainRegistry'
import type { Bindings, Variables } from '../types'

export const adminConfigCoreRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminConfigCoreRoutes.post('/api/admin/config/strategy-atomic/reconcile', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const payload = await c.req.json<any>().catch(() => null)
  if (!payload) return c.json({ error: 'strategy_atomic_nav_payload_required' }, 400)
  const { reconcileAtomicNavCandidates } = await import('../lib/strategyAtomicNavLifecycle')
  const db = databaseForDataDomain(c.env, 'learning')
  const { getTradingConfig } = await import('../lib/tradingConfig')
  const { hydrateExpectedReturnConfigFromPointers } = await import('../lib/expectedReturnServingRegistry')
  const readCurrent = async () => ({
    tradingConfig: (await hydrateExpectedReturnConfigFromPointers(db,
      await getTradingConfig(c.env.KV, { bypassCache: true }))).config,
    riskConfig: await c.env.KV.get('trading:risk_config', 'json') as Record<string, any>,
  })
  try { return c.json(await reconcileAtomicNavCandidates(db, c.env, payload, undefined, readCurrent)) }
  catch (error) {
    const reason = error instanceof Error ? error.message : ''
    return c.json({ complete: false, owner: 'atomic_strategy', reason:
      /^(strategy_atomic_nav_|atomic_source_)[a-z_]+$/.test(reason) ? reason : 'strategy_atomic_nav_reconciliation_failed' }, 409)
  }
})

adminConfigCoreRoutes.post('/api/admin/config/strategy-atomic/promote', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const payload = await c.req.json<Record<string, any>>().catch(() => null)
  if (!payload) return c.json({ error: 'strategy_atomic_nav_payload_required' }, 400)
  const db = databaseForDataDomain(c.env, 'learning')
  const { adoptNavAtomicStrategy } = await import('../lib/strategyAtomicNavAdoption')
  const { getTradingConfig } = await import('../lib/tradingConfig')
  const { hydrateExpectedReturnConfigFromPointers } = await import('../lib/expectedReturnServingRegistry')
  const readCurrent = async () => ({
    tradingConfig: (await hydrateExpectedReturnConfigFromPointers(db,
      await getTradingConfig(c.env.KV, { bypassCache: true }))).config,
    riskConfig: await c.env.KV.get('trading:risk_config', 'json') as Record<string, any>,
  })
  try { return c.json(await adoptNavAtomicStrategy(db, c.env, payload, readCurrent)) }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'strategy_atomic_nav_publication_failed'
    return c.json({ complete: false, owner: 'atomic_strategy', reason:
      /^(strategy_atomic_nav_|atomic_source_|nav_promotion_)[a-z_]+$/.test(reason) ? reason : 'strategy_atomic_nav_publication_failed' }, 409)
  }
})

adminConfigCoreRoutes.post('/api/admin/config/strategy-route/reconcile', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const payload = await c.req.json<any>().catch(() => null)
  if (!payload) return c.json({ error: 'strategy_route_nav_payload_required' }, 400)
  const { reconcileNavStrategyRoute } = await import('../lib/strategyRouteNavAdoption')
  const db = databaseForDataDomain(c.env, 'learning')
  const { getTradingConfig } = await import('../lib/tradingConfig')
  const { hydrateExpectedReturnConfigFromPointers } = await import('../lib/expectedReturnServingRegistry')
  const readCurrent = async () => ({
    tradingConfig: (await hydrateExpectedReturnConfigFromPointers(db,
      await getTradingConfig(c.env.KV, { bypassCache: true }))).config,
    riskConfig: await c.env.KV.get('trading:risk_config', 'json') as Record<string, any>,
  })
  try { return c.json(await reconcileNavStrategyRoute(db, c.env, payload, undefined, readCurrent)) }
  catch { return c.json({ complete: false, owner: 'l15_route', reason: 'strategy_route_nav_reconciliation_failed' }, 409) }
})

adminConfigCoreRoutes.post('/api/admin/config/strategy-route/promote', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const payload = await c.req.json<Record<string, any>>().catch(() => null)
  if (!payload) return c.json({ error: 'strategy_route_nav_payload_required' }, 400)
  const db = databaseForDataDomain(c.env, 'learning')
  const { adoptNavStrategyRoute } = await import('../lib/strategyRouteNavAdoption')
  const { getTradingConfig } = await import('../lib/tradingConfig')
  const { hydrateExpectedReturnConfigFromPointers } = await import('../lib/expectedReturnServingRegistry')
  const readCurrent = async () => ({
    tradingConfig: (await hydrateExpectedReturnConfigFromPointers(db,
      await getTradingConfig(c.env.KV, { bypassCache: true }))).config,
    riskConfig: await c.env.KV.get('trading:risk_config', 'json') as Record<string, any>,
  })
  try { return c.json(await adoptNavStrategyRoute(db, c.env, payload, readCurrent)) }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'strategy_route_nav_publication_failed'
    return c.json({ complete: false, owner: 'l15_route', reason:
      /^(strategy_route_nav_|nav_promotion_)[a-z_]+$/.test(reason) ? reason : 'strategy_route_nav_publication_failed' }, 409)
  }
})

adminConfigCoreRoutes.get('/api/admin/config', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const learningDb = databaseForDataDomain(c.env, 'learning')

  const { getTradingConfig } = await import('../lib/tradingConfig')
  const { hydrateExpectedReturnConfigFromPointers } = await import('../lib/expectedReturnServingRegistry')
  const config = await getTradingConfig(c.env.KV, { bypassCache: c.req.query('fresh') === '1' })
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

adminConfigCoreRoutes.post('/api/admin/config/opb/promote', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError
  const body = await c.req.json<Record<string, any>>().catch(() => null)
  if (!body || typeof body.artifact_id !== 'string' || typeof body.artifact_checksum !== 'string'
    || !body.prospective_validation || typeof body.prospective_validation !== 'object') {
    return c.json({ error: 'opb_nav_candidate_required' }, 400)
  }
  const outcome = { owner: 'opb_arm_prior', artifact_id: body.artifact_id,
    artifact_checksum: body.artifact_checksum, pointer_committed: false, already_committed: false,
    config_projection_verified: false, control_activation_verified: false }
  try {
    const db = databaseForDataDomain(c.env, 'learning')
    const { getTradingConfig } = await import('../lib/tradingConfig')
    const { hydrateExpectedReturnConfigFromPointers } = await import('../lib/expectedReturnServingRegistry')
    const { commitOpbNavChampion, readOpbNavCommitReceipt, inspectOpbNavComparison, projectOpbNavChampion,
      readOpbNavControlExecution } = await import('../lib/opbNavPublication')
    const identity = { artifactId: body.artifact_id, artifactChecksum: body.artifact_checksum }
    const readCurrent = async () => ({
      tradingConfig: (await hydrateExpectedReturnConfigFromPointers(db,
        await getTradingConfig(c.env.KV, { bypassCache: true }))).config,
      riskConfig: await c.env.KV.get('trading:risk_config', 'json') as Record<string, any>,
    })
    outcome.already_committed = Boolean(await readOpbNavCommitReceipt(db, identity))
    const { reconcileOpbNavPublication } = await import('../lib/opbNavRetirement')
    const retirement = await reconcileOpbNavPublication(db, c.env.KV, identity,
      body.prospective_validation, readCurrent, c.env)
    if (retirement) return c.json(retirement)
    if (!outcome.already_committed) {
      const comparison = await inspectOpbNavComparison(db, { ...identity,
        gate: body.prospective_validation, currentConfigReader: readCurrent, navBindings: c.env })
      if (comparison) return c.json({ ...outcome, success: false, status: 'waiting',
        completion_scope: 'candidate_comparison', comparison })
    }
    const receipt = await commitOpbNavChampion(db, { ...identity,
      gate: body.prospective_validation, currentConfigReader: readCurrent, navBindings: c.env })
    outcome.pointer_committed = true
    const projection = await projectOpbNavChampion(db, c.env.KV, receipt, readCurrent, c.env)
    outcome.config_projection_verified = true
    const control = await readOpbNavControlExecution(db, receipt, projection.config)
    await projection.verifyCurrent()
    outcome.control_activation_verified = control.status === 'completed'
    const complete = control.status !== 'failed'
    return c.json({ ...outcome, schema_version: 'opb-nav-adoption-receipt-v1', completion_scope: 'publication',
      success: complete, status: complete ? 'completed' : 'incomplete', control,
      reason: complete ? null : control.reason, snapshot: projection.snapshot,
      publication_receipt_checksum: receipt.payload_checksum })
  } catch (error) {
    return c.json({ ...outcome, success: false, status: 'incomplete',
      reason: error instanceof Error ? error.message : 'opb_nav_publication_failed' })
  }
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
  const { verifyNavPromotionEvidence } = await import('../lib/pairedNavPromotionEvidence')
  const { verifyNavCurrentContext } = await import('../lib/pairedNavPromotionContext')
  const { getTradingConfig, setTradingConfig, validateTradingConfig } = await import('../lib/tradingConfig')
  const {
    markParameterCandidatePromoted,
    recordParameterCandidateEvidence,
    recordParameterCandidateFromSandbox,
    validatePromotionPacketForProd,
  } = await import('../lib/parameterCandidateRegistry')

  const rawCurrent = await getTradingConfig(c.env.KV) as unknown as Record<string, any>
  const { hydrateExpectedReturnConfigFromPointers, readExpectedReturnCommitReceipt } = await import('../lib/expectedReturnServingRegistry')
  let current = (await hydrateExpectedReturnConfigFromPointers(learningDb, rawCurrent)).config
  const projectCommittedConfig = async (
    identity: Parameters<typeof readExpectedReturnCommitReceipt>[1],
    receipt: NonNullable<Awaited<ReturnType<typeof readExpectedReturnCommitReceipt>>>,
    pushId: string,
  ) => {
    const hydrated = await hydrateExpectedReturnConfigFromPointers(learningDb,
      await getTradingConfig(c.env.KV, { bypassCache: true }))
    const projection = hydrated.projections[identity.owner]
    const before = await readExpectedReturnCommitReceipt(learningDb, identity)
    const damagedOwner = Object.values(hydrated.projections).some(p => !p.valid
      && (p.pointer_present || p.owner_state === 'learned_champion'))
    if (damagedOwner || !projection.valid || projection.champion_artifact_id !== receipt.artifact_id
        || !before || before.payload_checksum !== receipt.payload_checksum) {
      throw new Error('expected_return_projection_pointer_changed')
    }
    const errors = validateTradingConfig(hydrated.config as any)
    if (errors.length) throw new Error(`expected_return_projection_config_invalid:${errors.join(',')}`)
    const snapshot = await setTradingConfig(c.env.KV, hydrated.config as any, {
      source: 'expected_return_oof_auto_promotion', push_id: pushId,
    })
    // Read the backing KV, not getTradingConfig's isolate cache. An acknowledged
    // put or a changed pointer cannot manufacture a successful closure receipt.
    const stored = await c.env.KV.get('trading:config', 'json')
    const after = await readExpectedReturnCommitReceipt(learningDb, identity)
    const currentPointers = await hydrateExpectedReturnConfigFromPointers(learningDb, hydrated.config)
    const pointersChanged = Object.entries(hydrated.projections).some(([owner, p]) => {
      const next = currentPointers.projections[owner as keyof typeof hydrated.projections]
      return next.valid !== p.valid || next.owner_state !== p.owner_state
        || next.champion_artifact_id !== p.champion_artifact_id
        || JSON.stringify(next.artifact) !== JSON.stringify(p.artifact)
    })
    if (JSON.stringify(stored) !== JSON.stringify(hydrated.config)
        || pointersChanged || !after || after.payload_checksum !== receipt.payload_checksum) {
      throw new Error('expected_return_projection_readback_mismatch')
    }
    current = hydrated.config
    return snapshot
  }
  const readCurrentNavConfig = async () => ({
    tradingConfig: (await hydrateExpectedReturnConfigFromPointers(learningDb,
      await getTradingConfig(c.env.KV, { bypassCache: true }))).config,
    riskConfig: await c.env.KV.get('trading:risk_config', 'json') as Record<string, any>,
  })
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
      prospective_validation: rawCandidate.prospective_validation ?? {},
      offline_admission: rawCandidate.offline_admission ?? {},
    }
    const commitIdentity = { owner, artifactId: candidate.artifact_id,
      modelVersion: String(candidate.artifact.model_version ?? ''),
      artifactChecksum: candidate.artifact_checksum, artifactPath: candidate.artifact_path }
    let existingReceipt
    try {
      existingReceipt = await readExpectedReturnCommitReceipt(learningDb, commitIdentity)
    } catch (error) {
      outcomes[owner] = { promoted: false,
        blockers: [`champion_pointer_receipt:${error instanceof Error ? error.message : String(error)}`] }
      continue
    }
    if (existingReceipt) {
      let snapshot = null
      let configProjectionError: string | null = null
      try {
        snapshot = await projectCommittedConfig(commitIdentity, existingReceipt,
          `expected-return-recovery:${existingReceipt.artifact_id}`)
      } catch (error) {
        configProjectionError = error instanceof Error ? error.message : String(error)
      }
      // Maintenance of an already adopted model is not a fresh NAV comparison.
      // Do not create candidates/packets, rewrite history, or consume a review.
      outcomes[owner] = { promoted: true, already_committed: true,
        model_version: commitIdentity.modelVersion, pointer_commit: existingReceipt,
        snapshot, config_projection_error: configProjectionError }
      continue
    }
    let navProof
    let comparisonProof
    let navVerificationError: string | null = null
    try {
      navProof = await verifyNavPromotionEvidence(learningDb, {
        owner, artifactId: candidate.artifact_id, artifactChecksum: candidate.artifact_checksum,
        gate: candidate.prospective_validation,
      })
      comparisonProof = navProof
      const freshConfig = await readCurrentNavConfig()
      current = freshConfig.tradingConfig
      const existing = await learningDb.prepare('SELECT champion_artifact_id FROM model_champion_pointers WHERE model_name=?')
        .bind(owner).first<{ champion_artifact_id: string }>()
      // An already-committed pointer is a non-mutating receipt verification,
      // not a new comparison against the configuration it just replaced.
      if (existing?.champion_artifact_id !== candidate.artifact_id) {
        await verifyNavCurrentContext(learningDb, navProof, async () => freshConfig, c.env)
      }
    } catch (error) {
      navProof = undefined
      navVerificationError = error instanceof Error ? error.message : 'nav_promotion_verification_failed'
    }
    const plan = buildExpectedReturnOwnerPromotionPlan(current, owner, candidate, navProof)
    if (navVerificationError) plan.blockers.push(navVerificationError)
    // ORIGINAL current-context rejection and ineligible plan stay intact.
    // This branch can only report read-only waiting; it cannot promote.
    if (!plan.eligible && comparisonProof && navVerificationError && [
      'nav_promotion_current_configuration_changed', 'nav_promotion_current_ml_baseline_changed',
      'nav_promotion_exact_l4_dependency_changed',
    ].includes(navVerificationError)) {
      const sourcePlan = buildExpectedReturnOwnerPromotionPlan(current, owner, candidate, comparisonProof)
      if (sourcePlan.blockers.every(blocker => owner === 'allocator_ev_fusion' && [
        'fusion_requires_serving_compatible_l4', 'serving_contract:nav_exact_l4_dependency_not_serving',
      ].includes(blocker))) {
        try {
          const { inspectExpectedReturnComparison } = await import('../lib/expectedReturnComparison')
          const comparison = await inspectExpectedReturnComparison(learningDb, {
            owner, artifact: sourcePlan.serving_artifact ?? candidate.artifact,
            artifactId: candidate.artifact_id, artifactPath: candidate.artifact_path,
            artifactChecksum: candidate.artifact_checksum, sourceRunDate: candidate.source_run_date,
            candidateId: plan.candidate_id, promotionPacketId: '',
            prospectiveValidation: candidate.prospective_validation, offlineAdmission: candidate.offline_admission,
            currentConfigReader: readCurrentNavConfig, navBindings: c.env,
          })
          if (comparison) {
            outcomes[owner] = { owner, artifact_id: candidate.artifact_id, artifact_checksum: candidate.artifact_checksum,
              status: 'waiting', promoted: false, pointer_committed: false, already_committed: false,
              completion_scope: 'candidate_comparison', comparison }
            continue
          }
        } catch (error) {
          plan.blockers.push(error instanceof Error ? error.message : 'nav_ev_comparison_verification_failed')
        }
      }
    }
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
      offline_admission: candidate.offline_admission,
      operational_parity: {
        schema_version: candidate.operational_parity.schema_version ?? null,
        owner_decision: candidate.operational_parity.owner_decisions?.[owner] ?? null,
        native_rows: candidate.operational_parity.native_rows ?? null,
        comparable_rows: candidate.operational_parity.comparable_rows ?? null,
        feature_mismatch_count: candidate.operational_parity.feature_mismatch_count ?? null,
        l4_serving_coverage: candidate.operational_parity.l4_serving_coverage ?? null,
        fusion_serving_coverage: candidate.operational_parity.fusion_serving_coverage ?? null,
      },
      prospective_validation: candidate.prospective_validation,
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
        prospectiveValidation: candidate.prospective_validation,
        offlineAdmission: candidate.offline_admission,
        currentConfigReader: readCurrentNavConfig,
        navBindings: c.env,
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
      // Project the freshly re-read config + D1 pointers, not the plan's stale
      // full config. Preserve unrelated changes made during promotion work.
      snapshot = await projectCommittedConfig(commitIdentity, pointerCommit, recorded.promotion_packet_id)
    } catch (error) {
      // D1 pointer + payload is the serving authority. KV is a repairable projection.
      configProjectionError = error instanceof Error ? error.message : String(error)
    }
    await markParameterCandidatePromoted(learningDb, {
      candidateId: plan.candidate_id,
      promotionPacketId: recorded.promotion_packet_id,
      detail: { expected_return_owner: owner, model_version: plan.model_version },
    })
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
  const complete = Object.keys(outcomes).length > 0 && Object.values(outcomes)
    .every(outcome => outcome.promoted === true && outcome.config_projection_error === null)
  const processingComplete = Object.keys(outcomes).length > 0 && Object.values(outcomes)
    .every(outcome => outcome.status === 'waiting' || outcome.promoted === true && outcome.config_projection_error === null)
  const { readCurrentExpectedReturnServingState } = await import('../lib/expectedReturnServingState')
  const effectiveOwner = promotedOwners.length > 0 && promotedOwners.every(owner => outcomes[owner].config_projection_error === null)
    ? (await readCurrentExpectedReturnServingState(c.env)).expected_return_owner : null
  return c.json({
    success: complete,
    effective_owner: effectiveOwner,
    status: complete ? 'promoted' : processingComplete
      ? 'waiting' : promotedOwners.length > 0 ? 'incomplete' : 'failed_validation',
    promoted_owners: promotedOwners,
    processing_complete: processingComplete,
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
