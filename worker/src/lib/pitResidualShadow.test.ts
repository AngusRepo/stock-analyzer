import assert from 'node:assert/strict'
import {
  buildPitResidualCounterfactuals,
  loadPitResidualShadowSnapshot,
  PIT_RESIDUAL_CANDIDATE_SET_MUTATION_ALLOWED,
  PIT_RESIDUAL_DEBATE_VISIBILITY,
  PIT_RESIDUAL_PRIMARY_HORIZON_SESSIONS,
  PIT_RESIDUAL_SHADOW_WEIGHT,
  requireLearningShadowDatabase,
} from './pitResidualShadow'

type Call = { sql: string; params: unknown[] }

function makeDb() {
  const calls: Call[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params })
          return {
            async first() {
              return { signal_date: '2026-08-28' }
            },
            async all() {
              return {
                results: params.slice(1).map((symbol, index) => ({
                  signal_date: '2026-08-28',
                  symbol,
                  industry: index % 2 ? '電子' : '半導體',
                  residual_momentum_rank: 0.1 + (index % 9) * 0.1,
                  breadth_rank: 0.6,
                  flow_diffusion_rank: 0.4,
                  research_base_score: 0.5,
                  research_shadow_score: 0.48 + (index % 9) * 0.01,
                  factor_contract_version: 'pit-residual-momentum-w10-v1',
                  taxonomy_snapshot_date: '2026-08-28',
                  taxonomy_checksum: 'checksum',
                })),
              }
            },
          }
        },
      }
    },
  } as unknown as D1Database
  return { db, calls }
}

void (async () => {
  const learning = { kind: 'learning' } as unknown as D1Database
  assert.equal(requireLearningShadowDatabase({ LEARNING_DB: learning }), learning)
  assert.throws(() => requireLearningShadowDatabase({}), /pit_residual_learning_db_binding_required/)

  const { db, calls } = makeDb()
  const symbols = Array.from({ length: 81 }, (_, index) => `S${index}`)
  const snapshot = await loadPitResidualShadowSnapshot(db, symbols, '2026-08-29')
  assert.equal(snapshot.signalDate, '2026-08-28')
  assert.equal(snapshot.rows.length, 81)
  assert.equal(calls.length, 3)
  assert(calls[0].sql.includes('MAX(signal_date)'))
  assert(calls.slice(1).every((call) => call.sql.includes("decision_effect = 'none'")))
  assert(calls.slice(1).every((call) => call.params.length <= 81))

  const result = buildPitResidualCounterfactuals(
    [
      { symbol: 'A', score: 90 },
      { symbol: 'B', score: 80 },
      { symbol: 'C', score: 70 },
    ],
    {
      signalDate: '2026-08-28',
      rows: [
        {
          signalDate: '2026-08-28',
          symbol: 'A',
          industry: '甲',
          residualMomentumRank: 0.1,
          breadthRank: 0.8,
          flowDiffusionRank: 0.6,
          researchBaseScore: 0.8,
          researchShadowScore: 0.73,
          factorContractVersion: 'pit-residual-momentum-w10-v1',
          taxonomySnapshotDate: '2026-08-28',
          taxonomyChecksum: 'x',
        },
        {
          signalDate: '2026-08-28',
          symbol: 'B',
          industry: '甲',
          residualMomentumRank: 1.0,
          breadthRank: 0.8,
          flowDiffusionRank: 0.6,
          researchBaseScore: 0.6,
          researchShadowScore: 0.64,
          factorContractVersion: 'pit-residual-momentum-w10-v1',
          taxonomySnapshotDate: '2026-08-28',
          taxonomyChecksum: 'x',
        },
        {
          signalDate: '2026-08-28',
          symbol: 'C',
          industry: '乙',
          residualMomentumRank: 0.9,
          breadthRank: 0.2,
          flowDiffusionRank: 0.4,
          researchBaseScore: 0.4,
          researchShadowScore: 0.45,
          factorContractVersion: 'pit-residual-momentum-w10-v1',
          taxonomySnapshotDate: '2026-08-28',
          taxonomyChecksum: 'x',
        },
      ],
    },
  )
  assert.equal(result.length, 3)
  assert.equal(result.find((row) => row.symbol === 'B')?.diagnosticConfirmationRank, 0.7)
  assert(result.every((row) => Number.isFinite(row.productionShadowScore)))
  assert.equal(PIT_RESIDUAL_SHADOW_WEIGHT, 0.10)
  assert.equal(PIT_RESIDUAL_PRIMARY_HORIZON_SESSIONS, 10)
  assert.equal(PIT_RESIDUAL_CANDIDATE_SET_MUTATION_ALLOWED, false)
  assert.equal(PIT_RESIDUAL_DEBATE_VISIBILITY, false)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})

