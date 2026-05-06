import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'

type VirtualizedListProps<T> = {
  items: T[]
  itemHeight: number
  height: number
  overscan?: number
  getKey: (item: T, index: number) => string
  renderItem: (item: T, index: number) => ReactNode
  empty?: ReactNode
}

export function VirtualizedList<T>({
  items,
  itemHeight,
  height,
  overscan = 4,
  getKey,
  renderItem,
  empty,
}: VirtualizedListProps<T>) {
  const [scrollTop, setScrollTop] = useState(0)
  const totalHeight = items.length * itemHeight

  const range = useMemo(() => {
    const visibleCount = Math.ceil(height / itemHeight)
    const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan)
    const end = Math.min(items.length, start + visibleCount + overscan * 2)
    return { start, end }
  }, [height, itemHeight, items.length, overscan, scrollTop])

  if (!items.length) return <>{empty ?? null}</>

  return (
    <div
      className="overflow-y-auto"
      style={{ height }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className="relative" style={{ height: totalHeight }}>
        {items.slice(range.start, range.end).map((item, offset) => {
          const index = range.start + offset
          return (
            <div
              key={getKey(item, index)}
              className="absolute left-0 right-0"
              style={{ height: itemHeight, transform: `translateY(${index * itemHeight}px)` }}
            >
              {renderItem(item, index)}
            </div>
          )
        })}
      </div>
    </div>
  )
}
