/** Accounting evidence only. Never translates an allocation seal into NAV credit. */
export interface PairedNavReadModel {
  status: 'awaiting_allocation_context' | 'awaiting_execution_pairs' | 'observing' | 'valuation_incomplete' | 'terminal_zero_nav' | 'historical_comparisons' | 'unavailable'
  allocation_context_dates: number | null
  latest_allocation_context_date: string | null
  pairs: Array<{ pair_id: string; sessions: number; latest_session: string | null; accounted_sessions: number;
    unverified_sessions: number; undefined_return_sessions: number; zero_nav_sessions: number;
    latest_accounting_session: string; candidate_checksum: string; baseline_checksum: string;
    comparison?: { owner: string; kind: 'incumbent_replacement' | 'incremental_layer' | 'route_policy_contrast' | 'allocator_policy_contrast' | 'atomic_strategy_replacement'; baseline_kind: string; metadata_sessions: number };
    lifecycle?: { reason: 'comparison_changed'; transition_signal_date: string; final_session_date: string;
      successor_pair_id: string; changed_fields: string[] } }>
  promotion_allowed: false
  ev_prediction_dates_added: 0
  blockers: string[]
}

export async function readPairedNav(db: D1Database, requestedDate: string): Promise<PairedNavReadModel> {
  const base: PairedNavReadModel = { status: 'awaiting_allocation_context', allocation_context_dates: null,
    latest_allocation_context_date: null, pairs: [], promotion_allowed: false, ev_prediction_dates_added: 0,
    blockers: [] }
  try {
    const [contexts, pairs, closures] = await Promise.all([
      db.prepare(`SELECT COUNT(DISTINCT signal_date) AS dates,MAX(signal_date) AS latest
        FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_context' AND signal_date<=?`)
        .bind(requestedDate).first<{ dates: number; latest: string | null }>(),
      db.prepare(`SELECT pair_id,COUNT(*) AS accounted_sessions,
        COUNT(json_extract(payload_json,'$.net_return_delta')) AS sessions,
        SUM(CASE WHEN json_extract(payload_json,'$.net_return_delta') IS NULL THEN 1 ELSE 0 END) AS unverified_sessions,
        SUM(CASE WHEN json_type(payload_json,'$.net_return_delta')='null'
          AND json_type(payload_json,'$.arms.candidate.nav') IN ('integer','real')
          AND json_type(payload_json,'$.arms.baseline.nav') IN ('integer','real')
          AND json_extract(payload_json,'$.arms.candidate.nav')>=0
          AND json_extract(payload_json,'$.arms.baseline.nav')>=0
          AND (json_type(payload_json,'$.arms.candidate.daily_return') IN ('integer','real')
            OR (json_extract(payload_json,'$.arms.candidate.return_status')='undefined_zero_opening_nav'
              AND json_extract(payload_json,'$.arms.candidate.nav')=0))
          AND (json_type(payload_json,'$.arms.baseline.daily_return') IN ('integer','real')
            OR (json_extract(payload_json,'$.arms.baseline.return_status')='undefined_zero_opening_nav'
              AND json_extract(payload_json,'$.arms.baseline.nav')=0)) AND (
          (json_extract(payload_json,'$.arms.candidate.return_status')='undefined_zero_opening_nav'
            AND json_type(payload_json,'$.arms.candidate.nav') IN ('integer','real')
            AND json_extract(payload_json,'$.arms.candidate.nav')=0
            AND json_type(payload_json,'$.arms.candidate.daily_return')='null')
          OR (json_extract(payload_json,'$.arms.baseline.return_status')='undefined_zero_opening_nav'
            AND json_type(payload_json,'$.arms.baseline.nav') IN ('integer','real')
            AND json_extract(payload_json,'$.arms.baseline.nav')=0
            AND json_type(payload_json,'$.arms.baseline.daily_return')='null'))
          THEN 1 ELSE 0 END) AS undefined_return_sessions,
        SUM(CASE WHEN (json_type(payload_json,'$.arms.candidate.nav') IN ('integer','real')
            AND json_extract(payload_json,'$.arms.candidate.nav')=0)
          OR (json_type(payload_json,'$.arms.baseline.nav') IN ('integer','real')
            AND json_extract(payload_json,'$.arms.baseline.nav')=0)
          THEN 1 ELSE 0 END) AS zero_nav_sessions,
        MAX(session_date) AS latest_accounting_session,
        MAX(CASE WHEN json_extract(payload_json,'$.net_return_delta') IS NOT NULL THEN session_date END) AS latest_session,
        MIN(json_extract(payload_json,'$.pair_identity.candidate_checksum')) AS candidate_checksum,
        MIN(json_extract(payload_json,'$.pair_identity.baseline_checksum')) AS baseline_checksum,
        COUNT(json_extract(payload_json,'$.comparison')) AS comparison_sessions,
        COUNT(DISTINCT json_extract(payload_json,'$.comparison')) AS comparison_versions,
        MIN(json_extract(payload_json,'$.comparison.owner')) AS comparison_owner,
        MIN(json_extract(payload_json,'$.comparison.kind')) AS comparison_kind,
        MIN(json_extract(payload_json,'$.comparison.baseline_kind')) AS comparison_baseline_kind,
        SUM(CASE WHEN json_type(payload_json,'$.comparison') IS NULL THEN 0
          WHEN json_extract(payload_json,'$.comparison.schema_version')='paired-nav-comparison-v1'
            AND json_extract(payload_json,'$.comparison.candidate_checksum')=json_extract(payload_json,'$.pair_identity.candidate_checksum')
            AND json_extract(payload_json,'$.comparison.baseline_checksum')=json_extract(payload_json,'$.pair_identity.baseline_checksum')
            AND ((json_extract(payload_json,'$.comparison.owner') IN ('ensemble','l4_alpha_ev')
              AND json_extract(payload_json,'$.comparison.kind')='incumbent_replacement'
              AND json_extract(payload_json,'$.comparison.baseline_kind')='frozen_incumbent_policy')
            OR (json_extract(payload_json,'$.comparison.owner')='allocator_ev_fusion'
              AND json_extract(payload_json,'$.comparison.kind')='incremental_layer'
              AND json_extract(payload_json,'$.comparison.baseline_kind')='exact_frozen_l4_candidate')
            OR (json_extract(payload_json,'$.comparison.owner')='l15_route'
              AND json_extract(payload_json,'$.comparison.kind')='route_policy_contrast'
              AND json_extract(payload_json,'$.comparison.baseline_kind')='frozen_incumbent_route')
            OR (json_extract(payload_json,'$.comparison.owner')='opb_arm_prior'
              AND json_extract(payload_json,'$.comparison.kind')='allocator_policy_contrast'
              AND json_extract(payload_json,'$.comparison.baseline_kind')='exact_frozen_incumbent_allocator')
            OR (json_extract(payload_json,'$.comparison.owner')='atomic_strategy'
              AND json_extract(payload_json,'$.comparison.kind')='atomic_strategy_replacement'
              AND json_extract(payload_json,'$.comparison.baseline_kind')='frozen_incumbent_strategy_policy'))
          THEN 0 ELSE 1 END) AS invalid_comparisons,
        COUNT(DISTINCT json_extract(payload_json,'$.pair_identity.candidate_checksum')) AS candidate_versions,
        COUNT(DISTINCT json_extract(payload_json,'$.pair_identity.baseline_checksum')) AS baseline_versions,
        COUNT(DISTINCT json_extract(payload_json,'$.pair_identity.configuration_checksum')) AS configuration_versions,
        COUNT(DISTINCT json_extract(payload_json,'$.pair_identity.execution_owner_version')) AS execution_versions,
        SUM(CASE WHEN json_type(payload_json,'$.net_return_delta') IN ('integer','real','null')
          AND (json_type(payload_json,'$.net_return_delta')='null'
            OR abs(json_extract(payload_json,'$.net_return_delta'))<=1.7976931348623157e308)
          AND json_extract(payload_json,'$.schema_version')='paired-nav-journal-v1'
          AND json_extract(payload_json,'$.pair_identity.pair_id')=pair_id
          AND json_extract(payload_json,'$.pair_id')=pair_id
          AND json_extract(payload_json,'$.session_date')=session_date
          AND json_type(payload_json,'$.pair_identity.candidate_checksum')='text'
          AND length(trim(json_extract(payload_json,'$.pair_identity.candidate_checksum')))>0
          AND json_type(payload_json,'$.pair_identity.baseline_checksum')='text'
          AND length(trim(json_extract(payload_json,'$.pair_identity.baseline_checksum')))>0
          AND json_type(payload_json,'$.pair_identity.configuration_checksum')='text'
          AND length(trim(json_extract(payload_json,'$.pair_identity.configuration_checksum')))>0
          AND json_type(payload_json,'$.pair_identity.execution_owner_version')='text'
          AND length(trim(json_extract(payload_json,'$.pair_identity.execution_owner_version')))>0
          THEN 0 ELSE 1 END) AS invalid_rows
        FROM paired_nav_daily_journal_v1 WHERE session_date<=? GROUP BY pair_id ORDER BY pair_id`)
        .bind(requestedDate).all<{ pair_id: string; sessions: number; latest_session: string | null;
          accounted_sessions: number; unverified_sessions: number; undefined_return_sessions: number;
          zero_nav_sessions: number; latest_accounting_session: string;
          comparison_sessions: number; comparison_versions: number; invalid_comparisons: number;
          comparison_owner: string; comparison_kind: NonNullable<PairedNavReadModel['pairs'][number]['comparison']>['kind']; comparison_baseline_kind: string;
          candidate_checksum: string; baseline_checksum: string; candidate_versions: number; baseline_versions: number;
          configuration_versions: number; execution_versions: number; invalid_rows: number }>(),
      db.prepare(`SELECT pair_id,payload_json,payload_checksum FROM paired_nav_lifecycle_closures_v1
        WHERE transition_signal_date<=? ORDER BY pair_id`).bind(requestedDate)
        .all<{ pair_id: string; payload_json: string; payload_checksum: string }>(),
    ])
    if (pairs.success === false || !Array.isArray(pairs.results)) throw new Error('paired_nav_query_incomplete')
    if (closures.success === false || !Array.isArray(closures.results)) throw new Error('paired_nav_lifecycle_query_incomplete')
    const lifecycle = new Map<string, NonNullable<PairedNavReadModel['pairs'][number]['lifecycle']>>()
    for (const row of closures.results) {
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(row.payload_json))))
        .map(value => value.toString(16).padStart(2, '0')).join('')
      const body = JSON.parse(row.payload_json)
      if (hash !== row.payload_checksum || body.schema_version !== 'paired-nav-lifecycle-closure-v1'
        || body.reason !== 'comparison_changed' || body.pair_id !== row.pair_id || body.promotion_allowed !== false
        || body.inherited_mature_sessions !== 0 || typeof body.successor_pair_id !== 'string'
        || !body.successor_pair_id || body.successor_pair_id === row.pair_id
        || typeof body.transition_signal_date !== 'string' || body.transition_signal_date > requestedDate
        || typeof body.final_session_date !== 'string' || body.final_session_date > body.transition_signal_date
        || !Array.isArray(body.changed_fields) || !body.changed_fields.length
        || body.changed_fields.some((key: unknown) => key !== 'baseline_checksum' && key !== 'configuration_checksum')) {
        throw new Error('paired_nav_lifecycle_identity_invalid')
      }
      lifecycle.set(row.pair_id, { reason: body.reason, transition_signal_date: body.transition_signal_date,
        final_session_date: body.final_session_date, successor_pair_id: body.successor_pair_id, changed_fields: body.changed_fields })
    }
    const rows = pairs.results
    if (!contexts || !Number.isInteger(contexts.dates) || contexts.dates < 0 || rows.some(row =>
      !Number.isInteger(row.sessions) || row.sessions < 0 || !Number.isInteger(row.accounted_sessions)
      || !Number.isInteger(row.unverified_sessions) || row.unverified_sessions < 0
      || !Number.isInteger(row.undefined_return_sessions) || row.undefined_return_sessions < 0
      || row.undefined_return_sessions > row.unverified_sessions
      || !Number.isInteger(row.zero_nav_sessions) || row.zero_nav_sessions < 0
      || row.zero_nav_sessions > row.accounted_sessions || row.undefined_return_sessions > row.zero_nav_sessions
      || row.accounted_sessions <= 0 || row.sessions + row.unverified_sessions !== row.accounted_sessions
      || row.candidate_versions !== 1 || row.baseline_versions !== 1
      || row.configuration_versions !== 1 || row.execution_versions !== 1 || row.invalid_rows !== 0
      || !Number.isInteger(row.comparison_sessions) || row.comparison_sessions < 0
      || row.comparison_sessions > row.accounted_sessions || row.invalid_comparisons !== 0
      || row.comparison_versions !== (row.comparison_sessions ? 1 : 0)
      || !row.candidate_checksum || !row.baseline_checksum)) throw new Error('paired_nav_identity_or_count_invalid')
    const incomplete = rows.some(row => row.unverified_sessions > row.undefined_return_sessions)
    const zeroCapital = rows.some(row => row.zero_nav_sessions > 0)
    const allClosed = rows.length > 0 && rows.every(row => lifecycle.has(row.pair_id))
    return { ...base, status: incomplete ? 'valuation_incomplete' : allClosed ? 'historical_comparisons' : zeroCapital ? 'terminal_zero_nav' : rows.length ? 'observing' : contexts.dates ? 'awaiting_execution_pairs' : 'awaiting_allocation_context',
      allocation_context_dates: contexts.dates, latest_allocation_context_date: contexts.latest,
      pairs: rows.map(({ candidate_versions: _candidate, baseline_versions: _baseline,
        comparison_sessions, comparison_versions: _versions, invalid_comparisons: _comparisonInvalid,
        comparison_owner, comparison_kind, comparison_baseline_kind,
        configuration_versions: _configuration, execution_versions: _execution, invalid_rows: _invalid, ...row }) => ({ ...row,
          ...(comparison_sessions > 0 ? { comparison: { owner: comparison_owner,
            kind: comparison_kind, baseline_kind: comparison_baseline_kind, metadata_sessions: comparison_sessions } } : {}),
          ...(lifecycle.has(row.pair_id) ? { lifecycle: lifecycle.get(row.pair_id) } : {}) })),
      // This endpoint reports accounting health, not a promotion verdict.
      blockers: rows.length ? (incomplete ? ['paired_nav_valuation_interval_unverified'] : [])
        : ['paired_execution_evidence_missing'],
    }
  } catch (error) {
    return { ...base, status: 'unavailable', blockers: [error instanceof Error && error.message.includes('no such table')
      ? (error.message.includes('paired_nav_lifecycle_closures_v1') ? 'paired_nav_migration_0043_missing' : 'paired_nav_migration_0040_missing')
      : 'paired_nav_read_or_identity_failed'] }
  }
}
