import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./strategyLearning.ts', import.meta.url), 'utf8')

function csvArity(value: string): number {
  let count = 1
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (char === "'") {
      if (quoted && value[index + 1] === "'") index += 1
      else quoted = !quoted
    } else if (char === ',' && !quoted) {
      count += 1
    }
  }
  return count
}

function assertInsertArities(table: string, expectedPlaceholders: number[]): void {
  const matches = [...source.matchAll(new RegExp(
    `INSERT INTO ${table}\\s*\\(([\\s\\S]*?)\\)\\s*VALUES\\s*\\(([\\s\\S]*?)\\)`,
    'g',
  ))]
  assert.equal(matches.length, expectedPlaceholders.length, `${table} INSERT count changed`)
  matches.forEach((match, index) => {
    assert.equal(csvArity(match[2]), csvArity(match[1]), `${table}[${index}] values must match columns`)
    assert.equal((match[2].match(/\?/g) ?? []).length, expectedPlaceholders[index], `${table}[${index}] bind arity changed`)
  })
}

assertInsertArities('strategy_decision_log', [20])
assertInsertArities('strategy_learning_daily_stats', [10, 10])
assertInsertArities('strategy_learning_head', [15])
assertInsertArities('strategy_reward_ledger', [20])
assert.match(source, /m\.evaluable = 1/)
assert.match(source, /m\.reference_contract_version = 'selection-reference-snapshot-v3'/)
assert.match(source, /evaluation_contract_version = 'strategy-evaluation-v2'/)
assert.match(source, /selection_contract_version = 'selection-reference-snapshot-v3'/)
assert.match(source, /decision_contract_version = 'strategy-evaluation-v2'/)
assert.match(source, /projection_version = 'strategy-learning-head-v2'/)
assert.match(source, /const canUseLatestHead = projectionHead\?\.latest_date != null/)
assert.match(source, /SUM\(CASE WHEN decision_contract_version = 'strategy-evaluation-v2' THEN decisions ELSE 0 END\) AS lifetime_decisions/)
assert.match(source, /COUNT\(DISTINCT CASE WHEN decision_contract_version = 'strategy-evaluation-v2' AND decisions > 0 THEN date END\) AS decision_dates/)
assert.doesNotMatch(source, /SUM\(decisions\) AS lifetime_decisions/)
assert.match(source, /decision_contract_version = 'strategy-evaluation-v2'\s+OR reward_contract_version = 'selection-reference-snapshot-v3'/)
assert.match(source, /SET evaluable=\?, evaluability_status=\?, unavailable_reason=\?,\s*evaluation_contract_version='strategy-evaluation-v2'/)
assert.match(source, /COALESCE\(r\.evaluation_contract_version, ''\) <> 'strategy-evaluation-v2'/)
assert.match(source, /existingMatrix\.reference_contract_version\) === SELECTION_REFERENCE_CONTRACT_VERSION/)
assert.match(source, /SET status='success'[\s\S]*evaluation_contract_version='strategy-evaluation-v2'/)
assert.match(source, /valid_runs AS \([\s\S]*STRATEGY_FORMAL_LABELER_VERSION[\s\S]*STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION[\s\S]*LEFT JOIN valid_runs v ON v\.signal_date=d\.date[\s\S]*r\.status='success' AND v\.signal_date IS NULL/)
assert.match(source, /m\.labeler_version=mr\.labeler_version/)
assert.match(source, /m\.strategy_registry_checksum=mr\.strategy_registry_checksum/)
assert.match(source, /m\.reference_contract_version=mr\.reference_contract_version/)
assert.match(source, /sr\.strategy_labeler_version=mr\.labeler_version/)
assert.match(source, /sr\.strategy_registry_checksum=mr\.strategy_registry_checksum/)
assert.match(source, /sourceMatrixLabeler !== referenceLabeler/)
assert.doesNotMatch(source, /candidateStrategyEvidenceMode/)
assert.match(source, /mr\.reference_contract_version='selection-reference-snapshot-v3'/)
assert.match(source, /mr\.persisted_cell_count=mr\.expected_cell_count/)
assert.match(source, /h\.run_id=mr\.producer_run_id/)
