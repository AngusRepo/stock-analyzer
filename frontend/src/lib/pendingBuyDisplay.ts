export function completedPendingBuys(payload: any): any[] {
  return (Array.isArray(payload?.completedBuys) ? payload.completedBuys : []).filter((row:any) =>
    ['filled','cancelled','skipped','expired','rejected'].includes(row?.execution_status))
}
export function currentDisplayPrice(live: any, cached: any, nowMs = Date.now()): any | null {
  const valid = (q:any) => q && Number.isFinite(q.price) && q.price>0 && Number.isFinite(Date.parse(q.as_of))
    && nowMs-Date.parse(q.as_of)>=0 && nowMs-Date.parse(q.as_of)<=90_000
  const candidates=[live,cached].filter(valid).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of))
  const latest=candidates[0]
  if (!latest) return null
  const day=(q:any)=>new Date(Date.parse(q.as_of)+8*3600_000).toISOString().slice(0,10)
  const reference=candidates.find(q=>day(q)===day(latest) && Number.isFinite(q.reference_price) && q.reference_price>0)
  return {...latest,reference_price:reference?.reference_price??null}
}
