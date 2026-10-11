import { useLayoutEffect, useState, type RefObject } from 'react'

interface Size {
  readonly width: number
  readonly height: number
}

export function useSize(ref: RefObject<HTMLElement | null>, parent = false): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const node = parent ? ref.current?.parentElement : ref.current
    if (!node) return
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, parent])
  return size
}
