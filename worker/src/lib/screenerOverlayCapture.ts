/** Freeze the inputs actually read by the screener; never substitute live reads
 * during replay. Stored inside the EXISTING Atomic canonical artifact only.
 */
export type OverlayObservation = {
  started_at: string
  completed_at: string
  symbols: string[] | null
  status: 'captured' | 'failed' | 'unverified'
  value?: unknown
  reason?: string
}

// Map values are raw reader results, not a second scoring implementation.
function snapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item instanceof Map) return { entries: [...item.entries()] }
    if (item instanceof Set) return [...item]
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('overlay_capture_nonfinite')
    return item
  }))
}

export class ScreenerOverlayCapture {
  private readonly observations: Record<string, OverlayObservation[]> = {}

  /** Return the ORIGINAL result to the formal caller, but retain a detached copy.
   * A failed extra-symbol read must not erase a successful formal observation.
   * Errors contain stage identifiers only; do not persist credentials/SQL URLs.
   */
  async read<T>(name: string, symbols: string[] | null, loader: () => Promise<T>,
    verification: 'captured' | 'unverified' = 'captured'): Promise<T> {
    const started_at = new Date().toISOString()
    this.observations[name] ??= []
    try {
      const value = await loader()
      this.observations[name].push({ started_at, completed_at: new Date().toISOString(),
        symbols: symbols ? [...symbols] : null, status: verification, value: snapshot(value) })
      return value
    } catch (error) {
      this.observations[name].push({ started_at, completed_at: new Date().toISOString(),
        symbols: symbols ? [...symbols] : null, status: 'failed', reason: `${name}_read_failed` })
      throw error
    }
  }

  /** Formal scope runs first, unchanged. Extra observations are shadow-only;
   * they never change the formal scope, percentile population or returned data.
   */
  async partitioned<T>(name: string, formalSymbols: string[], allSymbols: string[],
    loader: (symbols: string[]) => Promise<T>, verification: 'captured' | 'unverified' = 'captured'): Promise<T> {
    const formal = await this.read(name, formalSymbols, () => loader(formalSymbols), verification)
    const present = new Set(formalSymbols)
    const extra = [...new Set(allSymbols)].filter(symbol => !present.has(symbol))
    if (extra.length) {
      await this.read(name, extra, () => loader(extra), verification).catch(() => undefined)
    }
    return formal
  }

  record(name: string, value: unknown, verification: 'captured' | 'unverified' = 'captured'): void {
    const at = new Date().toISOString()
    this.observations[name] = [{ started_at: at, completed_at: at, symbols: null,
      status: verification, value: snapshot(value) }]
  }

  freeze(input: { signalDate: string; universeSymbols: string[]; formalSymbols: string[]; finalSeed: unknown;
    safetyExcludedSymbols: string[]; policy: unknown }) {
    const required = ['news_sentiment', 'theme_context', 'external_risk', 'foreign_flow',
      'technical_history', 'selection_history', 'recent_sessions', 'theme_keywords',
      'theme_ptt', 'theme_news', 'theme_anue', 'theme_runtime', 'sector_bonus', 'core_seed_context', 'core_seed_materialization', 'core_seed_persistence']
    const perSymbol = new Set(['news_sentiment', 'external_risk', 'technical_history', 'selection_history', 'recent_sessions', 'sector_bonus'])
    const issues: string[] = []
    for (const name of required) {
      const records = this.observations[name] ?? []
      if (!records.length) issues.push(`${name}:not_captured`)
      for (const row of records) {
        if (row.status !== 'captured') issues.push(`${name}:${row.status}`)
        const value = row.value as { missing_identity_symbols?: unknown[]; source_status?: string; issues?: string[] } | undefined
        if (value?.missing_identity_symbols?.length) issues.push(`${name}:identity_missing`)
        if (value?.source_status === 'incomplete') issues.push(...(value.issues ?? ['incomplete']).map(issue => `${name}:${issue}`))
        // Live feeds queried after this signal day's close cannot reconstruct
        // historical context. Freeze honestly, without claiming PIT eligibility.
        if (['theme_ptt', 'theme_anue', 'theme_keywords'].includes(name)
          && Date.parse(row.completed_at) >= Date.parse(`${input.signalDate}T00:00:00+08:00`) + 86400_000) {
          issues.push(`${name}:observed_after_signal_day`)
        }
      }
      if (perSymbol.has(name)) {
        const covered = new Set(records.filter(row => row.status === 'captured').flatMap(row => row.symbols ?? []))
        if (input.universeSymbols.some(symbol => !covered.has(symbol))) issues.push(`${name}:coverage_missing`)
      }
    }
    return snapshot({ schema_version: 'atomic-post-overlay-inputs-v2',
      effect_scope: 'post_route_overlay_and_core_seed', downstream_status: 'requires_l2_ml',
      completed_at: new Date().toISOString(), ...input, observations: this.observations,
      input_status: issues.length ? 'incomplete' : 'captured', issues: [...new Set(issues)],
      // Capturing inputs is not replay parity, execution or promotion proof.
      replay_status: 'not_evaluated', production_effect: false, promotion_allowed: false,
      nav_maturity_credit: 0 }) as AtomicPostOverlayInputs
  }
}

export interface AtomicPostOverlayInputs {
  schema_version: 'atomic-post-overlay-inputs-v1' | 'atomic-post-overlay-inputs-v2'
  effect_scope: 'post_route_overlay_before_core_seed' | 'post_route_overlay_and_core_seed'
  downstream_status: 'requires_core_seed_l2_ml' | 'requires_l2_ml'
  completed_at: string
  signalDate: string
  universeSymbols: string[]
  formalSymbols: string[]
  finalSeed: unknown
  safetyExcludedSymbols: string[]
  policy: unknown
  observations: Record<string, OverlayObservation[]>
  input_status: 'captured' | 'incomplete'
  issues: string[]
  replay_status: 'not_evaluated'
  production_effect: false
  promotion_allowed: false
  nav_maturity_credit: 0
}
