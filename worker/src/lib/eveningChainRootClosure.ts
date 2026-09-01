import {
  loadLatestSchedulerRootTicket,
  updateSchedulerExecutionTicket,
  type SchedulerExecutionTicketRow,
} from './schedulerExecutionTickets'

const REQUIRED_STAGES = [
  'pipeline_execution',
  'post_pipeline_chain',
  'verify_v2',
  'screener_v2',
  'post_verify_chain',
] as const

type RequiredStage = typeof REQUIRED_STAGES[number]

type StageRow = {
  stage: string
  canonical_run_id: string
  status: string
  cursor_key: string | null
}

type StrategyLearningClosureRow = {
  canonical_run_id: string
  producer_run_id: string | null
  status: string
  expected_candidates: number
  processed_candidates: number
  expected_decision_rows: number
  persisted_decision_rows: number
  production_authority_intent: number
  policy_closure_status: string
  completed_at: string | null
}

type Active8ChildRow = SchedulerExecutionTicketRow & {
  snapshot_status: string | null
  snapshot_run_id: string | null
}

export type EveningChainRootClosureOutcome = {
  status: 'closed_success' | 'closed_error' | 'pending' | 'not_applicable'
  business_date: string
  canonical_run_id: string | null
  root_ticket_id: string | null
  blockers: string[]
  summary: string
}

function parseMetadata(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

async function resolveCanonicalRunId(
  db: D1Database,
  businessDate: string,
  expectedCanonicalRunId?: string,
): Promise<string | null> {
  const expected = String(expectedCanonicalRunId ?? '').trim()
  if (expected) return expected
  const row = await db.prepare(`
    SELECT canonical_run_id
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='post_verify_chain'
     LIMIT 1
  `).bind(businessDate).first<{ canonical_run_id?: string | null }>()
  return String(row?.canonical_run_id ?? '').trim() || null
}

async function loadActive8Child(
  db: D1Database,
  rootTicketId: string,
): Promise<Active8ChildRow | null> {
  return db.prepare(`
    SELECT active8.*,
           snapshot.status AS snapshot_status,
           snapshot.run_id AS snapshot_run_id
      FROM scheduler_execution_tickets_v1 active8
      LEFT JOIN scheduler_execution_tickets_v1 snapshot
        ON snapshot.ticket_id=active8.parent_ticket_id
       AND snapshot.root_ticket_id=active8.root_ticket_id
       AND snapshot.task='dataset-snapshot-export'
     WHERE active8.root_ticket_id=?
       AND active8.ticket_kind='logical_child'
       AND active8.task='active8-oof-daily'
       AND json_extract(active8.metadata_json, '$.origin')='dataset_snapshot_ready'
     ORDER BY active8.updated_at DESC, active8.ticket_id DESC
     LIMIT 1
  `).bind(rootTicketId).first<Active8ChildRow>()
}

function terminalFailure(status: string): boolean {
  return status === 'error' || status === 'blocked' || status === 'skipped'
}

export async function closeEveningChainRootIfComplete(
  db: D1Database,
  input: { businessDate: string; canonicalRunId?: string },
): Promise<EveningChainRootClosureOutcome> {
  const businessDate = String(input.businessDate ?? '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error(`evening_chain_root_closure_date_invalid:${businessDate}`)
  }
  const root = await loadLatestSchedulerRootTicket(db, {
    schedulerJobId: 'evening-chain',
    businessDate,
  })
  if (!root) {
    return {
      status: 'not_applicable',
      business_date: businessDate,
      canonical_run_id: null,
      root_ticket_id: null,
      blockers: ['evening_chain_physical_root_missing'],
      summary: `evening-chain durable root absent date=${businessDate}`,
    }
  }
  if (root.status === 'success' || terminalFailure(root.status)) {
    return {
      status: root.status === 'success' ? 'closed_success' : 'closed_error',
      business_date: businessDate,
      canonical_run_id: String(input.canonicalRunId ?? '').trim() || null,
      root_ticket_id: root.ticket_id,
      blockers: root.status === 'success' ? [] : [root.last_error || `root_${root.status}`],
      summary: root.last_summary || `evening-chain durable root already ${root.status}`,
    }
  }

  const canonicalRunId = await resolveCanonicalRunId(db, businessDate, input.canonicalRunId)
  if (!canonicalRunId) {
    return {
      status: 'pending',
      business_date: businessDate,
      canonical_run_id: null,
      root_ticket_id: root.ticket_id,
      blockers: ['post_verify_canonical_run_id_missing'],
      summary: `evening-chain root pending date=${businessDate} blocker=post_verify_canonical_run_id_missing`,
    }
  }

  const [stageResult, learning, active8] = await Promise.all([
    db.prepare(`
      SELECT stage, canonical_run_id, status, cursor_key
        FROM pipeline_stage_runs
       WHERE business_date=?
         AND stage IN ('pipeline_execution','post_pipeline_chain','verify_v2','screener_v2','post_verify_chain')
    `).bind(businessDate).all<StageRow>(),
    db.prepare(`
      SELECT canonical_run_id, producer_run_id, status,
             expected_candidates, processed_candidates,
             expected_decision_rows, persisted_decision_rows,
             production_authority_intent, policy_closure_status, completed_at
        FROM strategy_learning_runs
       WHERE business_date=? AND canonical_run_id=?
       LIMIT 1
    `).bind(businessDate, canonicalRunId).first<StrategyLearningClosureRow>(),
    loadActive8Child(db, root.root_ticket_id),
  ])
  const stageByName = new Map(
    (stageResult.results ?? []).map((row) => [row.stage as RequiredStage, row]),
  )
  const blockers: string[] = []
  let terminalError = false
  for (const stage of REQUIRED_STAGES) {
    const row = stageByName.get(stage)
    if (!row) {
      blockers.push(`${stage}:missing`)
      continue
    }
    // screener_v2 is owned by the upstream indicator canonical run. Its
    // lineage into the pipeline is fenced by cursor_key -> producer_run_id
    // below; forcing its canonical ID to equal the pipeline ID deadlocks root closure.
    if (stage !== 'screener_v2' && row.canonical_run_id !== canonicalRunId) {
      blockers.push(`${stage}:canonical_run_id_mismatch`)
      terminalError = terminalError || terminalFailure(row.status)
      continue
    }
    if (row.status !== 'success') {
      blockers.push(`${stage}:${row.status}`)
      terminalError = terminalError || terminalFailure(row.status)
    }
  }

  if (!learning) {
    blockers.push('strategy_learning:missing')
  } else {
    if (learning.status !== 'success') {
      blockers.push(`strategy_learning:${learning.status}`)
      terminalError = terminalError || terminalFailure(learning.status)
    }
    if (!learning.completed_at) blockers.push('strategy_learning:completed_at_missing')
    if (Number(learning.processed_candidates) !== Number(learning.expected_candidates)) {
      blockers.push('strategy_learning:candidate_count_mismatch')
    }
    if (Number(learning.persisted_decision_rows) !== Number(learning.expected_decision_rows)) {
      blockers.push('strategy_learning:decision_row_count_mismatch')
    }
    const validPolicyClosure = learning.policy_closure_status === 'materialized'
      || (
        Number(learning.production_authority_intent) === 0
        && learning.policy_closure_status === 'evidence_only'
      )
    if (!validPolicyClosure) blockers.push('strategy_learning:policy_closure_invalid')
    const screener = stageByName.get('screener_v2')
    if (!screener?.cursor_key) {
      blockers.push('screener_v2:producer_run_id_missing')
    } else if (String(learning.producer_run_id ?? '') !== screener.cursor_key) {
      blockers.push('strategy_learning:screener_producer_lineage_mismatch')
    }
  }

  if (!active8) {
    blockers.push('active8_oof_daily:missing')
  } else {
    if (active8.status !== 'success') {
      blockers.push(`active8_oof_daily:${active8.status}`)
      terminalError = terminalError || terminalFailure(active8.status)
    }
    if (active8.snapshot_status !== 'success') {
      blockers.push(`dataset_snapshot_export:${active8.snapshot_status || 'missing'}`)
      terminalError = terminalError || terminalFailure(active8.snapshot_status || '')
    }
    const metadata = parseMetadata(active8.metadata_json)
    if (String(metadata.snapshot_run_id ?? '') !== String(active8.snapshot_run_id ?? '')) {
      blockers.push('active8_oof_daily:snapshot_run_id_lineage_mismatch')
    }
  }

  if (blockers.length > 0 && !terminalError) {
    return {
      status: 'pending',
      business_date: businessDate,
      canonical_run_id: canonicalRunId,
      root_ticket_id: root.ticket_id,
      blockers,
      summary: `evening-chain root pending date=${businessDate} run_id=${canonicalRunId} blockers=${blockers.join(',')}`,
    }
  }

  const status = blockers.length === 0 ? 'success' : 'error'
  const summary = blockers.length === 0
    ? `evening-chain durable DAG complete date=${businessDate} run_id=${canonicalRunId} stages=${REQUIRED_STAGES.length} strategy_learning=success dataset_snapshot=success active8_oof_daily=success`
    : `evening-chain durable DAG failed date=${businessDate} run_id=${canonicalRunId} blockers=${blockers.join(',')}`
  await updateSchedulerExecutionTicket(db, {
    ticketId: root.ticket_id,
    runId: root.run_id,
    status,
    authority: 'logical_child',
    summary,
    error: blockers.length ? blockers.join(',') : undefined,
  })
  return {
    status: status === 'success' ? 'closed_success' : 'closed_error',
    business_date: businessDate,
    canonical_run_id: canonicalRunId,
    root_ticket_id: root.ticket_id,
    blockers,
    summary,
  }
}
