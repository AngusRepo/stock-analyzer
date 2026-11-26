import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DataState } from '@/components/ui/data-state'

type DeferredRenderProps = {
  children: ReactNode
  className?: string
  minHeight?: number
  rootMargin?: string
  /** 進入視窗前顯示的占位；預設占滿保留高度並寫明「捲動到這裡時載入」，不留無標示的空白。提前 600px 開始渲染，通常捲到時已就緒。 */
  placeholder?: ReactNode
}

export function DeferredRender({
  children,
  className,
  minHeight = 480,
  rootMargin = '600px 0px',
  placeholder,
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
    // minHeight only reserves space until the content renders; afterwards the content decides the height,
    // so a short section does not leave a blank band under it.
    <div ref={anchorRef} className={className} style={isVisible ? undefined : { minHeight }}>
      {isVisible ? children : placeholder ?? <DataState kind="loading" title="捲動到這裡時載入" minHeight={minHeight} />}
    </div>
  )
}
