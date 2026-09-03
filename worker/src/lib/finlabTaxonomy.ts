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

export async function syncFinLabIndustryProjection(env: Bindings): Promise<{
  owner: typeof FINLAB_TAXONOMY_OWNER
  canonical_symbols: number
  core_symbols: number
  updated: number
  cleared: number
}> {
  const canonical = await loadPrimaryFinLabIndustries(env)
  if (!canonical.size) throw new Error('finlab_taxonomy_owner_empty:industry')
  const coreDb = databaseForDataDomain(env, 'core')
  const { results } = await coreDb.prepare(
    'SELECT symbol, sector FROM stocks ORDER BY symbol',
  ).all<{ symbol: string; sector: string | null }>()
  const changed = (results ?? []).filter((row) => {
    const next = canonical.get(String(row.symbol)) ?? null
    const current = String(row.sector ?? '').trim() || null
    return current !== next
  })
  for (let offset = 0; offset < changed.length; offset += 80) {
    await coreDb.batch(changed.slice(offset, offset + 80).map((row) =>
      coreDb.prepare(
        "UPDATE stocks SET sector=?, updated_at=datetime('now') WHERE symbol=?",
      ).bind(canonical.get(String(row.symbol)) ?? null, row.symbol),
    ))
  }
  if (changed.length) {
    await Promise.all([
      env.KV.delete('screener:sector-map'),
      env.KV.delete('screener:sector-map:v5-finlab'),
      env.KV.delete('screener:industry-map:v5-finlab'),
    ])
  }
  return {
    owner: FINLAB_TAXONOMY_OWNER,
    canonical_symbols: canonical.size,
    core_symbols: (results ?? []).length,
    updated: changed.length,
    cleared: changed.filter((row) => !canonical.has(String(row.symbol))).length,
  }
}
