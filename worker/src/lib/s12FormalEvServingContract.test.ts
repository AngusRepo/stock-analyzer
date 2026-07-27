import assert from 'node:assert/strict'
import fs from 'node:fs'

const route = fs.readFileSync('src/routes/other.ts', 'utf8')
const intraday = fs.readFileSync('src/lib/paperEntryTasks.ts', 'utf8')

assert(route.includes('s12_formal_ev_decisions'))
assert(route.includes("formalEv?.action === 'potential_buy'"))
assert(route.includes("signal: formalPotentialBuy ? 'POTENTIAL_BUY' : r.signal"))
assert(route.includes('has_buy_signal: formalPotentialBuy ? 0 : r.has_buy_signal'))
assert(intraday.includes('/s12-formal-ev/run'))
assert(intraday.includes('structure_snapshot_id=s.id'))
