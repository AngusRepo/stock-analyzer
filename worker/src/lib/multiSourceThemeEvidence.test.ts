import {
  buzzResultsToThemeEvidence,
  combineMultiSourceThemeEvidence,
} from './multiSourceThemeEvidence'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const ptt = buzzResultsToThemeEvidence('ptt', [
  { concept: 'AI_Server', mentionCount: 8, sentimentAvg: 0.3, topPosts: ['ptt ai'] },
  { concept: 'PCB', mentionCount: 2, sentimentAvg: 0.1, topPosts: ['ptt pcb'] },
])

const anue = buzzResultsToThemeEvidence('anue', [
  { concept: 'AI_Server', mentionCount: 4, sentimentAvg: 0, topPosts: ['anue ai'] },
])

const runtimeSignals = [
  {
    source: 'finnhub_news',
    concept: 'AI_Server',
    mentionCount: 2,
    sentimentAvg: 0.2,
    topPosts: ['finnhub ai'],
    score: 0.8,
  },
  {
    source: 'gdelt_events',
    concept: 'SUPPLY_CHAIN_RISK',
    mentionCount: 3,
    sentimentAvg: -0.5,
    topPosts: ['gdelt risk'],
    score: 0.7,
    decisionEffect: 'research_or_risk_context',
  },
]

const combined = combineMultiSourceThemeEvidence([ptt, anue, runtimeSignals])

assert(combined.combinedBuzz[0].concept === 'AI_Server', 'AI_Server should stay top after cross-source evidence merge')
assert((combined.scoreMap.get('AI_Server') ?? 0) > (combined.scoreMap.get('PCB') ?? 0), 'multi-source score must beat single-source weak evidence')
assert(combined.sourceBreakdown.get('AI_Server')?.ptt !== undefined, 'PTT source contribution must be traceable')
assert(combined.sourceBreakdown.get('AI_Server')?.finnhub_news !== undefined, 'Finnhub source contribution must be traceable')
assert(combined.acceptedSources.ptt === 2, 'accepted source counts must include PTT rows')
assert(combined.acceptedSources.finnhub_news === 1, 'accepted source counts must include Finnhub rows')
