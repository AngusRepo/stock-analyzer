export function completedPendingBuys(payload: any): any[] {
  return (Array.isArray(payload?.completedBuys) ? payload.completedBuys : []).filter((row:any) =>
    ['filled','cancelled','skipped','expired','rejected'].includes(row?.execution_status))
}
export function currentDisplayPrice(live: any, cached: any, nowMs = Date.now()): any | null {
  const valid = (q:any) => q && Number.isFinite(q.price) && q.price>0 && Number.isFinite(Date.parse(q.as_of))
    && nowMs-Date.parse(q.as_of)>=0 && nowMs-Date.parse(q.as_of)<=90_000
  const candidates=[live,cached].filter(valid).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of))
  return candidates[0]??null
}
