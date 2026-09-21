/** Broker history is consumed as-of; never relabel a previous session as today. */
export async function brokerAsOfReadiness(market: D1Database, ops: D1Database, targetDate: string) {
  const tables = ['canonical_broker_flow_daily', 'canonical_broker_rank_daily'] as const
  const counts = async (date: string) => Promise.all(tables.map(async table => {
    const row = await market.prepare(`SELECT COUNT(DISTINCT stock_id) AS count FROM ${table}
      WHERE date=? AND as_of_date<=? AND source='finlab.broker_transactions' AND market_segment='LISTED_OTC'`)
      .bind(date,targetDate).first<{count:number}>()
    return Number(row?.count ?? 0)
  }))
  const today = await counts(targetDate)
  if (today.every(n => n >= 1000)) return tables.map((table,i) => ({
    key:`${table}:listed_otc`,ok:true,summary:`${table}=${today[i]} source_date=${targetDate} age_sessions=0`,
  }))
  const failure = () => tables.map((table,i) => ({key:`${table}:listed_otc`,ok:false,
    summary:`${table} target_rows=${today[i]}/1000 date=${targetDate}; verified_previous_session_source_required`}))
  // Do not accept stale history just because it exists: today's provider fetch
  // must attest a nonempty, valid raw schema whose latest date is the prior session.
  const report = await ops.prepare(`SELECT status,error_code,generated_at,metadata_json FROM source_key_report
    WHERE target_date=? AND lane='broker_flow_diversity' AND field='broker_transactions'
      AND api_key='broker_transactions' AND source='finlab'`).bind(targetDate)
    .first<{status:string;error_code:string|null;generated_at:string;metadata_json:string}>()
  let observation:any
  try { observation=JSON.parse(report?.metadata_json ?? '{}').source_observation } catch { return failure() }
  if (report?.status!=='empty' || report.error_code || !observation
      || observation.schema_version!=='finlab-broker-source-observation-v1'
      || observation.required_columns_valid!==true || observation.target_date!==targetDate
      || !(observation.raw_rows>0) || observation.valid_date_rows!==observation.raw_rows
      || observation.target_rows!==0
      || !Number.isFinite(Date.parse(report.generated_at))
      || new Date(Date.parse(report.generated_at)+8*60*60*1000).toISOString().slice(0,10)!==targetDate) return failure()
  const {results} = await market.prepare(`SELECT DISTINCT date FROM canonical_market_index_daily
    WHERE date<=? AND symbol IN ('TWII','TAIEX') ORDER BY date DESC LIMIT 2`).bind(targetDate).all<{date:string}>()
  const dates=(results ?? []).map(r=>r.date)
  if (dates.length!==2 || dates[0]!==targetDate || observation.raw_max_date!==dates[1]) return failure()
  const previous=await counts(dates[1])
  // A partial target date is not evidence of a fully delayed publication.
  if (today.some(n=>n!==0) || previous.some(n=>n<1000)) return failure()
  return tables.map((table,i)=>({key:`${table}:listed_otc`,ok:true,
    summary:`${table}=${previous[i]} source_date=${dates[1]} target_date=${targetDate} age_sessions=1 provider_delayed=true source_status=empty asof_history=true`}))
}
