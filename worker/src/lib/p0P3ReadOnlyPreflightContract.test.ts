import fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const preflight = fs.readFileSync('worker/preflight_p0_p3_readonly_2026_06_22.sql', 'utf8')
const withoutComments = preflight
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

assert(
  preflight.includes('P0-P3 production preflight audit, read-only'),
  'P0-P3 preflight SQL must declare read-only intent',
)
assert(
  preflight.includes('p0_direction_correct_minus_one_scope'),
  'P0-P3 preflight must audit direction_correct=-1 repair scope',
)
assert(
  preflight.includes('p1_timesfm_sidecar_presence'),
  'P0-P3 preflight must audit TimesFM sidecar rollout state',
)
assert(
  preflight.includes('p2_ga_registry_status'),
  'P0-P3 preflight must audit GA candidate registry state',
)
assert(
  preflight.includes('p2_ga_evidence_status'),
  'P0-P3 preflight must audit GA evidence/promotion packet state',
)
assert(
  !/\b(UPDATE|DELETE|INSERT|REPLACE|ALTER|DROP|CREATE|TRUNCATE|MERGE)\b/i.test(withoutComments),
  'P0-P3 preflight SQL must remain read-only',
)
assert(
  !/npx\s+wrangler[^\r\n]*--remote\s+--file/i.test(preflight),
  'P0-P3 read-only preflight must not recommend remote --file import mode',
)
