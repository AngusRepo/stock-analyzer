import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const botDashboard = readFileSync('src/pages/BotDashboard.tsx', 'utf8')

assert(
  botDashboard.includes('pendingExecutionPolicy') &&
    botDashboard.includes('pbData?.execution_policy') &&
    botDashboard.includes('policy={pendingExecutionPolicy}'),
  'BotDashboard must read /paper/pending-buys execution_policy and pass it into pending-buy badges',
)

assert(
  botDashboard.includes('l4_sparse_final_buy_only') &&
    botDashboard.includes('L4 sparse final BUY') &&
    botDashboard.includes('watch fallback off'),
  'BotDashboard must visibly identify pending buys as L4 sparse final BUY only with watch fallback disabled',
)

assert(
  botDashboard.includes('Only L4 sparse final BUY rows enter pending buys; daily recommendations stay evidence until L4 selects them.'),
  'BotDashboard fallback copy must explain that daily recommendations are evidence until L4 selects them',
)

assert(
  botDashboard.includes('L4 selected rows can enter pending buys.') &&
    !botDashboard.includes('會進 morning setup / debate / pending buys。'),
  'BotDashboard tradable recommendation copy must not imply raw daily recommendations directly enter pending buys',
)

assert(
  botDashboard.includes('L4 sparse final-buy execution pool') &&
    botDashboard.includes('policy: {pendingExecutionPolicy?.execution_pool_policy'),
  'BotDashboard pending-buy cards must expose execution-pool provenance beside item state',
)
