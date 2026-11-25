/** The daily readiness chain as a Canvas panel: one band per phase, the main lane left to right with arrows,
 * side stages (watchdogs, fan-out work that does not gate the lane) on a second row. Positions come from dag.json. */
import { C, STATUS, STATUS_LABELS_JSONATA, gp, statusMappings } from './lib.mjs'

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

function node(id, stage, left, top, next) {
  const box = place(left, top, NODE_W, NODE_H)
  return [
    { type: 'rectangle', name: `n_${id}`, placement: box, constraint: scale,
      background: { color: { field: `b_${id}`, fixed: '#191b20' } }, border: { color: { field: `s_${id}`, fixed: '#444' }, radius: 6, width: stage.optional ? 1 : 2 },
      config: { align: 'center', valign: 'middle', size: 10, color: { fixed: 'transparent' }, text: { mode: 'fixed', fixed: '' } },
      connections: next ? [{ path: 'straight', targetName: `n_${next}`, source: { x: 1, y: 0 }, target: { x: -1, y: 0 },
        color: { fixed: C.line }, size: { fixed: 1.5, min: 1, max: 10 } }] : [] },
    label(`l_${id}`, stage.label, place(left, top + 0.6, NODE_W, NODE_H * 0.55), { color: C.txt }),
    { ...label(`t_${id}`, '', place(left, top + NODE_H * 0.55, NODE_W, NODE_H * 0.4)),
      config: { align: 'center', valign: 'middle', size: 10, color: { field: `s_${id}`, fixed: C.sub }, text: { mode: 'field', field: `t_${id}`, fixed: '' } } },
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
  const legend = ['completed', 'running', 'not_started', 'at_risk', 'overdue', 'stuck', 'failed', 'skipped']
  legend.forEach((status, i) => elements.push(label(`lg_${status}`, `■ ${STATUS[status][0]}`,
    place(100 - (legend.length - i) * 6.4, 0.5, 6.4, TITLE_H), { color: STATUS[status][1], align: 'left' })))
  return elements
}

/** One wide row: s_<stage> (status → border and text colour), b_<stage> (fill), t_<stage> (status and its clock time). */
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
    't_' & stage_id: $trim($lookup($label, display_status) & ' ' & $clock($))
  })
)`

export function chainCanvas(title, target, dag, x, y, w, h) {
  return { type: 'canvas', title, gridPos: gp(x, y, w, h), datasource: target.datasource, targets: [target],
    options: { inlineEditing: false, showAdvancedTypes: false, panZoom: false, infinitePan: false, tooltip: { mode: 'none' },
      root: { type: 'frame', name: 'root', placement: { left: 0, top: 0, width: 100, height: 100 }, constraint: { horizontal: 'left', vertical: 'top' },
        background: fixed('transparent'), border: fixed('transparent'), elements: chainElements(dag) } },
    fieldConfig: { defaults: { mappings: statusMappings({ fills: true }), color: { mode: 'thresholds' },
      thresholds: { mode: 'absolute', steps: [{ color: C.idle, value: null }] } }, overrides: [] } }
}
