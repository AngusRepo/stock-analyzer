import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TODO_LANE_PAGE_SIZE, lanePage, lanePageOfIndex } from './todoBoardPaging.ts'

const cards = Array.from({ length: 45 }, (_, i) => i)

const first = lanePage(cards, 0)
assert.deepEqual([first.items.length, first.page, first.pageCount, first.total, first.start, first.end], [TODO_LANE_PAGE_SIZE, 0, 3, 45, 0, 20])
const last = lanePage(cards, 2)
assert.deepEqual(last.items, [40, 41, 42, 43, 44])
// A lane that shrank after a move/archive clamps to its last page instead of rendering empty.
assert.equal(lanePage(cards.slice(0, 21), 2).page, 1)
assert.equal(lanePage(cards, -3).page, 0)
assert.equal(lanePage(cards, Number.NaN).page, 0)
const empty = lanePage([], 4)
assert.deepEqual([empty.items.length, empty.page, empty.pageCount, empty.total], [0, 0, 1, 0])

// A card dropped into a lane that already holds 20 cards lands at index 20 -> page 1 (shown).
assert.equal(lanePageOfIndex(20), 1)
assert.equal(lanePageOfIndex(19), 0)
assert.equal(lanePageOfIndex(0), 0)
const dropped = lanePage([...cards.slice(0, 20), 99], lanePageOfIndex(20))
assert.ok(dropped.items.includes(99))

// The board must render a page per lane, never every card at once.
const page = readFileSync(new URL('../pages/TodoBoardPage.tsx', import.meta.url), 'utf8')
assert.ok(page.includes("from '@/lib/todoBoardPaging'"), 'TodoBoardPage should page each lane')
assert.ok(page.includes('visible.items.map((card) =>') && !page.includes('laneCards.map((card) =>'), 'Lanes must render only the current page')
assert.ok(page.includes('{laneCards.length}'), 'Lane count must stay the full total')

assert.ok(page.includes('lanePageOfIndex(lanePositions.length)'), 'A moved card must stay on screen: the target lane opens the page that shows it')
assert.ok(page.includes('.sort((a, b) => a.position - b.position)'), 'Lanes render in server order so the moved card is at the lane end')

assert.ok(!page.includes('展開全文') && !page.includes('setExpanded') && !page.includes('<details'), 'Cards show content directly (two lines + title tooltip), no expand toggle')

assert.ok(page.includes('const TODO_CARD_PREVIEW_CHARS = 160') && page.includes('content.slice(0, TODO_CARD_PREVIEW_CHARS)') && !page.includes('line-clamp-2 whitespace-pre-wrap'), 'Cards show up to 160 chars whole, longer ones cut at 160 (no line clamp)')

console.log('todoBoardPaging: OK')
