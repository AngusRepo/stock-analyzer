import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const paperExecutionEvents = readFileSync('src/lib/paperExecutionEvents.ts', 'utf8')

assert(paperEntryTasks.includes('buildStockVisionOrderIntent'), 'intraday execution should build StockVision order intent before preview/fill')
assert(paperEntryTasks.includes('fetchFinLabExecutionPreview'), 'intraday execution should call FinLab execution preview before paper fill')
assert(paperEntryTasks.includes('buildPaperBrokerReconciliation'), 'intraday execution should reconcile intent, preview, L5 and simulated fill')
assert(paperEntryTasks.includes("eventType: 'finlab_execution_preview'"), 'intraday execution should persist FinLab execution preview events')
assert(paperEntryTasks.includes("eventType: 'paper_broker_reconciliation'"), 'intraday execution should persist paper-broker reconciliation events')
assert(paperExecutionEvents.includes("'finlab_execution_preview'"), 'paper execution event contract should allow FinLab execution preview')
assert(paperExecutionEvents.includes("'paper_broker_reconciliation'"), 'paper execution event contract should allow reconciliation events')
