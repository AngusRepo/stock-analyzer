import type { Bindings } from '../types'

const SCALAR_NAMES = new Set(['ML_CONTROLLER_URL', 'SHIOAJI_PROXY_URL', 'LOCAL_TUNNEL_URL'])
const CREDENTIAL_NAMES = new Set(['ML_CONTROLLER_SECRET', 'PROXY_SERVICE_TOKEN', 'LIVE_EXECUTION_HMAC_SECRET'])
const PREFIX = /^(?:S12_|ENTRY_MODEL_V2_|EXECUTION_BOOK_|EXECUTION_CLOSE_WINDOW_|FINLAB_L5_|FINLAB_EXECUTION_PREVIEW_|INTRADAY_DYNAMIC_|INTRADAY_TECHNICAL_|SHIOAJI_L5_|LIVE_EXECUTION_)/
const POLICY_KEYS = ['ml:config', 'ml:config.debate_max_rounds', 'ml:adaptive_params'] as const

function rejectSecrets(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (/secret|api.?key|password|credential|token$/i.test(key)) {
      throw new Error('native_context_policy_contains_credentials')
    }
    rejectSecrets(child)
  }
}

/** Read the actual Worker flags, not guessed Controller/default equivalents.
 * This endpoint returns credential presence only; no binding/credential value
 * enters the private child, evidence receipt, log, or model prompt. */
export async function captureNativePaperSourceContext(env: Bindings) {
  const variables: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (CREDENTIAL_NAMES.has(key)) {
      variables[key] = value ? '__SEALED_CREDENTIAL__' : ''
    } else if (SCALAR_NAMES.has(key) || PREFIX.test(key)) {
      if (/TOKEN|SECRET|API_KEY|PASSWORD|WEBHOOK/.test(key)) continue
      if (typeof value !== 'string') throw new Error('native_context_scalar_type_invalid:' + key)
      variables[key] = value
    }
  }
  const values = await Promise.all(POLICY_KEYS.map(key => env.KV.get(key)))
  const frozenKv: Record<string, string | null> = {}
  values.forEach((raw, index) => {
    if (raw !== null) rejectSecrets(JSON.parse(raw))
    frozenKv[POLICY_KEYS[index]] = raw
  })
  return { schema_version: 'native-paper-source-context-v1', observed_at: new Date().toISOString(),
    variables, frozen_kv: frozenKv, account_mutations: 0 }
}
