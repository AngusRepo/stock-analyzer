import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function read(root: string, ...parts: string[]) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

const root = process.cwd()
const modelPool = read(root, 'src', 'pages', 'ModelPoolPage.tsx')
const inspector = read(root, 'src', 'pages', 'ModelPoolInspectorPage.tsx')
const app = read(root, 'src', 'App.tsx')

assert(modelPool.includes('ModelGovernanceVisualMap'), 'ModelPool should render a visual governance map before dense evidence tables')
assert(modelPool.includes('<ArtifactLifecycleSummaryPanel'), 'ModelPool should mount lifecycle summary as a visual bridge before dense governance details')
assert(modelPool.includes('data-testid="modelpool-governance-drilldown"'), 'ModelPool dense governance panels should live behind a drilldown disclosure')
assert(modelPool.includes('Governance drilldown'), 'ModelPool governance disclosure should have a stable visible label')
assert(
  modelPool.indexOf('<ArtifactLifecycleSummaryPanel') < modelPool.indexOf('data-testid="modelpool-governance-drilldown"'),
  'ModelPool lifecycle summary should appear before governance drilldown'
)
assert(modelPool.includes('/model-pool/inspector'), 'ModelPool should link raw artifact inspection to the dedicated inspector route')
assert(!modelPool.includes('Raw Artifact Inspector'), 'ModelPool governance page should not be the raw artifact inspector')

assert(inspector.includes('Raw Artifact Inspector'), 'Raw artifact inspection should live on the inspector page')
assert(inspector.includes('InspectorVisualSummary'), 'Inspector should summarize raw registry rows visually before the table')
assert(inspector.includes('visual-inspector-summary'), 'Inspector should expose a visual summary section for QA')
assert(inspector.includes('gate distribution'), 'Inspector should visualize gate distribution')
assert(inspector.includes('evidence coverage'), 'Inspector should visualize evidence coverage')
assert(inspector.includes('applyInspectorVisualFilter'), 'Inspector should apply visual summary filters to raw rows')
assert(inspector.includes('setVisualFilter'), 'Inspector should keep visual filter state separate from text search')
assert(inspector.includes('visual-filter-reset'), 'Inspector should expose a reset control for visual filters')
assert(inspector.includes('onVisualFilter'), 'Inspector visual summary bars should be interactive filter controls')
assert(inspector.includes('visualFilterTestId'), 'Inspector visual filters should expose stable test IDs for browser QA')
assert(inspector.includes('inspector-visual-summary-reset'), 'Inspector visual filter reset should have a stable browser QA selector')
assert(inspector.includes('<table'), 'Inspector should own raw registry table inspection')
assert(inspector.includes("queryKey: ['model-pool', 'artifactRegistry', 'inspector']"), 'Inspector should use its own artifact registry query key')

assert(app.indexOf('path="/model-pool/inspector"') >= 0, 'App should expose /model-pool/inspector')
assert(app.indexOf('path="/model-pool/inspector"') < app.indexOf('path="/model-pool"'), 'Inspector route should stay before /model-pool')
