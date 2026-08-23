import assert from 'node:assert/strict'

import { D1_SAFE_IN_CHUNK_SIZE, d1SafeInChunks } from './d1BindChunks'

const symbols = Array.from({ length: 197 }, (_, index) => `S${index}`)
const chunks = d1SafeInChunks(symbols)

assert.equal(D1_SAFE_IN_CHUNK_SIZE, 36)
assert.equal(chunks.length, 6)
assert.deepEqual(chunks.flat(), symbols)
assert(chunks.every((chunk) => chunk.length + 2 < 100), 'IN-list plus two date binds must stay below D1 limit')
assert.deepEqual(d1SafeInChunks([]), [])

console.log('D1 bind chunk tests passed')
