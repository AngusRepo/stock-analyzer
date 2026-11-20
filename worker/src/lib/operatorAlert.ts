/**
 * operatorAlert.ts - operator alerts through the existing LINE -> Discord -> Email sender.
 *
 * Kept outside the native Paper bundle (notify.ts is a native identity input), so call sites can move
 * to the shared sender without a re-pin. Without LINE secrets the sender posts the same Discord
 * `{content}` webhook body the direct calls did.
 */
import type { ReportDeliveryEnv } from './reportDeliveryChannel'
import { sendOperatorNotification } from './notify'

export type OperatorAlertResult = Awaited<ReturnType<typeof sendOperatorNotification>> | 'timeout'

/** Bounded so a slow channel never blocks the caller (the direct webhook calls used a 5 s abort). */
export async function sendOperatorAlert(
  env: ReportDeliveryEnv,
  message: string,
  timeoutMs = 5000,
): Promise<OperatorAlertResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      sendOperatorNotification(env, message),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
