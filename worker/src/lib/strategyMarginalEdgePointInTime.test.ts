import assert from 'node:assert/strict'

import { STRATEGY_MARGINAL_EDGE_POINT_IN_TIME_HEAD_SQL } from './strategyMarginalEdgePointInTime'

assert.match(STRATEGY_MARGINAL_EDGE_POINT_IN_TIME_HEAD_SQL, /status='promoted'/)
assert.match(STRATEGY_MARGINAL_EDGE_POINT_IN_TIME_HEAD_SQL, /as_of_date\s*<\s*\?/)
assert.doesNotMatch(STRATEGY_MARGINAL_EDGE_POINT_IN_TIME_HEAD_SQL, /as_of_date\s*<=\s*\?/)
assert.match(STRATEGY_MARGINAL_EDGE_POINT_IN_TIME_HEAD_SQL, /ORDER BY as_of_date DESC/)

console.log('strategy marginal edge point-in-time contract tests passed')
