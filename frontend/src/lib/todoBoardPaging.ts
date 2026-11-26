// /todo rendered every card of every lane at once (Grok 11/25: 14,468 DOM nodes, 648 KB).
// Each lane now renders one page of cards; the lane count still shows the full total.
export const TODO_LANE_PAGE_SIZE = 20

export type LanePage<T> = {
  items: T[]
  page: number
  pageCount: number
  total: number
  start: number
  end: number
}

/** Clamp the requested page so a lane that shrank (move, archive) never shows an empty page. */
export function lanePage<T>(items: T[], requestedPage: number, pageSize = TODO_LANE_PAGE_SIZE): LanePage<T> {
  const total = items.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(0, Math.floor(Number.isFinite(requestedPage) ? requestedPage : 0)), pageCount - 1)
  const start = page * pageSize
  const end = Math.min(total, start + pageSize)
  return { items: items.slice(start, end), page, pageCount, total, start, end }
}

/** Page that shows the card at this index of the lane (a card dropped at the lane end stays visible). */
export function lanePageOfIndex(index: number, pageSize = TODO_LANE_PAGE_SIZE): number {
  return Math.max(0, Math.floor((Number.isFinite(index) ? index : 0) / pageSize))
}
