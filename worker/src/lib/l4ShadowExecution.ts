import type { Bindings } from '../types'
import { controllerPostJson } from './controllerClient'
import { twToday } from './dateUtils'

/** Only already registered isolated accounts; this task cannot register or switch. */
export async function l4ShadowExecution(env:Bindings):Promise<string> {
  const result=await controllerPostJson<{
    status:string;accounts:Array<{status:string}>;production_effect:boolean;outer_acceptance_credit:number
  }>(env,'/paper/l4-shadow-execution-tick',{session_date:twToday()},280_000)
  if(result.production_effect!==false || result.outer_acceptance_credit!==0 || !Array.isArray(result.accounts))
    throw new Error('l4_shadow_execution_receipt_invalid')
  if(result.status==='awaiting_registry' && result.accounts.length===0) return 'SKIPPED: l4_shadow_awaiting_registry'
  if(result.status!=='ok' || result.accounts.some(a=>!['collecting','execution_complete'].includes(a.status)))
    throw new Error(`l4_shadow_execution_incomplete accounts=${result.accounts.length}`)
  return `l4_shadow_execution_ok accounts=${result.accounts.length}; production_effect=false; outer_acceptance_credit=0`
}
