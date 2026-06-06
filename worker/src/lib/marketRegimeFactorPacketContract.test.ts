import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = fs.readFileSync('src/lib/marketRegimeFactorPacket.ts', 'utf8')

assert(
  source.includes('function regimeEvidenceItem') &&
    source.includes('regimeState?.regime_evidence?.evidence?.[key]'),
  'market regime factor packet must read nested regime_evidence.evidence entries emitted by ml-controller',
)

assert(
  source.includes('regimeState?.regime_evidence?.evidence?.tw_business_indicators?.signal') &&
    source.includes('regimeState?.regime_evidence?.evidence?.tw_business_indicators?.leading_index'),
  'business-cycle tile must read nested FinLab TW business indicator evidence when present',
)
