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

for (const key of ['l4Distribution', 'l4R2Learning', 'sltp_per_regime']) {
  assert(
    source.includes(`{ ${key}: ${key === 'sltp_per_regime' ? '(current as any).sltp_per_regime' : `current.${key}`} }`),
    `admin config PUT must keep ${key} from the stored config`,
  )
}
assert(
  source.includes("['l4Distribution', 'l4R2Learning', 'sltp_per_regime'].filter((key) => key in body)")
    && source.includes("error: 'config_put_cannot_write_owned_blocks'"),
  'admin config PUT must reject writes to blocks owned by reviewed writers',
)

console.log('adminConfigCoreRoutesContract ok')
