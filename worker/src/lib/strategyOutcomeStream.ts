/// <reference types="node" />
import { createHash } from 'node:crypto'
import type { OutcomeCell } from './strategyMarginalEdgeV4'

/** Hash every source cell in its original order, but retain only the rows used
 * by the evaluators: hits, first symbol observations (sum order), and first
 * strategy observations (including strategies that never hit).
 * The label join must give every strategy the same outcome for a date/symbol.
 */
export class StrategyOutcomeStream {
  readonly cells: OutcomeCell[] = []
  sourceRows = 0
  private readonly hash = createHash('sha256').update('[')
  private readonly outcomes = new Map<string, OutcomeCell>()
  private readonly strategies = new Set<string>()
  private readonly strings = new Map<string, string>()
  private fingerprint: string | null = null

  append(rows: OutcomeCell[]): void {
    if (this.fingerprint !== null) throw new Error('strategy_outcome_stream_already_finished')
    for (const row of rows) {
      const symbolKey = `${row.signal_date}\u0000${row.symbol}`
      const strategyKey = `${row.strategy_id}\u0000${row.strategy_version}`
      const prior = this.outcomes.get(symbolKey)
      if (prior && (!Object.is(prior.absolute_return_net, row.absolute_return_net)
        || !Object.is(prior.residual_return_net, row.residual_return_net))) {
        throw new Error(`strategy_outcome_cohort_inconsistent:${row.signal_date}:${row.symbol}`)
      }
      if (this.sourceRows++) this.hash.update(',')
      this.hash.update(JSON.stringify([
        row.signal_date, row.symbol, row.strategy_id, row.strategy_version, row.family_id,
        Number(row.production_owner), Number(row.strategy_hit),
        Number(row.absolute_return_net), Number(row.residual_return_net),
      ]))
      if (!prior || !this.strategies.has(strategyKey) || Number(row.strategy_hit) === 1) {
        const retained = {
          ...row,
          signal_date: this.intern(row.signal_date), symbol: this.intern(row.symbol),
          strategy_id: this.intern(row.strategy_id), strategy_version: this.intern(row.strategy_version),
          family_id: this.intern(row.family_id),
        }
        this.cells.push(retained)
        if (!prior) this.outcomes.set(symbolKey, retained)
      }
      this.strategies.add(strategyKey)
    }
  }

  finish(): string {
    if (this.fingerprint === null) {
      this.fingerprint = this.hash.update(']').digest('hex').slice(0, 20)
      this.outcomes.clear()
      this.strategies.clear()
      this.strings.clear()
    }
    return this.fingerprint
  }

  private intern(value: string): string {
    const existing = this.strings.get(value)
    if (existing !== undefined) return existing
    this.strings.set(value, value)
    return value
  }
}
