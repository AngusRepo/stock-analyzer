import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildFactorTrajectoryTimeline,
  factorTrajectoryPlaybackInterval,
} from './pitFactorTrajectoryPlayback'

const root = path.resolve(process.cwd(), 'src')
const componentSource = fs.readFileSync(path.join(root, 'components/PitFactorTrajectoryPanel.tsx'), 'utf8')
const homeSource = fs.readFileSync(path.join(root, 'pages/MarketHomePage.tsx'), 'utf8')

const timeline = buildFactorTrajectoryTimeline([
  { points: [{ date: '2026-09-02' }, { date: '2026-08-31' }] },
  { points: [{ date: '2026-09-01' }, { date: '2026-09-02' }] },
])

assert.deepEqual(timeline, ['2026-08-31', '2026-09-01', '2026-09-02'], 'playback must use one shared sorted trading-day timeline')
assert.equal(factorTrajectoryPlaybackInterval(1), 0, 'single-session evidence must not pretend to animate')
assert.equal(factorTrajectoryPlaybackInterval(3), 650, 'short histories should remain readable instead of flashing through')
assert.equal(factorTrajectoryPlaybackInterval(60), 120, 'long histories should complete in bounded time')
assert.match(componentSource, /revealedTrajectoryPoints\(item\.points, currentDate\)/, 'each series must reveal only points reached by the shared playback date')
assert.match(componentSource, /writingMode: 'vertical-rl'/, 'Y-axis explanation must use upright vertical Chinese text')
assert.doesNotMatch(componentSource, /rotate\(-90/, 'Y-axis explanation must not require the reader to tilt their head')
assert.ok(componentSource.indexOf('四象限判讀說明') < componentSource.indexOf('<svg'), 'quadrant explanations must sit outside the XY plotting surface')
assert.doesNotMatch(homeSource, /xl:grid-cols-\[minmax\(0,3fr\)_minmax\(380px,2fr\)\]/, 'home trajectory panel must not remain constrained to the old 40% side column')
assert.match(homeSource, /xl:grid-cols-\[minmax\(380px,2fr\)_minmax\(0,3fr\)\]/, 'recommendations must remain visible beside a wider 60% trajectory panel on desktop')
assert.match(componentSource, /group_series: query\.data\.group_series\.slice\(0, DEFAULT_GROUP_LIMIT\)/, 'homepage must default to a bounded set of salient industries')
assert.match(componentSource, /顯示全部 \$\{totalGroupCount\} 類/, 'bounded industry view must provide an explicit show-all control')
assert.match(componentSource, /useState<'industry' \| 'industry_theme'>\('industry_theme'\)/, 'homepage must default to the public-facing cross-industry theme universe')
assert.match(componentSource, /\['industry_theme', '產業題材'\]/, 'homepage must expose an explicit industry-theme view')
assert.match(componentSource, /\['industry', '正式產業'\]/, 'homepage must keep formal industry as a separate universe')
assert.match(componentSource, /layer: groupLayer/, 'factor-flow requests must carry the selected standalone taxonomy layer')
assert.doesNotMatch(componentSource, /parentLayer: selectedIndustry/, 'homepage must not model industry_theme as a child of formal industry')
assert.match(componentSource, /<TrajectoryChart series=\{series\} scope=\{scope\} \/>/, 'theme and industry nodes must focus their own trajectory instead of navigating a fake taxonomy tree')

console.log('pit factor trajectory UI/playback contract passed')
