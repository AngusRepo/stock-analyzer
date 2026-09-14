import type { Bindings } from '../types'
import { allocatePrivateL4 } from './paperExecutionScope'
import { captureL4AccountContext } from './l4AccountContext'
import { storeL4PortfolioPlan, readL4PortfolioPlan } from './l4PortfolioPlan'

/** Same frozen model/optimizer, actual PRIVATE shares/cash, no remote writes. */
export async function replanPrivateL4(env:Bindings,signalDate:string) {
  const account=await captureL4AccountContext(env,signalDate)
  if (!account.complete) throw new Error('private_l4_account_incomplete')
  const envelope=await allocatePrivateL4(account)
  const result=await storeL4PortfolioPlan(env,envelope)
  return {status:'replanned',plan_id:result.plan_id}
}

export async function initializePrivateL4(env:Bindings,signalDate:string) {
  const current=await readL4PortfolioPlan(env)
  if (current?.signal_date===signalDate) return
  await replanPrivateL4(env,signalDate)
}
