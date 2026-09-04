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
assert.match(componentSource, /trajectoryPointsAtPosition\(item\.points, timeline, playbackPosition\)/, 'each series must reveal one continuously interpolated position on the shared timeline')
assert.match(componentSource, /window\.requestAnimationFrame\(advance\)/, 'trajectory playback must use continuous animation frames rather than pausing at each date')
assert.doesNotMatch(componentSource, /window\.setTimeout\(\s*\(\) => setPlaybackIndex/, 'trajectory playback must not advance with discrete per-date timeouts')
assert.match(componentSource, /writingMode: 'vertical-rl'/, 'Y-axis explanation must use upright vertical Chinese text')
assert.doesNotMatch(componentSource, /rotate\(-90/, 'Y-axis explanation must not require the reader to tilt their head')
assert.ok(componentSource.indexOf('四象限判讀說明') < componentSource.indexOf('<svg'), 'quadrant explanations must sit outside the XY plotting surface')
assert.doesNotMatch(homeSource, /xl:grid-cols-\[minmax\(0,3fr\)_minmax\(380px,2fr\)\]/, 'home trajectory panel must not remain constrained to the old 40% side column')
assert.match(homeSource, /xl:grid-cols-2/, 'recommendations and trajectory must use a 1:1 desktop split')
assert.match(homeSource, /data-home-boot-overlay/, 'homepage must mask unresolved initial API placeholders with one loading transition')
assert.match(homeSource, /useIsFetching/, 'homepage loading transition must follow real query activity')
assert.match(componentSource, /group_series: query\.data\.group_series\.slice\(0, DEFAULT_GROUP_LIMIT\)/, 'homepage must default to a bounded set of salient industries')
assert.match(componentSource, /顯示全部 \$\{totalGroupCount\} 類/, 'bounded industry view must provide an explicit show-all control')
assert.match(componentSource, /useState\(true\)/, 'homepage must show all industry themes by default')
assert.match(componentSource, /data-trajectory-intermediate/, 'historical path points must remain visible as tiny intermediate markers')
assert.match(componentSource, /r="1\.15"/, 'intermediate markers must stay visually subordinate to start and end points')
assert.match(componentSource, /useState<string \| null>\(null\)/, 'homepage must default to the FinLab industry-theme universe without a parallel owner toggle')
assert.match(componentSource, /selectedTheme \? 'subindustry' : 'industry_theme'/, 'selecting a theme must switch the visualization to its FinLab subindustry layer')
assert.match(componentSource, /點擊題材可展開其 FinLab 次產業/, 'homepage must explain the industry-theme to subindustry drill-down')
assert.match(componentSource, /layer: groupLayer/, 'factor-flow requests must carry the selected standalone taxonomy layer')
assert.match(componentSource, /parentLayer: selectedTheme \? 'industry_theme' : undefined/, 'subindustry requests must declare the selected FinLab industry-theme parent')
assert.match(componentSource, /onSeriesSelect=\{scope === 'group' && groupLayer === 'industry_theme' \? onThemeSelect : undefined\}/, 'top-level theme nodes must open their subindustry view')
assert.doesNotMatch(componentSource, /\['industry', '正式產業'\]/, 'homepage must not expose the retired parallel formal-industry toggle')

console.log('pit factor trajectory UI/playback contract passed')
