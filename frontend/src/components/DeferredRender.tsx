import { useEffect, useRef, useState, type ReactNode } from 'react'

type DeferredRenderProps = {
  children: ReactNode
  className?: string
  minHeight?: number
  rootMargin?: string
}

export function DeferredRender({
  children,
  className,
  minHeight = 480,
  rootMargin = '160px 0px',
}: DeferredRenderProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        setIsVisible(true)
        observer.disconnect()
      },
      { rootMargin },
    )
    observer.observe(anchor)
    return () => observer.disconnect()
  }, [rootMargin])

  return (
    <div ref={anchorRef} className={className} style={{ minHeight }}>
      {isVisible ? children : null}
    </div>
  )
}
