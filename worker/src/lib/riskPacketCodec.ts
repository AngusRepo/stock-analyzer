export function canonicalRiskJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalRiskJson).join(',') + ']'
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalRiskJson(value[key])).join(',')+'}'
}
export async function riskPacketChecksum(value: unknown): Promise<string> {
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalRiskJson(value)))
 return Array.from(new Uint8Array(hash)).map(v=>v.toString(16).padStart(2,'0')).join('')
}
