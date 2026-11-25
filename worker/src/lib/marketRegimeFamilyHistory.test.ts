import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { readHmmRegimeFamiliesBefore } from './marketRegimeState'
import { HMM_INPUT_CONTRACT } from './marketRiskRuntime'

// Confirmation history: one row per prior session, asOf-bounded, and only HMM states with the same
// provenance shape today's gate requires; anything else is a gap (null), never a confirming family.
const hex = (seed: string) => createHash('sha256').update(seed).digest('hex')
const provenance = (date: string, contract = HMM_INPUT_CONTRACT) => ({ hmm_provenance: {
  input_contract: contract, feature_date: date, risk_quality_checksum: hex('q' + date), input_checksum: hex('i' + date),
  model: { input_contract: contract, sha256: hex('m'), generation: '7' } } })

void (async () => {
  const f = l4NativeFixture()
  try {
    const m = f.sqls.market
    const days = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08']
    for (const d of days) m.prepare("INSERT OR IGNORE INTO market_trading_sessions(session_date,source,sample_size) VALUES(?,'t',1)").run(d)
    const insert = (d: string, label: string, evidence: unknown) => {
      const state = { schema_version: 'market-regime-state-v1', label, run_date: d, computed_at: d + 'T13:00:00Z', source: 'hmm', regime_evidence: evidence }
      const json = JSON.stringify(state)
      m.prepare(`INSERT INTO market_regime_state_history_v1(run_date,schema_version,effective_label,raw_label,family,source,hmm_state,regime_index,
        state_json,state_checksum,computed_at,persisted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(d, 'market-regime-state-v1', label, label, label.replace('_market', ''), 'hmm', 0, 0, json, hex(json), d + 'T13:00:00Z', d + 'T13:05:00Z')
    }
    insert('2026-09-01', 'bull_market', provenance('2026-09-01'))
    insert('2026-09-02', 'bear_market', provenance('2026-09-02'))
    insert('2026-09-03', 'bear_market', provenance('2026-09-03'))
    insert('2026-09-04', 'bull_market', provenance('2026-09-04', 'f'.repeat(64)))   // other input contract
    // 09-07 has no publication.
    // A later revision of 09-03 recorded after the decision clock must not be seen.
    {
      const d = '2026-09-03'
      const state = { schema_version: 'market-regime-state-v1', label: 'bull_market', run_date: d, computed_at: '2026-09-03T15:00:00Z', source: 'hmm', regime_evidence: provenance(d) }
      const json = JSON.stringify(state)
      m.prepare('INSERT INTO market_regime_state_revisions_v1(run_date,state_checksum,state_json,computed_at,recorded_at) VALUES(?,?,?,?,?)')
        .run(d, hex(json), json, state.computed_at, '2026-09-08T10:00:00Z')
    }
    const before = await readHmmRegimeFamiliesBefore(f.env.MARKET_DB, '2026-09-08', 10, HMM_INPUT_CONTRACT, '2026-09-08T01:00:00Z')
    assert.deepEqual(before, [
      { date: '2026-09-01', family: 'bull' }, { date: '2026-09-02', family: 'bear' }, { date: '2026-09-03', family: 'bear' },
      { date: '2026-09-04', family: null }, { date: '2026-09-07', family: null },
    ])
    const after = await readHmmRegimeFamiliesBefore(f.env.MARKET_DB, '2026-09-08', 10, HMM_INPUT_CONTRACT, '2026-09-08T12:00:00Z')
    assert.equal(after.find(row => row.date === '2026-09-03')?.family, 'bull')
    const window = await readHmmRegimeFamiliesBefore(f.env.MARKET_DB, '2026-09-08', 2, HMM_INPUT_CONTRACT, '2026-09-08T12:00:00Z')
    assert.deepEqual(window.map(row => row.date), ['2026-09-04', '2026-09-07'])
    console.log('market regime family history tests passed')
  } finally {
    f.close()
  }
})().catch(error => { console.error(error); process.exit(1) })
