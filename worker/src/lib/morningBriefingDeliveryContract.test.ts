const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const morningBriefing = fs.readFileSync('src/lib/morningBriefing.ts', 'utf8')

assert(
  morningBriefing.includes("channel === 'not_sent:no_channel_configured'") &&
    morningBriefing.includes("'not delivered: no_channel_configured'"),
  'Morning Briefing must distinguish scheduler success from actual report delivery when no channel is configured',
)
assert(
  !morningBriefing.includes('Morning briefing sent to ${channel}'),
  'Morning Briefing must not report "sent to not_sent:no_channel_configured"',
)
