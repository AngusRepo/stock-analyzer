const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const frontend = path.join(root, 'frontend', 'src')
const page = fs.readFileSync(path.join(frontend, 'pages', 'ModelPoolPage.tsx'), 'utf8')
const track = fs.readFileSync(path.join(frontend, 'lib', 'modelUpgradeTrack.ts'), 'utf8')

assert(page.includes('Alpha Models / 投票模型'), 'Model Pool must label production alpha voting models clearly')
assert(page.includes('Shadow Challengers / 影子挑戰者'), 'Model Pool must distinguish shadow challengers from active alpha models')
assert(page.includes('Research Benchmarks / 研究基準'), 'Model Pool must distinguish benchmark-only candidates from challengers')
assert(page.includes('Family Balance / 模型家族平衡'), 'Model Pool should include a visual family balance section')
assert(page.includes('State-space Overlays / 狀態空間 Overlay'), 'Model Pool must keep Kalman/Markov as overlays, not alpha vote models')
assert(page.includes('MODEL_UPGRADE_CANDIDATES'), 'Model Pool UI must render the P7 upgrade track candidates')

for (const id of ['ResidualMLP', 'GNN', 'TabM', 'iTransformer', 'TimesFM', 'Moirai']) {
  assert(track.includes(id), `Model upgrade track must include ${id}`)
}

assert(track.includes("stage: 'shadow_challenger'"), 'Upgrade track must include shadow challenger stage')
assert(track.includes("stage: 'benchmark_only'"), 'Upgrade track must include benchmark-only stage')
assert(track.includes('canVote: false'), 'Non-production upgrade candidates must not vote directly')
