/** The daily readiness chain as a Canvas panel: one band per phase, the main lane left to right with arrows,
 * side stages (watchdogs, fan-out work that does not gate the lane) on a second row. Positions come from dag.json.
 * A box shows its name and one short value; border = status, fill = slack to the deadline. Everything else (start,
 * finish, deadline, attempt, error) is in the box's tooltip: Canvas shows an element's name and its bound text field
 * on hover, so a transparent overlay per box carries the detail as its (invisible) text. */
import { C, COOL, READINESS_VOCAB, STATUS, STATUS_LABELS_JSONATA, TONE, gp } from './lib.mjs'

const SLOTS = 13
const SLOT_W = 100 / SLOTS
const NODE_W = SLOT_W - 0.9
const NODE_H = 11.5
/** [phase id, band, first slot]: models and premarket share the middle band. */
const BANDS = [['sources', 0, 0], ['models', 1, 0], ['premarket', 1, 7], ['evidence', 2, 0]]
const BAND_H = 100 / 3
const TITLE_H = 5
const MAIN_TOP = 6
const SIDE_TOP = MAIN_TOP + NODE_H + 2.5

/** Fill by minutes of slack to the deadline (f_none: no deadline). Not finished: 10 minutes or more is a quiet cool slate,
 * amber under 10 minutes, deeper once past the deadline. Finished in time: f_wide whatever the margin; finished late: f_late. */
const SLACK_FILL = { f_none: '#191b20', f_wide: '#1e2228', f_mid: '#1f2731', f_tight: '#47371a', f_late: '#6a4412' }
/** Canvas shows its edit placeholder for an empty text, so a blank line is a no-break space. */
const NBSP = ' '
/** State marks: the disc's fill per tone (OBS's --sv-bg-1 for a stage that has not run) and the glyph in it. */
const MARK_IDLE = '#111218'
const MARK_FILL = { ok: C.ok, run: C.run, warn: C.warn, bad: C.bad }
const MARK_GLYPH = { ok: '✓', run: '…', warn: '!', bad: '✕' }
const GLYPHS = JSON.stringify(Object.fromEntries(Object.entries(STATUS).map(([key, [, toneName]]) => [key, MARK_GLYPH[toneName] ?? NBSP])))
/** The slower-than-usual tag: a light violet, cool and apart from running blue (C.run). */
const SLOW = COOL.seq.writes
/** Parked on a planned wait (see PARKED): a neutral disc with an ellipsis, not the running blue. */
const MARK_PARKED = C.sub
/** Done, for a phase's count: the statuses drawn as done. */
const DONE = JSON.stringify(Object.entries(STATUS).filter(([, [, toneName]]) => toneName === 'ok').map(([key]) => key))
/** Data-readiness dots beside the stage that writes the dataset: [stage, readiness check id, name]. */
const DOTS = [['market-close-refresh', 'price_freshness', '價格資料'], ['update', 'chip_freshness', '籌碼資料'],
  ['indicator-queue', 'technical_indicator_freshness', '技術指標']]

/** Names that would wrap in a box, shortened; the tooltip's title keeps the full name. */
export const SHORT_LABELS = { 'active8-oof-daily': 'Active-8 daily', recommendation: 'L4 推薦', 'allocator-ev-feature-snapshot-backfill': 'EV snapshot',
  'active8-oof-weekly': 'Active-8 weekly', 'active8-oof-monthly': 'Active-8 monthly' }
const shortLabel = (id, stage) => SHORT_LABELS[id] ?? stage.label

const fixed = (color) => ({ color: { fixed: color } })
const place = (left, top, width, height) => ({ left, top, right: 100 - left - width, bottom: 100 - top - height })
const scale = { horizontal: 'scale', vertical: 'scale' }
const label = (name, content, placement, { size = 10, color = C.sub, align = 'center' } = {}) => ({ type: 'text', name, placement, constraint: scale,
  background: fixed('transparent'), border: { ...fixed('transparent'), width: 0 }, connections: [],
  config: { align, valign: 'middle', size, color: { fixed: color }, text: { mode: 'fixed', fixed: content } } })
/** Tooltip lines under a box's status: the tooltip draws its text in one wrapped row, but each element link on a
 * line of its own, so the timing lines are links (titled by the <stage>~1…4 fields, no target). */
export const TIP_LINES = 4
/** An element whose only job is its tooltip: invisible, its text read from `field`; `lines`: how many link lines under it. */
const hover = (type, name, placement, field, background = 'transparent', lines = 0) => ({ type, name, placement, constraint: scale,
  background: { color: background === 'transparent' ? { fixed: background } : { field: background, fixed: C.idle } }, border: { ...fixed('transparent'), width: 0 },
  config: { align: 'center', valign: 'middle', size: 8, color: { fixed: 'transparent' }, text: { mode: 'field', field, fixed: NBSP } }, connections: [],
  ...(lines ? { links: Array.from({ length: lines }, (_, i) => ({ title: `\${__data.fields["${field}~${i + 1}"]}`, url: '' })) } : {}) })

/** A stage box: name (fixed text, so one line), one short value (d_), border s_, fill b_; on top, the hover overlay
 * named after the stage whose text is the <stage id> field. */
function node(id, stage, left, top, next, w = NODE_W, h = NODE_H, [markW, markH] = markSize(24, 16), slow = false) {
  const box = place(left, top, w, h)
  const line = (prefix, from, height, size, color, fixedText) => ({ ...label(`${prefix}_${id}`, '', place(left, top + h * from, w, h * height)),
    config: { align: 'center', valign: 'middle', size, color, text: { mode: 'field', field: `${prefix}_${id}`, fixed: fixedText } } })
  return [
    { type: 'rectangle', name: `n_${id}`, placement: box, constraint: scale,
      background: { color: { field: `b_${id}`, fixed: SLACK_FILL.f_none } }, border: { color: { field: `s_${id}`, fixed: C.idle }, radius: 6, width: stage.optional ? 1 : 2 },
      config: { align: 'center', valign: 'middle', size: 10, color: { fixed: 'transparent' }, text: { mode: 'fixed', fixed: NBSP } },
      // The arrow out of a stage takes its status colour (OBS's connector): green once it is done, blue while it runs.
      connections: next ? [{ path: 'straight', targetName: `n_${next}`, source: { x: 1, y: 0 }, target: { x: -1, y: 0 },
        color: { field: `s_${id}`, fixed: C.line }, size: { fixed: 2, min: 1, max: 10 } }] : [] },
    { ...label(`l_${id}`, shortLabel(id, stage), place(left, top + h * 0.06, w, h * 0.46), { size: 9, color: C.txt }) },
    // OBS's state mark: a filled disc on the box's corner (done green with a tick, running blue, late amber, failed red);
    // not started and skipped are a dark disc in a grey ring.
    { type: 'ellipse', name: `k_${id}`, placement: place(left - markW / 2, top - markH / 2, markW, markH), constraint: scale,
      background: { color: { field: `k_${id}`, fixed: MARK_IDLE } }, border: { color: { field: `s_${id}`, fixed: C.idle }, width: 1 },
      config: { align: 'center', valign: 'middle', size: 11, color: { fixed: MARK_IDLE }, text: { mode: 'field', field: `g_${id}`, fixed: NBSP } }, connections: [] },
    line('d', 0.52, 0.4, 9, { field: `c_${id}`, fixed: C.sub }, NBSP),
    // Slower than usual (SLOW_PIVOT): a small cool tag at the end of the value line; amber stays for deadlines.
    ...(slow ? [{ ...label(`x_${id}`, '', place(left + w * 0.7, top + h * 0.52, w * 0.27, h * 0.4)),
      config: { align: 'right', valign: 'middle', size: 8, color: { fixed: SLOW }, text: { mode: 'field', field: `x_${id}`, fixed: NBSP } } }] : []),
    hover('rectangle', stage.label, box, id, 'transparent', slow ? TIP_LINES + 1 : TIP_LINES),
  ]
}

/** Canvas resolves every colour through the panel's value mappings: <status> → border, c_<status> → value text,
 * f_<slack bucket> → fill, m_<readiness status> → dot. */
export function canvasMappings() {
  const options = {}
  let index = 0
  for (const [key, [text, toneName]] of Object.entries(STATUS)) {
    options[key] = { text, color: TONE[toneName].edge, index: index++ }
    options[`c_${key}`] = { text: 'c', color: TONE[toneName].text, index: index++ }
  }
  for (const [key, [, toneName]] of Object.entries(STATUS)) options[`mk_${key}`] = { text: 'k', color: MARK_FILL[toneName] ?? MARK_IDLE, index: index++ }
  options.mk_parked = { text: 'k', color: MARK_PARKED, index: index++ }
  options.pc_done = { text: 'p', color: C.ok, index: index++ }
  options.pc_part = { text: 'p', color: C.sub, index: index++ }
  for (const [key, color] of Object.entries(SLACK_FILL)) options[key] = { text: 'f', color, index: index++ }
  for (const [key, [, toneName]] of Object.entries(READINESS_VOCAB)) {
    options[`m_${key}`] = { text: 'm', color: TONE[toneName].mark, index: index++ }
    options[`rc_${key}`] = { text: 'rc', color: TONE[toneName].text, index: index++ }
    options[`re_${key}`] = { text: 're', color: CARD_EDGE[toneName] ?? CARD.edge, index: index++ }
  }
  options.card = { text: 'card', color: CARD.fill, index: index++ }
  return [{ type: 'value', options }]
}

/** The OBS page's readiness card (DailyReadinessBoard.css): --card fill, a thin --border edge, the dataset name in the
 * foreground colour and the status as a coloured word with a dot. Only a card that needs action gets a coloured edge. */
const CARD = { fill: '#15161c', edge: '#292c37', name: '#e8ecf3' }
const CARD_EDGE = { warn: C.warn, bad: C.bad }

/** One card per data-readiness item, worst first (`items`: JSONata for the sorted items, each { name, status, short,
 * detail, source }); card i reads k<i> (present), re<i> (edge), m<i> (dot), n<i> (name), v<i> (status word and date),
 * rc<i> (its colour), t<i> and t<i>~1 (tooltip). Slots beyond the items stay invisible. */
export const readinessPivot = (items) => `(
  $words := ${JSON.stringify(Object.fromEntries(Object.entries(READINESS_VOCAB).map(([key, [word]]) => [key, word])))};
  $merge($map(${items}, function($v, $i) {{
    'k' & $i: 'card', 're' & $i: 're_' & $v.status, 'm' & $i: 'm_' & $v.status, 'rc' & $i: 'rc_' & $v.status,
    'n' & $i: $v.name, 'v' & $i: $lookup($words, $v.status) & '・' & $v.short,
    't' & $i: $v.name & '：' & $v.detail, 't' & $i & '~1': $v.source
  }}))
)`

export function readinessElements(slots, cols = slots, [dotW, dotH] = markSize(24, 4).map((size) => size * 8 / 18)) {
  const rows = Math.ceil(slots / cols)
  const gapX = 0.8
  const gapY = 4
  const w = (100 - gapX * (cols - 1)) / cols
  const h = (100 - gapY * (rows - 1)) / rows
  const elements = []
  for (let i = 0; i < slots; i++) {
    const left = (i % cols) * (w + gapX)
    const top = Math.floor(i / cols) * (h + gapY)
    // Insets are fractions of the card, so a card keeps its proportions in a row of 14 or a 7 × 2 grid.
    const text = (name, field, at, height, size, color, inset = 0.06) => ({ ...label(name, '', place(left + w * inset, top + h * at, w * (0.96 - inset), h * height)),
      config: { align: 'left', valign: 'middle', size, color, text: { mode: 'field', field, fixed: NBSP } } })
    elements.push(
      { type: 'rectangle', name: `card${i}`, placement: place(left, top, w, h), constraint: scale,
        background: { color: { field: `k${i}`, fixed: 'transparent' } }, border: { color: { field: `re${i}`, fixed: 'transparent' }, radius: 6, width: 2 },
        config: { align: 'center', valign: 'middle', size: 10, color: { fixed: 'transparent' }, text: { mode: 'fixed', fixed: NBSP } }, connections: [] },
      text(`name${i}`, `n${i}`, 0.08, 0.5, 10, { fixed: CARD.name }),
      { type: 'ellipse', name: `dot${i}`, placement: place(left + w * 0.06, top + h * 0.745 - dotH / 2, dotW, dotH), constraint: scale,
        background: { color: { field: `m${i}`, fixed: 'transparent' } }, border: { ...fixed('transparent'), width: 0 },
        config: { align: 'center', valign: 'middle', size: 8, color: { fixed: 'transparent' }, text: { mode: 'fixed', fixed: NBSP } }, connections: [] },
      text(`value${i}`, `v${i}`, 0.58, 0.32, 10, { field: `rc${i}`, fixed: C.sub }, 0.17),
      { type: 'rectangle', name: '資料就緒', placement: place(left, top, w, h), constraint: scale,
        background: fixed('transparent'), border: { ...fixed('transparent'), width: 0 },
        config: { align: 'center', valign: 'middle', size: 8, color: { fixed: 'transparent' }, text: { mode: 'field', field: `t${i}`, fixed: NBSP } }, connections: [],
        links: [{ title: `\${__data.fields["t${i}~1"]}`, url: '' }] })
  }
  return elements
}

export function readinessCanvas(title, target, slots, x, y, w, h, o = {}) {
  const panel = chainCanvas(title, [target], null, x, y, w, h, o)
  panel.options.root.elements = readinessElements(slots, o.cols, markSize(w, h).map((size) => size * 8 / 18))
  return panel
}

const CHAIN_PX = 1570
/** The state mark's size in percent of a panel `gridW` × `gridH` grid units (a unit is about 1,570 / 24 px wide and
 * 38 px high, less the 50 px title), so it draws as a round 18px disc on every chain (OBS's is 21px). */
const markSize = (gridW, gridH) => [18 / (gridW / 24 * CHAIN_PX) * 100, 18 / (gridH * 38 - 50) * 100]
/** A label's width in percent of the daily chain panel (full width, about 1,570 px on a 1,600 px screen): CJK and
 * circled digits are about a font size wide, other characters about 0.55 of it. */
const textWidth = (text, size) => [...text].reduce((sum, ch) => sum + (/[\u2460-\u24ff\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.55), 0) / CHAIN_PX * 100

export function chainElements(dag) {
  const elements = []
  const boxes = new Map()
  const phases = new Map(dag.phases.map((phase) => [phase.id, phase]))
  const add = (id, left, top, next) => { boxes.set(id, { left, top }); elements.push(...node(id, dag.stages[id], left, top, next, NODE_W, NODE_H, markSize(24, 16), true)) }
  BANDS.forEach(([phaseId, band, firstSlot], index) => {
    const phase = phases.get(phaseId)
    const top = band * BAND_H
    const left = (slot) => (firstSlot + slot) * SLOT_W + 0.45
    const title = `${'①②③④'[index]} ${phase.title}`
    elements.push(label(title, title, place(left(0), top + 0.5, SLOT_W * 5, TITLE_H), { size: 12, align: 'left' }))
    // OBS's phase header: the title, then its count in the foreground (required stages done / all, green once all are).
    const count = left(0) + textWidth(title, 12) + 0.5
    elements.push({ ...label(`${phase.title} 進度`, '', place(count, top + 0.5, SLOT_W, TITLE_H), { size: 12, align: 'left' }),
      config: { align: 'left', valign: 'middle', size: 12, color: { field: `pc_${phaseId}`, fixed: C.sub }, text: { mode: 'field', field: `p_${phaseId}`, fixed: NBSP } } })
    // Arrows stay inside a lane: the next phase is started by its own trigger, not by this lane's last stage.
    phase.main.forEach((id, slot) => add(id, left(slot), top + MAIN_TOP, phase.main[slot + 1]))
    phase.side.forEach((id, slot) => add(id, left(slot), top + SIDE_TOP, null))
    if (phase.side.length) elements.push(label(`旁支 ${phase.title}`, '↑ 旁支（不擋主線）', place(left(phase.side.length), top + SIDE_TOP, SLOT_W * 2, NODE_H), { align: 'left' }))
  })
  // A dot in the writer's top-right corner, after the overlays so it gets its own tooltip.
  for (const [stage, check, name] of DOTS) {
    const box = boxes.get(stage)
    if (!box) throw new Error(`readiness dot: ${stage} is not on the chain`)
    elements.push(hover('ellipse', `${name}就緒`, place(box.left + NODE_W - 1.1, box.top + 1.2, 0.7, 2.2), check, `r_${check}`))
  }
  // One swatch per border colour; the tooltip names the exact status.
  const legend = [['completed', '完成'], ['running', '執行中'], ['not_started', '未開始／等待'], ['at_risk', '趕不上／逾時'], ['failed', '失敗'],
    [null, '琥珀底＝快趕不上或逾時'], [null, '+m＝比平常慢'], [null, '● 資料就緒']]
  const widths = [4.5, 5, 7.5, 7.5, 4.5, 11, 7, 7]
  let left = 100 - widths.reduce((sum, w) => sum + w, 0)
  legend.forEach(([status, name], i) => {
    elements.push(label(name, status ? `■ ${name}` : name, place(left, 0.5, widths[i], TITLE_H),
      { color: status ? TONE[STATUS[status][1]].edge : C.sub, align: 'left' }))
    left += widths[i]
  })
  return elements
}

/** Watchers: run the whole session (intraday-check, every minute 09:00–13:30), so a deadline and a slack mean nothing;
 * the box shows the status only. The Worker's expected_by for it is the first result (opsChainStageCatalog, 09:10).
 * The row's own `watcher` wins; this list is for Workers that do not send it. */
export const WATCHERS = `['intraday-check']`
/** Statuses whose elapsed time still grows. */
const LIVE = `['running', 'stuck', 'overdue', 'at_risk']`
/** Statuses a box names instead of a time: the colour alone would not say which. */
const NAMED = `['failed', 'error', 'blocked', 'watcher_blocked', 'stuck', 'missed', 'overdue', 'at_risk', 'waiting', 'skipped']`
/** The alert kinds of chain.ts displayStatus: a stage showing one of them is never drawn as parked. */
const ALERTED = `['failed', 'overdue', 'stuck', 'blocked', 'watcher_blocked']`

/** A stage parked on a planned wait: the Worker logs it as scheduler status `waiting`, which the chain state folds into
 * `running` (opsChainStageState chainStageStatusFromRun), so only its summary still says so. The Worker writes these
 * summaries: post-pipeline-chain "… wait for the after-close dispatch at YYYY-MM-DD HH:MM run_id=…" (and the evening
 * root's "research waits for …"), and update "status=waiting awaiting_late_lane …" while FinLab's late lane is out
 * (adminControlRoutes.ts). Its time is not run time: no elapsed, no slack fill, no slow tag.
 * A Worker that sends `waiting` / `wait_until` (judgment/stageWait) decides it; this regex is the fallback for one that does not,
 * and there too a wait whose dispatch time has passed is no longer parked, so stuck / overdue show. */
export const PARKED = `/waits? for the after-close dispatch|status=waiting|awaiting_late_lane/i`

/** One wide row per chain: s_<stage> (status → border), b_<stage> (slack bucket → fill), c_<stage> (status → value
 * colour), d_<stage> (the one short value: duration when done, elapsed while running, slack before it
 * starts, the status word when it needs a word), <stage> (the tooltip's status line, with the error) and <stage>~1…4 (its 開始／完成／截止／餘裕 lines). Slack = deadline − finish when done,
 * the Worker's ETA margin when it has one, deadline − now otherwise; a sub-stage without a deadline uses its parent's.
 * Times are measured to the response's generated_at, so a cached answer stays consistent. */
export const CHAIN_PIVOT = `(
  $label := ${STATUS_LABELS_JSONATA};
  $now := $toMillis($$.generated_at);
  $rows := $$.rows[active = true];
  $hm := function($t) { $t ? $fromMillis($toMillis($t), '[H01]:[m01]', '+0800') : '' };
  $dur := function($m) {( $a := $floor($abs($m)); $a >= 60 ? $string($floor($a / 60)) & 'h' & ($a % 60 > 0 ? $string($a % 60) & 'm' : '') : $string($a) & 'm' )};
  $name := function($s) {( $l := $lookup($label, $s); $l ? $l : $s )};
  $parent := function($r) { $r.parent_stage_id ? $rows[stage_id = $r.parent_stage_id][0] : null };
  $watch := function($r) { $type($r.watcher) = 'boolean' ? $r.watcher : $r.stage_id in ${WATCHERS} };
  /* The status a box is drawn with: a watcher's blocked is the amber 被擋住 (Wei 11/26), a chain stage's stays 中止. */
  $ds := function($r) { $r.display_status = 'blocked' and $watch($r) ? 'watcher_blocked' : $r.display_status };
  $due := function($r) { $watch($r) ? null : $r.expected_by ? $r.expected_by : $parent($r).expected_by };
  $slack := function($r) {(
    $d := $due($r);
    $m := $r.eta_margin_min != null ? $r.eta_margin_min : $parent($r).eta_margin_min;
    $ds($r) = 'at_risk' ? -1
      : $r.completed_at ? ($d ? ($toMillis($d) - $toMillis($r.completed_at)) / 60000 : null)
      : $watch($r) ? null
      : $m != null ? $m
      : $d ? ($toMillis($d) - $now) / 60000 : null
  )};
  $bucket := function($s) { $s != null ? ($s < 0 ? 'f_late' : $s < 10 ? 'f_tight' : $s < 30 ? 'f_mid' : 'f_wide') : 'f_none' };
  /* Amber means "will miss it or already has": a stage that finished in time takes the plain fill whatever its margin
     (the margin is in the tooltip); one that finished late keeps the late fill. Not finished: the slack bucket. */
  $fill := function($r) {( $s := $slack($r); $r.completed_at ? ($s = null ? 'f_none' : $s < 0 ? 'f_late' : 'f_wide') : $bucket($s) )};
  $short := function($r) {(
    $s := $ds($r);
    $s in ${NAMED} ? $name($s)
      : $r.started_at and $not($r.completed_at) ? ($s in ${LIVE} ? '已 ' & $dur(($now - $toMillis($r.started_at)) / 60000) : '${NBSP}')
      : $r.started_at and $r.completed_at ? $dur(($toMillis($r.completed_at) - $toMillis($r.started_at)) / 60000)
      : $r.completed_at ? '${NBSP}'
      : ($sl := $slack($r); $sl != null ? '餘 ' & $dur($sl) : '${NBSP}')
  )};
  $tip := function($r) {
    $name($ds($r)) & ($r.attempt > 1 ? '・第 ' & $string($r.attempt) & ' 次' : '') & ($r.error ? '：' & $r.error : '')
  };
  $lines := function($r) {(
    $d := $due($r); $sl := $slack($r);
    [
      '開始 ' & ($r.started_at ? $hm($r.started_at) : '—'),
      $r.completed_at ? '完成 ' & $hm($r.completed_at) : $r.eta ? '預估完成 ' & $hm($r.eta) : '完成 —',
      '截止 ' & ($d ? $hm($d) : '—'),
      $sl != null ? ($sl < 0 ? '超過 ' : '餘裕 ') & $dur($sl) : '餘裕 —'
    ]
  )};
  /* The dispatch a fallback wait names: status=waiting wait_until=<ISO>, or the after-close dispatch in Taiwan time, read
     as a Z stamp less 8 h (Infinity reads an offset stamp as its date's UTC midnight, see DAY_TIME in build.mjs). No
     dispatch time: undefined, never a null literal. */
  $untilMs := function($r) {(
    $iso := $match($r.summary, /^status=waiting wait_until=(\\S+)/);
    $tw := $match($r.summary, /dispatch at (\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2})/);
    $iso ? $toMillis($iso[0].groups[0]) : $tw ? $toMillis($tw[0].groups[0] & 'T' & $tw[0].groups[1] & ':00.000Z') - ${8 * 3600_000}
  )};
  /* Infinity's Go JSONata evaluates both sides of and / or, so every guard here is a conditional: nothing that needs the
     guard (a comparison with a missing time, a match on a missing summary) is reached without it, and a missing field is
     tested by truth ($not(undefined) and undefined != 'x' are not true). A row that raises
     an alert or is at risk is never parked, as on the KPI strip. */
  $parked := function($r) {(
    $s := $ds($r);
    $r.status != 'running' ? false
      : $s in ${ALERTED} ? false
      : $s = 'at_risk' ? false
      : $type($r.waiting) = 'boolean' ? $r.waiting
      : $r.summary ? ($contains($r.summary, ${PARKED}) ? ($u := $untilMs($r); $type($u) = 'number' ? $u > $now : true) : false)
      : false
  )};
  $until := function($r) {(
    $u := $r.wait_until ? $toMillis($r.wait_until) : $untilMs($r);
    $u ? '等 ' & $fromMillis($u, '[H01]:[m01]', '+0800') : '等待中'
  )};
  $shown := $rows[display_position != null];
  /* Per phase: required stages done / required stages (p_<phase>), green once all are (pc_<phase>). */
  $phaseCount := function($p) {(
    $req := $shown[phase = $p and optional != true];
    $done := $count($req[$ds($) in ${DONE}]);
    { 'p_' & $p: $string($done) & '/' & $string($count($req)), 'pc_' & $p: $done = $count($req) ? 'pc_done' : 'pc_part' }
  )};
  /* one: the key the daily chain joins its three queries on (state, readiness dots, slow tags). */
  $merge($append($append({ 'one': 1 }, $distinct($shown[phase].phase).$phaseCount($)), $shown.($p := $parked($); {
    's_' & stage_id: $p ? 'waiting' : $ds($),
    'k_' & stage_id: $p ? 'mk_parked' : 'mk_' & $ds($),
    'g_' & stage_id: $p ? '…' : $lookup(${GLYPHS}, $ds($)),
    'b_' & stage_id: $p ? 'f_none' : $fill($),
    'c_' & stage_id: $p ? 'c_waiting' : 'c_' & $ds($),
    'd_' & stage_id: $p ? $until($) : $short($),
    stage_id: $p ? '排定的等待（不算耗時）：' & ($r := $; $r.summary ? $r.summary : $until($r)) : $tip($),
    ${Array.from({ length: TIP_LINES }, (_, i) => `stage_id & '~${i + 1}': $lines($)[${i}]`).join(',\n    ')}
  })))
)`

/** Slower than usual, per daily stage (third query, /v1/chain/timeline): x_<stage> = '+12m' when tonight's run time is
 * over 1.5 × its median over the other business days of the timeline and more than 5 minutes over it, and
 * <stage>~5 = '平常 12m' (the tooltip's fifth line). Run time = first running → last success of the day (still running
 * tonight: to generated_at); a day the stage spent parked (PARKED) has no run time. Under two business days in the
 * timeline there is no usual, so no tag. `ids`: every stage the chain draws, so each box finds its fields. */
export const slowPivot = (ids) => `(
  $now := $toMillis($$.generated_at);
  $all := $$.rows[transition_at and business_date];
  $dates := $sort($distinct($all.business_date));
  $today := $dates[-1];
  $enough := $count($dates) >= 2;
  $dur := function($m) {( $a := $floor($abs($m)); $a >= 60 ? $string($floor($a / 60)) & 'h' & ($a % 60 > 0 ? $string($a % 60) & 'm' : '') : $string($a) & 'm' )};
  $run := function($s, $d, $open) {(
    $t := $all[stage_id = $s and business_date = $d];
    $held := $count($t[summary and $contains(summary, ${PARKED})]) > 0;
    $a := $min($t[to_status = 'running'].$toMillis(transition_at));
    $b := $max($t[to_status = 'success'].$toMillis(transition_at));
    $not($held) and $a ? ($b and $b > $a ? ($b - $a) / 60000 : $open ? ($now - $a) / 60000)
  )};
  $merge($append({ 'one': 1 }, ${JSON.stringify(ids)}.($s := $;
    $u := $enough ? $sort($dates[$ != $today].($run($s, $, false)));
    $n := $count($u);
    $med := $n ? ($n % 2 = 1 ? $u[$floor($n / 2)] : ($u[$n / 2 - 1] + $u[$n / 2]) / 2);
    $tn := $n ? $run($s, $today, true);
    { 'x_' & $s: $tn and $tn > $med * 1.5 and $tn - $med > 5 ? '+' & $dur($tn - $med) : '${NBSP}',
      $s & '~5': $n ? '平常 ' & $dur($med) : '平常 —' })))
)`

const READINESS_WORDS = JSON.stringify(Object.fromEntries(Object.entries(READINESS_VOCAB).map(([key, [word]]) => [key, word])))
/** The readiness dots (second query, /v1/data-readiness): r_<check> (status → dot colour) and <check> (the tooltip). */
export const DOTS_PIVOT = `$merge($append({ 'one': 1 }, checks[id in ${JSON.stringify(DOTS.map(([, check]) => check))}].{
  'r_' & id: 'm_' & status,
  id: $join([$lookup(${READINESS_WORDS}, status), latest_date ? '最新 ' & latest_date, lag_days != null ? '落後 ' & $string(lag_days) & ' 天',
    rows_on_latest != null ? $string(rows_on_latest) & ' 列'], '｜')
}))`

/** Slots a one-band chain needs: each phase as wide as its longer row, half a slot between phases. */
export const laneSlots = (chain) => chain.phases.reduce((sum, phase) => sum + Math.max(phase.main.length, phase.side.length), 0) + (chain.phases.length - 1) / 2

/** A one-band chain (intraday, weekly, monthly): phases side by side, each with its lane and its side row underneath.
 * The daily chain's node proportions scaled to a single band; `slots` fixes the node width so panels of different
 * widths draw nodes of the same size. */
export function laneElements(chain, slots = laneSlots(chain), mark = markSize(24, 16)) {
  const slotW = 100 / slots
  const w = slotW * 0.93
  const h = NODE_H * 3
  const mainTop = chain.phases.length > 1 ? MAIN_TOP * 3 : MAIN_TOP
  const sideTop = mainTop + h + 7.5
  const elements = []
  let first = 0
  for (const phase of chain.phases) {
    const left = (slot) => (first + slot) * slotW + slotW * 0.035
    // A one-phase chain's phase title is the panel title.
    if (chain.phases.length > 1) elements.push(label(phase.title, phase.title, place(left(0), 1, slotW * Math.max(phase.main.length, 2), TITLE_H * 3), { size: 12, align: 'left' }))
    phase.main.forEach((id, slot) => elements.push(...node(id, chain.stages[id], left(slot), mainTop, phase.main[slot + 1], w, h, mark)))
    phase.side.forEach((id, slot) => elements.push(...node(id, chain.stages[id], left(slot), sideTop, null, w, h, mark)))
    first += Math.max(phase.main.length, phase.side.length) + 0.5
  }
  return elements
}

export function laneCanvas(title, target, chain, x, y, w, h, slots) {
  const panel = chainCanvas(title, [target], null, x, y, w, h)
  panel.options.root.elements = laneElements(chain, slots, markSize(w, h))
  return panel
}

/** Hovering a box (or a dot) shows its tooltip: the element's name over its text field (see the header comment). */
export function chainCanvas(title, targets, dag, x, y, w, h, o = {}) {
  return { type: 'canvas', title, description: o.desc ?? '', gridPos: gp(x, y, w, h), datasource: targets[0].datasource, targets,
    options: { inlineEditing: false, showAdvancedTypes: false, panZoom: false, infinitePan: false, tooltip: { mode: 'single', disableForOneClick: false },
      root: { type: 'frame', name: 'root', placement: { left: 0, top: 0, width: 100, height: 100 }, constraint: { horizontal: 'left', vertical: 'top' },
        background: fixed('transparent'), border: fixed('transparent'), elements: dag ? chainElements(dag) : [] } },
    fieldConfig: { defaults: { mappings: canvasMappings(), color: { mode: 'thresholds' },
      thresholds: { mode: 'absolute', steps: [{ color: C.idle, value: null }] } }, overrides: [] } }
}
