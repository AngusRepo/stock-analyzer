#!/usr/bin/env node
/** Writes the alert rules as a Grafana provisioning file (../alerts/sv-chain-rules.json).
 * Every rule is paused: enabling them is a separate step once the live datasource exists (see ../README.md). */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIVE_DS, N, querySource } from './lib.mjs'

const q = querySource('live', {})
const EXPR = { type: '__expr__', uid: '__expr__' }
const range = { from: 600, to: 0 }

/** A = one number read from the monitoring Worker, B = its last value, C = B > 0. */
function rule(uid, title, target, { severity, summary, noData = 'OK', forDuration = '0s' }) {
  return {
    uid, title, condition: 'C', for: forDuration, isPaused: true, noDataState: noData, execErrState: 'Error',
    labels: { severity, system: 'stockvision', source: 'monitoring-worker' },
    annotations: { summary, dashboard: '/d/sv-today' },
    data: [
      { refId: 'A', relativeTimeRange: range, datasourceUid: LIVE_DS.uid, model: { ...target, refId: 'A' } },
      { refId: 'B', relativeTimeRange: range, datasourceUid: EXPR.uid, model: { refId: 'B', type: 'reduce', datasource: EXPR, expression: 'A', reducer: 'last' } },
      { refId: 'C', relativeTimeRange: range, datasourceUid: EXPR.uid, model: { refId: 'C', type: 'threshold', datasource: EXPR, expression: 'B',
        conditions: [{ evaluator: { type: 'gt', params: [0] } }] } },
    ],
  }
}

const count = (field) => q('/v1/chain/alerts', { root: `{ 'n': counts.${field} }`, columns: [N('n', 'n')] })
const rules = [
  rule('sv-chain-failed', '流程鏈：有階段失敗', count('failed'), { severity: 'critical', summary: '四條鏈（每日、盤中、每週、每月）有階段以 error 結束（含只看失敗的階段）。看「今天」頁的要處理清單（有鏈別）。' }),
  rule('sv-chain-overdue', '流程鏈：必要階段逾時或卡住', q('/v1/chain/alerts', { root: `{ 'n': counts.overdue + counts.stuck }`, columns: [N('n', 'n')] }),
    { severity: 'critical', summary: '必要階段過了截止還沒完成；或執行中但 heartbeat 停了超過 15 分鐘；或盤中 intraday-check 超過 10 分鐘沒有新結果。', forDuration: '2m' }),
  rule('sv-chain-missed', '流程鏈：該跑的鏈沒有起跑', count('missed'), { severity: 'critical', summary: '過了第一站截止還沒有任何狀態列：每日 18:30、盤中 09:10（交易日）、每週週五 19:00、每月第一個週六 13:00。前一期也沒資料時（剛上線）不算。' }),
  // checks are judged against the expected-completed data date, so `fail` is data that should be there; `warn` (one day of lag) is not paged.
  rule('sv-data-not-ready', '資料就緒：該到的資料沒到', q('/v1/data-readiness', { root: `{ 'n': $count(checks[status = 'fail']) }`, columns: [N('n', 'n')] }),
    { severity: 'warning', summary: '價格、籌碼、技術指標或首頁資料匯入有 fail。看「今天」頁的資料就緒表。', forDuration: '15m' }),
  // Chained predicates: a null projection is dropped before the comparison.
  rule('sv-d1-capacity', 'D1 容量：使用率 ≥ 80% 或 30 天內會滿', q('/v1/capacity', {
    root: `{ 'n': $count(rows[utilization_pct >= 80]) + $count(rows[$type(projected_days_to_critical_90pct) = 'number'][projected_days_to_critical_90pct <= 30]) }`,
    columns: [N('n', 'n')] }),
    { severity: 'warning', summary: '有 D1 資料庫使用率達 80%，或依成長速度 30 天內會到 90%。看「健康」頁的容量表。', forDuration: '30m' }),
  // No rows and query errors both mean the monitoring Worker did not answer: that is the alert.
  { ...rule('sv-monitoring-silent', '監控端點拿不到資料', q('/v1/trading-day', { root: `{ 'n': rows ? 0 : 1 }`, columns: [N('n', 'n')] }),
    { severity: 'critical', summary: '監控 Worker 沒有回應或回應格式不對；其他規則此時無法判斷。', noData: 'Alerting', forDuration: '5m' }), execErrState: 'Alerting' },
]

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'alerts')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'sv-chain-rules.json'), `${JSON.stringify({ apiVersion: 1, groups: [
  { orgId: 1, name: 'sv-chain', folder: 'StockVision', interval: '1m', rules }] }, null, 1)}\n`)
console.log(`${rules.length} rules (all paused) → alerts/sv-chain-rules.json`)
