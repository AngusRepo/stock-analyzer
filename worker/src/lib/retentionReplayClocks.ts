/** Incomplete/non-date clocks stay unknown: never prune an archive using trade date instead. */
export function retentionReplayClockMetadata(rows: readonly Record<string, unknown>[]) {
  const result: Record<string, string> = {}
  function add(prefix: string, values: unknown[]) {
    const present = values.filter(v => v != null)
    if (!present.length || present.some(v => typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)
      || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v)) return
    const ordered = (present as string[]).sort()
    result[prefix + '_start'] = ordered[0]
    result[prefix + '_end'] = ordered[ordered.length - 1]
  }
  add('signal_coverage', rows.map(r => r.signal_date))
  const known: unknown[] = []
  for (const row of rows) {
    try {
      const detail = JSON.parse(String(row.detail_json ?? 'null'))
      known.push(detail?.replay_diagnostics?.outcome_known_date ?? null)
    } catch { return result } // Preserve original data; unknown metadata forces the reader to inspect it.
  }
  add('known_coverage', known)
  return result
}
