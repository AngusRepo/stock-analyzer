import fs from 'node:fs'

const source = fs.readFileSync('src/lib/storageCapacityTelemetry.ts', 'utf8')
if (!source.includes("utilizationPct >= 85") || !source.includes("return 'critical'")) {
  throw new Error('capacity telemetry must fail before D1 reaches the hard 10GB limit')
}
if (!source.includes("utilizationPct >= 75") || !source.includes("return 'drain'")) {
  throw new Error('capacity telemetry must expose an automatic archive drain watermark')
}
if (!source.includes("utilizationPct >= 65") || !source.includes("return 'warning'")) {
  throw new Error('capacity telemetry must expose an early warning watermark')
}
if (!source.includes('meta?.size_after') || source.includes('`PRAGMA ${name}`')) {
  throw new Error('capacity telemetry must use D1 query meta.size_after, not unsupported prepared PRAGMA calls')
}
if (!source.includes("databaseForDataDomain(env, 'ops')")) {
  throw new Error('capacity observations must be persisted through the ops domain owner')
}
