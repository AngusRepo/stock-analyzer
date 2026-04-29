export type ReportDeliveryChannel = 'discord' | 'email' | 'not_sent:no_channel_configured'

export interface ReportDeliveryEnv {
  RESEND_API_KEY?: string
  ADMIN_EMAIL?: string
  DISCORD_WEBHOOK_URL?: string
}

export function resolveReportDeliveryChannel(env: ReportDeliveryEnv): ReportDeliveryChannel {
  if (env.DISCORD_WEBHOOK_URL) return 'discord'
  if (env.RESEND_API_KEY && env.ADMIN_EMAIL) return 'email'
  return 'not_sent:no_channel_configured'
}
