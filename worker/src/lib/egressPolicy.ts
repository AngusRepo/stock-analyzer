import type { Bindings } from '../types'

export class EgressPolicyError extends Error {}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' || host === '::1' || host === '0.0.0.0' ||
    host === 'metadata.google.internal' || host.endsWith('.internal') || host.endsWith('.local')
  ) return true
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b] = octets
  return a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)
}

export function assertPublicServiceUrl(
  raw: string,
  options: { name: string; environment?: string; originOnly?: boolean },
): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new EgressPolicyError(`${options.name}: invalid URL`) }
  if (url.username || url.password || url.hash) {
    throw new EgressPolicyError(`${options.name}: userinfo and fragments are forbidden`)
  }
  const environment = (options.environment ?? 'production').trim().toLowerCase()
  const localDevelopment = ['development', 'dev', 'local', 'test'].includes(environment)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  if (url.protocol !== 'https:' && !(localDevelopment && loopback && url.protocol === 'http:')) {
    throw new EgressPolicyError(`${options.name}: HTTPS is required`)
  }
  if (isPrivateHostname(url.hostname) && !(localDevelopment && loopback)) {
    throw new EgressPolicyError(`${options.name}: private or metadata targets are forbidden`)
  }
  if (options.originOnly && (url.pathname !== '/' || url.search)) {
    throw new EgressPolicyError(`${options.name}: origin-only URL required`)
  }
  return url
}

export function assertDiscordWebhookUrl(raw: string): URL {
  const url = assertPublicServiceUrl(raw, { name: 'DISCORD_WEBHOOK_URL', environment: 'production' })
  const allowedHost = url.hostname === 'discord.com' || url.hostname === 'discordapp.com'
  if (!allowedHost || !url.pathname.startsWith('/api/webhooks/')) {
    throw new EgressPolicyError('DISCORD_WEBHOOK_URL: unsupported webhook origin')
  }
  return url
}

export function assertGithubDownloadUrl(raw: string): URL {
  const url = assertPublicServiceUrl(raw, { name: 'GitHub download URL', environment: 'production' })
  if (url.hostname !== 'raw.githubusercontent.com') {
    throw new EgressPolicyError('GitHub download URL: unexpected origin')
  }
  return url
}

export function validateEgressEnvironment(env: Bindings): void {
  const environment = env.ENVIRONMENT ?? 'production'
  const services: Array<[keyof Bindings, boolean]> = [
    ['ML_SERVICE_URL', true],
    ['ML_CONTROLLER_URL', true],
    ['PAGES_ORIGIN', true],
    ['LOCAL_TUNNEL_URL', true],
    ['SHIOAJI_PROXY_URL', true],
  ]
  for (const [key, originOnly] of services) {
    const raw = env[key]
    if (typeof raw === 'string' && raw.trim()) {
      assertPublicServiceUrl(raw.trim(), { name: String(key), environment, originOnly })
    }
  }
  if (env.DISCORD_WEBHOOK_URL?.trim()) assertDiscordWebhookUrl(env.DISCORD_WEBHOOK_URL.trim())
}
