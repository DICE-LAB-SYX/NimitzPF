import type { Point } from './cursor.ts'
import { fibers } from './drive.ts'

type PagePoint = (point: Point) => Point

interface VisualElement {
  readonly current: unknown
  getTransformPagePoint(): PagePoint | undefined
  measureInstanceViewportBox(instance: unknown, props: { readonly transformPagePoint?: PagePoint }): unknown
}

const PATCHED = Symbol.for('nimitzpf:zoom')

function visualElement(): VisualElement | null {
  for (const f of fibers()) {
    const ve = (f.memoizedProps?.value as { visualElement?: Partial<VisualElement> } | undefined)?.visualElement
    if (ve?.current instanceof HTMLElement && typeof ve.getTransformPagePoint === 'function' && typeof ve.measureInstanceViewportBox === 'function') return ve as VisualElement
  }
  return null
}

function owner(of: object, key: keyof VisualElement): Record<PropertyKey, unknown> | null {
  for (let p: object | null = of; p; p = Object.getPrototypeOf(p) as object | null) if (Object.hasOwn(p, key)) return p as Record<PropertyKey, unknown>
  return null
}

export function scaleMotion(zoom: () => number): boolean {
  const ve = visualElement()
  const read = ve && owner(ve, 'getTransformPagePoint')
  const measure = ve && owner(ve, 'measureInstanceViewportBox')
  if (!read || !measure) return false
  if (read[PATCHED]) return true
  const fit =
    (own?: PagePoint): PagePoint =>
    point => {
      const p = own ? own(point) : point
      const z = zoom()
      return z === 1 ? p : { x: p.x / z, y: p.y / z }
    }
  const getTransformPagePoint = read.getTransformPagePoint as VisualElement['getTransformPagePoint']
  const measureInstanceViewportBox = measure.measureInstanceViewportBox as VisualElement['measureInstanceViewportBox']
  read.getTransformPagePoint = function (this: VisualElement) {
    return fit(getTransformPagePoint.call(this))
  }
  measure.measureInstanceViewportBox = function (this: VisualElement, instance: unknown, props: { readonly transformPagePoint?: PagePoint }) {
    return measureInstanceViewportBox.call(this, instance, { ...props, transformPagePoint: fit(props.transformPagePoint) })
  }
  read[PATCHED] = true
  return true
}
