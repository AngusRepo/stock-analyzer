// Local UI fixture only; never imported by the application bundle.
import React from 'react'
import { createRoot } from 'react-dom/client'
import PairedNavShadow from '../src/components/PairedNavShadow'
import type { PairedNavShadowReadModel } from '../src/lib/pipelineMaturityContract'
import '../src/index.css'

const mode = new URLSearchParams(location.search).get('case') ?? 'observing'
const data: PairedNavShadowReadModel = {
  status: mode === 'missing' ? 'unavailable' : mode === 'empty' ? 'awaiting_execution_pairs' : 'observing',
  allocation_context_dates: mode === 'missing' ? null : 4,
  latest_allocation_context_date: mode === 'missing' ? null : '2026-09-07',
  pairs: mode === 'observing' ? [{ pair_id: 'synthetic-local-test-' + '1'.repeat(64), sessions: 3,
    accounted_sessions: 3, unverified_sessions: 0, latest_accounting_session: '2026-09-07',
    latest_session: '2026-09-07', candidate_checksum: 'c'.repeat(64), baseline_checksum: 'b'.repeat(64) }] : [],
  promotion_allowed: false, ev_prediction_dates_added: 0,
  blockers: [mode === 'missing' ? 'paired_nav_migration_0040_missing' : mode === 'empty'
    ? 'paired_execution_evidence_missing' : 'paired_nav_sequential_inference_not_validated'],
}
createRoot(document.getElementById('root')!).render(<main className="min-h-screen bg-slate-950 p-3 text-white">
  <p className="mb-3 text-sm">本機合成驗證，不是真實策略績效</p><PairedNavShadow data={mode === 'absent' ? undefined : data} />
</main>)
