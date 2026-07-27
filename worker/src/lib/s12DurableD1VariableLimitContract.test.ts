import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/lib/s12DurableStructureBatch.ts', 'utf8')

assert(source.includes('offset += 80'))
assert(source.includes('slice(offset, offset + 80)'))
assert(!source.includes('offset += 200'))
