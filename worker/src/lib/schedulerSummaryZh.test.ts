import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { SCHEDULER_SUMMARY_ZH_JOB_IDS, schedulerLastErrorZh, schedulerSummaryZh } from './schedulerSummaryZh'

type FixtureJob = { id: string; lastStatus: string; summary: string }
const fixture = JSON.parse(readFileSync(new URL('./fixtures/schedulerSummaryZh.prod-20261128.json', import.meta.url), 'utf8')) as { jobs: FixtureJob[] }

const KEY_VALUE = /\b[A-Za-z][\w.-]*=\S/
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i
const CJK = /[一-鿿]/

function assertHuman(id: string, sentence: string | undefined) {
  assert.ok(sentence, `${id}: 沒有中文句`)
  assert.match(sentence!, CJK, `${id}: 句子不是中文`)
  assert.doesNotMatch(sentence!, KEY_VALUE, `${id}: 殘留 key=value：${sentence}`)
  assert.doesNotMatch(sentence!, SNAKE, `${id}: 殘留 snake_case：${sentence}`)
}

test('prod 11/28 的 38 個 key=value 摘要每個都有中文句，且不殘留機器識別字', () => {
  assert.equal(fixture.jobs.length, 38)
  for (const job of fixture.jobs) {
    assert.ok(SCHEDULER_SUMMARY_ZH_JOB_IDS.includes(job.id), `${job.id}: 沒有專屬 formatter`)
    assertHuman(job.id, schedulerSummaryZh(job.id, job.summary))
  }
})

test('中文句帶出原文的關鍵數字與狀態', () => {
  const zh = (id: string) => schedulerSummaryZh(id, fixture.jobs.find((job) => job.id === id)!.summary)!
  const expect: Record<string, string[]> = {
    update: ['2026-11-27', '2,416', '2,408', '2,198', '1,336', '862', '2,213'],
    'market-close-refresh': ['2,104', '33 站', '日盤收盤未取到', '39,249', '0/3', '3 檔失敗'],
    'finlab-v4-backfill': ['109,983', '第 1 次'],
    screener: ['845', '594', '7 分 59 秒'],
    'screener-v2-watchdog': ['異常', '2026-11-27 找不到正式選股執行紀錄', '錯誤', '2026-11-26 策略學習已成功'],
    'pre-market-warmup': ['9925、2206、2072', '2 項降級', '紅燈'],
    'strategy-learning-mature-evidence': ['839', '11 → 10', '29,488', '3,392', '134,615'],
    'kv-config-drift': ['一致', '3 筆', '0 筆失敗'],
    'retention-hot-window-drain': ['dry run', '243', '10 個資料集被擋'],
    'retention-archive-only': ['9/9', '300', '1.4 MB'],
    'r2-retention-sweep': ['100', '77', '額度用盡'],
    'storage-capacity-report': ['market（約 33 天）', 'learning（約 53 天）', '91.3%'],
    'allocator-ev-lifecycle-watchdog': ['週末', '2026-11-28', '略過'],
    'active8-oof-daily': ['尚未執行', '未派送'],
    'adaptive-meta-policy-replay': ['未通過', 'LinUCB', '20,000', '3 項通過'],
    'linucb-multiplier-replay': ['未通過', '5,000', '32 組', '0.6'],
    'alpha-quality': ['1,000', '8 個警示', '-1.45R'],
    'dataset-snapshot-export': ['4,160,784', '1,002,504'],
  }
  for (const [id, parts] of Object.entries(expect)) {
    const sentence = zh(id)
    for (const part of parts) assert.ok(sentence.includes(part), `${id}: 缺「${part}」：${sentence}`)
  }
})

test('錯誤／略過／dry run 狀態在句子裡講清楚', () => {
  const cases: Array<[string, string, string]> = [
    ['market-close-refresh', 'error: market-close refresh incomplete; attempt finished; retry required; date=2026-11-27; price_latest=2026-11-26; price_rows=812; official_prices_waiting=timeout', '未完成'],
    ['kv-config-drift', 'kv_config_drift trading:config=drift:0bf52c5366e7 trading:risk_config=match:b1f9c64776dd', '不一致'],
    ['allocator-ev-readiness', 'L4 allocation readiness before pipeline for 2026-11-27 | knowledge_cutoff_date=2026-11-27 | expected_return_serving_state=blocked | expected_return_owner=none | legacy_ev_oof=retired_incompatible | action_ready=0 | readiness_state=fatal | hard_alerts=a_b,c_d', '不可執行配置'],
    ['retention-hot-window-drain', 'retention_hot_window_drain status=success dry_run=false policies=7 attempts=7 stop=complete pending=none scanned=10 archived=10 deleted=0 backlog=false failed=x_y blocked=0', '1 項政策失敗'],
    ['strategy-learning-watchdog', 'strategy-learning recovery blocked date=2026-11-26 reason=retry_exhausted', '被擋'],
    ['screener-v2-watchdog', 'status=skipped screener={SKIPPED canonical screener run missing for 2026-11-29; non_trading_day=weekend} strategy_learning={SKIPPED strategy-learning recovery no_candidate}', '略過'],
    ['active8-oof-weekly', 'active8_oof_lifecycle status=skipped reason=some_new_reason job_dispatched=false cadence=weekly', '原因代碼見明細'],
    ['pre-market-warmup', 'status=error event_stage=market-health plan_published=false', '失敗'],
    ['audit-json-retention', 'durable_drain failed; automatic_continuation_stopped backlog_remaining=true', '失敗'],
    ['external-evidence', 'external evidence receipt=ready_via_d1_readback target=2026-11-27 controller_http=524', '524'],
    ['update', 'holiday', ''],
  ]
  for (const [id, raw, part] of cases) {
    const sentence = schedulerSummaryZh(id, raw)
    if (!part) { assert.equal(sentence, undefined, `${id}: 認不得的原文要回 undefined`); continue }
    assertHuman(id, sentence)
    assert.ok(sentence!.includes(part), `${id}: 缺「${part}」：${sentence}`)
  }
  assert.ok(schedulerSummaryZh('debate-memory-retention', 'skipped by scheduler policy: holiday:2026-12-25; policy=trading_day')!.includes('假日休市'))
})

test('認不得的 job 或原文回 undefined，前端退回 humanJobSummary', () => {
  assert.equal(schedulerSummaryZh('unknown-job', 'a=1 b=2'), undefined)
  assert.equal(schedulerSummaryZh('screener', ''), undefined)
  assert.equal(schedulerSummaryZh('screener', 'something unexpected'), undefined)
  assert.equal(schedulerLastErrorZh('daily-snapshot', 'Error: D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.'),
    'D1 資料庫過載（10 秒內資源用量超限），本次未完成')
  assert.ok(schedulerLastErrorZh('kv-config-drift', 'Error: kv_config_drift trading:config=missing')!.includes('不存在'))
  assert.equal(schedulerLastErrorZh('screener', 'TypeError: x is undefined'), undefined)
})

test('只在讀取時解析字串：模組不 import 任何東西、不碰 D1／KV', () => {
  const source = readFileSync(new URL('./schedulerSummaryZh.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /^import /m)
  assert.doesNotMatch(source, /\.prepare\(|\bKV\.|\bD1Database\b|fetch\(/)
  const status = readFileSync(new URL('./schedulerStatus.ts', import.meta.url), 'utf8')
  assert.match(status, /summaryZh: schedulerSummaryZh\(row\.id, row\.summary\)/)
  assert.match(status, /lastErrorZh: schedulerLastErrorZh\(row\.id, row\.lastError\)/)
})

test('verifier 回報的變體：盤勢未切換不誤報、dry run 出錯標題講失敗、容量警戒線要提醒', () => {
  assert.ok(schedulerSummaryZh('regime-compute', 'pre-screener regime=bear idx=2 kv=verified shift=same; source=x')!.includes('盤勢未切換'))
  assert.ok(schedulerSummaryZh('regime-compute', 'pre-screener regime=bear idx=2 kv=verified shift=shift:bull→bear enqueued; source=x')!.includes('由多頭切換為空頭'))
  assert.doesNotMatch(schedulerSummaryZh('regime-compute', 'pre-screener regime=bear idx=2 kv=verified shift=skip(missing_label); source=x')!, /切換/)
  const drain = schedulerSummaryZh('retention-hot-window-drain', 'retention_hot_window_drain status=error dry_run=true policies=7 attempts=7 stop=preflight pending=none scanned=1 archived=0 deleted=0 backlog=false failed=a_b,c_d blocked=0')!
  assert.match(drain, /^熱資料視窗清理預檢失敗/)
  const storage = schedulerSummaryZh('storage-capacity-report', fixture.jobs.find((job) => job.id === 'storage-capacity-report')!.summary)!
  assert.ok(storage.includes('market 71.9% 已超過 65% 警戒線'), storage)
  assert.equal(schedulerSummaryZh('strategy-learning-mature-evidence', 'mature_recovery=mature_signal_date=none inspected_dates=0 gaps_before=0 targeted=none projection_runs=0 labels_persisted=0 gaps_after=0 blocked=none labels=0 pending=0 unavailable=0')!.includes('尚無成熟訊號日'), true)
})
