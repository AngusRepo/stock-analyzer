import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const botDashboard = readFileSync('src/pages/BotDashboard.tsx', 'utf8')

// Paper never applies the risk-level SL/TP add (Wei 10/30 B).
assert(
  botDashboard.includes('未套用：Paper 不使用此欄位') && !botDashboard.includes('高風險 regime 加寬'),
  'BotDashboard must not present the SL/TP add as applied',
)
