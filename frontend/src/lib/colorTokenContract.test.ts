import * as fs from 'node:fs'
import * as path from 'node:path'
import { STATUS_CHIP, STATUS_TEXT, TW_COLORS } from './colorTokens'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

// 2026-11-26 batch3 color split: red/green only mean price direction (--up/--down);
// pass/warn/fail use blue/amber/magenta (--ok/--warn/--fail) plus an icon; slate (--na) means not checked yet.
const src = path.join(process.cwd(), 'src')
const rel = (file: string) => path.relative(src, file).split(path.sep).join('/')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : []
  })
}
const files = walk(src)

// 1. CSS tokens match the chart palette.
const css = fs.readFileSync(path.join(src, 'index.css'), 'utf8')
for (const key of ['up', 'down', 'ok', 'warn', 'fail', 'na'] as const) {
  const match = css.match(new RegExp(`--${key}:\\s*(#[0-9a-fA-F]{6})`))
  assert(match && match[1].toLowerCase() === TW_COLORS[key], `index.css --${key} must equal TW_COLORS.${key}`)
  assert(css.includes(`--color-${key}: var(--${key})`), `@theme must map --color-${key} for Tailwind utilities`)
}
assert(/--destructive:\s*var\(--fail\)/.test(css), 'destructive/error UI must use the fail token, not red')

// 2. No raw red/green Tailwind palette classes anywhere in app code.
const paletteClass = /\b(?:text|bg|border|ring|fill|stroke|from|to|via|outline|decoration|shadow|accent)-(?:emerald|rose|red|green|teal|lime)-\d{2,3}\b/
const offenders = files.filter((file) => paletteClass.test(fs.readFileSync(file, 'utf8'))).map(rel)
assert(offenders.length === 0, `red/green palette classes must become up/down or status tokens: ${offenders.join(', ')}`)

// 3. Red/green hex values live only in the token definitions.
const redGreenHex = /#(?:22c55e|16a34a|10b981|34d399|4ade80|00c076|059669|ef4444|dc2626|f43f5e|fb7185|f87171|e11d48|ff4d4f|fda4af|a7f3d0)\b/i
const hexOffenders = files
  .filter((file) => !['index.css', 'lib/colorTokens.ts'].includes(rel(file)))
  .filter((file) => redGreenHex.test(fs.readFileSync(file, 'utf8')))
  .map(rel)
assert(hexOffenders.length === 0, `red/green hex must come from TW_COLORS or var(--up/--down): ${hexOffenders.join(', ')}`)

// 4. Status helpers never use the price colors.
for (const value of [...Object.values(STATUS_CHIP), ...Object.values(STATUS_TEXT)]) {
  assert(!/\b(?:text|bg|border)-(?:up|down)\b/.test(value), `status class must not use up/down: ${value}`)
}
for (const file of ['components/ui/status.tsx', 'components/ui/data-state.tsx', 'components/simroom/SimRoom.tsx', 'components/simroom/simroom.css']) {
  const text = fs.readFileSync(path.join(src, file), 'utf8')
  assert(!/emerald|rose|\bred-|\bgreen-/.test(text), `${file} must not use emerald/rose/red/green`)
}
const simroomCss = fs.readFileSync(path.join(src, 'components/simroom/simroom.css'), 'utf8')
assert(/\.bar i\.ok \{ background: var\(--ok\)/.test(simroomCss) && /\.bar i\.fail \{ background: var\(--fail\)/.test(simroomCss),
  'condition dots use status tokens')

console.log('colorTokenContract: OK')
