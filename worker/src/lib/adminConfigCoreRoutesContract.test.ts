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
  /setTradingConfig\(c\.env\.KV, merged, \{\s*\.\.\.snapshotMeta,/.test(source)
    && source.includes("source: overrideAudit ? 'manual_override' : 'parameter_promotion'")
    && source.includes('push_id: promotionPacketId ?? snapshotMeta.push_id'),
  'admin config PUT must preserve caller metadata and authoritative promotion/override audit',
)

assert(
  /return c\.json\(\{\s*success: true,\s*config: merged,\s*snapshot,/.test(source),
  'admin config PUT response must expose snapshot write result for audit',
)

console.log('adminConfigCoreRoutesContract ok')
