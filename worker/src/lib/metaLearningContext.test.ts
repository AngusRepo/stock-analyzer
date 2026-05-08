import {
  META_LEARNING_CONTEXT_FEATURES,
  buildExpandedMetaLearningContext,
  hashExpandedMetaLearningContext,
} from './metaLearningContext'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(META_LEARNING_CONTEXT_FEATURES.length === 12, 'expanded meta context should include 11 signals plus bias')
  assert(META_LEARNING_CONTEXT_FEATURES.includes('model_ic'), 'context should include model IC')
  assert(META_LEARNING_CONTEXT_FEATURES.includes('prediction_dispersion'), 'context should include prediction dispersion')
  assert(META_LEARNING_CONTEXT_FEATURES.includes('fill_quality'), 'context should include fill quality')
}

{
  const context = buildExpandedMetaLearningContext({
    model_ic: 0.08,
    coverage: 0.72,
    prediction_dispersion: 0.15,
    data_quality: 0.94,
    market_breadth: 0.61,
    sector_heat: 0.44,
    liquidity: 0.8,
    fill_quality: 0.7,
    regime: 'bull',
    volatility: 0.24,
    market_risk: 0.19,
  })

  assert(context.version === 'meta-context-v2', 'context version should be explicit')
  assert(context.vector.length === META_LEARNING_CONTEXT_FEATURES.length, 'vector length should match feature contract')
  assert(context.values.regime === 0, 'bull regime should encode as low risk/opportunity context')
  assert(context.values.bias === 1, 'bias should always be one')
  assert(context.coverage.missing.length === 0, 'full input should not report missing features')
  assert(hashExpandedMetaLearningContext(context).startsWith('meta-context-v2:'), 'hash should include version')
}

{
  const context = buildExpandedMetaLearningContext({ regime: 'bear', data_quality: null })
  assert(context.coverage.missing.includes('model_ic'), 'missing model IC should be reported')
  assert(context.coverage.missing.includes('data_quality'), 'null data quality should be reported as missing')
  assert(context.values.regime === 1, 'bear regime should encode as high risk context')
  assert(context.values.bias === 1, 'partial context should still include bias')
}
