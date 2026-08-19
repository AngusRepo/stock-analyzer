import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./dataDomainShadowBackfill.ts', import.meta.url), 'utf8')
const authorityStart = source.indexOf('export async function backfillDataDomainTableShadow')
const authorityEnd = source.indexOf('const learningAuthority', authorityStart)
const authority = source.slice(authorityStart, authorityEnd)

assert(authorityStart >= 0 && authorityEnd > authorityStart)
assert(authority.includes('activeDataDomains(env).has(domain)'))
assert(!authority.includes('MULTI_D1_STRICT'))

console.log('data domain shadow strict isolation contract passed')
