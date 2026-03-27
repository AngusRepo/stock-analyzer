/**
 * timeverse.ts — Timeverse 台股研究資料庫同步
 *
 * 每週自動從 GitHub Timeverse/My-TW-Coverage pull：
 *   - 供應鏈圖譜（上中下游 + 客戶/供應商）
 *   - 業務簡介
 *   - 財務摘要（3 年年度 + 4 季季報）
 * 寫入 D1 stock_profiles 表，供 Debate prompt 注入。
 *
 * Source: https://github.com/Timeverse/My-TW-Coverage (MIT License)
 */

import type { Bindings } from '../types'

const GITHUB_API = 'https://api.github.com'
const REPO = 'Timeverse/My-TW-Coverage'
const REPORT_DIR = 'Pilot_Reports'

interface StockProfile {
  symbol: string
  name: string
  sector: string
  business_desc: string
  supply_chain: string       // JSON: {upstream: [], midstream: [], downstream: []}
  key_customers: string      // JSON array
  key_suppliers: string      // JSON array
  financials_summary: string // JSON: {annual: [...], quarterly: [...]}
  wikilinks: string          // JSON array of [[linked]] entities
}

/**
 * 從 GitHub API 取得 Pilot_Reports 下所有產業資料夾
 */
async function fetchSectorList(): Promise<string[]> {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}/contents/${REPORT_DIR}`, {
    headers: { 'User-Agent': 'StockVision-Sync', Accept: 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const items = await res.json() as any[]
  return items.filter((i: any) => i.type === 'dir').map((i: any) => i.name)
}

/**
 * 取得某產業資料夾下的所有 .md 檔案路徑
 */
async function fetchFilesInSector(sector: string): Promise<{ name: string; download_url: string }[]> {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}/contents/${REPORT_DIR}/${encodeURIComponent(sector)}`, {
    headers: { 'User-Agent': 'StockVision-Sync', Accept: 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) return []
  const items = await res.json() as any[]
  return items
    .filter((i: any) => i.type === 'file' && i.name.endsWith('.md'))
    .map((i: any) => ({ name: i.name, download_url: i.download_url }))
}

/**
 * 從 Markdown 解析出結構化資訊
 */
function parseReport(markdown: string, filename: string, sector: string): StockProfile | null {
  // 檔名格式: "2330 台積電.md" 或 "2330_TSMC.md"
  const symbolMatch = filename.match(/^(\d{4})/)
  if (!symbolMatch) return null
  const symbol = symbolMatch[1]

  // 取公司名（從檔名或第一行 heading）
  const nameMatch = filename.match(/^\d{4}\s*[_\s]?\s*(.+)\.md$/)
  const name = nameMatch ? nameMatch[1].trim() : symbol

  // 業務簡介：找 ## 業務簡介 或 ## Business 段落
  const businessMatch = markdown.match(/##\s*(?:業務簡介|Business|公司簡介)[^\n]*\n([\s\S]*?)(?=\n##|\n---|\Z)/i)
  const business_desc = businessMatch ? businessMatch[1].trim().slice(0, 500) : ''

  // 供應鏈：找 upstream/midstream/downstream 或 上游/中游/下游
  const upstream = extractListItems(markdown, /(?:上游|Upstream)/i)
  const midstream = extractListItems(markdown, /(?:中游|Midstream)/i)
  const downstream = extractListItems(markdown, /(?:下游|Downstream)/i)

  // 客戶/供應商
  const customers = extractListItems(markdown, /(?:主要客戶|Key Customers|Major Customers)/i)
  const suppliers = extractListItems(markdown, /(?:主要供應商|Key Suppliers|Major Suppliers)/i)

  // Wikilinks: [[xxx]] 格式
  const wikilinks = [...new Set((markdown.match(/\[\[([^\]]+)\]\]/g) ?? []).map(w => w.slice(2, -2)))]

  // 財務：找表格
  const financials = extractFinancialTables(markdown)

  return {
    symbol,
    name,
    sector,
    business_desc,
    supply_chain: JSON.stringify({ upstream, midstream, downstream }),
    key_customers: JSON.stringify(customers),
    key_suppliers: JSON.stringify(suppliers),
    financials_summary: JSON.stringify(financials),
    wikilinks: JSON.stringify(wikilinks),
  }
}

function extractListItems(markdown: string, sectionPattern: RegExp): string[] {
  const lines = markdown.split('\n')
  let inSection = false
  const items: string[] = []

  for (const line of lines) {
    if (sectionPattern.test(line)) { inSection = true; continue }
    if (inSection && /^##/.test(line)) break
    if (inSection && /^[-*]\s/.test(line)) {
      const item = line.replace(/^[-*]\s+/, '').replace(/\[\[|\]\]/g, '').trim()
      if (item) items.push(item)
    }
  }
  return items
}

function extractFinancialTables(markdown: string): { annual: string[]; quarterly: string[] } {
  // 簡單提取：找含數字的表格行
  const annual: string[] = []
  const quarterly: string[] = []
  const lines = markdown.split('\n')
  let context = ''

  for (const line of lines) {
    if (/年度|Annual|FY/i.test(line)) context = 'annual'
    if (/季度|Quarterly|Q[1-4]/i.test(line)) context = 'quarterly'
    if (/\|.*\d.*\|/.test(line) && !/^[-|:\s]+$/.test(line)) {
      if (context === 'annual') annual.push(line.trim())
      else if (context === 'quarterly') quarterly.push(line.trim())
    }
  }
  return { annual: annual.slice(0, 10), quarterly: quarterly.slice(0, 10) }
}


/**
 * 主函數：同步 Timeverse 到 D1
 */
export async function syncTimeverse(env: Bindings): Promise<string> {
  console.log('[Timeverse] Starting weekly sync...')

  let synced = 0
  let failed = 0

  try {
    const sectors = await fetchSectorList()
    console.log(`[Timeverse] Found ${sectors.length} sectors`)

    // 每次只處理前 20 個 sector（避免 GitHub rate limit 60 req/hr for unauthenticated）
    const batch = sectors.slice(0, 20)

    for (const sector of batch) {
      const files = await fetchFilesInSector(sector)

      for (const file of files) {
        try {
          const mdRes = await fetch(file.download_url, {
            headers: { 'User-Agent': 'StockVision-Sync' },
            signal: AbortSignal.timeout(10_000),
          })
          if (!mdRes.ok) continue
          const markdown = await mdRes.text()

          const profile = parseReport(markdown, file.name, sector)
          if (!profile) continue

          // Upsert D1
          await env.DB.prepare(`
            INSERT INTO stock_profiles (symbol, name, sector, business_desc, supply_chain, key_customers, key_suppliers, financials_summary, wikilinks, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(symbol) DO UPDATE SET
              name=excluded.name, sector=excluded.sector, business_desc=excluded.business_desc,
              supply_chain=excluded.supply_chain, key_customers=excluded.key_customers,
              key_suppliers=excluded.key_suppliers, financials_summary=excluded.financials_summary,
              wikilinks=excluded.wikilinks, updated_at=datetime('now')
          `).bind(
            profile.symbol, profile.name, profile.sector,
            profile.business_desc, profile.supply_chain,
            profile.key_customers, profile.key_suppliers,
            profile.financials_summary, profile.wikilinks,
          ).run()
          synced++
        } catch (e) {
          failed++
        }
      }

      // Rate limit: 1s between sectors
      await new Promise(r => setTimeout(r, 1000))
    }
  } catch (e: any) {
    console.error('[Timeverse] Sync failed:', e?.message)
    return `同步失敗: ${e?.message}`
  }

  console.log(`[Timeverse] Done: ${synced} synced, ${failed} failed`)
  return `Timeverse 同步完成：${synced} 筆成功、${failed} 筆失敗`
}
