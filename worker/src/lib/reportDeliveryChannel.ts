export type ReportDeliveryChannel = 'line' | 'discord' | 'email' | 'not_sent:no_channel_configured'

export interface ReportDeliveryEnv {
  LINE_CHANNEL_ACCESS_TOKEN?: string
  LINE_USER_ID?: string
  RESEND_API_KEY?: string
  ADMIN_EMAIL?: string
  DISCORD_WEBHOOK_URL?: string
}

export function resolveReportDeliveryChannel(env: ReportDeliveryEnv): ReportDeliveryChannel {
  if (env.LINE_CHANNEL_ACCESS_TOKEN && env.LINE_USER_ID) return 'line'
  if (env.DISCORD_WEBHOOK_URL) return 'discord'
  if (env.RESEND_API_KEY && env.ADMIN_EMAIL) return 'email'
  return 'not_sent:no_channel_configured'
}
