import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { D1_CAPACITY_MARKERS, D1_OVERLOAD_CODES, D1_OVERLOAD_MARKERS, isD1CapacityError } from '../lib/d1CapacityErrors'
import { isTransientD1Overload } from '../lib/strategyLearningRecoveryWatchdog'
import { ERROR_BRIEF, errorBrief } from './errorBrief'
import { D1_OVERLOAD_MARKERS as TICKET_MARKERS } from './schedulerTickets'

const expect = (brief: string, texts: string[]) => { for (const text of texts) assert.equal(errorBrief(text), brief, text) }

test('errorBrief: no error has no reason', () => {
  for (const value of [null, undefined, '', '   ']) assert.equal(errorBrief(value), null)
})

test('errorBrief: only the head is classified, never the trace frames', () => {
  expect(ERROR_BRIEF.other, [
    'ValueError: paired nav write rejected | trace: x.py:20 in nav_worker_timeout',
    'RuntimeError: dispatch failed | trace: proxy.py:41 in _proxy_timeout_seconds',
    'KeyError: score | trace: d1.py:9 in d1_overloaded_guard <- svc.py:3 in fetch_missing_rows',
  ])
  expect(ERROR_BRIEF.upstream, ['ValueError: daily_native_update_status_unavailable:disclosure | trace: x.py:20 in _deadline_daily'])
})

test('errorBrief: D1 capacity errors are 資料庫過載 in any case, before a timeout or a missing input in the same text', () => {
  for (const marker of D1_CAPACITY_MARKERS.filter((m) => m !== 'Network connection lost')) {
    expect(ERROR_BRIEF.overloaded, [`D1_ERROR: ${marker}`, `d1_error: ${marker.toLowerCase()}`, marker.toUpperCase()])
  }
  expect(ERROR_BRIEF.overloaded, [
    'D1 DB storage operation exceeded timeout which caused object to be reset',
    'database is locked: SQLITE_BUSY',
    'D1 request failed: HTTP 429: Too Many Requests',
    'D1 request failed: HTTP 503',
    'd1_overloaded', 'd1_rate_limited', 'screener read failed: D1_RATE_LIMITED',
    'Requests queued for too long; request timed out',
    'daily_native_update_status_unavailable after D1 DB is overloaded',
  ])
})

test('errorBrief: one D1 capacity source for the watchdog, the ticket query and the panels', () => {
  assert.equal(TICKET_MARKERS, D1_OVERLOAD_MARKERS)
  for (const marker of D1_CAPACITY_MARKERS) assert.ok(isTransientD1Overload(new Error(`x: ${marker.toUpperCase()}`)), marker)
  assert.ok(isTransientD1Overload('D1 request failed: HTTP 429: Too Many Requests'))
  assert.equal(isTransientD1Overload('D1_ERROR: no such column: x'), false)
  assert.equal(isD1CapacityError('D1_ERROR: UNIQUE constraint failed'), false)
  // The codes a D1 overload is filed under (marketScreener's classifier, ml-service's serving resolver); the panels read
  // them as 資料庫過載.
  const writers = { d1_overloaded: '../lib/marketScreener.ts', d1_rate_limited: '../../../ml-service/app/serving_resolver.py' }
  assert.deepEqual(Object.keys(writers), [...D1_OVERLOAD_CODES])
  for (const [code, path] of Object.entries(writers)) assert.ok(readFileSync(new URL(path, import.meta.url), 'utf8').includes(`'${code}'`) ||
    readFileSync(new URL(path, import.meta.url), 'utf8').includes(`"${code}"`), code)
})

test('errorBrief: a dropped D1 connection is 服務暫時無法使用, not an overload it does not show', () => {
  expect(ERROR_BRIEF.unavailable, ['D1_ERROR: Network connection lost.', 'network connection lost'])
  // With an overload in the same text, the overload wins.
  expect(ERROR_BRIEF.overloaded, ['Network connection lost; D1 DB is overloaded'])
})

test('errorBrief: real timeouts are 執行逾時', () => {
  expect(ERROR_BRIEF.timeout, ['timeout', 'Timeout after 180000ms', 'request timed out', 'DEADLINE_EXCEEDED', 'Modal call exceeded its deadline',
    'TimeoutError: modal function', 'requests.exceptions.ReadTimeout: read timed out', 'grpc DeadlineExceeded', 'deadline exceeded',
    '504 Gateway Timeout', 'time-out waiting for callback', 'pipeline_callback_timeout', '執行逾時'])
  // A timeout that names a missing input is still a timeout.
  expect(ERROR_BRIEF.timeout, ['timed out waiting for chip_snapshot_unavailable'])
})

test('errorBrief: the repo\'s own timeout codes are 執行逾時, wherever the timeout word sits in the code', () => {
  expect(ERROR_BRIEF.timeout, [
    // worker/src/lib/eveningChainRootClosure.ts (root closure deadline).
    'Error: root_closure_deadline_exceeded:2026-11-25',
    'evening-chain durable DAG failed date=2026-11-25 run_id=missing root_closure_deadline_exceeded:l3-pipeline,ml-predict',
    // worker/src/lib/postVerifyTaskCheckpoint.ts.
    'RuntimeError: post_verify_checkpoint_timeout_unsettled:research-snapshot',
    // ml-controller/services/pipeline_runtime_preflight.py.
    'ValueError: pipeline_modal_provenance_timeout_before_compute',
    'deadline_exceeded', 'DEADLINE_EXCEEDED: Deadline Exceeded', 'grpc status DEADLINE_EXCEEDED',
    // A Python requests timeout names its setting too; the exception says what happened.
    "ReadTimeout: HTTPSConnectionPool(host='api.finlab.tw', port=443): Read timed out. (read timeout=30)",
  ])
})

test('errorBrief: a deadline or timeout setting or check is not a timeout', () => {
  expect(ERROR_BRIEF.other, ['ValueError: cloud_run_dispatch_deadline_invalid', 'deadline_ms must be positive', 'max_timeout_seconds must be an int',
    'invalid sweep_timeout=0', 'ValueError: sweep_timeout=0', 'sweep_timeout = -1', 'timeout must be positive', 'timeout_ms should be an integer',
    'ValueError: invalid modal_timeout', 'KeyError: request_timeout_seconds'])
})

test('errorBrief: *_unavailable, *_missing and *_stale codes and missing inputs are 上游資料未就緒', () => {
  expect(ERROR_BRIEF.upstream, [
    'ValueError: daily_native_update_status_unavailable:disclosure | trace: daily_native_reuse.py:50 in unchanged_native_fields <- daily_native_reuse.py:88',
    'kv_config_manifest_unavailable:503', 'daily_composition_market_dates_missing:2026-11-25', 'premarket_source_stale:taifex',
    'screener_price_history_source_stale:2330', 'ValueError: subscription_original_holder_deadline_missing',
    'screener-v2-watchdog: upstream artifact not ready', 'status=failed screener v2 missing date', 'FinLab margin dates missing',
    'source unavailable', 'not_ready: finlab canonical', 'no data for 2026-11-26', 'no_data', '缺資料：籌碼', 'L3 輸入尚未就緒',
    'no_data_for_session', 'ValueError: no_data_for_session:2026-11-26', 'RuntimeError: premarket no_data_for_session taifex',
    'daily_native_update_status_unavailable_for_disclosure',
  ])
})

test('errorBrief: a data word with a config, schema, request or key word is a code error, not upstream', () => {
  expect(ERROR_BRIEF.other, ['price missing from config schema', 'rows missing primary key in upsert batch', 'date missing in request body',
    'ValueError: date missing from params', 'source missing in payload', 'no data field in request', 'input missing argument: universe'])
  // The rule reads one sentence at a time: an upstream sentence next to an unrelated config sentence still counts.
  expect(ERROR_BRIEF.upstream, ['FinLab margin dates missing. Retry uses config default'])
})

test('errorBrief: an external quota spent for the day is 外部服務額度用盡, not a service outage or missing data', () => {
  expect(ERROR_BRIEF.quota, [
    // FinLab's quota refusal, as tools/finlab_v4_remote_backfill.py and finlabSourceContract.ts FINLAB_QUOTA match it.
    'ConnectionError: Usage exceed 5000 MB/day, join the VIP program', 'RuntimeError: Usage exceed 5000 MB/day',
    'Exception: Usage exceed 5000 MB/day (HTTP 429)', 'please join the VIP program to continue',
    // ml-controller/services/llm_debate_client.py.
    'RuntimeError: workers_ai_debate_daily_free_quota_exhausted',
    'running: evening-chain root skipped FinLab data.get refetch; quota_exhausted_no_refetch=quota limit',
  ])
  // A bare "quota" in a setting check is not a spent quota (controllerResearchWorkflows.ts).
  expect(ERROR_BRIEF.other, ['FINLAB_BACKFILL_LANES must be set for archive backfill; empty lanes would run all CORE_SPECS and burn FinLab quota'])
})

test('errorBrief: a service that is down or refusing for now is 服務暫時無法使用', () => {
  expect(ERROR_BRIEF.unavailable, ['503 Server Error: Service Unavailable for url: https://api.example/x',
    'grpc._channel._InactiveRpcError: status = StatusCode.UNAVAILABLE', 'UNAVAILABLE: failed to connect to all addresses',
    '502 Bad Gateway', 'HTTP 429: Too Many Requests', 'FinLab temporarily unavailable', 'HTTP 503', 'HTTP/1.1 502', 'status 503',
    'status_code=429', 'request failed with status code 502', '503 Service Unavailable', '429 Too Many Requests'])
  // A bare 429, 502 or 503 is a number, not an HTTP status.
  expect(ERROR_BRIEF.other, ['ValueError: expected 429 rows, got 428', 'KeyError: 502', 'ValueError: shape mismatch (503, 12)', 'stock 2503 not found'])
})

test('errorBrief: code, setting and validation errors are the generic reason, never the raw text', () => {
  expect(ERROR_BRIEF.other, [
    'KeyError: score', 'Error: boom', 'TypeError: Cannot read properties of undefined (reading "x")', 'exit 1',
    'TypeError: build() missing 1 required positional argument: \'date\'',
    "1 validation error for Plan\nscore\n  Field required [type=missing, input_value={}, input_type=dict]",
    'Missing required env var MODAL_TOKEN_ID', 'Cloud Run Job config missing. Set GCP_PROJECT_ID, GCP_REGION, and a job name.',
    'mono_data invalid', 'dismissing stale lock',
  ])
})

test('errorBrief: a name a code error quotes or calls is not an upstream code', () => {
  expect(ERROR_BRIEF.other, [
    // Real ml-controller function names with a missing word.
    "TypeError: feature_missing_masks() got an unexpected keyword argument 'meta'",
    "TypeError: artifacts_missing_pit_binding() missing 1 required keyword-only argument: 'receipt_sha256'",
    "TypeError: unavailable_review() got an unexpected keyword argument 'x'",
    "NameError: name 'missing_dates' is not defined", "AttributeError: 'NoneType' object has no attribute 'is_stale'",
    "KeyError: 'source_missing_count'",
  ])
  // A code that is the message itself stays upstream, and so do the codes a RuntimeError quotes in its list
  // (ml-service/app/prep_lineage.py).
  expect(ERROR_BRIEF.upstream, ['ValueError: daily_native_update_status_unavailable:disclosure', 'ValueError: price_missing',
    "RuntimeError: stale prep lineage blocks artifact registration: ['prep_rows_missing', 'prep_objects_missing']"])
})

test('errorBrief: a timeout reads by the name it is on, not by a rule or value elsewhere in the sentence', () => {
  expect(ERROR_BRIEF.timeout, ['Error: Worker timeout: the job must be restarted', 'Error: upstream returned invalid JSON after read timeout',
    'RuntimeError: timeout waiting for callback, should be retried', 'Error: timeout after 30 s',
    // A setting named with what happened to it.
    'Error: lease wait timeout=600s exceeded', 'Error: request aborted (timeout=30000)', 'Error: job exceeded timeout_seconds=3600',
    'Error: cloud_run_task_timeout_seconds_exceeded', 'RuntimeError: provenance_timeout_retry_already_used'])
  expect(ERROR_BRIEF.other, ['timeout must be a positive number', 'invalid timeout_ms', 'ValueError: timeout_ms=-1',
    'ValueError: timeout_headroom_ratio must be < 1'])
})

test('errorBrief: a quota is spent only when the text says so', () => {
  expect(ERROR_BRIEF.quota, [
    'google.genai.errors.ClientError: 429 RESOURCE_EXHAUSTED. You exceeded your current quota, please check your plan and billing details.',
    'Error: rate limit exceeded, quota resets at 00:00', 'Error: Usage exceed 5000 MB/day', 'RuntimeError: workers_ai_debate_daily_free_quota_exhausted',
    'Quota exceeded', 'ResourceExhausted: 429 Quota exceeded for quota metric', 'RESOURCE_EXHAUSTED: Quota limit reached'])
  expect(ERROR_BRIEF.other, ['ValueError: quota_limit must be positive', 'finlab: quota'])
})

test('errorBrief: an HTTP status in any of its spellings is 服務暫時無法使用, a count of things is not', () => {
  expect(ERROR_BRIEF.unavailable, ['HTTPError: 503 Server Error: None for url: https://x', 'Error: upstream responded statusCode: 503',
    'Error: http_status=503', 'Error: fetch failed: 502', 'urllib.error.HTTPError: HTTP Error 503: Service Unavailable',
    'AxiosError: Request failed with status code 502', 'Error: ml-service HTTP 502', 'Error: HTTP/1.1 503'])
  expect(ERROR_BRIEF.other, ['Error: expected status=429 rows'])
})

test('errorBrief: only a code error\'s own message hides its quoted and called names', () => {
  // The KeyError's message is its (…); the codes listed after it are read.
  expect(ERROR_BRIEF.upstream, ["RuntimeError: modal call failed: KeyError('x'); reasons=['daily_composition_market_dates_missing']",
    'Error: premarket_source_stale(taifex)', 'Error: l3 failed: "daily_composition_market_dates_missing:2026-11-25" (KeyError upstream)',
    "ImportError: cannot import name 'x' ; daily_native_update_status_unavailable:disclosure"])
})

test('errorBrief: a rule on a timeout setting outweighs what happened near it, and a camelCase setting is a setting', () => {
  expect(ERROR_BRIEF.other, ['Error: timeout value is invalid', 'ValueError: invalid timeout_ms for expired lease',
    'ValueError: timeout_seconds must exceed elapsed_ms', 'Error: Obsidian reporting must be timeout-bounded and non-critical for canonical post-verify closure',
    'connectTimeout must be positive', 'requestTimeout=0', 'TypeError: setTimeout is not a function', 'Error: timeout is required',
    'timeout: 0', 'ValueError: timeout=abc', 'ValueError: timeout cannot be negative', 'Error: lease expired; timeout_ms must be positive'])
  // `missing timeout` is a setting, not a missing input.
  expect(ERROR_BRIEF.other, ['Error: missing timeout'])
  // A value after a code that goes on past `timeout` belongs to the code.
  // ml-controller/services/pipeline_input_events.py raises `pipeline_input_prep_completion_timeout:` + idx: after a
  // snake code `:<value>` is its argument; only a one-name key (`timeout: 0`) takes a setting's value.
  expect(ERROR_BRIEF.timeout, ['ValueError: pipeline_input_prep_completion_timeout:3', 'ValueError: pipeline_input_prep_completion_timeout:2026-11-25'])
  expect(ERROR_BRIEF.other, ['requestTimeout: 0', 'ValueError: sweep_timeout=0'])
  expect(ERROR_BRIEF.timeout, ['RuntimeError: post_verify_checkpoint_timeout_unsettled:2026-11-25', 'Error: Timeout of 30000ms exceeded',
    'TimeoutError: source unavailable', "requests.exceptions.ReadTimeout: HTTPSConnectionPool(host='x', port=443)"])
})

test('errorBrief: the repo\'s <x>_http_<status> codes and any status after HTTP are 服務暫時無法使用', () => {
  expect(ERROR_BRIEF.unavailable, ['Error: pipeline_cloud_reconcile_http:503', 'Error: finlab_sequence_refresh_http:503',
    'Error: post_verify_delivery_HTTP503', 'Error: yahoo_http_503', 'RuntimeError: workers_ai_debate_http_429', 'RuntimeError: allocator_forecast_http_503',
    'ValueError: pipeline_snapshot_recovery_worker_calendar_http_502', 'Error: HTTP 503 records missing',
    // ml-controller's D1 HTTP errors other than d1CapacityErrors' `D1 request failed` stay the service.
    'RuntimeError: D1 raw request failed: HTTP 503: x'])
  expect(ERROR_BRIEF.other, ['Error: s12_research_service_5030', 'Error: yahoo_http_5031'])
})

test('errorBrief: a megabyte of text is classified from its head, fast', () => {
  for (const text of ['invalid timeout '.repeat(40960), 'a_'.repeat(320000) + 'B', "KeyError: " + "'a".repeat(320000)]) {
    const start = performance.now()
    errorBrief(text)
    assert.ok(performance.now() - start < 50, `${text.length} chars took ${performance.now() - start} ms`)
  }
  assert.equal(errorBrief('premarket_source_stale:taifex ' + 'x'.repeat(640000)), ERROR_BRIEF.upstream)
})
