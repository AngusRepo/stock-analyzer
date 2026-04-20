/**
 * configDiff.ts — Deep diff for TradingConfig restore preview (#28b T3.2)
 *
 * Produces a flat {added, removed, changed} summary by walking both configs
 * recursively and comparing leaf values. Used by /admin/config/restore
 * dry-run preview so Wei sees exactly what would change before confirming.
 *
 * Design: path-based flatten → compare leaves → return three buckets.
 * Paths are dot-notation ("circuit.buyConfThreshold", "position.kelly.enabled").
 * Array leaves compared by canonical JSON equality (RFC 8785 style).
 */

export interface ConfigDiff {
  added: Record<string, unknown>       // paths present in `next` but not `prev`
  removed: Record<string, unknown>     // paths present in `prev` but not `next`
  changed: Array<{ path: string; from: unknown; to: unknown }>
  unchanged_count: number               // how many leaves matched (context stat)
}

/** Walk object recursively emitting leaves as (path, value) pairs. */
function* flatten(obj: unknown, prefix: string = ''): Generator<[string, unknown]> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    yield [prefix, obj]
    return
  }
  for (const k of Object.keys(obj).sort()) {
    const v = (obj as Record<string, unknown>)[k]
    const path = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      yield* flatten(v, path)
    } else {
      yield [path, v]
    }
  }
}

/** Canonical JSON equality check (handles nested arrays too). */
function canonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Compute flat diff between two configs.
 *
 * @param prev current config (what's in KV now)
 * @param next target config (what snapshot has)
 * @returns flat {added, removed, changed, unchanged_count}
 */
export function diffConfig(prev: unknown, next: unknown): ConfigDiff {
  const prevLeaves = new Map<string, unknown>()
  const nextLeaves = new Map<string, unknown>()

  for (const [path, val] of flatten(prev)) prevLeaves.set(path, val)
  for (const [path, val] of flatten(next)) nextLeaves.set(path, val)

  const added: Record<string, unknown> = {}
  const removed: Record<string, unknown> = {}
  const changed: Array<{ path: string; from: unknown; to: unknown }> = []
  let unchanged_count = 0

  // Paths in next (added or changed)
  for (const [path, nextVal] of nextLeaves) {
    if (!prevLeaves.has(path)) {
      added[path] = nextVal
    } else {
      const prevVal = prevLeaves.get(path)
      if (canonEqual(prevVal, nextVal)) {
        unchanged_count++
      } else {
        changed.push({ path, from: prevVal, to: nextVal })
      }
    }
  }

  // Paths only in prev (removed by restore)
  for (const [path, prevVal] of prevLeaves) {
    if (!nextLeaves.has(path)) removed[path] = prevVal
  }

  return { added, removed, changed, unchanged_count }
}

/** Summary line for logs / Discord alerts. */
export function summarizeDiff(d: ConfigDiff): string {
  const a = Object.keys(d.added).length
  const r = Object.keys(d.removed).length
  const c = d.changed.length
  return `${c} changed, ${a} added, ${r} removed, ${d.unchanged_count} unchanged`
}
