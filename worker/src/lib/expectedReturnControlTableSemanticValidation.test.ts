import assert from 'node:assert/strict'
import test from 'node:test'
import { checksumText } from './dataDomainShadowManifest'
import { validateExpectedReturnControlSemanticPage } from './expectedReturnControlTableSemanticValidation'
import type {
  ExpectedReturnHistoryRow,
  ExpectedReturnPayloadRow,
  ExpectedReturnRegistryRow,
} from './expectedReturnPointerSemanticGuard'

type Statement = {
  values: unknown[]
  bind: (...values: unknown[]) => Statement
  all: <T>() => Promise<{ results: T[] }>
}

function semanticDb(input: {
  registry: ExpectedReturnRegistryRow
  payload: ExpectedReturnPayloadRow
  queries: Array<{ sql: string; values: unknown[] }>
}): D1Database {
  return {
    prepare: (sql: string) => {
      const statement: Statement = {
        values: [],
        bind: (...values: unknown[]) => {
          statement.values = values
          return statement
        },
        all: async <T>() => {
          input.queries.push({ sql, values: [...statement.values] })
          if (sql.includes('FROM "model_artifact_registry"')) {
            return { results: [input.registry] as T[] }
          }
          if (sql.includes('FROM "expected_return_artifact_payloads"')) {
            return { results: [input.payload] as T[] }
          }
          throw new Error(`unexpected_semantic_query:${sql}`)
        },
      }
      return statement
    },
  } as unknown as D1Database
}

test('rejects raw payload tamper on an intermediate archived expected-return history row', async () => {
  const owner = 'allocator_ev_fusion'
  const version = 'fusion-retired-v13'
  const artifactId = 'opaque-fusion-intermediate'
  const contract = 'allocator-ev-fusion-contract-dynamic'
  const cohort = 'baseline:fusion-v13'
  const artifactJson = JSON.stringify({
    expected_return_owner: owner,
    model_version: version,
    serving_mode: 'abstention_baseline',
    promotion_state: 'safe_abstention',
    output_is_net_of_costs: true,
    primary_expected_return_allowed: false,
    artifact_contract_version: contract,
    validation_packet: { decision: 'PASS', alpha_quality_passed: false },
  })
  const checksum = await checksumText(artifactJson)
  const artifactPath = `artifacts/${artifactId}.json`
  const registry: ExpectedReturnRegistryRow = {
    artifact_id: artifactId,
    model_name: owner,
    version,
    state: 'archived',
    artifact_path: artifactPath,
    training_run_id: cohort,
    feature_policy_version: contract,
    checksum,
    offline_evidence_json: null,
  }
  const payload: ExpectedReturnPayloadRow = {
    artifact_id: artifactId,
    model_name: owner,
    model_version: version,
    serving_mode: 'abstention_baseline',
    artifact_json: `${artifactJson} `,
    payload_checksum: checksum,
    source_artifact_path: artifactPath,
    source_artifact_checksum: checksum,
    source_cohort_id: cohort,
  }
  const history: ExpectedReturnHistoryRow = {
    event_id: 'fusion-intermediate-event',
    model_name: owner,
    version,
    artifact_id: artifactId,
    effective_at: '2025-01-01T00:00:00Z',
    retired_at: '2026-01-01T00:00:00Z',
    source: 'model_champion_history',
    evidence_grade: 'exact',
    evidence_json: JSON.stringify({
      schema_version: 'expected-return-history-test-v1',
      owner,
      version,
      artifact_contract_version: contract,
      artifact_checksum: checksum,
      artifact_path: artifactPath,
      payload_checksum: checksum,
    }),
  }
  const queries: Array<{ sql: string; values: unknown[] }> = []
  await assert.rejects(
    validateExpectedReturnControlSemanticPage(
      semanticDb({ registry, payload, queries }),
      'model_champion_history',
      [history as unknown as Record<string, unknown>],
    ),
    /history:fusion-intermediate-event:payload:payload_raw_checksum/,
  )
  assert.equal(queries.length, 2)
  assert(queries.every((query) => query.values.length === 1))
  assert(queries.every((query) => query.values[0] === artifactId))
  assert(queries.every((query) => /LIMIT 25/.test(query.sql)))
})

test('keeps scanned and applicable history denominators separate', async () => {
  const emptyDb = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database
  const result = await validateExpectedReturnControlSemanticPage(
    emptyDb,
    'model_champion_history',
    [{
      event_id: 'non-expected-owner',
      model_name: 'some_other_model',
      version: 'v1',
      artifact_id: 'other:v1',
      effective_at: '2026-01-01T00:00:00Z',
      retired_at: null,
      source: 'model_champion_history',
      evidence_grade: 'exact',
      evidence_json: '{}',
    }],
  )
  assert.deepEqual(result, {
    schemaVersion: 'expected-return-control-semantic-v2',
    rowsScanned: 1,
    rowsApplicable: 0,
    rowsValidated: 0,
  })
})
