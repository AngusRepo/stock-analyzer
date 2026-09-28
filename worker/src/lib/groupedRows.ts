/** Stable grouping without copying the already accumulated prefix. */
export function appendGroup<K, V>(groups: Map<K, V[]>, key: K, row: V): void {
  const existing = groups.get(key)
  if (existing) existing.push(row)
  else groups.set(key, [row])
}
