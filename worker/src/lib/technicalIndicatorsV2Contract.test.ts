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
]

const schema = fs.readFileSync('schema.sql', 'utf8')
const migration = fs.readFileSync('migration_technical_indicators_v2.sql', 'utf8')
const technicalIndicators = fs.readFileSync('src/lib/technicalIndicators.ts', 'utf8')
const technicalIndicatorTest = fs.readFileSync('src/lib/technicalIndicators.test.ts', 'utf8')
const sharedFixture = JSON.parse(fs.readFileSync('src/lib/technicalIndicatorsV2.fixture.json', 'utf8'))
const payloadBuilder = fs.readFileSync('../ml-controller/services/payload_builder.py', 'utf8')
const recommendationService = fs.readFileSync('../ml-controller/services/recommendation_service.py', 'utf8')
const scoreV2TechnicalContract = fs.readFileSync('../ml-controller/tests/test_score_v2_technical_contract.py', 'utf8')

for (const column of requiredColumns) {
  assert(schema.includes(column), `schema.sql must define technical_indicators.${column}`)
  assert(
    migration.includes(`ALTER TABLE technical_indicators ADD COLUMN ${column} REAL`),
    `migration_technical_indicators_v2.sql must add ${column}`,
  )
  assert(technicalIndicators.includes(column), `computeAndStoreIndicators must write ${column}`)
  assert(payloadBuilder.includes(column), `payload_builder must read ${column}`)
}

assert(
  technicalIndicators.includes('computeDmiAdx') &&
    technicalIndicators.includes('computeParabolicSar') &&
    technicalIndicators.includes('computeCci') &&
    technicalIndicators.includes('computeVolumeWeightedRsi') &&
    technicalIndicators.includes('computeVolumeMomentumDivergence'),
  'technical indicator runtime must compute DMI/ADX, SAR, CCI, volume-weighted RSI, and volume momentum divergence',
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
          .replace('volume_momentum_divergence_13_27_10', 'volumeMomentumDivergence132710') === key,
      ),
    `shared technical fixture must include expected value for ${column}`,
  )
}

assert(
  technicalIndicatorTest.includes('technicalIndicatorsV2.fixture.json') &&
    scoreV2TechnicalContract.includes('technicalIndicatorsV2.fixture.json'),
  'Worker formula tests and Python Score V2 tests must both consume the shared technical indicator fixture',
)
