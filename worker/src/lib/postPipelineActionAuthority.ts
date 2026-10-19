import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { inspectActive8ActionAuthorityState } from './allocatorEvDailyLifecycle'
import { readCurrentExpectedReturnServingState } from './expectedReturnServingState'
import { assertL4PlanCurrentPolicy, readL4PortfolioPlan } from './l4PortfolioPlan'

/** Paper L4 release authority and Active8 ranking quality are separate contracts. */
export async function inspectPostPipelineActionAuthority(env: Bindings, businessDate: string) {
  const config = await env.KV.get('trading:config', 'json') as
    Parameters<typeof assertL4PlanCurrentPolicy>[2] | null
  let identity: Record<string, string> | undefined
  if (config?.l4Distribution != null) {
    const plan = await readL4PortfolioPlan(env)
    if (!plan || plan.signal_date !== businessDate || plan.execution_scope !== 'paper') {
      throw new Error('post_pipeline_l4_paper_plan_missing')
    }
    await assertL4PlanCurrentPolicy(env, plan, config)
    const serving = await readCurrentExpectedReturnServingState(env, businessDate)
    if (serving.expected_return_owner !== 'l4_distribution' || serving.state !== 'production_primary') {
      throw new Error('post_pipeline_l4_serving_authority_invalid')
    }
    identity = plan.l3_identity
  }
  // Artifact state, production effect, and pointer/artifact checksums still apply.
  return inspectActive8ActionAuthorityState(
    databaseForDataDomain(env, 'learning'), databaseForDataDomain(env, 'core'), businessDate, identity,
  )
}
