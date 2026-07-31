import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')

assert.match(
  source,
  /mr\.labeler_version IN \(\s*'strategy-labeler-v1',\s*'strategy-decision-log-pit-reconstruction-v6'\s*\)/,
  'historical repair discovery must treat a complete native matrix as closed',
)
assert.match(
  source,
  /\[\s*'strategy-labeler-v1',\s*labelerVersion,\s*\]\.includes\(cleanToken\(existingMatrix\.labeler_version\)\)/,
  'historical repair must reuse a complete native matrix instead of deleting Route V2 evidence',
)
assert.match(
  source,
  /if \(reusableExistingMatrix\) \{\s*matrixRows = expectedMatrixRows\s*\} else \{\s*if \(existingMatrix\)/,
  'matrix deletion must remain inside the incomplete/non-native repair branch',
)
