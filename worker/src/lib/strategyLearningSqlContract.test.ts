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

assertInsertArities('strategy_decision_log', [19])
assertInsertArities('strategy_learning_daily_stats', [8, 10])
assertInsertArities('strategy_learning_head', [13])
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