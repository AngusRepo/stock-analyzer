/**
 * tagReclassifier.ts — LLM 概念標籤重新分類
 *
 * 讀取 stock_profiles（TimeVerse）+ 現有 stock_tags，
 * 用 LLM 判斷每支股票的 top 3 核心概念 + 權重（0.1~1.0）。
 *
 * 觸發方式：POST /api/admin/trigger/reclassify-tags
 */

import type { Bindings } from '../types'

interface TagWeight {
  tag: string
  weight: number  // 0.1 ~ 1.0
}

export async function reclassifyTags(env: Bindings): Promise<{ processed: number; updated: number; errors: string[] }> {
  // 1. 取所有 stock_tags 中有多於 3 個概念的股票
  const { results: multiTagStocks } = await env.DB.prepare(`
    SELECT symbol, COUNT(*) as cnt
    FROM stock_tags GROUP BY symbol HAVING cnt > 3
    ORDER BY cnt DESC
  `).all<{ symbol: string; cnt: number }>()

  if (!multiTagStocks?.length) {
    console.log('[Reclassify] 無超過 3 個概念的股票')
    return { processed: 0, updated: 0, errors: [] }
  }

  console.log(`[Reclassify] ${multiTagStocks.length} 支股票需要重新分類`)

  // 2. 取 stock_profiles（TimeVerse 公司描述）
  const { results: profileRows } = await env.DB.prepare(
    'SELECT symbol, name, business_desc, key_customers, key_suppliers FROM stock_profiles'
  ).all<any>()
  const profileMap = new Map((profileRows ?? []).map((r: any) => [r.symbol, r]))

  // 3. 取所有可用概念標籤
  const { results: allTags } = await env.DB.prepare(
    'SELECT DISTINCT tag FROM stock_tags ORDER BY tag'
  ).all<{ tag: string }>()
  const availableTags = (allTags ?? []).map(t => t.tag)

  // 4. 逐股 LLM 判斷
  let processed = 0
  let updated = 0
  const errors: string[] = []
  const BATCH_SIZE = 5 // 每次處理 5 股避免 timeout

  for (const stock of multiTagStocks.slice(0, 30)) { // 最多處理 30 股/次
    try {
      // 取現有 tags
      const { results: currentTags } = await env.DB.prepare(
        'SELECT tag, weight FROM stock_tags WHERE symbol = ?'
      ).bind(stock.symbol).all<{ tag: string; weight: number }>()

      const profile = profileMap.get(stock.symbol)
      const { results: stockInfo } = await env.DB.prepare(
        'SELECT name, sector FROM stocks WHERE symbol = ?'
      ).bind(stock.symbol).first<any>() ?
        { results: [await env.DB.prepare('SELECT name, sector FROM stocks WHERE symbol = ?').bind(stock.symbol).first<any>()] } :
        { results: [] }

      const stockName = stockInfo?.[0]?.name ?? stock.symbol
      const sector = stockInfo?.[0]?.sector ?? ''

      // 組 LLM prompt
      const currentTagList = (currentTags ?? []).map(t => t.tag).join(', ')
      const businessDesc = profile?.business_desc
        ? profile.business_desc.replace(/\*\*/g, '').slice(0, 300)
        : ''

      const prompt = [
        `股票：${stock.symbol} ${stockName}（產業：${sector}）`,
        businessDesc ? `公司概況：${businessDesc}` : '',
        `現有概念標籤（${currentTags?.length} 個）：${currentTagList}`,
        '',
        '請從以上標籤中選出該公司最核心的 3 個概念，並賦予權重。',
        '權重規則：主業 = 1.0，重要副業 = 0.6，次要關聯 = 0.3',
        '',
        '回覆格式（JSON array，不要其他文字）：',
        '[{"tag":"概念名","weight":1.0},{"tag":"概念名","weight":0.6},{"tag":"概念名","weight":0.3}]',
      ].filter(Boolean).join('\n')

      // 呼叫 LLM（Workers AI Llama，免費）
      let result: TagWeight[] | null = null

      if ((env as any).AI) {
        try {
          const aiResult = await ((env as any).AI as any).run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: '你是台股概念股分類專家。只回覆 JSON array，不要其他文字。' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 200,
          }) as any
          const text = aiResult?.response ?? ''
          // 解析 JSON
          const match = text.match(/\[[\s\S]*\]/)
          if (match) {
            result = JSON.parse(match[0]) as TagWeight[]
          }
        } catch (e) {
          console.warn(`[Reclassify] Workers AI failed for ${stock.symbol}: ${e}`)
        }
      }

      // Fallback: 用規則判斷（如果 LLM 失敗）
      if (!result || result.length === 0) {
        // 簡單規則：取 sector 相關的概念權重最高，其他按出現頻率
        const sectorRelated = (currentTags ?? []).filter(t =>
          sector && (t.tag.includes(sector) || sector.includes(t.tag))
        )
        const others = (currentTags ?? []).filter(t => !sectorRelated.includes(t))
        result = [
          ...(sectorRelated.length ? [{ tag: sectorRelated[0].tag, weight: 1.0 }] : []),
          ...others.slice(0, sectorRelated.length ? 2 : 3).map((t, i) => ({
            tag: t.tag,
            weight: i === 0 ? (sectorRelated.length ? 0.6 : 1.0) : 0.3,
          })),
        ].slice(0, 3)
      }

      if (!result?.length) continue

      // 驗證 tags 存在
      const validTags = result.filter(r => availableTags.includes(r.tag))
      if (!validTags.length) continue

      // 5. 更新 D1：先刪除所有 tags，再插入 top 3 with weights
      await env.DB.prepare('DELETE FROM stock_tags WHERE symbol = ?').bind(stock.symbol).run()
      const stmts = validTags.slice(0, 3).map(tw =>
        env.DB.prepare('INSERT INTO stock_tags (symbol, tag, weight) VALUES (?, ?, ?)')
          .bind(stock.symbol, tw.tag, Math.min(1.0, Math.max(0.1, tw.weight)))
      )
      await env.DB.batch(stmts)

      updated++
      console.log(`[Reclassify] ${stock.symbol} ${stockName}: ${(currentTags ?? []).length} tags → ${validTags.length} (${validTags.map(t => `${t.tag}:${t.weight}`).join(', ')})`)
    } catch (e) {
      errors.push(`${stock.symbol}: ${e}`)
    }
    processed++
  }

  console.log(`[Reclassify] 完成：processed=${processed}, updated=${updated}, errors=${errors.length}`)
  return { processed, updated, errors }
}
