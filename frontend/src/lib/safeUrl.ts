// Links built from API data (news, evidence, sources) must never become javascript:/data: URLs,
// which would run on this origin and could read the session token.
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}
