// A chain stage's error as a short zh-TW reason for the Grafana tooltips and lists. The panels never show the raw error
// (a Python traceback or a stack of codes overflows the Canvas box and names internals); its detail stays in the logs.
import { D1_CONNECTION_LOST, D1_OVERLOAD_CODES, isD1CapacityError } from '../lib/d1CapacityErrors'

export const ERROR_BRIEF = {
  overloaded: '資料庫過載',
  timeout: '執行逾時',
  upstream: '上游資料未就緒',
  quota: '外部服務額度用盡',
  unavailable: '服務暫時無法使用',
  other: '執行錯誤，細節見 log',
} as const
export type ErrorBrief = (typeof ERROR_BRIEF)[keyof typeof ERROR_BRIEF]

/** Only the head is classified: `<head> | trace: <frames>` frames are function and file names (nav_worker_timeout,
 * _deadline_daily), not what happened (tools/finlab_capture_guard.py: a frame adds no marker the head lacks). */
const head = (error: string) => error.split(' | trace: ')[0]
const OVERLOAD_CODE = new RegExp(`\\b(?:${D1_OVERLOAD_CODES.join('|')})\\b`, 'i')
const CONNECTION_LOST = new RegExp(D1_CONNECTION_LOST, 'i')

/** The words of each run of words and codes: `no data_for 2026-11-26` is no, data, for, 2026-11-26. */
const phraseWords = (text: string) => [...text.matchAll(/[A-Za-z0-9]+(?:[_:\s-]+[A-Za-z0-9]+)*/g)].map((m) => m[0].toLowerCase().split(/[_:\s]+/))
const hasRun = (words: string[], run: string[]) => words.some((_, i) => run.every((word, j) => words[i + j] === word))

const sentences = (text: string) => text.split(/[.;。；\n]+(?:\s|$)/)

/** Python's, requests' and gRPC's timeout names (an exception type: `ReadTimeout: …`), and the words for one: these are
 * never a setting. A camelCase name that is no exception type (`connectTimeout must be positive`, `setTimeout is not a
 * function`) is read by its words below. */
const TIMEOUT_NAME = [/TimeoutError|\b[A-Z][A-Za-z]*Timeout(?=:|$)|DeadlineExceeded/, /\btimed out\b|\btime[ -]out\b|\bexceeded (?:its |the )?deadline\b|逾時|超時/i]
/** A timeout setting is not a timeout. What marks it sits on the name itself, never elsewhere in the sentence (`Worker
 * timeout: the job must be restarted`, `invalid JSON after read timeout` are timeouts).
 * A rule on it: right after (`timeout must be positive`, `timeout_seconds must exceed elapsed_ms`, `timeout value is
 * invalid`, `timeout is required`, `timeout cannot be negative`, `setTimeout is not a function`) or right before
 * (`invalid timeout_ms`, `missing timeout`, `must be timeout-bounded`). Nothing that happened outweighs it. */
const RULE_AFTER = /^\s*:?\s*(?:must|should|cannot|can ?not|can't)\b|^\s*(?:value\s+)?(?:is|are)\s+(?:invalid|not|required|missing)\b|^\s*(?:value\s+)?(?:invalid|required)\b/i
const RULE_BEFORE = /\b(?:invalid|missing|(?:must|should) be)(?:\s+(?:value|setting))?(?:\s+(?:for|of))?\s*$/i
/** A unit (`timeout_ms`, `_timeout_seconds`) or a value (`sweep_timeout=0`, `timeout=abc`, `timeout: 0`): a setting
 * unless what happened to it is named next to it. `: <value>` sets only a key that is one name (`timeout: 0`,
 * `requestTimeout: 0`); after a snake code it is the code's argument (ml-controller pipeline_input_events.py
 * `pipeline_input_prep_completion_timeout:3` is a timeout). */
const UNIT = new Set(['ms', 's', 'sec', 'secs', 'second', 'seconds', 'min', 'mins', 'minute', 'minutes', 'hours'])
const ASSIGNED = /^\s*[=<>]/
const KEY_VALUE = /^\s*:\s*-?\d/
/** What happened, in the timeout's own code or within two words of it: `lease wait timeout=600s exceeded`, `request
 * aborted (timeout=30000)`, `job exceeded timeout_seconds=3600`, `cloud_run_task_timeout_seconds_exceeded`. */
const HAPPENED = new Set(['exceeded', 'aborted', 'expired', 'elapsed'])
/** A word or a snake / kebab / camelCase code, its words split at `_`, `-` and a lower-to-upper case change:
 * `root_closure_deadline_exceeded` is root, closure, deadline, exceeded; `connectTimeout` is connect, timeout. A `\b`
 * after `_timeout` fails when the code goes on (`_timeout_unsettled`), so codes are read by word. */
const NAME = /[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*/g
const nameWords = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_-]/)
function isTimeout(text: string): boolean {
  if (TIMEOUT_NAME.some((pattern) => pattern.test(text))) return true
  return sentences(text).some((sentence) => {
    const names = [...sentence.matchAll(NAME)].map((m) => ({ words: nameWords(m[0]), start: m.index!, end: m.index! + m[0].length }))
    if (hasRun(names.flatMap(({ words }) => words), ['deadline', 'exceeded'])) return true
    return names.some(({ words, start, end }, i) => {
      const at = words.indexOf('timeout')
      if (at < 0) return false
      const after = sentence.slice(end, end + 40)
      if (words.includes('invalid') || RULE_AFTER.test(after) || RULE_BEFORE.test(sentence.slice(Math.max(0, start - 40), start))) return false
      if (names.slice(Math.max(0, i - 2), i + 3).some((name) => name.words.some((word) => HAPPENED.has(word)))) return true
      // A value belongs to the code it follows: `sweep_timeout=0` sets a timeout, `…_timeout_unsettled:2026-11-25` does not.
      const setting = at === words.length - 1 && (ASSIGNED.test(after) || (!sentence.slice(start, end).includes('_') && KEY_VALUE.test(after)))
      return !UNIT.has(words[at + 1] ?? '') && !setting
    })
  })
}

/** A lower-case snake_case code with an `unavailable`, `missing` or `stale` word (the pipeline, FinLab, premarket and
 * screener source guards write these: `daily_composition_market_dates_missing:2026-11-25`, `premarket_source_stale:taifex`). */
const SNAKE_CODE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g
const UPSTREAM_WORD = new Set(['unavailable', 'missing', 'stale'])
const isUpstreamCode = (text: string) => [...text.matchAll(SNAKE_CODE)].some((m) => m[0].split('_').some((word) => UPSTREAM_WORD.has(word)))

/** A Python code error's own message names the code it failed in, not what happened: in it a called function
 * (`TypeError: feature_missing_masks() got an unexpected keyword argument`) and a quoted name (`KeyError:
 * 'source_missing_count'`, `NameError: name 'missing_dates' is not defined`, `no attribute 'is_stale'`) are read as no
 * code. Its message is `Type: …` up to a `;`, a line end or the next exception type, or the `(…)` of `Type(…)`; the
 * text around it is read as it is (`modal call failed: KeyError('x'); reasons=['daily_composition_market_dates_missing']`,
 * `premarket_source_stale(taifex)`). A ValueError or RuntimeError's own quotes are read: it quotes the codes it was raised
 * for (ml-service prep_lineage.py: `blocks artifact registration: ['prep_rows_missing']`), and the repo raises no code
 * as a KeyError, TypeError, AttributeError or NameError. */
const CODE_ERROR = /\b(?:TypeError|NameError|AttributeError|KeyError|IndexError|LookupError|UnboundLocalError|ImportError|ModuleNotFoundError)(?::|(?=\())/g
const MESSAGE_END = /[;\n]|\b[A-Z]\w*(?:Error|Exception)\b/g
const CALLED = /\b[a-z0-9]+(?:_[a-z0-9]+)+(?=\()/g
const QUOTED = /'[^'\n]*'|"[^"\n]*"/g
function messageEnd(text: string, start: number): number {
  if (text[start] === '(') {
    let depth = 0
    for (let i = start; i < text.length; i++) if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) return i + 1
    return text.length
  }
  MESSAGE_END.lastIndex = start
  return MESSAGE_END.exec(text)?.index ?? text.length
}
function withoutCodeNames(text: string): string {
  let out = ''; let from = 0
  for (const m of text.matchAll(CODE_ERROR)) {
    const start = m.index! + m[0].length
    if (start < from) continue
    const end = messageEnd(text, start)
    out += text.slice(from, start) + text.slice(start, end).replace(CALLED, 'f').replace(QUOTED, "''")
    from = end
  }
  return out + text.slice(from)
}

/** An external quota spent for the day: FinLab's `Usage exceed 5000 MB/day, join the VIP program` (its markers in
 * finlabSourceContract.ts FINLAB_QUOTA and tools/finlab_v4_remote_backfill.py; FinLab may send it with HTTP 429), Workers
 * AI's `workers_ai_debate_daily_free_quota_exhausted`, Gemini's `429 RESOURCE_EXHAUSTED. You exceeded your current
 * quota`. Not 服務暫時無法使用: a retry today is refused again (the chain stops refetching, quota_blocked), and not
 * 上游資料未就緒: the data is out, we may not read more of it. A bare "quota" is not enough (`would ... burn FinLab quota`
 * is a setting check, `quota_limit must be positive` a setting). */
const QUOTA = new RegExp(['Usage exceed', 'VIP program', '5000\\s*MB\\/day', 'quota[ _](?:exhausted|exceeded|blocked)',
  'quota[ _]limit[ _](?:reached|exceeded|hit)', 'exceeded (?:the |your )?(?:current |daily )?quota', 'quota (?:resets?|will reset)\\b'].join('|'), 'i')

/** A service that is down or refusing for now (HTTP 502 / 503 / 429, gRPC UNAVAILABLE, a dropped connection): retrying
 * later is the remedy, unlike a code error, and it is no input of ours that is missing. A bare 429 or 503 is a number
 * (`expected 429 rows`, `KeyError: 502`, `shape (503, 12)`): only an HTTP status or its words count. After `HTTP` it
 * always is (`HTTP 503`, `HTTP/1.1 503`, `HTTP 503 records missing`), and so in the repo's codes (`yahoo_http_503`,
 * `pipeline_cloud_reconcile_http:503`, `post_verify_delivery_HTTP503`, `workers_ai_debate_http_429`). After a status word
 * (`statusCode: 503`, `http_status=503`, `fetch failed: 502`, requests' `503 Server Error`) it is unless a count of
 * things follows (`expected status=429 rows`). */
const CODE = '(?:429|50[23])(?![0-9])'
const STATUS = `${CODE}(?!\\s+(?:rows?|records?|items?|entries|stocks?|symbols?|columns?|lines?)\\b)`
const SERVICE_DOWN = [new RegExp(`(?:\\b|_)HTTP(?:\\/[\\d.]+| Error)?[\\s:=_]*${CODE}`, 'i'),
  new RegExp(`\\b(?:(?:http_)?status(?:[ _]?code)?|fetch failed)\\s*[:=]?\\s*${STATUS}`, 'i'),
  new RegExp(`\\b${STATUS} (?:Server|Client) Error\\b`, 'i'),
  /service unavailable|temporarily unavailable|bad gateway|too many requests/i, /StatusCode\.UNAVAILABLE|\bUNAVAILABLE\b/]

/** Inputs that are not there yet, in words. A missing argument, field, env var or key, or anything said about a config,
 * schema or request, is a code or setting error, not this (`price missing from config schema`, `rows missing primary key
 * in upsert batch`, `date missing in request body`). */
const DATA = '(?:sources?|data|dates?|rows?|prices?|inputs?|snapshots?|artifacts?|feeds?)'
const UPSTREAM_TEXT = new RegExp(`not[ _-]ready|\\b${DATA} (?:unavailable|missing|stale)\\b|\\bmissing ${DATA}\\b|缺資料|缺少|未就緒|尚未寫入`, 'i')
const CODE_WORDS = /\b(?:config(?:uration)?|schema|request|body|primary key|keys?|arguments?|params?|parameters?|fields?|env|payload)\b/i
const isUpstreamText = (text: string) => sentences(text).some((sentence) => !CODE_WORDS.test(sentence)
  && (UPSTREAM_TEXT.test(sentence) || phraseWords(sentence).some((words) => hasRun(words, ['no', 'data']))))

/** Checked in this order: an overload is often reported as a timeout too, a timeout may name a missing input, and a
 * missing input may carry the HTTP status it was read with (`kv_config_manifest_unavailable:503`). A dropped D1
 * connection is retried like an overload (d1CapacityErrors) but shows no overload, so it reads as the service. The rest
 * is read without the code names a code error quotes, from its first CLASSIFIED_CHARS characters only (what happened
 * is said first; the word-by-word reads stay fast on a megabyte of text). */
const CLASSIFIED_CHARS = 2000
export function errorBrief(error: string | null | undefined): ErrorBrief | null {
  if (!error || !error.trim()) return null
  const raw = head(error)
  if (isD1CapacityError(raw.split(CONNECTION_LOST).join(' ')) || OVERLOAD_CODE.test(raw)) return ERROR_BRIEF.overloaded
  const text = withoutCodeNames(raw.slice(0, CLASSIFIED_CHARS))
  if (QUOTA.test(text)) return ERROR_BRIEF.quota
  if (isTimeout(text)) return ERROR_BRIEF.timeout
  if (isUpstreamCode(text)) return ERROR_BRIEF.upstream
  if (CONNECTION_LOST.test(text) || SERVICE_DOWN.some((pattern) => pattern.test(text))) return ERROR_BRIEF.unavailable
  if (isUpstreamText(text)) return ERROR_BRIEF.upstream
  return ERROR_BRIEF.other
}
