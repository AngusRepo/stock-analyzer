import type { Bindings } from '../types'
import {
  assertInactiveLearningShadowAuthority,
  controlTableReceiptBlockers,
  controlTableRowCounts,
  invalidateControlTableClosure,
  loadControlTableReceipt,
  type InactiveLearningShadowAuthority,
} from './dataDomainControlTableParity'
import type { DataDomainControlTable } from './dataDomainShadowManifest'
import {
  dataDomainControlRevisionBlockers,
  loadDataDomainControlRevisionPair,
  type DataDomainControlRevisionPair,
} from './dataDomainControlRevision'
import {
  changedExpectedReturnSemanticTables,
  expectedReturnSemanticBlockers,
  loadExpectedReturnSemanticSnapshot,
  type ExpectedReturnSemanticSnapshot,
} from './expectedReturnPointerSemanticGuard'

const POINTER_TABLE = 'model_champion_pointers' as const
const POINTER_PARENT_TABLES = [
  'model_artifact_registry',
  'expected_return_artifact_payloads',
  'model_champion_history',
] as const

export class ExpectedReturnPointerShadowGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpectedReturnPointerShadowGuardError'
  }
}

export function isExpectedReturnPointerShadowGuardError(
  error: unknown,
): error is ExpectedReturnPointerShadowGuardError {
  return error instanceof ExpectedReturnPointerShadowGuardError
    || (error instanceof Error && error.message.startsWith('expected_return_pointer_shadow_guard_'))
}

export type ExpectedReturnPointerShadowGuard = {
  authority: InactiveLearningShadowAuthority
  sourceBefore: ExpectedReturnSemanticSnapshot
  target: D1Database
  parentRevisions: Readonly<Record<
    typeof POINTER_PARENT_TABLES[number],
    DataDomainControlRevisionPair
  >>
}

function guardReason(code: string, blockers: readonly string[]): string {
  return `${code}:${[...new Set(blockers)].join('|')}`.slice(0, 1000)
}

async function blockPointerOnly(
  env: Bindings,
  authority: InactiveLearningShadowAuthority,
  reason: string,
  preserveCursor: boolean,
): Promise<never> {
  await invalidateControlTableClosure(env.DB, {
    changedTables: [POINTER_TABLE],
    preserveCursorTables: preserveCursor ? [POINTER_TABLE] : [],
    reason,
    authority,
  })
  throw new ExpectedReturnPointerShadowGuardError(reason)
}

export async function beginExpectedReturnPointerShadowGuard(
  env: Bindings,
  target: D1Database,
  parityNotBefore: string | null | undefined,
): Promise<ExpectedReturnPointerShadowGuard> {
  const authority = assertInactiveLearningShadowAuthority(env)
  if (!parityNotBefore) {
    return blockPointerOnly(
      env,
      authority,
      'expected_return_pointer_shadow_guard_parity_watermark_missing',
      true,
    )
  }
  const parentStates = await Promise.all(
    POINTER_PARENT_TABLES.map(async (table) => ({
      table,
      receipt: await loadControlTableReceipt(env.DB, table),
      counts: await controlTableRowCounts(env.DB, target, table),
      liveRevision: await loadDataDomainControlRevisionPair(env.DB, target, table),
    })),
  )
  const blockedParents = parentStates.map(({ table, receipt, counts, liveRevision }) => {
    const blockers = controlTableReceiptBlockers({
      table,
      ...receipt,
      parityNotBefore,
    })
    blockers.push(...dataDomainControlRevisionBlockers({
      receipt: receipt.parity,
      live: liveRevision,
    }))
    if (counts.sourceCount !== counts.targetCount) {
      blockers.push(`live_count_mismatch:${counts.sourceCount}/${counts.targetCount}`)
    }
    if (counts.sourceCount !== Number(receipt.parity?.source_count ?? -1)) {
      blockers.push(`live_source_count_stale:${counts.sourceCount}/${String(receipt.parity?.source_count ?? 'missing')}`)
    }
    if (counts.targetCount !== Number(receipt.parity?.target_count ?? -1)) {
      blockers.push(`live_target_count_stale:${counts.targetCount}/${String(receipt.parity?.target_count ?? 'missing')}`)
    }
    return { table, receipt, counts, blockers: [...new Set(blockers)] }
  }).filter((state) => state.blockers.length)
  const parentBlockers = blockedParents.flatMap(({ table, blockers }) =>
    blockers.map((blocker) => `${table}:${blocker}`),
  )
  if (parentBlockers.length) {
    const reason = guardReason(
      'expected_return_pointer_shadow_guard_parent_receipt_blocked',
      parentBlockers,
    )
    await invalidateControlTableClosure(env.DB, {
      changedTables: blockedParents.map(({ table }) => table),
      preserveCursorTables: blockedParents
        .filter(({ receipt, counts }) => (
          counts.sourceCount === counts.targetCount
          && receipt.cursor?.status === 'complete'
          && Number(receipt.cursor.rows_copied ?? -1) === counts.sourceCount
        ))
        .map(({ table }) => table),
      reason,
      authority,
    })
    throw new ExpectedReturnPointerShadowGuardError(reason)
  }
  const sourceBefore = await loadExpectedReturnSemanticSnapshot(env.DB)
  const semanticBlockers = await expectedReturnSemanticBlockers(sourceBefore)
  if (semanticBlockers.length) {
    return blockPointerOnly(
      env,
      authority,
      guardReason('expected_return_pointer_shadow_guard_source_semantic_blocked', semanticBlockers),
      true,
    )
  }
  return {
    authority,
    sourceBefore,
    target,
    parentRevisions: Object.fromEntries(parentStates.map((state) => [
      state.table,
      state.liveRevision,
    ])) as Record<typeof POINTER_PARENT_TABLES[number], DataDomainControlRevisionPair>,
  }
}

async function loadStableSource(
  env: Bindings,
  guard: ExpectedReturnPointerShadowGuard,
): Promise<ExpectedReturnSemanticSnapshot> {
  const liveParentRevisions = await Promise.all(POINTER_PARENT_TABLES.map(async (table) => ({
    table,
    live: await loadDataDomainControlRevisionPair(env.DB, guard.target, table),
  })))
  const changedParents = liveParentRevisions.filter(({ table, live }) => {
    const expected = guard.parentRevisions[table]
    return live.sourceRevision !== expected.sourceRevision
      || live.targetRevision !== expected.targetRevision
  })
  if (changedParents.length) {
    const changedTables = changedParents.map(({ table }) => table)
    const reason = guardReason(
      'expected_return_pointer_shadow_guard_parent_revision_drift',
      changedParents.flatMap(({ table, live }) => {
        const expected = guard.parentRevisions[table]
        return [
          `${table}:source_revision:${expected.sourceRevision}/${live.sourceRevision}`,
          `${table}:target_revision:${expected.targetRevision}/${live.targetRevision}`,
        ]
      }),
    )
    await invalidateControlTableClosure(env.DB, {
      changedTables: [...changedTables, POINTER_TABLE],
      preserveCursorTables: changedTables,
      reason,
      authority: guard.authority,
    })
    throw new ExpectedReturnPointerShadowGuardError(reason)
  }
  const sourceAfter = await loadExpectedReturnSemanticSnapshot(env.DB)
  const changed = changedExpectedReturnSemanticTables(guard.sourceBefore, sourceAfter)
  const semanticBlockers = await expectedReturnSemanticBlockers(sourceAfter)
  if (changed.length || semanticBlockers.length) {
    const changedTables = [...new Set<DataDomainControlTable>([
      ...changed,
      POINTER_TABLE,
    ])]
    const reason = guardReason(
      'expected_return_pointer_shadow_guard_source_drift',
      [
        ...changed.map((table) => `source_changed:${table}`),
        ...semanticBlockers,
      ],
    )
    await invalidateControlTableClosure(env.DB, {
      changedTables,
      reason,
      authority: guard.authority,
    })
    throw new ExpectedReturnPointerShadowGuardError(reason)
  }
  return sourceAfter
}

export async function assertExpectedReturnPointerSourceStable(
  env: Bindings,
  guard: ExpectedReturnPointerShadowGuard | null,
): Promise<void> {
  if (!guard) return
  await loadStableSource(env, guard)
}

export async function assertExpectedReturnPointerTargetClosure(
  env: Bindings,
  target: D1Database,
  guard: ExpectedReturnPointerShadowGuard | null,
): Promise<void> {
  if (!guard) return
  const sourceAfter = await loadStableSource(env, guard)
  const targetSnapshot = await loadExpectedReturnSemanticSnapshot(target)
  const targetBlockers = await expectedReturnSemanticBlockers(targetSnapshot)
  if (targetBlockers.length || sourceAfter.digest !== targetSnapshot.digest) {
    const targetChanged = changedExpectedReturnSemanticTables(sourceAfter, targetSnapshot)
    const reason = guardReason(
      'expected_return_pointer_shadow_guard_target_blocked',
      [
        ...(sourceAfter.digest === targetSnapshot.digest ? [] : ['semantic_digest_mismatch']),
        ...targetBlockers,
      ],
    )
    await invalidateControlTableClosure(env.DB, {
      changedTables: [...new Set<DataDomainControlTable>([
        ...targetChanged,
        POINTER_TABLE,
      ])],
      reason,
      authority: guard.authority,
    })
    throw new ExpectedReturnPointerShadowGuardError(reason)
  }
}
