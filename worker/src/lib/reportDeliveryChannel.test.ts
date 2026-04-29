import { resolveReportDeliveryChannel } from './reportDeliveryChannel'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(resolveReportDeliveryChannel({}) === 'not_sent:no_channel_configured', 'missing Discord and email config should be explicit')
  assert(resolveReportDeliveryChannel({ DISCORD_WEBHOOK_URL: 'https://discord.example' }) === 'discord', 'Discord should be preferred')
  assert(resolveReportDeliveryChannel({ RESEND_API_KEY: 'key', ADMIN_EMAIL: 'admin@example.com' }) === 'email', 'email should be fallback')
}
