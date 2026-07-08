import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/routes/adminConfigCoreRoutes.ts', 'utf8')

assert(
  source.includes("const requestMeta = body.meta") &&
    source.includes("source: typeof requestMeta.source") &&
    source.includes("push_id: typeof requestMeta.push_id"),
  'admin config PUT must accept caller snapshot metadata',
)

assert(
  source.includes("setTradingConfig(c.env.KV, merged, snapshotMeta)"),
  'admin config PUT must pass snapshot metadata into setTradingConfig',
)

assert(
  source.includes("snapshot })"),
  'admin config PUT response must expose snapshot write result for audit',
)

console.log('adminConfigCoreRoutesContract ok')
