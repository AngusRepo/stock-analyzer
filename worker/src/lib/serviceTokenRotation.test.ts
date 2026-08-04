import assert from 'node:assert/strict'

import { hasServiceToken } from './auth'

assert.equal(hasServiceToken('current', 'current', 'previous'), true)
assert.equal(hasServiceToken('previous', 'current', 'previous'), true)
assert.equal(hasServiceToken('retired', 'current', 'previous'), false)
assert.equal(hasServiceToken('', 'current', 'previous'), false)
assert.equal(hasServiceToken('previous', 'current'), false)

console.log('service token rotation contract tests passed')
