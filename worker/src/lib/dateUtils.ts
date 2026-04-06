/**
 * dateUtils.ts — Taiwan timezone helpers
 *
 * Cloudflare Workers 沒有 timezone support，用固定 UTC+8 offset 計算台灣時間。
 */

const TW_OFFSET_MS = 8 * 3600_000

export function twNow(): Date {
  return new Date(Date.now() + TW_OFFSET_MS)
}

export function twToday(): string {
  return twNow().toISOString().slice(0, 10)
}

export function twDaysAgo(days: number): string {
  return new Date(Date.now() + TW_OFFSET_MS - days * 86400000).toISOString().slice(0, 10)
}
