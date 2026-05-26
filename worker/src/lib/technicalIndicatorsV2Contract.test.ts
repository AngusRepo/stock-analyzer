import * as fs from 'fs'

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const requiredColumns = [
  'plus_di14',
  'minus_di14',
  'adx14',
  'parabolic_sar',
  'cci20',
  'volume_weighted_rsi14',
  'volume_momentum_divergence_13_27_10',
  'squeeze_on',
  'squeeze_release',
  'squeeze_momentum',
  'obv_temperature_60',
  'adaptive_rsi_midline_50',
  'adaptive_rsi_upper_50',
  'adaptive_rsi_lower_50',
  'adaptive_rsi_overbought',
  'adaptive_rsi_oversold',
]

const schema = fs.readFileSync('schema.sql', 'utf8')
const migration = fs.readFileSync('migration_technical_indicators_v2.sql', 'utf8')
const xqMigration = fs.readFileSync('migration_technical_indicators_xq_2026_05_26.sql', 'utf8')
const adaptiveRsiMigration = fs.readFileSync('migration_technical_indicators_adaptive_rsi_2026_05_26.sql', 'utf8')
const technicalIndicators = fs.readFileSync('src/lib/technicalIndicators.ts', 'utf8')
const technicalIndicatorTest = fs.readFileSync('src/lib/technicalIndicators.test.ts', 'utf8')
const sharedFixture = JSON.parse(fs.readFileSync('src/lib/technicalIndicatorsV2.fixture.json', 'utf8'))
const payloadBuilder = fs.readFileSync('../ml-controller/services/payload_builder.py', 'utf8')
const recommendationService = fs.readFileSync('../ml-controller/services/recommendation_service.py', 'utf8')
const scoreV2TechnicalContract = fs.readFileSync('../ml-controller/tests/test_score_v2_technical_contract.py', 'utf8')

for (const column of requiredColumns) {
  assert(schema.includes(column), `schema.sql must define technical_indicators.${column}`)
  assert(
    migration.includes(`ALTER TABLE technical_indicators ADD COLUMN ${column} REAL`) ||
      xqMigration.includes(`ALTER TABLE technical_indicators ADD COLUMN ${column} REAL`) ||
      adaptiveRsiMigration.includes(`ALTER TABLE technical_indicators ADD COLUMN ${column} REAL`),
    `technical indicator migrations must add ${column}`,
  )
  assert(technicalIndicators.includes(column), `computeAndStoreIndicators must write ${column}`)
  assert(payloadBuilder.includes(column), `payload_builder must read ${column}`)
}

assert(
  technicalIndicators.includes('computeDmiAdx') &&
    technicalIndicators.includes('computeParabolicSar') &&
    technicalIndicators.includes('computeCci') &&
    technicalIndicators.includes('computeVolumeWeightedRsi') &&
    technicalIndicators.includes('computeVolumeMomentumDivergence') &&
    technicalIndicators.includes('computeTtmSqueeze') &&
    technicalIndicators.includes('computeObvTemperature') &&
    technicalIndicators.includes('computeAdaptiveRsiBands'),
  'technical indicator runtime must compute DMI/ADX, SAR, CCI, volume-weighted RSI, volume momentum divergence, TTM squeeze, OBV temperature, and adaptive RSI bands',
)

assert(
  recommendationService.includes('"technicalSignals"') &&
    recommendationService.includes('"technicalBreakdown"') &&
    recommendationService.includes('volumeMomentumDivergence132710'),
  'controller Score V2 payload must preserve technicalSignals and technicalBreakdown',
)

for (const column of requiredColumns) {
  assert(
    sharedFixture.expectedIndicators &&
      Object.keys(sharedFixture.expectedIndicators).some((key) =>
        column
          .replace('plus_di14', 'plusDi14')
          .replace('minus_di14', 'minusDi14')
          .replace('parabolic_sar', 'parabolicSar')
          .replace('volume_weighted_rsi14', 'volumeWeightedRsi14')
          .replace('volume_momentum_divergence_13_27_10', 'volumeMomentumDivergence132710')
          .replace('squeeze_on', 'squeezeOn')
          .replace('squeeze_release', 'squeezeRelease')
          .replace('squeeze_momentum', 'squeezeMomentum')
          .replace('obv_temperature_60', 'obvTemperature60')
          .replace('adaptive_rsi_midline_50', 'adaptiveRsiMidline50')
          .replace('adaptive_rsi_upper_50', 'adaptiveRsiUpper50')
          .replace('adaptive_rsi_lower_50', 'adaptiveRsiLower50')
          .replace('adaptive_rsi_overbought', 'adaptiveRsiOverbought')
          .replace('adaptive_rsi_oversold', 'adaptiveRsiOversold') === key,
      ),
    `shared technical fixture must include expected value for ${column}`,
  )
}

assert(
  technicalIndicatorTest.includes('technicalIndicatorsV2.fixture.json') &&
    scoreV2TechnicalContract.includes('technicalIndicatorsV2.fixture.json'),
  'Worker formula tests and Python Score V2 tests must both consume the shared technical indicator fixture',
)
