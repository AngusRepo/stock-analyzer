import { paperExecutionDate } from './paperExecutionScope'
import { databaseForDataDomain } from './dataDomainRegistry'
import { crawlYahooRSS } from './news'
import type { Bindings } from '../types'

export const NEWS_FEATURES = ['relevance', 'sentiment', 'price_impact', 'direction', 'earnings_impact', 'investor_confidence', 'risk_change'] as const
export interface NewsEvidence {
  id: string; title: string; summary: string; url: string; source: string
  published_at: string; observed_at: string
}
export interface NewsAssessment {
  evidence_ids: string[]
  features: Record<typeof NEWS_FEATURES[number], number | null>
  rationale: string
}

export function filterNewsEvidence(rows: NewsEvidence[], cutoff: string): NewsEvidence[] {
  const now = Date.parse(cutoff)
  const urls = new Set<string>(), titles = new Set<string>()
  return rows.filter(row => {
    const published = Date.parse(row.published_at), observed = Date.parse(row.observed_at)
    if (!Number.isFinite(published) || !Number.isFinite(observed) || published > now || observed > now ||
      now - published > 72 * 3600_000 || !/^https?:\/\//.test(row.url) || !row.title.trim()) return false
    const title = row.title.replace(/\s+/g, '').toLowerCase()
    let url: URL
    try { url = new URL(row.url) } catch { return false }
    url.search = ''; url.hash = ''
    if (urls.has(url.href) || titles.has(title)) return false
    urls.add(url.href); titles.add(title)
    return true
  }).slice(0, 12).map(row => ({ ...row, title: row.title.slice(0, 240), summary: row.summary.slice(0, 400) }))
}

function utcTimestamp(value: string): string {
  const iso = value.replace(' ', 'T')
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`
}

export async function gatherNewsEvidence(env: Bindings): Promise<{ cutoff: string; evidence: NewsEvidence[] }> {
  const db = databaseForDataDomain(env, 'market')
  const at = paperExecutionDate().toISOString()
  const result = await db.prepare(`SELECT id, title, summary, url, source, published_at, created_at
    FROM news WHERE julianday(published_at) <= julianday(?) AND julianday(created_at) <= julianday(?)
      AND julianday(published_at) >= julianday(?, '-72 hours')
    ORDER BY published_at DESC, id DESC LIMIT 60`).bind(at, at, at).all<any>()
  if (!result.success) throw new Error('premarket_news_query_failed')
  const rows: NewsEvidence[] = (result.results ?? []).map(row => ({
    id: `news:${row.id}`, title: String(row.title ?? ''), summary: String(row.summary ?? ''),
    url: String(row.url ?? ''), source: String(row.source ?? ''),
    published_at: utcTimestamp(String(row.published_at)),
    observed_at: utcTimestamp(String(row.created_at)),
  }))
  // A single public feed provides US macro/ADR headlines, not another per-stock LLM loop.
  const feed = await crawlYahooRSS('TSM,^GSPC', 0)
  const cutoff = paperExecutionDate().toISOString()
  for (const item of feed) {
    if (!item.url) continue
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(item.url))
    const id = Array.from(new Uint8Array(digest)).map(v => v.toString(16).padStart(2, '0')).join('')
    rows.push({ id: `rss:${id}`, title: item.title, summary: item.summary ?? '', url: item.url,
      source: item.source, published_at: item.publishedAt, observed_at: cutoff })
  }
  // Reserve space for each source; do not let a stock-news burst suppress macro evidence.
  const rss = rows.filter(r => r.id.startsWith('rss:'))
  const stored = rows.filter(r => r.id.startsWith('news:'))
  const interleaved = Array.from({ length: Math.max(rss.length, stored.length) }, (_, i) => [rss[i], stored[i]]).flat().filter(Boolean)
  return { cutoff, evidence: filterNewsEvidence(interleaved, cutoff) }
}

export function parseNewsAssessments(raw: unknown, evidence: NewsEvidence[]): NewsAssessment[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return null
  const known = new Set(evidence.map(e => e.id))
  for (const item of raw) {
    if (!item || !Array.isArray(item.evidence_ids) || !item.evidence_ids.length || item.evidence_ids.length > 4 ||
      item.evidence_ids.some((id: unknown) => typeof id !== 'string' || !known.has(id)) ||
      typeof item.rationale !== 'string' || !item.rationale.trim() || item.rationale.length > 200 ||
      !item.features || NEWS_FEATURES.some(key => !(key in item.features) || (item.features[key] !== null &&
        (typeof item.features[key] !== 'number' || !Number.isFinite(item.features[key]) || Math.abs(item.features[key]) > 2)))) return null
  }
  return raw as NewsAssessment[]
}
