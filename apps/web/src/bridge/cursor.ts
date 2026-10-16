export interface Point {
  readonly x: number
  readonly y: number
}

const STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; z-index: 2147483600; pointer-events: none; }
.cursor { position: absolute; left: 0; top: 0; width: 28px; height: 28px; will-change: transform; filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55)); }
.cursor svg { width: 28px; height: 28px; transition: transform 120ms ease-out; transform-origin: 4px 3px; }
.cursor.pressed svg { transform: scale(0.82); }
.ripple { position: absolute; left: 4px; top: 3px; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 3px solid #f2c35b; opacity: 0; }
.ripple.on { animation: ripple 420ms ease-out; }
@keyframes ripple { from { opacity: 0.95; transform: scale(0.3); } to { opacity: 0; transform: scale(1.4); } }
.tag { position: absolute; left: 26px; top: 22px; padding: 3px 8px; border-radius: 4px; background: #0b2a30; color: #f3d9a4;
  font: 600 12px/1.4 system-ui, sans-serif; white-space: nowrap; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45); }
.layer.hidden { display: none; }
`

const ARROW =
  '<svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 3l17 12-7.4 1.3 4.6 8.2-3.3 1.8-4.6-8.3L4 23z" fill="#f2c35b" stroke="#0b2a30" stroke-width="1.8" stroke-linejoin="round"/></svg>'

function ease(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
}

export class Cursor {
  private readonly layer: HTMLElement
  private readonly cursor: HTMLElement
  private readonly ripple: HTMLElement
  private readonly tag: HTMLElement
  private at: Point = { x: window.innerWidth * 0.45, y: window.innerHeight * 0.55 }

  constructor() {
    const host = document.createElement('div')
    host.id = 'nimitzpf-cursor'
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = STYLE
    this.layer = document.createElement('div')
    this.layer.className = 'layer hidden'
    this.cursor = document.createElement('div')
    this.cursor.className = 'cursor'
    this.cursor.innerHTML = ARROW
    this.ripple = document.createElement('div')
    this.ripple.className = 'ripple'
    this.tag = document.createElement('div')
    this.tag.className = 'tag'
    this.cursor.append(this.ripple, this.tag)
    this.layer.append(this.cursor)
    root.append(style, this.layer)
    document.documentElement.append(host)
    this.place(this.at)
  }

  private place(p: Point): void {
    this.at = p
    this.cursor.style.transform = `translate(${p.x - 4}px, ${p.y - 3}px)`
  }

  show(label: string): void {
    this.tag.textContent = label
    this.layer.classList.remove('hidden')
  }

  hide(): void {
    this.layer.classList.add('hidden')
  }

  press(down: boolean): void {
    this.cursor.classList.toggle('pressed', down)
  }

  pulse(): void {
    this.ripple.classList.remove('on')
    void this.ripple.offsetWidth
    this.ripple.classList.add('on')
  }

  moveTo(to: Point, ms: number, step?: (p: Point) => void): Promise<void> {
    const from = this.at
    const distance = Math.hypot(to.x - from.x, to.y - from.y)
    const duration = distance < 2 ? 0 : Math.max(120, Math.min(ms, ms * (distance / 500) + 120))
    if (duration === 0) {
      this.place(to)
      step?.(to)
      return Promise.resolve()
    }
    return new Promise(resolve => {
      const start = performance.now()
      const next = () => (document.hidden ? window.setTimeout(() => frame(performance.now()), 16) : requestAnimationFrame(frame))
      const frame = (now: number) => {
        const t = Math.min(1, (now - start) / duration)
        const k = ease(t)
        const p = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }
        this.place(p)
        step?.(p)
        if (t < 1) next()
        else resolve()
      }
      next()
    })
  }
}
