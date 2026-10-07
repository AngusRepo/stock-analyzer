export function completedPendingBuys(payload: any): any[] {
  return (Array.isArray(payload?.completedBuys) ? payload.completedBuys : []).filter((row:any) =>
    ['filled','cancelled','skipped','expired','rejected'].includes(row?.execution_status))
}
type DailyReferenceEvidence = { previous_close?: unknown; assessed_at_ms?: unknown; checked_at?: unknown }

export function currentDisplayPrice(live: any, cached: any, nowMs = Date.now(), daily?: DailyReferenceEvidence | null): any | null {
  const observed = (q:any) => q && Number.isFinite(q.price) && q.price>0 && Number.isFinite(Date.parse(q.as_of))
    && Date.parse(q.as_of)<=nowMs
  const candidates=[live,cached].filter(observed).sort((a,b)=>Date.parse(b.as_of)-Date.parse(a.as_of))
  const latest=candidates.find(q=>nowMs-Date.parse(q.as_of)<=90_000)
  if (!latest) return null
  const day=(ms:number)=>new Date(ms+8*3600_000).toISOString().slice(0,10)
  // A daily reference does not expire with a quiet stock's last trade.
  // Its original trading date is mandatory; it never supplies a current price.
  const reference=candidates.find(q=>day(Date.parse(q.as_of))===day(Date.parse(latest.as_of))
    && Number.isFinite(q.reference_price) && q.reference_price>0)
  if(reference) return {...latest,reference_price:reference.reference_price,reference_source:'quote'}
  const checkedAt=typeof daily?.checked_at==='string' ? daily.checked_at.replace(' ','T') : ''
  const assessedAt=daily?.assessed_at_ms==null
    ? Date.parse(checkedAt+(/Z$|[+-]\d{2}:\d{2}$/.test(checkedAt)?'':'Z'))
    : typeof daily.assessed_at_ms==='number' ? daily.assessed_at_ms : NaN
  const dailyReference=typeof daily?.previous_close==='number' && Number.isFinite(daily.previous_close)
    && daily.previous_close>0 && Number.isFinite(assessedAt) && assessedAt>=0 && assessedAt<=nowMs
    && day(assessedAt)===day(Date.parse(latest.as_of)) ? daily.previous_close : null
  return {...latest,reference_price:dailyReference,reference_source:dailyReference==null?null:'daily_assessment'}
}
