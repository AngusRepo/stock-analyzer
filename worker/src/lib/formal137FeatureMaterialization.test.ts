import assert from 'node:assert/strict'
import { materializeFormal137UsSentimentScoreRank } from './formal137FeatureMaterialization'
import { assessCandidateAgainstStrategySpecs, DEFAULT_STRATEGY_SPECS } from './strategySpec'

const strategy0193 = {
  ...DEFAULT_STRATEGY_SPECS[0],
  id: 'alpha_miner_pymoo_nsga3_novelty_0193',
  thresholds: {
    minPrice: 10,
    minVolumeExpansion20: 0.55,
    featureRefs: {
      weightedScore: {
        min: 0.58,
        terms: [
          { featureRef: 'us_sentiment_score', signal: 'factorSignals.us_sentiment_score', weight: 0.478671 },
          { featureRef: 'margin_balance', signal: 'factorSignals.margin_balance', weight: 0.521329 },
        ],
      },
    },
  },
}

{
  const candidates: any[] = [
    {
      symbol: '1111',
      current_price: 30,
      raw_signals: {
        return5d: -0.02,
        return20d: -0.05,
        volumeExpansion20: 0.8,
        marginBalance: 10,
        factorSignals: {
          us_sentiment_score: 1,
          margin_balance: 10,
          formal137MarginBalanceRank: 0.2,
        },
      },
    },
    {
      symbol: '2222',
      current_price: 30,
      raw_signals: {
        return5d: 0.01,
        return20d: 0.03,
        volumeExpansion20: 1.1,
        marginBalance: 20,
        factorSignals: {
          us_sentiment_score: 1,
          margin_balance: 20,
          formal137MarginBalanceRank: 0.55,
        },
      },
    },
    {
      symbol: '3333',
      current_price: 30,
      raw_signals: {
        return5d: 0.08,
        return20d: 0.12,
        volumeExpansion20: 1.6,
        marginBalance: 30,
        factorSignals: {
          us_sentiment_score: 1,
          margin_balance: 30,
          formal137MarginBalanceRank: 0.8,
        },
      },
    },
  ]
  const telemetry = materializeFormal137UsSentimentScoreRank(candidates)
  assert.equal(telemetry.materializedCount, 3)
  assert.equal(candidates[0].raw_signals.factorSignals.formal137UsSentimentScoreRank, 0)
  assert.equal(candidates[2].raw_signals.factorSignals.formal137UsSentimentScoreRank, 1)
  assert.equal(
    candidates[2].raw_signals.factorSignals.us_sentiment_score_rank,
    candidates[2].raw_signals.factorSignals.formal137UsSentimentScoreRank,
  )

  const assessment = assessCandidateAgainstStrategySpecs(candidates[2], [strategy0193])
  assert(
    assessment.matches.some((match) => match.specId === 'alpha_miner_pymoo_nsga3_novelty_0193'),
    '0193 should strict-match after us sentiment is materialized as non-constant formal137 rank',
  )
}

{
  const candidates: any[] = [
    { raw_signals: { return5d: -0.02, factorSignals: { us_sentiment_score: 0.5 } } },
    { raw_signals: { return5d: 0.08, factorSignals: { us_sentiment_score: 0.5 } } },
  ]
  const telemetry = materializeFormal137UsSentimentScoreRank(candidates)
  assert.equal(telemetry.materializedCount, 0)
  assert.equal(telemetry.skippedNeutralCount, 2)
  assert.equal(candidates[0].raw_signals.factorSignals.formal137UsSentimentScoreRank, undefined)
}

{
  const candidates: any[] = [
    { raw_signals: { return5d: 0.01, factorSignals: { us_sentiment_score: 1 } } },
    { raw_signals: { return5d: 0.01, factorSignals: { us_sentiment_score: 1 } } },
  ]
  const telemetry = materializeFormal137UsSentimentScoreRank(candidates)
  assert.equal(telemetry.materializedCount, 0)
  assert.equal(telemetry.skippedConstantExposureCount, 2)
  assert.equal(candidates[0].raw_signals.factorSignals.formal137UsSentimentScoreRank, undefined)
}
