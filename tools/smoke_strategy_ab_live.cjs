/* Local browser fixtures exercise rendering only; never production performance. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
async function main() {
 const output = path.resolve('audits/strategy-ab-release-20260920/ui')
 fs.mkdirSync(output, {recursive:true})
 const a = JSON.parse(fs.readFileSync('audits/strategy-ab-release-20260920/live-ui-fixture.json', 'utf8'))
 const b = structuredClone(a); b.pair_id='fixture-B'; b.strategy_ab.role='B'; b.strategy_ab.recipe='exo137_timexer_three_head_scalar_ev_mlp'
 const browser = await chromium.launch({headless:true, ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath:process.env.CHROMIUM_EXECUTABLE} : {})})
 const page = await browser.newPage({viewport:{width:1440,height:1080}})
 const errors=[], writes=[]
 page.on('pageerror', e=>errors.push(String(e)))
 let mode='ready'
 await page.route('**/*', async route=>{
  const req=route.request(), url=new URL(req.url())
  if(url.hostname!=='127.0.0.1') return route.abort()
  if(!url.pathname.startsWith('/api/')) return route.continue()
  if(req.method()!=='GET') writes.push(req.method()+' '+url.pathname)
  if(url.pathname==='/api/auth/me') return route.fulfill({json:{email:'ui@example.invalid',role:'admin',is_primary_admin:true}})
  const details=[a,b]
  if(url.pathname==='/api/dashboard/v4/nav/comparisons') return route.fulfill({json:{status:'observing',pairs:mode==='empty'?[]:details.map(d=>({pair_id:d.pair_id,sessions:2,latest_session:d.latest.date,comparison:{strategy_ab:d.strategy_ab}})),blockers:[],allocation_context_dates:2}})
  const detail=details.find(d=>url.pathname==='/api/dashboard/v4/nav/comparisons/'+d.pair_id)
  if(detail) {
   const value=structuredClone(detail)
   if(mode==='misaligned' && value.strategy_ab.role==='B') value.initial_nav=200000
   return route.fulfill({json:value})
  }
  return route.fulfill({status:503,json:{error:'unmocked-local-read'}})
 })
 try {
  await page.goto('http://127.0.0.1:5176/bot?tab=nav')
  const panel=page.getByRole('region',{name:'A B 每日實際比較',exact:true})
  await panel.getByText('共同帳務期間 2026-09-08～2026-09-09',{exact:false}).waitFor()
  assert.match(await panel.innerText(), /59,943/)
  assert.match(await panel.innerText(), /1.98%/)
  await panel.screenshot({path:path.join(output,'desktop.png')})
  await page.setViewportSize({width:390,height:844})
  await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true})
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  mode='misaligned'; await page.reload()
  await panel.getByRole('alert').waitFor()
  assert.match(await panel.innerText(), /起始日期或起始資金未對齊/)
  mode='empty'; await page.reload()
  await panel.getByText('尚未形成同一實驗的 A/B 完整帳本。下方歷史研究不會填入每日績效。',{exact:true}).waitFor()
  assert.deepEqual(errors,[]); assert.deepEqual(writes,[])
  fs.writeFileSync(path.join(output,'browser-check.json'),JSON.stringify({passed:true,fixture_only:true,modes:['ready','misaligned','empty'],errors,writes},null,2))
 } finally { await browser.close() }
}
main().catch(e=>{console.error(e);process.exitCode=1})
