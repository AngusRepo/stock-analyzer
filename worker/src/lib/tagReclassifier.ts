/**
 * tagReclassifier.ts — LLM 概念標籤重新分類
 *
 * 讀取 stock_profiles（TimeVerse）+ 現有 stock_tags，
 * 用 LLM 判斷每支股票的核心概念（1~3 個，不強制湊滿）+ 權重（0.1~1.0）。
 *
 * LLM 優先級：Local Tunnel Opus → Workers AI Llama → 規則 fallback
 * 觸發方式：POST /api/admin/trigger/reclassify-tags
 */

import type { Bindings } from '../types'

interface TagWeight {
  tag: string
  weight: number  // 0.1 ~ 1.0
}

export async function reclassifyTags(env: Bindings): Promise<{ processed: number; updated: number; errors: string[] }> {
  // 1. 取所有有 stock_tags 的股票（重新分類全部，清除錯誤 tags）
  const { results: multiTagStocks } = await env.DB.prepare(`
    SELECT symbol, COUNT(*) as cnt
    FROM stock_tags GROUP BY symbol
    ORDER BY cnt DESC
  `).all<{ symbol: string; cnt: number }>()

  if (!multiTagStocks?.length) {
    console.log('[Reclassify] 無 stock_tags 資料')
    return { processed: 0, updated: 0, errors: [] }
  }

  console.log(`[Reclassify] ${multiTagStocks.length} 支股票待分類`)

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
        `可用概念清單（只能從這裡選）：${availableTags.join('、')}`,
        '',
        '請從「可用概念清單」中選出該公司真正相關的核心概念（1~3 個，不用湊滿 3 個）。',
        '只選與公司主業或產品直接相關的概念，不相關的不要選。',
        '權重規則：主業 = 1.0，重要副業 = 0.6，次要但確實相關 = 0.3',
        '',
        '回覆格式（JSON array，1~3 個元素，不要其他文字）：',
        '[{"tag":"概念名","weight":1.0}]',
      ].filter(Boolean).join('\n')

      // 呼叫 LLM：優先 Anthropic API（Opus），fallback Workers AI Llama
      let result: TagWeight[] | null = null

      // 1. Anthropic API (Opus) — on-demand 用途，品質最高
      const apiKey = (env as any).ANTHROPIC_API_KEY as string | undefined
      if (apiKey && !result) {
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 200,
              messages: [
                { role: 'user', content: `你是台股概念股分類專家。只回覆 JSON array，不要其他文字。\n\n${prompt}` },
              ],
            }),
            signal: AbortSignal.timeout(30000),
          })
          if (res.ok) {
            const json = await res.json() as any
            const text = json.content?.[0]?.text ?? ''
            const match = text.match(/\[[\s\S]*\]/)
            if (match) result = JSON.parse(match[0]) as TagWeight[]
          }
        } catch (e) {
          console.warn(`[Reclassify] Anthropic API failed for ${stock.symbol}: ${e}`)
        }
      }

      // 2. Fallback: Workers AI Llama
      if (!result && (env as any).AI) {
        try {
          const aiResult = await ((env as any).AI as any).run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: '你是台股概念股分類專家。只回覆 JSON array，不要其他文字。' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 200,
          }) as any
          const text = aiResult?.response ?? ''
          const match = text.match(/\[[\s\S]*\]/)
          if (match) result = JSON.parse(match[0]) as TagWeight[]
        } catch (e) {
          console.warn(`[Reclassify] Workers AI failed for ${stock.symbol}: ${e}`)
        }
      }

      // 3. Fallback: 規則判斷（LLM 全失敗時）
      if (!result || result.length === 0) {
        const sectorRelated = (currentTags ?? []).filter(t =>
          sector && (t.tag.includes(sector) || sector.includes(t.tag))
        )
        // 只給確實相關的，不硬湊
        if (sectorRelated.length) {
          result = [{ tag: sectorRelated[0].tag, weight: 1.0 }]
        } else if ((currentTags ?? []).length) {
          result = [{ tag: currentTags![0].tag, weight: 1.0 }]
        }
      }

      if (!result?.length) continue

      // 驗證 tags 存在
      const validTags = result.filter(r => availableTags.includes(r.tag))
      if (!validTags.length) continue

      // 5. 更新 D1：先刪除所有 tags，再插入 1~3 with weights（不強制湊滿）
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
