import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(process.cwd(), 'src')
const card = fs.readFileSync(path.join(root, 'components/RecommendationCardClean.tsx'), 'utf8')
const between = (start: string, end: string) => {
  const from = card.indexOf(start)
  const to = card.indexOf(end, from + start.length)
  assert(from >= 0 && to > from, `anchors must exist: ${start}`)
  return card.slice(from, to)
}

test('the recognised alpha model list is the legacy eight plus TimeXer, so the fallback keeps TimeXer predictions', () => {
  const list = between('const DIRECT_ALPHA_VOTE_MODEL_NAMES = [', '] as const')
  for (const model of ['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'TimeXer', 'PatchTST', 'iTransformer']) {
    assert(list.includes(`'${model}'`), `missing ${model}`)
  }
  assert(card.includes("timexer: 'TimeXer'"), 'TimeXer aliases normalise to the recognised name')
})

test('model totals come from the API roster; without one the card shows 未提供, never a hard-coded 8', () => {
  assert(card.includes("const ROSTER_NOT_PROVIDED = '未提供'"))
  const roster = between('function forecastModelRoster(', '\n}\n')
  assert(roster.includes('ensemble_v2?.model_order') && roster.includes('active_model_contract'))
  assert(!/\?\?\s*8\b|\|\|\s*8\b/.test(card), 'no ?? 8 / || 8 fallback')
  assert(!card.includes("['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer']"),
    'no literal eight-model fallback list')
  assert(!card.includes('DIRECT_ALPHA_VOTE_MODEL_NAMES.length,') && !card.includes(': DIRECT_ALPHA_VOTE_MODEL_NAMES.length}'),
    'the recognised-name list is not used as a denominator')
  const vote = between('function mlVoteSummaryFromRec(', 'function mlDiagnosticsFromRec(')
  assert(vote.includes('const roster = forecastModelRoster(forecast)') && vote.includes('const inRoster = rosterModelFilter(roster)'))
  assert(vote.includes('const totalBound = roster?.length ?? DIRECT_ALPHA_VOTE_MODEL_NAMES.length'),
    'a persisted denominator is bounded by the declared roster, else by the recognised names, never a literal')
  assert(!card.includes('L3 8ML'), 'the stack header does not claim a fixed model count')
  assert(vote.includes('missing: total === undefined ? undefined'))
  const diagnostics = between('function mlDiagnosticsFromRec(', 'function mlMetadataGapText(')
  assert(diagnostics.includes('totalAlphaModels: roster?.length') && !diagnostics.includes('isAlphaPredictionModelName'),
    'diagnostics count only the declared roster')
  assert(card.includes('ROSTER_NOT_PROVIDED}`)'), 'weight chip denominator falls back to 未提供')
  assert(card.includes('value={l3Expected == null ? ROSTER_NOT_PROVIDED : countText(l3Expected)}'))
  assert(card.includes("teacherModelList.length ? teacherModelList.join(' / ') : ROSTER_NOT_PROVIDED"))
  assert(card.includes('（模型總數${ROSTER_NOT_PROVIDED}）'))
})
