import type { StockVisionOrderIntent } from './stockvisionOrderIntent'

export interface FinLabExecutionPreviewResult {
  schema_version?: string
  status: 'pass' | 'blocked' | 'warning' | 'error' | string
  visible_reason: string
  can_submit_real_order: false
  live_submit_enabled?: false
  blocked_reasons?: string[]
  warnings?: string[]
  audit_event?: Record<string, unknown>
  raw?: Record<string, unknown> | null
}

function truthyFlag(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'shadow'
}

function errorPreview(reason: string): FinLabExecutionPreviewResult {
  return {
    status: 'error',
    visible_reason: reason,
    can_submit_real_order: false,
    live_submit_enabled: false,
    blocked_reasons: [reason],
    warnings: [],
  }
}

export async function fetchFinLabExecutionPreview(
  env: {
    ML_CONTROLLER_URL?: string
    ML_CONTROLLER_SECRET?: string
    FINLAB_EXECUTION_PREVIEW_ENABLED?: string
    FINLAB_EXECUTION_PREVIEW_ALLOW_BROKER_LOGIN?: string
  },
  intent: StockVisionOrderIntent,
): Promise<FinLabExecutionPreviewResult | null> {
  if (!truthyFlag(env.FINLAB_EXECUTION_PREVIEW_ENABLED)) return null
  const controllerUrl = env.ML_CONTROLLER_URL?.trim()
  if (!controllerUrl) return errorPreview('ml_controller_url_missing')

  try {
    const res = await fetch(`${controllerUrl.replace(/\/$/, '')}/finlab/execution/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.ML_CONTROLLER_SECRET ? { 'X-Controller-Token': env.ML_CONTROLLER_SECRET } : {}),
      },
      body: JSON.stringify({
        intent,
        allow_broker_login: truthyFlag(env.FINLAB_EXECUTION_PREVIEW_ALLOW_BROKER_LOGIN),
      }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return errorPreview(`finlab_preview_http_${res.status}`)
    const payload = await res.json() as any
    if (payload?.can_submit_real_order === true || payload?.live_submit_enabled === true) {
      return errorPreview('finlab_preview_live_submit_flag_violation')
    }
    return {
      status: String(payload?.status ?? 'error'),
      visible_reason: String(payload?.visible_reason ?? payload?.reason ?? 'finlab_preview_status_unknown'),
      can_submit_real_order: false,
      live_submit_enabled: false,
      blocked_reasons: Array.isArray(payload?.blocked_reasons) ? payload.blocked_reasons.map(String) : [],
      warnings: Array.isArray(payload?.warnings) ? payload.warnings.map(String) : [],
      audit_event: payload?.audit_event && typeof payload.audit_event === 'object' ? payload.audit_event : undefined,
      raw: payload,
    }
  } catch (error) {
    return errorPreview(`finlab_preview_fetch_failed:${error instanceof Error ? error.message : String(error)}`)
  }
}
