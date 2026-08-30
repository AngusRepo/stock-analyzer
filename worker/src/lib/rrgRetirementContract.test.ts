import assert from 'node:assert/strict'
import fs from 'node:fs'

const screener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const pending = fs.readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const breeze2 = fs.readFileSync('src/lib/breeze2Runtime.ts', 'utf8')
const home = fs.readFileSync('../frontend/src/pages/MarketHomePage.tsx', 'utf8')
const bot = fs.readFileSync('../frontend/src/pages/BotDashboard.tsx', 'utf8')
const pipeline = fs.readFileSync('../frontend/src/pages/PipelinePage.tsx', 'utf8')

assert(!screener.includes("stage: 'rrg_overlay'"), 'screener must not persist an RRG shadow stage')
assert(screener.includes("stage: 'pit_residual_momentum_shadow'"), 'residual shadow must be the sole factor challenger')
assert(!pending.includes('loadQuadrantMap'), 'pending-buy must not load RRG quadrant authority')
assert(!pending.includes('RRG_LAGGING_SOFT_RISK'), 'pending-buy must not size from RRG lagging state')
assert(!pending.includes('RRG_WEAKENING_DOWNGRADE'), 'pending-buy must not size from RRG weakening state')
assert(!breeze2.includes('hasRrg'), 'Breeze2 must not infer semantic risk from RRG')
assert(!fs.existsSync('../frontend/src/components/DailyRecommendationPanel.tsx'), 'discarded RRG UI source must be removed')
assert(home.includes('<GroupFactorTrajectoryPanel />'), 'homepage must mount group factor trajectories')
assert(bot.includes('<StockFactorTrajectoryPanel />'), 'simulation room must mount stock factor trajectories')
assert(!/RRG 四象限|RRG 象限過濾結果|主題輪動 \+ RRG/.test(`${home}\n${bot}\n${pipeline}`), 'visible RRG copy must be retired')
