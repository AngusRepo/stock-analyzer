import assert from 'node:assert/strict'
import test from 'node:test'
import {rotationDecision,replacementLotOutcome} from './paperRotationAudit'
test('rotation keeps actual cost basis and distinguishes missing replacement data',()=>{
 assert.equal(rotationDecision('swing_daily_orl',{avg_cost:100,shares:1000},110),null)
 const r=rotationDecision('[L4Target] plan='+ 'a'.repeat(64),{avg_cost:100,shares:1000},110)!
 assert.ok(Math.abs(r.floating_pnl_pct-.1)<1e-12)
 const buy:any={id:2,symbol:'B',side:'buy',shares:1000,price:100,total_cost:100020}
 const sell:any={id:3,symbol:'B',side:'sell',shares:400,price:110,total_cost:43800}
 assert.equal(replacementLotOutcome(buy,[sell],null).net_pnl,null)
 assert.equal(replacementLotOutcome(buy,[sell],120).net_pnl,15780)
 assert.equal(replacementLotOutcome(buy,[{...sell,shares:1000,total_cost:109000}],null).net_pnl,8980)
 assert.equal(replacementLotOutcome(buy,[sell,{...buy,id:4},{...sell,id:5}],120).remaining_shares,600)
})

test('daily SQLite audit keeps four required fields and immature outcomes explicit',async()=>{
 const {l4NativeFixture}=await import('./l4NativeFixture.testSupport')
 const {withPaperExecutionScope}=await import('./paperExecutionScope')
 const {updateRotationAudit}=await import('./paperRotationAudit')
 const {readFileSync}=await import('node:fs')
 const f=l4NativeFixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0008_rotation_audit.sql',import.meta.url),'utf8'))
 try {
  const plan='a'.repeat(64),reason='[L4Target] plan='+plan+' target=0'
  f.sqls.paper.prepare("INSERT INTO paper_orders(account_id,symbol,name,side,shares,price,commission,tax,total_cost,source,note,created_at) VALUES(1,'A','A','sell',1000,110,20,330,109650,'intraday_exit',?,'2026-10-02 01:05:00')").run(JSON.stringify({l4_rotation:rotationDecision(reason,{avg_cost:100,shares:1000},110)}))
  f.sqls.paper.prepare("INSERT INTO paper_orders(account_id,symbol,name,side,shares,price,commission,tax,total_cost,source,note,created_at) VALUES(1,'B','B','buy',1000,100,20,0,100020,'intraday_check',?,'2026-10-02 01:20:00')").run(JSON.stringify({l4_plan_id:plan}))
  f.sqls.core.exec("INSERT INTO stocks(id,symbol,name) VALUES(1,'0050','ETF'),(2,'A','A'),(3,'B','B')")
  f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,close) VALUES(1,'2026-10-02',100),(2,'2026-10-02',110),(3,'2026-10-02',102)")
  await withPaperExecutionScope(f.ports,()=>updateRotationAudit(f.env,'2026-10-02'))
  const row:any=f.sqls.paper.prepare('SELECT payload_json FROM paper_rotation_outcomes_v1').get(),value=JSON.parse(row.payload_json)
  assert.equal(value.status,'immature');assert.equal(value.exit_reason,reason)
  assert.ok(value.floating_pnl_pct>0);assert.deepEqual(value.original_next_20_sessions,[])
  assert.equal(value.replacements[0].net_pnl,1980);assert.equal(value.replacements[0].status,'immature')
  assert.equal(value.causal_pairing,false);assert.equal(value.learning_input,false)
 }finally{f.close()}
})


const buy:any={id:2,symbol:'B',side:'buy',shares:1000,price:100,total_cost:100020,created_at:'2026-10-02T01:20:00Z'}
const cash:any={action_id:'div',symbol:'B',kind:'cash',ex_date:'2026-10-05',eligible_shares:1000,cash_due:2000,shares_due:0,whole_shares_due:0,settled:0}
const stock:any={...cash,action_id:'stock',kind:'stock',cash_due:0,shares_due:100,whole_shares_due:100}
const evidence=(rows:any[],until='2026-10-09')=>({entitlements:rows,openings:[],until})
test('cash is included once whether unpaid, paid, or old holding sold after ex date',()=>{
 const first=replacementLotOutcome(buy,[],98,evidence([cash]));assert.equal(first.net_pnl,-20)
 assert.equal(replacementLotOutcome(buy,[],98,evidence([{...cash,settled:1,settled_at:'2026-10-08T00:00:00Z'}])).net_pnl,first.net_pnl)
 const sale={...buy,id:3,side:'sell',total_cost:97500,created_at:'2026-10-06T01:20:00Z'}
 assert.equal(replacementLotOutcome(buy,[sale],null,evidence([cash])).net_pnl,-520)
 assert.equal(replacementLotOutcome(buy,[{...sale,created_at:'2026-10-02T02:00:00Z'}],null,evidence([cash])).cash_entitlements,0)
})
test('stock receivable stays marked before delivery and actual delivery can later be sold',()=>{
 assert.equal(replacementLotOutcome(buy,[],100,evidence([stock])).net_pnl,9980)
 const delivered={...stock,settled:1,settled_at:'2026-10-07T00:00:00Z'}
 const sale={...buy,id:3,side:'sell',shares:1100,total_cost:109600,created_at:'2026-10-08T01:20:00Z'}
 const result=replacementLotOutcome(buy,[sale],null,evidence([delivered]))
 assert.equal(result.net_pnl,9580);assert.equal(result.receivable_shares,0)
 assert.equal(result.remaining_shares,0)
 // The current ledger's settled flag cannot leak delivery into an earlier as-of mark.
 assert.equal(replacementLotOutcome(buy,[],100,evidence([delivered],'2026-10-06')).receivable_shares,100)
})
test('pending stock survives sale of original shares; later merged ownership fails explicitly',()=>{
 const sale={...buy,id:3,side:'sell',total_cost:99500,created_at:'2026-10-06T01:20:00Z'}
 const row=replacementLotOutcome(buy,[sale],100,evidence([stock]))
 assert.equal(row.net_pnl,9480);assert.equal(row.receivable_shares,100)
 const reentry={...buy,id:4,created_at:'2026-10-06T02:00:00Z'}
 assert.equal(replacementLotOutcome(buy,[sale,reentry],100,evidence([stock])).reconciliation_reason,'merged_lot_ownership_ambiguous')
})
test('exchange action transforms share quantity without inventing an economic loss',()=>{
 const opening:any={session_date:'2026-10-05',positions:[{symbol:'B',shares:1000}],actions:[{symbol:'B',kind:'exchange',ex_date:'2026-10-05',stock_per_share:.5}]}
 const result=replacementLotOutcome(buy,[],200,{...evidence([]),openings:[opening]})
 assert.equal(result.remaining_shares,500);assert.equal(result.net_pnl,-20)
})
test('unknown rights and ownership mismatches never become zero profit',()=>{
 const rights={...cash,kind:'subscription',cash_due:0,rights_json:JSON.stringify({policy:'do_not_subscribe',payment_deadline:'2026-10-08'})}
 assert.equal(replacementLotOutcome(buy,[],100,evidence([rights],'2026-10-07')).net_pnl,null)
 assert.equal(replacementLotOutcome(buy,[],100,evidence([rights])).net_pnl,-20)
 assert.equal(replacementLotOutcome(buy,[],100,evidence([{...cash,eligible_shares:900}])).net_pnl,null)
 const sale={...buy,id:3,side:'sell',shares:1100,total_cost:109600,created_at:'2026-10-08T01:20:00Z'}
 assert.equal(replacementLotOutcome(buy,[sale],100).reconciliation_reason,'sell_exceeds_reconciled_lot')
})

test('actual corporate ledger and verified receipt flow through the daily rotation audit',async()=>{
 const {l4NativeFixture}=await import('./l4NativeFixture.testSupport')
 const {withPaperExecutionScope}=await import('./paperExecutionScope')
 const {processPaperCorporateActions}=await import('./paperCorporateActions')
 const {updateRotationAudit}=await import('./paperRotationAudit')
 const {readFileSync}=await import('node:fs')
 const f=l4NativeFixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0008_rotation_audit.sql',import.meta.url),'utf8'))
 try {
  const plan='a'.repeat(64)
  f.sqls.paper.prepare("INSERT INTO paper_orders(account_id,symbol,name,side,shares,price,commission,tax,total_cost,source,note,created_at) VALUES(1,'2317','X','sell',1000,100,20,300,99680,'intraday_exit',?,'2026-10-02 01:05:00')").run(JSON.stringify({l4_rotation:rotationDecision('[L4Target] plan='+plan,{avg_cost:100,shares:1000},100)}))
  f.sqls.paper.prepare("INSERT INTO paper_orders(account_id,symbol,name,side,shares,price,commission,tax,total_cost,source,note,created_at) VALUES(1,'2330','Y','buy',1000,100,20,0,100020,'intraday_check',?,'2026-10-02 01:20:00')").run(JSON.stringify({l4_plan_id:plan}))
  f.sqls.paper.exec("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date) VALUES(1,'2330','Y',1000,100.02,100,'2026-10-02')")
  f.sqls.core.exec("INSERT INTO stocks(id,symbol,name) VALUES(1,'0050','ETF'),(2,'2317','X'),(3,'2330','Y')")
  f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,close) VALUES(1,'2026-10-02',100),(1,'2026-10-05',101),(2,'2026-10-05',100),(3,'2026-10-05',98)")
  f.ports.nowMs=Date.parse('2026-10-05T00:00:00Z')
  const snapshot:any={schema_version:'paper-corporate-source-v1',session_date:'2026-10-05',observed_at:'2026-10-05T00:00:00Z',source_checksum:'b'.repeat(64),
    covered_symbols:['2330'],blockers:{},tax_basis:'gross_before_personal_tax',actions:[{action_id:'cash',symbol:'2330',kind:'cash',ex_date:'2026-10-05',payable_date:null,cash_per_share:2,stock_per_share:0}]}
  await withPaperExecutionScope(f.ports,()=>processPaperCorporateActions(f.env,'2026-10-05',snapshot,new Map([['2330',100]])))
  await withPaperExecutionScope(f.ports,()=>updateRotationAudit(f.env,'2026-10-05'))
  const row:any=f.sqls.paper.prepare('SELECT payload_json FROM paper_rotation_outcomes_v1').get()
  const replacement=JSON.parse(row.payload_json).replacements[0]
  assert.equal(replacement.net_pnl,-20);assert.equal(replacement.cash_entitlements,2000)
  assert.equal(replacement.reconciliation_reason,null)
 }finally{f.close()}
})
