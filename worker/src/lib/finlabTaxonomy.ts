import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

export const FINLAB_TAXONOMY_OWNER = 'finlab_taxonomy_tags'
export const FINLAB_INDUSTRY_SOURCE = 'finlab.security_categories'
export const FINLAB_THEME_SOURCE = 'finlab.security_industry_themes'

export type FinLabTaxonomyType = 'industry' | 'industry_theme' | 'subindustry'

export interface FinLabTaxonomyOwnerAudit {
  owner: typeof FINLAB_TAXONOMY_OWNER
  industry_rows: number
  industry_symbols: number
  industry_duplicate_rows: number
  industry_theme_rows: number
  industry_theme_symbols: number
  subindustry_rows: number
  subindustry_symbols: number
  legacy_stock_tag_rows: number
  unexpected_finlab_rows: number
  latest_as_of_date: string | null
  status: 'ready' | 'blocked'
}

export async function auditFinLabTaxonomyOwner(env: Bindings): Promise<FinLabTaxonomyOwnerAudit> {
  const marketDb = databaseForDataDomain(env, 'market')
  const [canonical, legacy, unexpected] = await Promise.all([
    marketDb.prepare(`
      SELECT
        SUM(CASE WHEN tag_type='industry' THEN 1 ELSE 0 END) AS industry_rows,
        COUNT(DISTINCT CASE WHEN tag_type='industry' THEN symbol END) AS industry_symbols,
        SUM(CASE WHEN tag_type='industry_theme' THEN 1 ELSE 0 END) AS industry_theme_rows,
        COUNT(DISTINCT CASE WHEN tag_type='industry_theme' THEN symbol END) AS industry_theme_symbols,
        SUM(CASE WHEN tag_type='subindustry' THEN 1 ELSE 0 END) AS subindustry_rows,
        COUNT(DISTINCT CASE WHEN tag_type='subindustry' THEN symbol END) AS subindustry_symbols,
        MAX(as_of_date) AS latest_as_of_date
      FROM finlab_taxonomy_tags
      WHERE (tag_type='industry' AND source=?)
         OR (tag_type IN ('industry_theme','subindustry') AND source=?)
    `).bind(FINLAB_INDUSTRY_SOURCE, FINLAB_THEME_SOURCE).first<Record<string, unknown>>(),
    marketDb.prepare(`
      SELECT COUNT(*) AS total
      FROM stock_tags
    `).first<{ total: number }>(),
    marketDb.prepare(`
      SELECT COUNT(*) AS total
        FROM finlab_taxonomy_tags
       WHERE tag_type IN ('industry','industry_theme','subindustry')
         AND NOT (
           (tag_type='industry' AND source=?)
           OR (tag_type IN ('industry_theme','subindustry') AND source=?)
         )
    `).bind(FINLAB_INDUSTRY_SOURCE, FINLAB_THEME_SOURCE).first<{ total: number }>(),
  ])
  const result: FinLabTaxonomyOwnerAudit = {
    owner: FINLAB_TAXONOMY_OWNER,
    industry_rows: Number(canonical?.industry_rows ?? 0),
    industry_symbols: Number(canonical?.industry_symbols ?? 0),
    industry_duplicate_rows: Math.max(
      0,
      Number(canonical?.industry_rows ?? 0) - Number(canonical?.industry_symbols ?? 0),
    ),
    industry_theme_rows: Number(canonical?.industry_theme_rows ?? 0),
    industry_theme_symbols: Number(canonical?.industry_theme_symbols ?? 0),
    subindustry_rows: Number(canonical?.subindustry_rows ?? 0),
    subindustry_symbols: Number(canonical?.subindustry_symbols ?? 0),
    legacy_stock_tag_rows: Number(legacy?.total ?? 0),
    unexpected_finlab_rows: Number(unexpected?.total ?? 0),
    latest_as_of_date: canonical?.latest_as_of_date ? String(canonical.latest_as_of_date) : null,
    status: 'blocked',
  }
  result.status = (
    result.industry_symbols > 0
    && result.industry_duplicate_rows === 0
    && result.industry_theme_symbols > 0
    && result.subindustry_symbols > 0
    && result.legacy_stock_tag_rows === 0
    && result.unexpected_finlab_rows === 0
  ) ? 'ready' : 'blocked'
  return result
}

export async function loadPrimaryFinLabIndustries(
  env: Bindings,
): Promise<Map<string, string>> {
  const marketDb = databaseForDataDomain(env, 'market')
  const { results } = await marketDb.prepare(`
    SELECT symbol, tag
    FROM (
      SELECT symbol, tag,
             ROW_NUMBER() OVER (
               PARTITION BY symbol
               ORDER BY date(as_of_date) DESC, tag ASC
             ) AS rn
      FROM finlab_taxonomy_tags
      WHERE tag_type='industry' AND source=?
    )
    WHERE rn=1
    ORDER BY symbol
  `).bind(FINLAB_INDUSTRY_SOURCE).all<{ symbol: string; tag: string }>()
  return new Map((results ?? []).map((row) => [String(row.symbol), String(row.tag)]))
}

// Q03: stocks the FinLab owner has not classified yet (new listings) can take a fallback sector.
// The materializer mirrors candidates as industry_fallback rows; their own tag_type keeps them out
// of every owner-filtered reader (L3 sector features included).
export const SECTOR_FALLBACK_TAG_TYPE = 'industry_fallback'
// One row per stock whose sector came from a fallback tier: source=sector_fallback.<tier>.
export const SECTOR_PROVENANCE_TAG_TYPE = 'sector_provenance'
export const UNCLASSIFIED_SECTOR = 'unclassified'
const SECTOR_FALLBACK_SOURCES = {
  company_basic_info: 'finlab.company_basic_info',
  etf_basic_info: 'finlab.tw_etf_basic_info',
  unclassified: null,
} as const
export type SectorFallbackTier = keyof typeof SECTOR_FALLBACK_SOURCES
// Override with FINLAB_SECTOR_FALLBACK_ORDER (comma list of tiers); 'off' keeps owner-only sectors.
const DEFAULT_SECTOR_FALLBACK_ORDER = 'company_basic_info,etf_basic_info,unclassified'

export function sectorFallbackOrder(env: Bindings): SectorFallbackTier[] {
  const raw = String((env as Record<string, unknown>).FINLAB_SECTOR_FALLBACK_ORDER ?? DEFAULT_SECTOR_FALLBACK_ORDER)
    .trim().toLowerCase()
  if (!raw || raw === 'off' || raw === 'none') return []
  const tiers = raw.split(',').map((tier) => tier.trim()).filter(Boolean)
  const known = (tier: string): tier is SectorFallbackTier => Object.hasOwn(SECTOR_FALLBACK_SOURCES, tier)
  const unknown = tiers.filter((tier) => !known(tier))
  if (unknown.length) console.warn(`[FinLabTaxonomy] ignoring unknown sector fallback tiers: ${unknown.join(',')}`)
  return [...new Set(tiers.filter(known))]
}

async function loadSectorFallbacks(env: Bindings, order: SectorFallbackTier[]): Promise<Map<string, Map<string, string>>> {
  const sources = order.map((tier) => SECTOR_FALLBACK_SOURCES[tier]).filter((source): source is string => !!source)
  const bySource = new Map<string, Map<string, string>>()
  if (!sources.length) return bySource
  const { results } = await databaseForDataDomain(env, 'market').prepare(`
    SELECT symbol, tag, source
    FROM (
      SELECT symbol, tag, source,
             ROW_NUMBER() OVER (
               PARTITION BY symbol, source
               ORDER BY date(as_of_date) DESC, tag ASC
             ) AS rn
      FROM finlab_taxonomy_tags
      WHERE tag_type=? AND source IN (${sources.map(() => '?').join(',')})
    )
    WHERE rn=1
  `).bind(SECTOR_FALLBACK_TAG_TYPE, ...sources).all<{ symbol: string; tag: string; source: string }>()
  for (const row of results ?? []) {
    const map = bySource.get(row.source) ?? new Map<string, string>()
    map.set(String(row.symbol), String(row.tag))
    bySource.set(row.source, map)
  }
  return bySource
}

type SectorProjection = Map<string, { sector: string; tier: SectorFallbackTier }>

async function loadSectorProvenance(env: Bindings): Promise<SectorProjection> {
  const { results } = await databaseForDataDomain(env, 'market').prepare(
    'SELECT symbol, tag, source FROM finlab_taxonomy_tags WHERE tag_type=?',
  ).bind(SECTOR_PROVENANCE_TAG_TYPE).all<{ symbol: string; tag: string; source: string }>()
  return new Map((results ?? []).map((row) => [String(row.symbol), {
    sector: String(row.tag),
    tier: String(row.source).replace(/^sector_fallback\./, '') as SectorFallbackTier,
  }]))
}

/** Rewrites the provenance rows only when the projection changes. */
async function writeSectorProvenance(
  env: Bindings,
  current: SectorProjection,
  desired: SectorProjection,
  order: SectorFallbackTier[],
): Promise<void> {
  if (current.size === desired.size && [...desired].every(([symbol, row]) =>
    current.get(symbol)?.sector === row.sector && current.get(symbol)?.tier === row.tier)) return
  const marketDb = databaseForDataDomain(env, 'market')
  const asOfDate = new Date().toISOString().slice(0, 10)
  await marketDb.batch([
    marketDb.prepare('DELETE FROM finlab_taxonomy_tags WHERE tag_type=?').bind(SECTOR_PROVENANCE_TAG_TYPE),
    ...[...desired].map(([symbol, row]) => marketDb.prepare(`
      INSERT INTO finlab_taxonomy_tags (symbol, tag, tag_type, source, weight, lineage_json, as_of_date)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `).bind(symbol, row.sector, SECTOR_PROVENANCE_TAG_TYPE, `sector_fallback.${row.tier}`, JSON.stringify({
      sector_source: SECTOR_FALLBACK_SOURCES[row.tier] ?? UNCLASSIFIED_SECTOR,
      fallback_order: order,
      projection: 'stocks.sector',
    }), asOfDate)),
  ])
}

export async function syncFinLabIndustryProjection(env: Bindings): Promise<{
  owner: typeof FINLAB_TAXONOMY_OWNER
  canonical_symbols: number
  core_symbols: number
  updated: number
  cleared: number
  fallback: { order: SectorFallbackTier[]; projected: number; by_tier: Record<string, number>; recorded: boolean }
}> {
  const canonical = await loadPrimaryFinLabIndustries(env)
  if (!canonical.size) throw new Error('finlab_taxonomy_owner_empty:industry')
  const coreDb = databaseForDataDomain(env, 'core')
  const { results } = await coreDb.prepare(
    'SELECT symbol, sector, delisted_date FROM stocks ORDER BY symbol',
  ).all<{ symbol: string; sector: string | null; delisted_date: string | null }>()
  const order = sectorFallbackOrder(env)
  let previous: SectorProjection = new Map()
  let projected: SectorProjection = new Map()
  let recorded = true
  let previousLoaded = false
  try {
    previous = await loadSectorProvenance(env)
    previousLoaded = true
    const fallbacks = await loadSectorFallbacks(env, order)
    // Owner first; a listed stock the owner has not classified takes the first configured tier that has it.
    for (const row of results ?? []) {
      const symbol = String(row.symbol)
      if (canonical.has(symbol) || row.delisted_date) continue
      for (const tier of order) {
        const source = SECTOR_FALLBACK_SOURCES[tier]
        const sector = source ? fallbacks.get(source)?.get(symbol) : UNCLASSIFIED_SECTOR
        if (sector) {
          projected.set(symbol, { sector, tier })
          break
        }
      }
    }
    // The record is written before stocks.sector, so a fallback sector never lands without it.
    await writeSectorProvenance(env, previous, projected, order)
  } catch (error) {
    // Hold what the last recorded run projected, so a transient failure neither drops nor
    // reclassifies those stocks; without a record a stock stays owner-only, as before Q03.
    console.warn(`[FinLabTaxonomy] sector fallback held at the last record: ${error instanceof Error ? error.message : String(error)}`)
    recorded = false
    projected = new Map([...previous].filter(([symbol]) => !canonical.has(symbol)))
  }
  const currentSector = (row: { sector: string | null }) => String(row.sector ?? '').trim() || null
  // Without the record nothing tells a fallback sector from a stale one, so stocks the owner
  // does not classify keep their current sector.
  const next = (row: { symbol: string; sector: string | null }) =>
    canonical.get(String(row.symbol)) ??
    (previousLoaded ? projected.get(String(row.symbol))?.sector ?? null : currentSector(row))
  const changed = (results ?? []).filter((row) => currentSector(row) !== next(row))
  for (let offset = 0; offset < changed.length; offset += 80) {
    await coreDb.batch(changed.slice(offset, offset + 80).map((row) =>
      coreDb.prepare(
        "UPDATE stocks SET sector=?, updated_at=datetime('now') WHERE symbol=?",
      ).bind(next(row), row.symbol),
    ))
  }
  if (changed.length) {
    await Promise.all([
      env.KV.delete('screener:sector-map'),
      env.KV.delete('screener:sector-map:v5-finlab'),
      env.KV.delete('screener:industry-map:v5-finlab'),
    ])
  }
  const byTier: Record<string, number> = {}
  for (const row of projected.values()) byTier[row.tier] = (byTier[row.tier] ?? 0) + 1
  return {
    owner: FINLAB_TAXONOMY_OWNER,
    canonical_symbols: canonical.size,
    core_symbols: (results ?? []).length,
    updated: changed.length,
    cleared: changed.filter((row) => next(row) === null).length,
    fallback: { order, projected: projected.size, by_tier: byTier, recorded },
  }
}
