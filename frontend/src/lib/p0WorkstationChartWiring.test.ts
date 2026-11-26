import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const packageJsonPath = path.join(root, 'package.json')
const lockPath = path.join(root, 'package-lock.json')
const modelPoolPagePath = path.join(root, 'src', 'pages', 'ModelPoolPage.tsx')
const strategyLabPagePath = path.join(root, 'src', 'pages', 'StrategyLearningPage.tsx')
const viteConfigPath = path.join(root, 'vite.config.ts')

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { dependencies?: Record<string, string> }
const packageLock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { packages?: Record<string, { license?: string; version?: string }> }

assert(packageJson.dependencies?.['lightweight-charts'] === '^5.2.0', 'P0 workstation charts should pin lightweight-charts to the accepted 5.2.x line')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.version === '5.2.0', 'package-lock should resolve lightweight-charts to 5.2.0')
assert(packageLock.packages?.['node_modules/lightweight-charts']?.license === 'Apache-2.0', 'package-lock should retain the accepted Apache-2.0 license')
const modelPoolPage = fs.readFileSync(modelPoolPagePath, 'utf8')
assert(modelPoolPage.includes('ModelPoolNewFlowWorkbench'), 'ModelPool page should render the L2/L3 model cockpit')
assert(!modelPoolPage.includes('<PromotionQueuePanelV2'), 'ModelPool page should not duplicate per-artifact champion comparisons below the evidence table')
assert(!modelPoolPage.includes('UpgradeTrackPanelV2'), 'ModelPool page should not duplicate artifact-gated L3 tracks')
assert(modelPoolPage.includes('!isRetiredModelName(name)'), 'ModelPool page should filter retired ML')
assert(!modelPoolPage.includes('{false &&'), 'ModelPool page should not hide legacy UI in false branches')
assert(!modelPoolPage.includes('<Model' + 'PoolHealthChart'), 'ModelPool page should not render a duplicate health chart')
// eba146b5 rewrote the page description in zh-TW around the ensemble / serving-vs-maturity split.
assert(modelPoolPage.includes('description="正式 ensemble、八模型角色、證據成熟度與下一個 cohort。模型選擇與服務狀態分開呈現。"'), 'ModelPool copy should describe the active model flow')

const strategyLabPage = fs.readFileSync(strategyLabPagePath, 'utf8')
const viteConfig = fs.readFileSync(viteConfigPath, 'utf8')
assert(strategyLabPage.includes('策略學習與報酬帳本'), 'Strategy Lab should be a focused production reward-ledger surface')
assert(strategyLabPage.includes('StrategyHealthBoard'), 'Strategy Lab should expose an always-visible strategy health board')
assert(strategyLabPage.includes('STRATEGY_LIFECYCLE_LANES') && strategyLabPage.includes('strategyLifecycleLane(row) === lane.key'), 'Strategy health board should separate formal and Shadow/Learning lifecycles before health routing')
assert(strategyLabPage.includes('rows={orderedRows}'), 'Strategy Lab health board should render every non-retired strategy')
assert(strategyLabPage.includes('rows={[selectedRow]}'), 'Strategy Lab should render one selected strategy workspace')
assert(strategyLabPage.includes('StrategyLineageInspector'), 'Strategy Lab should preserve production lineage in a compact inspector')
assert(!strategyLabPage.includes('Action Lanes'), 'Strategy Lab should remove unrelated experiment action lanes')
assert(!strategyLabPage.includes('Registry / Evidence Inspector'), 'Strategy Lab should remove unrelated registry inspector UI')
assert(!strategyLabPage.includes('Pre-trade Spec + Dry-run'), 'Strategy Lab should remove pre-trade spec and dry-run duplication')
// 40cb11ea split the read-time preview (previewPolicy) from the formal lane production-effect owner.
assert(strategyLabPage.includes('previewPolicy?.evidence.production_effect') && strategyLabPage.includes('strategyLanes?.formal.production_effect'), 'Strategy adaptive state must render the backend production-effect contract')
assert(viteConfig.includes("devOptions: { enabled: process.env.VITE_PWA_DEV === '1' }"), 'Vite PWA dev service worker should remain opt-in')

console.log('p0WorkstationChartWiring: OK')
