import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// List + fixed detail panel (same pattern as /bot SimRoom). Selecting a row swaps the panel
// content; the panel always shows the selected row (first row by default), so nothing sits
// behind a toggle. Side-by-side is decided by the container width, because the home list lives
// in a half-width column and the pipeline list in a quarter-width one on xl; below 34rem the
// panel stacks under the list.
// No inner scrollbar: the panel is sticky at its natural height. A panel taller than the viewport
// gets a negative `top` (viewport − panel height), so it scrolls with the page until its bottom
// edge is visible and then sticks there — every line stays reachable by the page scroll alone.
// --ld-panel-h is measured with a ResizeObserver.
const PANEL_STICKY = '@min-[34rem]:sticky @min-[34rem]:top-[min(calc(3.5rem_+_env(safe-area-inset-top)_+_0.75rem),calc(100dvh_-_var(--ld-panel-h,0px)_-_0.75rem))]'
const GRID: Record<'narrow' | 'balanced', string> = {
  narrow: '@min-[34rem]:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]',
  balanced: '@min-[34rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]',
}

export function ListDetailLayout({
  list,
  detail,
  detailKey,
  listLabel,
  detailLabel,
  listWidth = 'balanced',
  className,
  listClassName = 'space-y-1',
  detailClassName,
}: {
  list: ReactNode
  detail: ReactNode
  /** Identity of the selected row; when it changes while stacked, the panel is scrolled into view. */
  detailKey?: string
  listLabel: string
  detailLabel: string
  listWidth?: 'narrow' | 'balanced'
  className?: string
  listClassName?: string
  detailClassName?: string
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const previousKey = useRef(detailKey)
  const [panelHeight, setPanelHeight] = useState(0)

  useEffect(() => {
    const panel = panelRef.current
    if (!panel || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setPanelHeight(Math.ceil(panel.offsetHeight)))
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (previousKey.current === detailKey) return
    previousKey.current = detailKey
    const grid = gridRef.current
    const panel = panelRef.current
    if (!grid || !panel) return
    const stacked = getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length < 2
    if (!stacked) return
    const top = panel.getBoundingClientRect().top
    if (top < 0 || top > window.innerHeight * 0.6) panel.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [detailKey])

  return (
    <div className={cn('@container', className)}>
      <div ref={gridRef} className={cn('grid items-start gap-3', GRID[listWidth])}>
        <div role="listbox" aria-label={listLabel} className={cn('min-w-0', listClassName)}>{list}</div>
        <section ref={panelRef} aria-label={detailLabel} className={cn('min-w-0 scroll-mt-16', PANEL_STICKY, detailClassName)}
          style={{ '--ld-panel-h': `${panelHeight}px` } as CSSProperties}
        >
          {detail}
        </section>
      </div>
    </div>
  )
}

export function selectableRowProps(selected: boolean, onSelect: () => void) {
  return {
    role: 'option' as const,
    tabIndex: 0,
    'aria-selected': selected,
    onClick: onSelect,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onSelect()
      }
    },
  }
}
