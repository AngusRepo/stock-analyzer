import assert from 'node:assert/strict'
import {
  materializeFormal137FeatureAliases,
  materializeFormal137UsSentimentScoreRank,
} from './formal137FeatureMaterialization'
import { assessCandidateAgainstStrategySpecs, DEFAULT_STRATEGY_SPECS } from './strategySpec'

const strategy0081 = {
  ...DEFAULT_STRATEGY_SPECS[0],
  id: 'alpha_miner_pymoo_nsga3_novelty_0081',
  thresholds: {
    minPrice: 10,
    minVolumeExpansion20: 0.7,
    featureRefs: {
      weightedScore: {
        min: 0.62,
        terms: [
          { featureRef: 'KLOW2', signal: 'factorSignals.KLOW2', weight: 0.415128 },
          { featureRef: 'advance_ratio', signal: 'factorSignals.advance_ratio', weight: 0.117772 },
          { featureRef: 'CNTD_20', signal: 'factorSignals.CNTD_20', weight: 0.20684 },
          { featureRef: 'KSFT', signal: 'factorSignals.KSFT', weight: 0.260259 },
        ],
      },
    },
  },
}

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
  const candidates: any[] = [{
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      volumeExpansion20: 0.9,
      advanceRatio: 0.7,
      technicalIndicators: {
        KLOW2: 0.9,
        CNTD_20: 0.8,
        KSFT: 0.8,
      },
      factorSignals: {},
    },
  }]
  const telemetry = materializeFormal137FeatureAliases(candidates)
  assert.equal(telemetry.materializedCount, 1)
  assert.equal(candidates[0].raw_signals.factorSignals.KLOW2, 0.9)
  assert.equal(candidates[0].raw_signals.factorSignals.CNTD_20, 0.8)
  assert.equal(candidates[0].raw_signals.factorSignals.KSFT, 0.8)
  assert.equal(candidates[0].raw_signals.factorSignals.advance_ratio, 0.7)

  const assessment = assessCandidateAgainstStrategySpecs(candidates[0], [strategy0081])
  assert(
    assessment.matches.some((match) => match.specId === 'alpha_miner_pymoo_nsga3_novelty_0081'),
    '0081 should strict-match after canonical formal137 aliases are materialized from existing raw technicals',
  )
}

{
  const candidates: any[] = [{
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      volumeExpansion20: 0.9,
      advanceRatio: 0.7,
      technicalIndicators: {
        KLOW2: 0.9,
        CNTD_20: 0.8,
      },
      factorSignals: {},
    },
  }]
  materializeFormal137FeatureAliases(candidates)
  const assessment = assessCandidateAgainstStrategySpecs(candidates[0], [strategy0081])
  assert(!assessment.matches.length, '0081 should still fail closed when a required formal137 source value is absent')
  assert(
    assessment.watchPoints.some((point) => point.includes('KSFT')),
    '0081 should keep missing source evidence visible after alias materialization',
  )
}

{
  const candidates: any[] = [{
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      closeAboveMa60Pct: 0.05,
      volShareTurnover21d: 0.034,
      technicalIndicators: {
        squeezeRelease: 1,
        bbBandwidthPct: 0.08,
        bestOrderBlockStrength: 0.72,
        VSTD_10: 12345,
        tech_emv_14: 0.0012,
      },
      factorSignals: {},
    },
  }]
  const telemetry = materializeFormal137FeatureAliases(candidates)
  assert.equal(telemetry.materializedCount, 1)
  assert.equal(candidates[0].raw_signals.factorSignals.l1_closeAboveMa60Pct, 0.05)
  assert.equal(candidates[0].raw_signals.factorSignals.l1_squeezeRelease, 1)
  assert.equal(candidates[0].raw_signals.factorSignals.l1_bbBandwidthPct, 0.08)
  assert.equal(candidates[0].raw_signals.factorSignals.l1_bestOrderBlockStrength, 0.72)
  assert.equal(candidates[0].raw_signals.factorSignals.VSTD_10, 12345)
  assert.equal(candidates[0].raw_signals.factorSignals.tech_emv_14, 0.0012)
  assert.equal(candidates[0].raw_signals.factorSignals.vol_share_turnover_21d, 0.034)
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
  const candidates: any[] = [{
    symbol: '4444',
    current_price: 30,
    raw_signals: {
      return5d: 0.03,
      return20d: 0.08,
      volumeExpansion20: 1.2,
      marginBalance: 68_793,
      factorSignals: {
        formal137UsSentimentScoreRank: 0.9,
        finlabCsMarginBalanceRank: 0.8,
      },
    },
  }]
  const telemetry = materializeFormal137FeatureAliases(candidates)
  assert.equal(telemetry.materializedCount, 1)
  assert.equal(candidates[0].raw_signals.factorSignals.margin_balance, 68_793)
  assert.equal(candidates[0].raw_signals.factorSignals.formal137MarginBalanceRank, 0.8)
  assert.equal(candidates[0].raw_signals.factorSignals.margin_balance_rank, 0.8)

  const assessment = assessCandidateAgainstStrategySpecs(candidates[0], [strategy0193])
  assert(
    assessment.matches.some((match) => match.specId === 'alpha_miner_pymoo_nsga3_novelty_0193'),
    '0193 should strict-match when margin raw value and existing finlab margin rank are projected into formal137 aliases',
  )
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
