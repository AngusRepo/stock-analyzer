import { resolveReportDeliveryChannel } from './reportDeliveryChannel'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(resolveReportDeliveryChannel({}) === 'not_sent:no_channel_configured', 'missing Discord and email config should be explicit')
  assert(resolveReportDeliveryChannel({ LINE_CHANNEL_ACCESS_TOKEN: 'line-token', LINE_USER_ID: 'wei' }) === 'line', 'LINE should be preferred for personal morning reports')
  assert(resolveReportDeliveryChannel({ LINE_CHANNEL_ACCESS_TOKEN: 'line-token' }) === 'not_sent:no_channel_configured', 'LINE must require both token and user id')
  assert(resolveReportDeliveryChannel({ LINE_USER_ID: 'wei' }) === 'not_sent:no_channel_configured', 'LINE must require both token and user id')
  assert(resolveReportDeliveryChannel({ DISCORD_WEBHOOK_URL: 'https://discord.example' }) === 'discord', 'Discord should be preferred')
  assert(resolveReportDeliveryChannel({ RESEND_API_KEY: 'key', ADMIN_EMAIL: 'admin@example.com' }) === 'email', 'email should be fallback')
  assert(
    resolveReportDeliveryChannel({
      LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
      LINE_USER_ID: 'wei',
      DISCORD_WEBHOOK_URL: 'https://discord.example',
    }) === 'line',
    'LINE should win over Discord when both are configured',
  )
}
