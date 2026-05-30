import fs from 'node:fs'
import path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const api = fs.readFileSync(path.join(root, 'src', 'lib', 'api.ts'), 'utf8')
const systemStatusBar = fs.readFileSync(path.join(root, 'src', 'components', 'SystemStatusBar.tsx'), 'utf8')

assert(
  api.includes('SystemStatusReport') &&
    api.includes('source?: string | null') &&
    api.includes("status: () => get<SystemStatusReport>('/system/status')"),
  'frontend API contract must type system chips source from /system/status',
)

assert(
  systemStatusBar.includes('d.chips.source') &&
    systemStatusBar.includes('source={d.chips.source') &&
    systemStatusBar.includes('canonical_chip_daily'),
  'SystemStatusBar must display the chips source so canonical vs legacy fallback is visible on the homepage',
)
