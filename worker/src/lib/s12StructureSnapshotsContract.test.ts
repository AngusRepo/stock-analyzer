import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadS12ResearchCohortSymbolsByDate, runS12ResearchStructureSnapshots } from './s12ResearchStructureSnapshots'
import { buildS12SnapshotEntryContext } from './s12StructureSnapshots'

const schema = readFileSync('schema.sql', 'utf8')
const migration = readFileSync('migration_s12_structure_snapshots_2026_07_08.sql', 'utf8')
const helper = readFileSync('src/lib/s12StructureSnapshots.ts', 'utf8')
const researchProducer = readFileSync('src/lib/s12ResearchStructureSnapshots.ts', 'utf8')
const entryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const exitTasks = readFileSync('src/lib/paperExitTasks.ts', 'utf8')
const updateOrchestrator = readFileSync('src/lib/updateOrchestrator.ts', 'utf8')

assert(schema.includes('CREATE TABLE IF NOT EXISTS s12_structure_snapshots'), 'schema must include s12_structure_snapshots')
assert(migration.includes('UNIQUE(trade_date, symbol, source)'), 'migration must keep one latest snapshot per date/symbol/source')
assert(migration.includes('idx_s12_structure_snapshots_date_symbol'), 'migration must add date/symbol lookup index')
assert(helper.includes('ON CONFLICT(trade_date, symbol, source) DO UPDATE SET'), 'snapshot helper must upsert latest structure')
assert(entryTasks.includes("source: 's12_intraday_structure'"), 'entry sidecar must persist S12 structure snapshots')
assert(exitTasks.includes("source: 's12_holding_defense'"), 'holding defense must persist S12 structure snapshots')
assert(researchProducer.includes('selection_reference_snapshots_v1'), 'research snapshot producer must use the canonical L0 reference cohort')
assert(researchProducer.includes("options.source ?? 's12_research_structure_snapshot'"), 'research snapshot producer must use a research-only source')
assert(researchProducer.includes("'s12_research_structure_reconstruction'"), 'historical reconstruction must preserve a distinct research source')
assert(researchProducer.includes('S12_RESEARCH_SNAPSHOT_LIMIT'), 'research snapshot producer must expose a bounded research limit')
assert(updateOrchestrator.includes("await import('./s12ResearchStructureSnapshots')"), 'research recovery and historical replay must load the research-only producer')
assert(!updateOrchestrator.includes("await import('./s12CandidateStructureSnapshots')"), 'production chain must not retain the candidate snapshot module')
assert(!updateOrchestrator.includes('runS12CandidateStructureSnapshots(env, triggerTime)'), 'production chain must not run candidate S12 snapshots before recommendation')

const context = buildS12SnapshotEntryContext({
  engineVersion: 's12_smcvwap_tw_equity_v2',
  state: 'reaction_ready',
  entryState: 'EXECUTABLE',
  sessionContextSource: 'current_session_60m',
  biasSession60: { direction: 'long', confidence: 'high', channelAlign: true },
  ready: true,
  detail: [
    'calibration_artifact_id=s12-tw-calibration-2026w27',
    'calibration_scope=TWSE|ALL|OPEN',
    'entry_archetype=equity_repricing_breakout',
    'vwap_fast_acceptance=true',
    'vwap_fast_reasons=session_vwap_above|rolling15m_7_above',
    'vwap_slow_context=overhead_supply',
    'htf_hard_block=false',
  ].join(';'),
} as any)

assert.equal(context.engine_version, 's12_smcvwap_tw_equity_v2')
assert.equal(context.entry_state, 'EXECUTABLE')
assert.equal(context.session_context_source, 'current_session_60m')
assert.equal(context.session_60m_bias, 'long')
assert.equal(context.calibration_artifact_id, 's12-tw-calibration-2026w27')
assert.equal(context.entry_archetype, 'equity_repricing_breakout')
assert.equal(context.vwap_fast_acceptance, true)
assert.deepEqual(context.vwap_fast_reasons, ['session_vwap_above', 'rolling15m_7_above'])
assert.equal(context.vwap_slow_context, 'overhead_supply')
assert.equal(context.htf_hard_block, false)
assert.equal(context.detail_available, true)

async function runBehaviorTests(): Promise<void> {
  const queries: Array<{ sql: string; binds: unknown[] }> = []
  const fakeDb = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          queries.push({ sql, binds })
          return {
            async all() {
              return {
                results: [
                  {
                    symbol: '8091',
                    name: '台灣高鐵',
                    rank: 1,
                    score_after: 88,
                    stage: 'l1_candidate_seed_after_overlay',
                  },
                ],
              }
            },
          }
        },
      }
    },
  } as any

  const symbols = await loadS12ResearchCohortSymbolsByDate(fakeDb, '2026-07-07', 160)
  assert.equal(symbols.length, 1)
  assert.equal(symbols[0].symbol, '8091')
  assert.match(queries[0].sql, /selection_reference_snapshots_v1/)
  assert.match(queries[0].sql, /canonical_run_heads/)
  assert.equal(queries[0].binds[0], '2026-07-07')
  assert.equal(queries[0].binds[1], '')
  assert.equal(queries[0].binds[2], 161)

  let writeCount = 0
  let writeSql = ''
  const fakeEnv = {
    DB: {
      prepare(sql: string) {
        writeSql = sql
        return {
          bind() {
            return {
              async run() {
                writeCount += 1
                return {}
              },
            }
          },
        }
      },
    },
  } as any
  const summary = await runS12ResearchStructureSnapshots(fakeEnv, '2026-07-07', {
    symbols,
    loadBars: async () => ({
      bars: [],
      fallback15mBars: [],
      fallback1hBars: [],
      fallback4hBars: [],
      diagnostics: {},
    } as any),
  })
  assert.equal(summary.persisted, 1)
  assert.equal(summary.ready, 0)
  assert.equal(summary.unavailable, 1)
  assert.equal(summary.blocked, 0)
  assert.equal(summary.skipped, 1)
  assert.equal(summary.errors, 0)
  assert.equal(writeCount, 1)
  assert.match(writeSql, /state, ready, invalidated/)
  assert.match(writeSql, /'data_unavailable', 0, 0/)
}

void runBehaviorTests().catch((error) => {
  throw error
})
