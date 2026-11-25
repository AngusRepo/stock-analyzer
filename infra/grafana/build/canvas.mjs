/** The daily readiness chain as a Canvas panel: one band per phase, the main lane left to right with arrows,
 * side stages (watchdogs, fan-out work that does not gate the lane) on a second row. Positions come from dag.json. */
import { C, STATUS_COLOR, STATUS_LABELS_JSONATA, gp, statusMappings } from './lib.mjs'

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

const fixed = (color) => ({ color: { fixed: color } })
const place = (left, top, width, height) => ({ left, top, right: 100 - left - width, bottom: 100 - top - height })
const scale = { horizontal: 'scale', vertical: 'scale' }
const label = (name, content, placement, { size = 10, color = C.sub, align = 'center' } = {}) => ({ type: 'text', name, placement, constraint: scale,
  background: fixed('transparent'), border: { ...fixed('transparent'), width: 0 }, connections: [],
  config: { align, valign: 'middle', size, color: { fixed: color }, text: { mode: 'fixed', fixed: content } } })

function node(id, stage, left, top, next, w = NODE_W, h = NODE_H) {
  const box = place(left, top, w, h)
  return [
    { type: 'rectangle', name: `n_${id}`, placement: box, constraint: scale,
      background: { color: { field: `b_${id}`, fixed: '#191b20' } }, border: { color: { field: `s_${id}`, fixed: '#444' }, radius: 6, width: stage.optional ? 1 : 2 },
      config: { align: 'center', valign: 'middle', size: 10, color: { fixed: 'transparent' }, text: { mode: 'fixed', fixed: '' } },
      connections: next ? [{ path: 'straight', targetName: `n_${next}`, source: { x: 1, y: 0 }, target: { x: -1, y: 0 },
        color: { fixed: C.line }, size: { fixed: 1.5, min: 1, max: 10 } }] : [] },
    label(`l_${id}`, stage.label, place(left, top + h * 0.05, w, h * 0.55), { color: C.txt }),
    { ...label(`t_${id}`, '', place(left, top + h * 0.55, w, h * 0.4)),
      config: { align: 'center', valign: 'middle', size: 10, color: { field: `c_${id}`, fixed: C.sub }, text: { mode: 'field', field: `t_${id}`, fixed: '' } } },
  ]
}

export function chainElements(dag) {
  const elements = []
  const phases = new Map(dag.phases.map((phase) => [phase.id, phase]))
  BANDS.forEach(([phaseId, band, firstSlot], index) => {
    const phase = phases.get(phaseId)
    const top = band * BAND_H
    const left = (slot) => (firstSlot + slot) * SLOT_W + 0.45
    elements.push(label(`lane_${phaseId}`, `${'①②③④'[index]} ${phase.title}`, place(left(0), top + 0.5, SLOT_W * 5, TITLE_H), { size: 12, align: 'left' }))
    // Arrows stay inside a lane: the next phase is started by its own trigger, not by this lane's last stage.
    phase.main.forEach((id, slot) => elements.push(...node(id, dag.stages[id], left(slot), top + MAIN_TOP, phase.main[slot + 1])))
    if (phase.side.length) {
      phase.side.forEach((id, slot) => elements.push(...node(id, dag.stages[id], left(slot), top + SIDE_TOP, null)))
      elements.push(label(`side_${phaseId}`, '↑ 旁支（不擋主線）', place(left(phase.side.length), top + SIDE_TOP, SLOT_W * 2, NODE_H), { align: 'left' }))
    }
  })
  // One swatch per colour; the node text names the exact status.
  const legend = [['completed', '完成'], ['running', '執行中'], ['not_started', '未開始'], ['overdue', '逾時／趕不上截止'], ['failed', '失敗／卡住／漏跑']]
  const widths = [5, 6, 6, 11, 11]
  let left = 100 - widths.reduce((sum, w) => sum + w, 0)
  legend.forEach(([status, name], i) => {
    elements.push(label(`lg_${status}`, `■ ${name}`, place(left, 0.5, widths[i], TITLE_H),
      { color: STATUS_COLOR(status, status === 'completed' ? 'edge' : 'text'), align: 'left' }))
    left += widths[i]
  })
  return elements
}

/** One wide row: s_<stage> (status → border), b_<stage> (fill), c_<stage> (label colour), t_<stage> (status and its clock time). */
export const CHAIN_PIVOT = `(
  $label := ${STATUS_LABELS_JSONATA};
  $hm := function($t) { $t ? $fromMillis($toMillis($t), '[H01]:[m01]', '+0800') : '' };
  $clock := function($r) {
    $r.display_status in ['not_started', 'out_of_window', 'waiting', 'overdue', 'at_risk', 'stuck']
      ? ($r.expected_by ? '截止 ' & $hm($r.expected_by) : '')
      : $r.display_status = 'running' ? $hm($r.started_at) & ' 起' : $hm($r.completed_at ? $r.completed_at : $r.started_at)
  };
  $merge(rows[active = true and display_position != null].{
    's_' & stage_id: display_status,
    'b_' & stage_id: 'f_' & display_status,
    'c_' & stage_id: 'c_' & display_status,
    't_' & stage_id: $trim($lookup($label, display_status) & ' ' & $clock($))
  })
)`

/** Slots a one-band chain needs: each phase as wide as its longer row, half a slot between phases. */
export const laneSlots = (chain) => chain.phases.reduce((sum, phase) => sum + Math.max(phase.main.length, phase.side.length), 0) + (chain.phases.length - 1) / 2

/** A one-band chain (intraday, weekly, monthly): phases side by side, each with its lane and its side row underneath.
 * The daily chain's node proportions scaled to a single band; `slots` fixes the node width so panels of different
 * widths draw nodes of the same size. */
export function laneElements(chain, slots = laneSlots(chain)) {
  const slotW = 100 / slots
  const w = slotW * 0.93
  const h = NODE_H * 3
  const mainTop = MAIN_TOP * 3
  const sideTop = mainTop + h + 7.5
  const elements = []
  let first = 0
  for (const phase of chain.phases) {
    const left = (slot) => (first + slot) * slotW + slotW * 0.035
    elements.push(label(`lane_${phase.id}`, phase.title, place(left(0), 1, slotW * Math.max(phase.main.length, 2), TITLE_H * 3), { size: 12, align: 'left' }))
    phase.main.forEach((id, slot) => elements.push(...node(id, chain.stages[id], left(slot), mainTop, phase.main[slot + 1], w, h)))
    phase.side.forEach((id, slot) => elements.push(...node(id, chain.stages[id], left(slot), sideTop, null, w, h)))
    first += Math.max(phase.main.length, phase.side.length) + 0.5
  }
  return elements
}

export function laneCanvas(title, target, chain, x, y, w, h, slots) {
  const panel = chainCanvas(title, target, null, x, y, w, h)
  panel.options.root.elements = laneElements(chain, slots)
  return panel
}

export function chainCanvas(title, target, dag, x, y, w, h) {
  return { type: 'canvas', title, gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    options: { inlineEditing: false, showAdvancedTypes: false, panZoom: false, infinitePan: false, tooltip: { mode: 'none' },
      root: { type: 'frame', name: 'root', placement: { left: 0, top: 0, width: 100, height: 100 }, constraint: { horizontal: 'left', vertical: 'top' },
        background: fixed('transparent'), border: fixed('transparent'), elements: dag ? chainElements(dag) : [] } },
    fieldConfig: { defaults: { mappings: statusMappings('canvas'), color: { mode: 'thresholds' },
      thresholds: { mode: 'absolute', steps: [{ color: C.idle, value: null }] } }, overrides: [] } }
}
