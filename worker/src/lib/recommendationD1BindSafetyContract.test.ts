import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.resolve(process.cwd(), 'src/routes/other.ts'), 'utf8')

assert(source.includes('for (const chunk of d1SafeInChunks(symbolsForHydration))'))
assert(source.includes('for (const resultSymbolChunk of d1SafeInChunks(resultSymbols))'))
assert(source.includes('for (const stockIdChunk of d1SafeInChunks(stockIds))'))
assert(!source.includes('.bind(cardDataAsOfDate, ...resultSymbols)'))
assert(!source.includes('.bind(date, ...resultSymbols)'))
assert(!source.includes('.bind(...stockIds, date)'))
assert(source.includes('optional broker aggregate hydration unavailable'))

console.log('Recommendation D1 bind safety contract tests passed')
