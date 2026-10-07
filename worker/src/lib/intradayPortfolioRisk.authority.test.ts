import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Miniflare } from 'miniflare'
import { checkP9IntradayDrawdown, readP9IntradayHalt } from './intradayPortfolioRisk'
import { DEFAULT_RISK_CONFIG } from './riskConfig'

async function main() {
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:['PAPER']})
 try {
 const db=await mf.getD1Database('PAPER') as unknown as D1Database
 await db.prepare(fs.readFileSync('domain-migrations/paper/0010_intraday_nav_risk.sql','utf8').replace(/^--.*$/gm,'')).run()
 const values=new Map<string,any>()
 const kv={get:async(key:string)=>values.get(key)??null,put:async(key:string,v:string)=>{values.set(key,JSON.parse(v))}} as any
 const deps={defaults:{halt:false,maxPositionPct:.125,buyConfThreshold:.6,sellConfThreshold:.65},effectiveBuy:.6,effectiveSell:.65}
 const day='2026-10-07'
 const update=(nav:number,account=1,upper?:number)=>checkP9IntradayDrawdown(db,kv,account,day,nav,DEFAULT_RISK_CONFIG,deps,upper)
 assert.equal((await update(1000000)).evaluation?.triggered,false)
 assert.equal((await update(1020000)).evaluation?.state.peakNav,1020000)
 assert.equal((await update(960000)).state?.halt,true)
 assert.equal((await update(1010000)).evaluation?.triggered,true,'same-day recovery cannot unlatch')
 // Distinct accounts do not share NAV peaks or halts.
 assert.equal((await update(500000,42)).state,null)
 assert.equal(await readP9IntradayHalt(db,kv,42,day,deps),null)
 assert.equal((await readP9IntradayHalt(db,kv,1,day,deps))?.halt,true)
 // Concurrent updates must preserve the highest committed peak and an OR-latched halt.
 await update(1100000,43)
 await Promise.all([update(1200000,43),update(1000000,43)])
 const last=await update(1190000,43)
 assert.equal(last.evaluation?.state.peakNav,1200000)
 assert.equal(last.evaluation?.triggered,true)
 const throwing={prepare(){throw new Error('db_down')}} as unknown as D1Database
 assert.equal((await readP9IntradayHalt(throwing,kv,1,day,deps))?.halt,true)
 assert.equal((await checkP9IntradayDrawdown(throwing,kv,1,day,900000,DEFAULT_RISK_CONFIG,deps)).evaluation,null)
 const writeFailure={prepare(sql:string){if(sql.startsWith('INSERT'))throw new Error('write_down');return db.prepare(sql)}} as unknown as D1Database
 const before=await db.prepare('SELECT * FROM paper_intraday_nav_risk_v1 WHERE account_id=1 AND trade_date=?').bind(day).first()
 const unavailable=await checkP9IntradayDrawdown(writeFailure,kv,1,day,900000,DEFAULT_RISK_CONFIG,deps)
 assert.equal(unavailable.evaluation,null);assert.equal(unavailable.state?.halt,true)
 assert.deepEqual(await db.prepare('SELECT * FROM paper_intraday_nav_risk_v1 WHERE account_id=1 AND trade_date=?').bind(day).first(),before)
 assert.equal((await readP9IntradayHalt(db,kv,0,day,deps))?.halt,true)
 // An unreadable legacy key cannot create a new clean authoritative row.
 const failedKv={get:async()=>{throw new Error('kv_down')},put:async()=>{}} as any
 const failed=await checkP9IntradayDrawdown(db,failedKv,1,'2026-10-08',900000,DEFAULT_RISK_CONFIG,deps)
 assert.equal(failed.state?.halt,true);assert.equal(failed.state?.deRiskExistingPositions,false)
 assert.equal(failed.state?.targetExposurePct,null)
 assert.equal(await db.prepare('SELECT COUNT(*) n FROM paper_intraday_nav_risk_v1 WHERE trade_date=?').bind('2026-10-08').first('n'),0)
 // Preserve existing legacy high water and halt on adoption; then KV is only a mirror.
 values.set('risk:intraday_nav_peak:2026-10-09',{tradeDate:'2026-10-09',peakNav:1200000,lastNav:1190000,halted:true,updatedAt:'2026-10-09T01:00:00Z'})
 const migrated=await checkP9IntradayDrawdown(db,kv,1,'2026-10-09',1190000,DEFAULT_RISK_CONFIG,deps)
 assert.equal(migrated.evaluation?.state.peakNav,1200000);assert.equal(migrated.state?.halt,true)
 const mirrorFailure={get:async()=>{throw new Error('should_not_need_kv')},put:async()=>{throw new Error('mirror_down')}} as any
 assert.equal((await checkP9IntradayDrawdown(db,mirrorFailure,1,'2026-10-09',1210000,DEFAULT_RISK_CONFIG,deps)).state?.halt,true)
 // First account/session uncertainty is bounded, not hidden; a new day resets only its own state.
 assert.equal((await update(1000000,44,1060000)).state?.halt,true)
 assert.equal((await checkP9IntradayDrawdown(db,kv,42,'2026-10-08',500000,DEFAULT_RISK_CONFIG,deps)).state,null)
 console.log('P9 authority: actual D1 SQL, monotone peak/latch, account isolation, concurrency, legacy adoption, failures and bounds passed')
 } finally {await mf.dispose()}
}
main().catch(e=>{console.error(e);process.exit(1)})
