/**
 * 長錯誤的畫面文字：600 字以內全文直接換行顯示（手機沒有 hover 也看得到）；超過才截斷並註明全文字數，
 * 全文放 title。不收合、不開內捲軸。字數以 Unicode 字元計，不切斷中文或 emoji。
 */
export const ERROR_PREVIEW_CHAR_LIMIT = 600

export function clipErrorText(text: string, limit = ERROR_PREVIEW_CHAR_LIMIT): { text: string; clipped: boolean; length: number } {
  const chars = Array.from(text)
  if (chars.length <= limit) return { text, clipped: false, length: chars.length }
  return { text: `${chars.slice(0, limit).join('')}…（全文 ${chars.length} 字，見 title）`, clipped: true, length: chars.length }
}
