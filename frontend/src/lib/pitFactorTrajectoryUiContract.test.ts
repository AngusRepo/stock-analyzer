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

console.log('pit factor trajectory UI/playback contract passed')
