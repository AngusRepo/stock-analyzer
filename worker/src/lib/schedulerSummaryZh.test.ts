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

// ── 第二批：非 key=value 摘要、pipeline 執行中、排程框架句 ─────────────────
type Batch2Job = FixtureJob & { lastError?: string }
const batch2 = JSON.parse(readFileSync(new URL('./fixtures/schedulerSummaryZh.prod-20261128-batch2.json', import.meta.url), 'utf8')) as { jobs: Batch2Job[] }
const sample = (id: string, marker: string) => {
  const job = batch2.jobs.find((row) => row.id === id && row.summary.includes(marker))
  assert.ok(job, `fixture 缺 ${id}「${marker}」`)
  return job!
}

test('prod 第二批每個樣本（summary 與 lastError）都有中文句，且不殘留機器識別字', () => {
  assert.ok(batch2.jobs.length >= 150, `樣本太少：${batch2.jobs.length}`)
  for (const job of batch2.jobs) {
    assertHuman(job.id, schedulerSummaryZh(job.id, job.summary))
    if (job.lastError) assertHuman(`${job.id} lastError`, schedulerLastErrorZh(job.id, job.lastError))
  }
  const required = [
    'storage-health-check', 'learning-retention-readiness', 'legacy-learning-deletion-readiness', 'storage-integrity-audit',
    'weekly-readiness', 'monthly-readiness', 'weekly-backtest', 'us-leading', 'intraday-check', 'rescore-10', 'rescore-11',
    'rescore-12', 'rescore-1230', 'daily-snapshot', 'hmm-maintenance', 'pipeline', 'evening-chain',
  ]
  for (const id of required) assert.ok(batch2.jobs.some((job) => job.id === id), `第二批缺 ${id}`)
})

test('第二批中文句帶出原文的關鍵數字與狀態', () => {
  const cases: Array<[string, string, string[]]> = [
    ['hmm-maintenance', 'hmm=not_due', ['尚未到期', '盤勢涵蓋已就緒']],
    ['hmm-maintenance', 'hmm=dispatched', ['已派送', '等待完成']],
    ['storage-health-check', 'storage_health_check', ['正常', '完整性阻擋 0', 'DLQ 待處理 0', 'market 71.9%', 'learning 69.5%']],
    ['learning-retention-readiness', 'learning_retention_readiness', ['尚未就緒', '120 天', '3,650 天', '721,168', '阻擋 22 項', '75/75']],
    ['legacy-learning-deletion-readiness', 'legacy_learning_deletion_readiness', ['尚未就緒', '未授權刪除', '不會自動刪除', '2026-09-17', '74/74']],
    ['storage-integrity-audit', 'storage integrity audit failed', ['失敗', '檢查 100 件', '驗證通過 99 件', '讀取錯誤 1', 'D1 過載']],
    ['storage-integrity-audit', 'checked=100 verified=100', ['通過', '檢查 100 件', '驗證 100 件']],
    ['weekly-readiness', 'weekly_readiness_blocked', ['被擋', '2 項必要工作未收斂', '儲存完整性稽核失敗', '每週回測失敗']],
    ['monthly-readiness', 'monthly_readiness_blocked', ['被擋', '每月策略挖掘未收到完成回呼']],
    ['weekly-backtest', 'research_corporate_coverage_incomplete', ['被擋', '455 個交易日', '455 日有缺口', '候選搜尋未開始']],
    ['us-leading', '"sox"', ['2026-11-27', '費半 -0.65%', '台積電 ADR -1.96%', 'VIX 26.80']],
    ['intraday-check', '"status":"partial"', ['不完整', '3 檔持股只取得 2 檔報價', '2206']],
    ['intraday-check', '"status":"ok"', ['正常', '3 檔持股皆取得報價']],
    ['rescore-10', '2 positions', ['2 檔持股', '自動出場 0', '警示 2', '續抱 0']],
    ['rescore-1230', '3 positions', ['3 檔持股', '警示 3']],
    ['rescore-11', 'No open positions', ['沒有持股']],
    ['daily-snapshot', 'paper_snapshot_mark_date_mismatch', ['失敗', '2026-11-27', '3 檔持股', '2072、2206、9925', '未寫入快照']],
    ['daily-snapshot', '"nav":948203.63', ['2026-11-20', '948,203.63', '持股 0 檔']],
    ['pipeline', 'preds=2375', ['Pipeline 完成', '2,375', '475', '沒有錯誤']],
    ['pipeline', 'atomic_inputs=waiting', ['L3 已封存', 'Atomic 輸入等待中']],
    ['pipeline', 'historical learning lineage boundary', ['擋下', '未執行']],
    ['evening-chain', 'blockers=active8_oof_daily:error', ['晚間流程失敗', '2026-11-20', '歷史重播', 'Active-8 每日證據錯誤']],
    ['evening-chain', 'durable DAG complete date=2026-11-03', ['晚間流程完成', '2026-11-03', '5 個必要階段', '2026-08-20']],
    ['screener-v2-watchdog', 'continuation=already_success', ['正式選股已確認', '839', 'Pipeline 未失敗']],
    ['strategy-learning-watchdog', 'reason=run_error:D1_ERROR', ['被擋', '2026-11-17', 'D1 過載', '不自動重跑']],
    ['allocator-ev-lifecycle-watchdog', 'dates=5 incomplete=1', ['失敗', '5 日', '未完成 1 日', '2026-11-23']],
    ['active8-oof-daily', 'reason=awaiting_pipeline', ['尚未執行', '2026-11-26', '未派送']],
    ['news-analyst', 'bias=negative', ['偏空', '0.70', '5 個']],
    ['premarket-evidence-watchdog', 'stage=premarket_v3:allocate', ['進行中', ' L4 配置階段', '佇列 2 件', '08:45']],
    ['premarket-evidence-watchdog', 'overdue=true', ['逾時未完成', '盤前脈絡階段', '08:45']],
    ['verify-v2', 'verified 5588/5624', ['5,624', '5,588', '判定正確 0 筆']],
    ['optuna-queue', 'per_regime:regime_shift:volatile', ['高波動', '2026-11-27', 'Cloud Run job']],
    ['artifact-reconcile', 'maintenance_lease_busy:audit-json-retention:queue:2026-11-23 18:06:31', ['稽核 JSON 清理', '台灣時間 2026-11-24 02:06', '未執行']],
    ['storage-capacity-report', 'observed_date=2026-11-20', ['2026-11-20', 'legacy 91.3% 已超過 90% 上限警戒', 'market 69.0%', 'learning 70.5%', 'market（約 39 天）', 'learning（約 45 天）']],
    ['allocator-ev-lifecycle-watchdog', 'window=2026-11-19..2026-11-25', ['已完成 2 日', '等待 Pipeline 1 日', '2026-11-23 Pipeline 後續鏈已無法補救', '已重試 9 次仍失敗', '先前已回報']],
    ['allocator-ev-lifecycle-watchdog', 'window=2026-11-23..2026-11-27', ['檢查失敗', '無法補救', '需人工檢查']],
    ['active8-oof-monthly', 'full_fit_poll_only_terminal_failure', ['失敗', '2026-11-05', '終止失敗', '重試 12 次已用完']],
    ['daily-report', 'no_channel_configured', ['未寄出', '報告列出買進 15 檔', '賣出 10 檔']],
    ['legacy-learning-deletion-readiness', 'legacy_learning_deletion_readiness', ['最近一次全表比對 74/74 張一致', '切換後目標端有 6 項漂移', '4 張控制表版本落後']],
    ['model-ic-full-check', 'config=no_challenger', ['65,983', '沒有挑戰者交易參數組']],
    ['sector-leaders', 'sectors=45', ['45 個產業', '132 檔']],
  ]
  for (const [id, marker, parts] of cases) {
    const sentence = schedulerSummaryZh(id, sample(id, marker).summary)!
    for (const part of parts) assert.ok(sentence.includes(part), `${id}「${marker}」缺「${part}」：${sentence}`)
  }
  // 單日 ok 只代表檢查沒丟錯：無法補救的日子不能被歸成「已處理」
  for (const job of batch2.jobs.filter((row) => row.id === 'allocator-ev-lifecycle-watchdog')) {
    assert.doesNotMatch(schedulerSummaryZh(job.id, job.summary)!, /已處理|檢查正常/)
  }
  assert.doesNotMatch(schedulerSummaryZh('active8-oof-monthly', sample('active8-oof-monthly', 'full_fit_poll_only_terminal_failure').summary)!, /尚未完成/)
})

test('pipeline 執行中摘要（phase=… phase_status=… execution=…）翻成階段中文，認不得的階段回 undefined', () => {
  const running = schedulerSummaryZh('pipeline', 'phase=modal_inference phase_status=running execution=pipeline-job-abc12')
  assertHuman('pipeline running', running)
  assert.ok(running!.includes('執行中'), running)
  const failed = schedulerSummaryZh('pipeline', 'phase=node_write_d1 phase_status=failed execution=pipeline-job-abc12')!
  assert.ok(failed.includes('失敗'), failed)
  assert.doesNotMatch(failed, /完成|成功/)
  assert.equal(schedulerSummaryZh('pipeline', 'phase=brand_new_phase phase_status=running execution=x'), undefined)
  assert.equal(schedulerSummaryZh('pipeline', 'phase=modal_inference phase_status=weird execution=x'), undefined)
})

test('第二批錯誤／略過變體不會講成成功，認不得的格式回 undefined', () => {
  const failures: Array<[string, string, RegExp]> = [
    ['hmm-maintenance', 'admitted delivery ended before execution started', /未執行/],
    ['optuna-queue', 'sync delivery ended after execution started without settling its ticket', /結果不明/],
    ['legacy-strategy-evidence-migration', 'blocked by storage admission: legacy_d1_capacity_unknown utilization=unknown%', /擋下/],
    ['active8-oof-daily', 'active8-oof-daily requires sync=1', /擋下未執行/],
    ['linucb-reward-ledger', 'skipped non-production-authoritative callback run_date=2026-11-03; linucb-reward-ledger is live-canonical only', /未執行/],
    ['model-ic-full-check', 'RuntimeError: D1 request failed: HTTP 400: {"errors":[{"code":7500,"message":"D1 query result exceeded the maximum response size limit of 50 MB"}]}', /50 MB/],
  ]
  for (const [id, raw, re] of failures) {
    const sentence = schedulerSummaryZh(id, raw)
    assertHuman(id, sentence)
    assert.match(sentence!, re, `${id}: ${sentence}`)
    assert.doesNotMatch(sentence!, /完成：|成功|通過|正常/, `${id} 把失敗講成成功：${sentence}`)
  }
  assert.equal(schedulerSummaryZh('hmm-maintenance', 'status=success hmm=brand_new coverage=true call=none'), undefined)
  assert.equal(schedulerSummaryZh('storage-health-check', 'storage_health_check {not json'), undefined)
  assert.equal(schedulerSummaryZh('intraday-check', '{"status":"brand_new","positions":1}'), undefined)
  assert.equal(schedulerSummaryZh('weekly-readiness', 'weekly_readiness_blocked {"truncated'), undefined)
  assert.equal(schedulerSummaryZh('rescore-10', 'some other text'), undefined)
  assert.equal(schedulerSummaryZh('us-leading', '{"date":"2026-11-27","fetched_at":"x"'), undefined)
  assert.equal(schedulerSummaryZh('allocator-ev-lifecycle-watchdog', 'status=success allocator EV lifecycle window=2026-11-19..2026-11-25 dates=1 incomplete=0 dispatched=none outside_window_new=0 outside_window_known=0; 2026-11-23=ok:status:success_allocator_EV_lifecycle_brand_new_detail'), undefined)
  const kv = schedulerSummaryZh('kv-config-drift', 'kv_config_drift trading:config=match:a trading:risk_config=match:b | stored_risk_v2_drift since=2026-10-12 checked=2 skipped_pre_v2=0 failed=1 policy_changed=0')!
  assert.match(kv, /發現問題/)
  assert.doesNotMatch(kv, /比對完成/)
  assert.doesNotMatch(schedulerSummaryZh('sector-flow-pre-screener', 'sector_flow date=2026-11-20 status=brand_new rebuild_run_id=x')!, /狀態狀態/)
})
