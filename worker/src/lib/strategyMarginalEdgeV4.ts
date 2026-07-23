export const STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION = 'strategy-marginal-edge-v4'
const MIN_EDGE_DATES = 5
const EDGE_LOOKBACK_CALENDAR_DAYS = 540
const EDGE_PAGE_SIZE = 1000

// One-sided 90% lower confidence bound. Small date cohorts require Student-t,
// not a normal approximation that understates uncertainty.
function lcb90CriticalValue(sampleSize: number): number | null {
  if (sampleSize < 2) return null
  const byDf = [
    0, 3.077684, 1.885618, 1.637744, 1.533206, 1.475884,
    1.439756, 1.414924, 1.396815, 1.383029, 1.372184,
    1.363430, 1.356217, 1.350171, 1.345030, 1.340606,
    1.336757, 1.333379, 1.330391, 1.327728, 1.325341,
    1.323188, 1.321237, 1.319460, 1.317836, 1.316345,
    1.314972, 1.313703, 1.312527, 1.311434, 1.310415,
  ]
  const df = sampleSize - 1
  return df < byDf.length ? byDf[df] : 1.281552
}

interface OutcomeCell {
  signal_date: string
  symbol: string
  strategy_id: string
  strategy_version: string
  production_owner: number | string
  strategy_hit: number | string
  absolute_return_net: number | string
  residual_return_net: number | string
}

interface StrategyEdgeResult {
  strategyId: string
  strategyVersion: string
  observationDates: number
  candidateObservations: number
  marginalEdgeMean: number | null
  marginalEdgeLcb90: number | null
  positiveDateRate: number | null
  absoluteHitReturnMean: number | null
  productionEligible: boolean
  productionWeightRaw: number
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function sampleStandardDeviation(values: number[], average: number): number | null {
  if (values.length < 2) return null
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1))
}

export function evaluateStrategyMarginalEdgesV4(cells: OutcomeCell[]): StrategyEdgeResult[] {
  const byDate = new Map<string, OutcomeCell[]>()
  const strategyKeys = new Map<string, { id: string; version: string }>()
  for (const cell of cells) {
    const residual = finite(cell.residual_return_net)
    const absolute = finite(cell.absolute_return_net)
    if (residual == null || absolute == null) continue
    const dateRows = byDate.get(cell.signal_date) ?? []
    dateRows.push(cell)
    byDate.set(cell.signal_date, dateRows)
    strategyKeys.set(`${cell.strategy_id}|${cell.strategy_version}`, { id: cell.strategy_id, version: cell.strategy_version })
  }

  const edges = new Map<string, number[]>()
  const hitAbsolute = new Map<string, number[]>()
  const observationSymbols = new Map<string, Set<string>>()
  for (const dateRows of byDate.values()) {
    const outcomes = new Map<string, { residual: number; absolute: number }>()
    const hitsBySymbol = new Map<string, Set<string>>()
    for (const row of dateRows) {
      outcomes.set(row.symbol, { residual: Number(row.residual_return_net), absolute: Number(row.absolute_return_net) })
      const key = `${row.strategy_id}|${row.strategy_version}`
      if (Number(row.strategy_hit) === 1) {
        const hits = hitsBySymbol.get(row.symbol) ?? new Set<string>()
        hits.add(key)
        hitsBySymbol.set(row.symbol, hits)
        const absolute = hitAbsolute.get(key) ?? []
        absolute.push(Number(row.absolute_return_net))
        hitAbsolute.set(key, absolute)
        const symbols = observationSymbols.get(key) ?? new Set<string>()
        symbols.add(`${row.signal_date}|${row.symbol}`)
        observationSymbols.set(key, symbols)
      }
    }
    const allSelected = [...hitsBySymbol.entries()].filter(([, hits]) => hits.size > 0).map(([symbol]) => symbol)
    if (!allSelected.length) continue
    const allValue = mean(allSelected.map((symbol) => outcomes.get(symbol)!.residual))!
    for (const key of strategyKeys.keys()) {
      const without = [...hitsBySymbol.entries()]
        .filter(([, hits]) => [...hits].some((hit) => hit !== key))
        .map(([symbol]) => symbol)
      const strategyContributes = allSelected.some((symbol) => hitsBySymbol.get(symbol)?.has(key))
      if (!strategyContributes) continue
      const withoutValue = without.length ? mean(without.map((symbol) => outcomes.get(symbol)!.residual))! : 0
      const values = edges.get(key) ?? []
      values.push(allValue - withoutValue)
      edges.set(key, values)
    }
  }

  return [...strategyKeys.entries()].map(([key, strategy]) => {
    const dateEdges = edges.get(key) ?? []
    const edgeMean = mean(dateEdges)
    const sd = edgeMean == null ? null : sampleStandardDeviation(dateEdges, edgeMean)
    const critical = lcb90CriticalValue(dateEdges.length)
    const lcb = edgeMean != null && sd != null && critical != null
      ? edgeMean - critical * sd / Math.sqrt(dateEdges.length)
      : null
    const absoluteMean = mean(hitAbsolute.get(key) ?? [])
    const eligible = dateEdges.length >= MIN_EDGE_DATES
      && lcb != null && lcb > 0
      && absoluteMean != null && absoluteMean > 0
    return {
      strategyId: strategy.id,
      strategyVersion: strategy.version,
      observationDates: dateEdges.length,
      candidateObservations: observationSymbols.get(key)?.size ?? 0,
      marginalEdgeMean: edgeMean,
      marginalEdgeLcb90: lcb,
      positiveDateRate: dateEdges.length ? dateEdges.filter((value) => value > 0).length / dateEdges.length : null,
      absoluteHitReturnMean: absoluteMean,
      productionEligible: eligible,
      productionWeightRaw: eligible ? lcb! : 0,
    }
  }).sort((left, right) => left.strategyId.localeCompare(right.strategyId))
}

export interface StrategyPortfolioDateReturnV4 {
  signalDate: string
  residualReturn: number
  absoluteReturn: number
}

interface ConfidenceSummary {
  dates: number
  mean: number | null
  lcb90: number | null
}

function confidenceSummary(values: number[]): ConfidenceSummary {
  const average = mean(values)
  const sd = average == null ? null : sampleStandardDeviation(values, average)
  const critical = lcb90CriticalValue(values.length)
  return {
    dates: values.length,
    mean: average,
    lcb90: average != null && sd != null && critical != null
      ? average - critical * sd / Math.sqrt(values.length)
      : null,
  }
}

export function evaluateStrategyPortfolioEdgeV4(
  cells: OutcomeCell[],
  strategyWeights: Map<string, number>,
): StrategyPortfolioDateReturnV4[] {
  const byDate = new Map<string, OutcomeCell[]>()
  for (const cell of cells) {
    const rows = byDate.get(cell.signal_date) ?? []
    rows.push(cell)
    byDate.set(cell.signal_date, rows)
  }
  const output: StrategyPortfolioDateReturnV4[] = []
  for (const [signalDate, rows] of byDate.entries()) {
    const symbols = new Map<string, { residual: number; absolute: number; hits: Set<string> }>()
    for (const row of rows) {
      const residual = finite(row.residual_return_net)
      const absolute = finite(row.absolute_return_net)
      if (residual == null || absolute == null) continue
      const item = symbols.get(row.symbol) ?? { residual, absolute, hits: new Set<string>() }
      if (Number(row.strategy_hit) === 1) item.hits.add(`${row.strategy_id}|${row.strategy_version}`)
      symbols.set(row.symbol, item)
    }
    let totalWeight = 0
    let residualSum = 0
    let absoluteSum = 0
    for (const item of symbols.values()) {
      const weight = [...item.hits].reduce((sum, key) => sum + Math.max(0, strategyWeights.get(key) ?? 0), 0)
      if (weight <= 0) continue
      totalWeight += weight
      residualSum += item.residual * weight
      absoluteSum += item.absolute * weight
    }
    if (totalWeight > 0) {
      output.push({
        signalDate,
        residualReturn: residualSum / totalWeight,
        absoluteReturn: absoluteSum / totalWeight,
      })
    }
  }
  return output.sort((left, right) => left.signalDate.localeCompare(right.signalDate))
}

async function sourceFingerprint(cells: OutcomeCell[]): Promise<string> {
  const payload = JSON.stringify(cells.map((row) => [
    row.signal_date, row.symbol, row.strategy_id, row.strategy_version,
    Number(row.production_owner), Number(row.strategy_hit),
    Number(row.absolute_return_net), Number(row.residual_return_net),
  ]))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].slice(0, 10).map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function refreshStrategyMarginalEdgeV4(
  db: D1Database,
  asOfDate: string,
): Promise<{ runId: string; status: 'shadow' | 'promoted'; sampleDates: number; eligibleStrategies: number }> {
  const asOfMs = Date.parse(`${asOfDate}T00:00:00Z`)
  if (!Number.isFinite(asOfMs)) throw new Error(`invalid_strategy_edge_as_of_date:${asOfDate}`)
  const startDate = new Date(asOfMs - EDGE_LOOKBACK_CALENDAR_DAYS * 86_400_000).toISOString().slice(0, 10)
  const cells: OutcomeCell[] = []
  let cursorDate = ''
  let cursorSymbol = ''
  let cursorStrategyId = ''
  let cursorStrategyVersion = ''
  for (;;) {
    const page = await db.prepare(`
      SELECT m.signal_date, m.symbol, m.strategy_id, m.strategy_version,
             m.production_owner, m.strategy_hit,
             l.absolute_return_net, l.residual_return_net
        FROM strategy_label_matrix_v4 m
        JOIN canonical_selection_labels_v4 l
          ON l.signal_date=m.signal_date
         AND l.symbol=m.symbol
         AND l.producer_run_id=m.producer_run_id
         AND l.label_schema_version='canonical-strategy-selection-label-v4'
       WHERE m.signal_date BETWEEN ? AND ?
         AND m.strategy_status IN ('active', 'candidate', 'shadow')
         AND EXISTS (
           SELECT 1 FROM canonical_run_heads h
            WHERE h.logical_run_key='screener:' || m.signal_date || ':TW:production:market_screener'
              AND h.run_id=m.producer_run_id
         )
         AND (
           m.signal_date > ?
           OR (m.signal_date = ? AND m.symbol > ?)
           OR (m.signal_date = ? AND m.symbol = ? AND m.strategy_id > ?)
           OR (m.signal_date = ? AND m.symbol = ? AND m.strategy_id = ? AND m.strategy_version > ?)
         )
       ORDER BY m.signal_date, m.symbol, m.strategy_id, m.strategy_version
       LIMIT ?
    `).bind(
      startDate, asOfDate,
      cursorDate,
      cursorDate, cursorSymbol,
      cursorDate, cursorSymbol, cursorStrategyId,
      cursorDate, cursorSymbol, cursorStrategyId, cursorStrategyVersion,
      EDGE_PAGE_SIZE,
    ).all<OutcomeCell>()
    const rows = page.results ?? []
    cells.push(...rows)
    if (rows.length < EDGE_PAGE_SIZE) break
    const last = rows.at(-1)!
    cursorDate = last.signal_date
    cursorSymbol = last.symbol
    cursorStrategyId = last.strategy_id
    cursorStrategyVersion = last.strategy_version
  }

  const edges = evaluateStrategyMarginalEdgesV4(cells)
  const eligible = edges.filter((row) => row.productionEligible)
  const candidateWeights = new Map(eligible.map((row) => [
    `${row.strategyId}|${row.strategyVersion}`,
    row.productionWeightRaw,
  ]))
  const candidateDates = evaluateStrategyPortfolioEdgeV4(cells, candidateWeights)
  const candidateResidual = confidenceSummary(candidateDates.map((row) => row.residualReturn))
  const candidateAbsoluteMean = mean(candidateDates.map((row) => row.absoluteReturn))

  const previousHead = await db.prepare("SELECT run_id FROM strategy_marginal_edge_head_v4 WHERE owner_key='production'")
    .first<{ run_id?: string }>()
  const previousWeightRows = previousHead?.run_id
    ? await db.prepare(`
        SELECT strategy_id, strategy_version, production_weight_raw
          FROM strategy_marginal_edge_v4
         WHERE run_id=? AND production_eligible=1
      `).bind(previousHead.run_id).all<{ strategy_id: string; strategy_version: string; production_weight_raw: number | string }>()
    : { results: [] }
  const championWeights = new Map((previousWeightRows.results ?? []).map((row) => [
    `${row.strategy_id}|${row.strategy_version}`,
    Math.max(0, Number(row.production_weight_raw) || 0),
  ]))
  const championDates = evaluateStrategyPortfolioEdgeV4(cells, championWeights)
  const championByDate = new Map(championDates.map((row) => [row.signalDate, row]))
  const pairedDeltas = candidateDates
    .filter((row) => championByDate.has(row.signalDate))
    .map((row) => row.residualReturn - championByDate.get(row.signalDate)!.residualReturn)
  const paired = confidenceSummary(pairedDeltas)

  const fingerprint = await sourceFingerprint(cells)
  const runId = `strategy-marginal-edge-v4-${asOfDate}-${fingerprint}`
  const sameAsChampion = previousHead?.run_id === runId
  const candidatePortfolioPass = candidateResidual.dates >= MIN_EDGE_DATES
    && candidateResidual.lcb90 != null && candidateResidual.lcb90 > 0
    && candidateAbsoluteMean != null && candidateAbsoluteMean > 0
  const championComparisonPass = !previousHead?.run_id
    ? candidatePortfolioPass
    : sameAsChampion || (paired.dates >= MIN_EDGE_DATES && paired.lcb90 != null && paired.lcb90 > 0)
  const status: 'shadow' | 'promoted' = eligible.length > 0 && candidatePortfolioPass && championComparisonPass
    ? 'promoted'
    : 'shadow'
  const sampleDates = candidateDates.length
  const candidateQuality = eligible.reduce((sum, row) => sum + row.productionWeightRaw, 0)

  await db.prepare(`
    INSERT INTO strategy_marginal_edge_runs_v4 (
      run_id, as_of_date, status, strategy_count, eligible_strategy_count, sample_dates, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      status=excluded.status, strategy_count=excluded.strategy_count,
      eligible_strategy_count=excluded.eligible_strategy_count,
      sample_dates=excluded.sample_dates, evidence_json=excluded.evidence_json, error_code=NULL
  `).bind(runId, asOfDate, status, edges.length, eligible.length, sampleDates, JSON.stringify({
    schema_version: STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION,
    source: 'strategy_label_matrix_v4+canonical_selection_labels_v4',
    source_fingerprint: fingerprint,
    lookback_start_date: startDate,
    pagination: { page_size: EDGE_PAGE_SIZE, complete: true },
    candidate_strategy_lcb_sum_diagnostic_only: candidateQuality,
    candidate_portfolio: {
      dates: candidateResidual.dates,
      residual_mean: candidateResidual.mean,
      residual_lcb90: candidateResidual.lcb90,
      absolute_mean: candidateAbsoluteMean,
    },
    champion_comparison: {
      champion_run_id: previousHead?.run_id ?? null,
      same_source_fingerprint: sameAsChampion,
      paired_dates: paired.dates,
      paired_residual_delta_mean: paired.mean,
      paired_residual_delta_lcb90: paired.lcb90,
    },
    promotion_gates: {
      eligible_strategy_exists: eligible.length > 0,
      candidate_portfolio_positive_cost_net_lcb: candidatePortfolioPass,
      paired_champion_improvement_lcb: championComparisonPass,
      no_hard_top_k: true,
      candidate_and_shadow_strategies_evaluated: true,
      registry_cutover_requires_full_v4_portfolio_and_champion_pass: true,
    },
  })).run()

  try {
    const strategyStatements = edges.map((row) => db.prepare(`
      INSERT INTO strategy_marginal_edge_v4 (
        run_id, as_of_date, strategy_id, strategy_version, edge_schema_version,
        observation_dates, candidate_observations, marginal_edge_mean, marginal_edge_lcb90,
        positive_date_rate, absolute_hit_return_mean, production_eligible,
        production_weight_raw, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, strategy_id, strategy_version) DO UPDATE SET
        observation_dates=excluded.observation_dates,
        candidate_observations=excluded.candidate_observations,
        marginal_edge_mean=excluded.marginal_edge_mean,
        marginal_edge_lcb90=excluded.marginal_edge_lcb90,
        positive_date_rate=excluded.positive_date_rate,
        absolute_hit_return_mean=excluded.absolute_hit_return_mean,
        production_eligible=excluded.production_eligible,
        production_weight_raw=excluded.production_weight_raw,
        evidence_json=excluded.evidence_json
    `).bind(
      runId, asOfDate, row.strategyId, row.strategyVersion, STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION,
      row.observationDates, row.candidateObservations, row.marginalEdgeMean, row.marginalEdgeLcb90,
      row.positiveDateRate, row.absoluteHitReturnMean, row.productionEligible ? 1 : 0,
      row.productionWeightRaw,
      JSON.stringify({
        method: 'date_clustered_leave_one_strategy_out_portfolio_delta_active_candidate_shadow',
        outcome: 'sector_or_market_neutral_cost_net_return',
        lcb: 'student_t_one_sided_90pct_date_clustered',
        min_dates: MIN_EDGE_DATES,
        lookback_calendar_days: EDGE_LOOKBACK_CALENDAR_DAYS,
        no_hard_top_k: true,
      }),
    ))
    for (let offset = 0; offset < strategyStatements.length; offset += 200) {
      await db.batch(strategyStatements.slice(offset, offset + 200))
    }

    const dateStatements = candidateDates.map((candidate) => {
      const champion = championByDate.get(candidate.signalDate)
      return db.prepare(`
        INSERT INTO strategy_marginal_edge_dates_v4 (
          run_id, signal_date, candidate_residual_return, candidate_absolute_return,
          champion_residual_return, champion_absolute_return, paired_residual_delta
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, signal_date) DO UPDATE SET
          candidate_residual_return=excluded.candidate_residual_return,
          candidate_absolute_return=excluded.candidate_absolute_return,
          champion_residual_return=excluded.champion_residual_return,
          champion_absolute_return=excluded.champion_absolute_return,
          paired_residual_delta=excluded.paired_residual_delta
      `).bind(
        runId, candidate.signalDate, candidate.residualReturn, candidate.absoluteReturn,
        champion?.residualReturn ?? null, champion?.absoluteReturn ?? null,
        champion ? candidate.residualReturn - champion.residualReturn : null,
      )
    })
    for (let offset = 0; offset < dateStatements.length; offset += 200) {
      await db.batch(dateStatements.slice(offset, offset + 200))
    }

    if (status === 'promoted') {
      const registryPromotionStatements = eligible.map((row) => db.prepare(`
        UPDATE strategy_spec_registry
           SET status='active', promotion_status='production', updated_at=CURRENT_TIMESTAMP
         WHERE strategy_id=? AND version=?
           AND owner_type='strategy'
           AND status IN ('research','shadow','candidate','active')
           AND promotion_status <> 'retired'
      `).bind(row.strategyId, row.strategyVersion))
      const cutoverStatements = [...registryPromotionStatements]
      if (!sameAsChampion) {
        cutoverStatements.push(db.prepare(`
          INSERT INTO strategy_marginal_edge_head_v4(owner_key, run_id, previous_run_id, promoted_at)
          VALUES ('production', ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(owner_key) DO UPDATE SET
            run_id=excluded.run_id, previous_run_id=strategy_marginal_edge_head_v4.run_id,
            promoted_at=CURRENT_TIMESTAMP
        `).bind(runId, previousHead?.run_id ?? null))
      }
      cutoverStatements.push(db.prepare(`
        INSERT INTO observability_events(
          event_id, date, severity, domain, source, status, title, summary,
          owner, impact, next_action, evidence, created_at
        )
        SELECT ?, ?, 'info', 'strategy', 'strategy_marginal_edge_v4', 'promoted',
               'Strategy Edge V4 automatic promotion', ?, 'strategy-learning',
               'Eligible strategies can contribute to the production breadth plan without a hard top-K.',
               'Monitor date-clustered cost-net edge and automatic zero-weight cooldown.', ?, CURRENT_TIMESTAMP
         WHERE NOT EXISTS (
           SELECT 1 FROM observability_events WHERE event_id=? AND date=?
         )
      `).bind(
        `strategy-edge-v4-promotion:${runId}`,
        asOfDate,
        `promoted=${eligible.map((row) => row.strategyId).join(',')} gates=portfolio_lcb+absolute_return+paired_champion`,
        JSON.stringify({
          schema_version: STRATEGY_MARGINAL_EDGE_SCHEMA_VERSION,
          run_id: runId,
          eligible_strategies: eligible.map((row) => ({
            strategy_id: row.strategyId,
            strategy_version: row.strategyVersion,
            marginal_edge_lcb90: row.marginalEdgeLcb90,
            absolute_hit_return_mean: row.absoluteHitReturnMean,
          })),
          candidate_portfolio_residual_lcb90: candidateResidual.lcb90,
          candidate_portfolio_absolute_mean: candidateAbsoluteMean,
          paired_champion_delta_lcb90: paired.lcb90,
          no_hard_top_k: true,
        }),
        `strategy-edge-v4-promotion:${runId}`,
        asOfDate,
      ))
      await db.batch(cutoverStatements)
    }
  } catch (error) {
    await db.prepare(`
      UPDATE strategy_marginal_edge_runs_v4
         SET status='failed', error_code=? WHERE run_id=?
    `).bind(error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500), runId).run().catch(() => {})
    throw error
  }
  return { runId, status, sampleDates, eligibleStrategies: eligible.length }
}

export async function loadPromotedStrategyMarginalEdgeWeightsV4(
  db: D1Database,
  strategyIds: string[],
): Promise<{ runId: string | null; weights: Record<string, number> } | null> {
  const head = await db.prepare(`
    SELECT h.run_id
      FROM strategy_marginal_edge_head_v4 h
      JOIN strategy_marginal_edge_runs_v4 r ON r.run_id=h.run_id AND r.status='promoted'
     WHERE h.owner_key='production'
  `).first<{ run_id?: string }>()
  if (!head?.run_id) return null
  const rows = await db.prepare(`
    SELECT strategy_id, production_weight_raw
      FROM strategy_marginal_edge_v4
     WHERE run_id=?
  `).bind(head.run_id).all<{ strategy_id: string; production_weight_raw: number | string }>()
  const raw = new Map<string, number>()
  for (const row of rows.results ?? []) {
    raw.set(row.strategy_id, (raw.get(row.strategy_id) ?? 0) + Math.max(0, Number(row.production_weight_raw) || 0))
  }
  const total = [...raw.values()].reduce((sum, value) => sum + value, 0)
  const weights = Object.fromEntries(strategyIds.map((id) => [id, total > 0 ? (raw.get(id) ?? 0) / total : 0]))
  return { runId: head.run_id, weights }
}
