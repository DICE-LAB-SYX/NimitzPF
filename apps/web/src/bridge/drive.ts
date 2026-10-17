import { Cursor, type Point } from './cursor.ts'
import type { DriveStep, PlaySlot } from './protocol.ts'

interface Fiber {
  readonly key: string | null
  readonly type: unknown
  readonly child: Fiber | null
  readonly sibling: Fiber | null
  readonly return: Fiber | null
  readonly stateNode: unknown
  readonly memoizedProps: Record<string, unknown> | null
}

interface GameStore {
  getState(): GameState
  dispatch(action: { type: string }): unknown
}

interface GameState {
  readonly battleBoard?: {
    readonly activeKeypointId: string | null
    readonly battleAnimationPhase: string | null
    readonly keypointStatuses: Readonly<Record<string, string>>
    readonly keypoints: Readonly<Record<string, BoardState | undefined>>
  }
}

interface BoardState {
  readonly cards: readonly ({ readonly code: string } | null)[]
  readonly modifiersGroupA: readonly ({ readonly id: string } | null)[]
  readonly modifiersGroupB: readonly ({ readonly id: string } | null)[]
}

export class DriveError extends Error {
  constructor(
    readonly step: DriveStep,
    readonly detail: string | null = null,
  ) {
    super(step)
  }
}

const BLOCKED = ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup'] as const
const STATUS_DONE = new Set(['cleared', 'missed'])

const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms))

function rootFiber(): Fiber | null {
  const app = document.getElementById('app')
  if (!app) return null
  const key = Object.keys(app).find(k => k.startsWith('__reactContainer$'))
  return key ? ((app as unknown as Record<string, Fiber>)[key] ?? null) : null
}

export function* fibers(): Generator<Fiber> {
  const root = rootFiber()
  const stack: Fiber[] = root ? [root] : []
  while (stack.length) {
    const f = stack.pop()!
    yield f
    if (f.sibling) stack.push(f.sibling)
    if (f.child) stack.push(f.child)
  }
}

function hostOf(f: Fiber): HTMLElement | null {
  if (f.stateNode instanceof HTMLElement) return f.stateNode
  const stack: Fiber[] = f.child ? [f.child] : []
  while (stack.length) {
    const c = stack.pop()!
    if (c.stateNode instanceof HTMLElement) return c.stateNode
    if (c.sibling) stack.push(c.sibling)
    if (c.child) stack.push(c.child)
  }
  return null
}

function shown(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function findFiber(test: (props: Record<string, unknown>, f: Fiber) => boolean): Fiber | null {
  for (const f of fibers()) {
    const p = f.memoizedProps
    if (p && typeof p === 'object' && typeof f.type !== 'string' && test(p, f) && shown(hostOf(f))) return f
  }
  return null
}

function find(test: (props: Record<string, unknown>, f: Fiber) => boolean): HTMLElement | null {
  const f = findFiber(test)
  return f ? hostOf(f) : null
}

function onBoard(f: Fiber): boolean {
  for (let up = f.return; up; up = up.return) if (up.memoizedProps && 'slotIdx' in up.memoizedProps) return true
  return false
}

function inventoryGroup(f: Fiber): number | null {
  for (let up = f.return; up; up = up.return) {
    const p = up.memoizedProps
    if (!p) continue
    if ('slotIdx' in p) return null
    if ('amountsById' in p && typeof p.modifierType === 'number') return p.modifierType
  }
  return null
}

function keyed(key: string): HTMLElement | null {
  const el = find((_, f) => f.key === key)
  if (!el) return null
  const button = el.matches('button') ? el : el.querySelector('button')
  return button instanceof HTMLElement && shown(button) ? button : null
}

function gameStore(): GameStore | null {
  for (const f of fibers()) {
    const store = f.memoizedProps?.store as GameStore | undefined
    if (store && typeof store.getState === 'function' && typeof store.dispatch === 'function') return store
  }
  return null
}

function center(el: Element): Point {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

function fire(target: EventTarget, kind: 'down' | 'move' | 'up', p: Point, buttons: number): void {
  const init = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y, button: 0, buttons, view: window }
  target.dispatchEvent(new PointerEvent(`pointer${kind}`, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
  target.dispatchEvent(new MouseEvent(`mouse${kind}`, init))
}

function describe(el: Element): string {
  const r = el.getBoundingClientRect()
  return `${el.tagName.toLowerCase()}@${Math.round(r.left)},${Math.round(r.top)}+${Math.round(r.width)}x${Math.round(r.height)}`
}

function path(): string[] {
  return window.location.pathname.split('/').filter(Boolean).map(decodeURIComponent)
}

function keypointOf(props: Record<string, unknown>): string | null {
  const kp = props.keypoint as { id?: unknown } | undefined
  return kp && kp.id != null ? String(kp.id) : null
}

export interface DriverHost {
  readonly halted: () => boolean
  readonly ownTarget: (event: Event) => boolean
  readonly covered: () => DOMRect | null
}

export class Driver {
  private readonly cursor = new Cursor()
  private guards: (() => void) | null = null

  constructor(private readonly host: DriverHost) {}

  private check(): void {
    if (this.host.halted()) throw new DriveError('aborted')
  }

  private block(on: boolean): void {
    this.guards?.()
    this.guards = null
    if (!on) return
    const stop = (event: Event) => {
      if (!event.isTrusted || this.host.ownTarget(event)) return
      event.stopImmediatePropagation()
      if (event.cancelable) event.preventDefault()
    }
    for (const type of BLOCKED) window.addEventListener(type, stop, { capture: true, passive: false })
    this.guards = () => {
      for (const type of BLOCKED) window.removeEventListener(type, stop, { capture: true })
    }
  }

  private board(keypointId: string): BoardState | null {
    return gameStore()?.getState().battleBoard?.keypoints[keypointId] ?? null
  }

  private async waitFor<T>(probe: () => T | null | false | undefined, ms: number, every = 120): Promise<T | null> {
    const until = performance.now() + ms
    for (;;) {
      this.check()
      const value = probe()
      if (value) return value
      if (performance.now() > until) return null
      await sleep(every)
    }
  }

  private target(p: Point, fallback: Element): Element {
    const hit = document.elementFromPoint(p.x, p.y)
    return hit && document.getElementById('app')?.contains(hit) ? hit : fallback
  }

  private async click(el: HTMLElement): Promise<void> {
    this.check()
    const p = center(el)
    await this.cursor.moveTo(p, 420)
    this.cursor.press(true)
    fire(el, 'down', p, 1)
    await sleep(90)
    fire(el, 'up', p, 0)
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, view: window }))
    this.cursor.press(false)
    this.cursor.pulse()
    await sleep(250)
  }

  private viewRight(): number {
    const covered = this.host.covered()
    return Math.min(window.innerWidth, covered && covered.width > 0 ? covered.left : Infinity)
  }

  private natural(el: HTMLElement, box: HTMLElement): DOMRect {
    let sticky: HTMLElement | null = null
    for (let e: HTMLElement | null = el; e && e !== box; e = e.parentElement) if (getComputedStyle(e).position === 'sticky') sticky = e
    if (!sticky) return el.getBoundingClientRect()
    const before = sticky.style.getPropertyValue('position')
    const priority = sticky.style.getPropertyPriority('position')
    sticky.style.setProperty('position', 'relative', 'important')
    const rect = el.getBoundingClientRect()
    if (before) sticky.style.setProperty('position', before, priority)
    else sticky.style.removeProperty('position')
    return rect
  }

  private async glide(box: HTMLElement, left: number): Promise<void> {
    const from = box.scrollLeft
    const to = Math.max(0, Math.min(left, box.scrollWidth - box.clientWidth))
    const distance = Math.abs(to - from)
    if (distance < 2) return
    const ms = Math.min(1100, 300 + distance * 0.4)
    const start = performance.now()
    await new Promise<void>(resolve => {
      const next = () => (document.hidden ? window.setTimeout(step, 16) : requestAnimationFrame(step))
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / ms)
        const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
        box.scrollTo({ left: from + (to - from) * k, behavior: 'instant' })
        if (t < 1) next()
        else resolve()
      }
      next()
    })
    await sleep(120)
  }

  private async reveal(el: HTMLElement): Promise<void> {
    let box = el.parentElement
    while (box && box !== document.body && (box.scrollWidth <= box.clientWidth + 2 || getComputedStyle(box).overflowX === 'visible')) box = box.parentElement
    if (!box || box === document.body) return
    for (let i = 0; i < 3; i++) {
      const b = box.getBoundingClientRect()
      const left = Math.max(0, b.left)
      const right = Math.min(this.viewRight(), b.right)
      const home = this.natural(el, box)
      const now = el.getBoundingClientRect()
      const settled = Math.abs(home.left - now.left) < 2 && home.left >= left + home.width * 0.6 && home.right <= right - home.width * 0.6
      if (settled) return
      if (i === 0) await this.cursor.moveTo({ x: (left + right) / 2, y: now.top + now.height / 2 }, 420)
      const before = box.scrollLeft
      await this.glide(box, before + home.left + home.width / 2 - (left + right) / 2)
      if (box.scrollLeft === before) return
    }
  }

  private async drag(from: HTMLElement, to: () => HTMLElement | null): Promise<void> {
    this.check()
    await this.reveal(from)
    await sleep(160)
    const a = center(from)
    await this.cursor.moveTo(a, 420)
    this.cursor.press(true)
    fire(from, 'down', a, 1)
    await sleep(140)
    const goal = to()
    if (!goal) {
      fire(from, 'up', a, 0)
      this.cursor.press(false)
      throw new DriveError('card', 'drop target')
    }
    const b = center(goal)
    await this.cursor.moveTo(b, 650, p => fire(this.target(p, goal), 'move', p, 1))
    await sleep(120)
    const aimed = await this.aim(goal, b, from, a)
    console.info('[NimitzPF] drag', describe(goal), aimed.note)
    fire(this.target(aimed.at, goal), 'up', aimed.at, 0)
    this.cursor.press(false)
    await sleep(380)
  }

  private highlighted(): HTMLElement | null {
    for (const f of fibers()) {
      const p = f.memoizedProps
      if (!p || typeof p.targetClassName !== 'string' || !Array.isArray(p.accept)) continue
      const host = hostOf(f)
      const marker = p.targetClassName.split(' ')[0]
      if (host && marker && host.classList.contains(marker)) return host
    }
    return null
  }

  private async aim(goal: HTMLElement, from: Point, held: HTMLElement, grab: Point): Promise<{ readonly at: Point; readonly note: string }> {
    let p = from
    for (let i = 0; i < 40; i++) {
      const lit = this.highlighted()
      if (lit === goal) return { at: p, note: `on target after ${i}` }
      let now: Point
      if (lit) now = center(lit)
      else {
        now = center(held)
        if (Math.hypot(now.x - grab.x, now.y - grab.y) < 30) return { at: p, note: 'nothing highlighted' }
      }
      const want = center(goal)
      const dx = Math.abs(want.x - now.x) > 3 ? Math.sign(want.x - now.x) * Math.min(14, Math.abs(want.x - now.x)) : 0
      const dy = Math.abs(want.y - now.y) > 3 ? Math.sign(want.y - now.y) * Math.min(10, Math.abs(want.y - now.y)) : 0
      if (dx === 0 && dy === 0) return { at: p, note: lit ? 'stuck' : 'nothing highlighted' }
      p = { x: p.x + dx, y: p.y + dy }
      await this.cursor.moveTo(p, 40, q => fire(this.target(q, goal), 'move', q, 1))
      await sleep(30)
    }
    return { at: p, note: 'gave up' }
  }

  private onBoard(keypointId: string): boolean {
    const parts = path()
    if (parts[parts.length - 1] !== keypointId || parts[parts.length - 3] !== 'operations') return false
    if (gameStore()?.getState().battleBoard?.activeKeypointId !== keypointId) return false
    return Boolean(find(p => p.id === 'card-slot-0' && Array.isArray(p.accept)))
  }

  private onMap(operationId: string): boolean {
    const parts = path()
    return parts[parts.length - 1] === operationId && parts[parts.length - 2] === 'operations'
  }

  private navigate(to: string): void {
    window.history.pushState(null, '', to)
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
  }

  private lang(): string {
    return path()[0] ?? 'en'
  }

  private mainButton(): HTMLButtonElement | null {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#app button[data-size="l"]')].filter(b => shown(b) && !/nextStage/.test(b.className))
    return buttons[buttons.length - 1] ?? null
  }

  private stageButton(): HTMLButtonElement | null {
    return [...document.querySelectorAll<HTMLButtonElement>('#app button[data-size="l"]')].find(b => shown(b) && /nextStage/.test(b.className)) ?? null
  }

  private tab(keypointId: string): HTMLElement | null {
    return find((p, f) => keypointOf(p) === keypointId && 'isActive' in p && f.child !== null)
  }

  private async backToMap(operationId: string): Promise<void> {
    if (this.onMap(operationId)) return
    console.info('[NimitzPF] back to map')
    const parts = path()
    if (parts[parts.length - 3] === 'operations') {
      const back = [...document.querySelectorAll<HTMLButtonElement>('#app button')]
        .filter(b => shown(b) && b.getBoundingClientRect().top < 140)
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]
      if (back) {
        await this.click(back)
        await this.waitFor(() => this.onMap(operationId), 4000)
      }
    }
    if (!this.onMap(operationId)) {
      this.navigate(`/${this.lang()}/operations/${encodeURIComponent(operationId)}`)
      await this.waitFor(() => this.onMap(operationId), 6000)
    }
    await sleep(700)
  }

  private async openKeypoint(operationId: string, keypointId: string): Promise<void> {
    if (this.onBoard(keypointId)) return
    let tab = this.tab(keypointId)
    if (!tab && !this.onMap(operationId)) {
      await this.backToMap(operationId)
      tab = await this.waitFor(() => this.tab(keypointId), 6000)
    }
    if (tab) {
      await this.click(tab.closest('button') ?? tab)
      await this.waitFor(() => this.onBoard(keypointId) || this.onMap(operationId), 3000)
    }
    if (!this.onBoard(keypointId) && this.onMap(operationId)) {
      const enter = await this.waitFor(() => this.mainButton(), 2000)
      if (enter && !enter.disabled) {
        await this.click(enter)
        await this.waitFor(() => this.onBoard(keypointId), 8000)
      }
    }
    if (!this.onBoard(keypointId)) {
      this.navigate(`/${this.lang()}/operations/${encodeURIComponent(operationId)}/${encodeURIComponent(keypointId)}`)
      await this.waitFor(() => this.onBoard(keypointId), 8000)
    }
    if (!this.onBoard(keypointId)) throw new DriveError('open')
    await sleep(600)
  }

  private inventoryCard(code: string): HTMLElement | null {
    const el = find((p, f) => (p.card as { code?: unknown } | undefined)?.code === code && 'inventoryItem' in p && !onBoard(f))
    return (el?.closest('[role="button"]') as HTMLElement | null) ?? el
  }

  private placedCard(code: string): HTMLElement | null {
    return find((p, f) => (p.card as { code?: unknown } | undefined)?.code === code && !('inventoryItem' in p) && 'kind' in p && onBoard(f))
  }

  private modifier(id: string): { readonly el: HTMLElement; readonly type: number } | null {
    const f = findFiber((p, fiber) => p.id === id && 'entityId' in p && 'availableAmount' in p && inventoryGroup(fiber) !== null)
    const type = f ? inventoryGroup(f) : null
    const el = f ? hostOf(f) : null
    return el && type !== null ? { el, type } : null
  }

  private slot(id: string): HTMLElement | null {
    return find(p => p.id === id && Array.isArray(p.accept))
  }

  private async placeCards(keypointId: string, slots: readonly (PlaySlot | null)[]): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const [lane, slot] of slots.entries()) {
        const want = slot?.cardCode ?? null
        const have = this.board(keypointId)?.cards[lane]?.code ?? null
        if (!want || want === have) continue
        let from = this.inventoryCard(want) ?? this.placedCard(want)
        if (!from) {
          gameStore()?.dispatch({ type: 'inventoryCards/resetFilters' })
          await sleep(300)
          from = this.inventoryCard(want) ?? this.placedCard(want)
        }
        if (!from) throw new DriveError('card', want)
        await this.drag(from, () => this.slot(`card-slot-${lane}`))
      }
      const board = this.board(keypointId)
      if (slots.every((s, lane) => (board?.cards[lane]?.code ?? null) === (s?.cardCode ?? null))) return
    }
    const board = this.board(keypointId)
    const wrong = slots.findIndex((s, lane) => (board?.cards[lane]?.code ?? null) !== (s?.cardCode ?? null))
    throw new DriveError('card', `lane ${wrong + 1}`)
  }

  private async placeModifiers(keypointId: string, slots: readonly (PlaySlot | null)[]): Promise<void> {
    const wanted: { lane: number; id: string }[] = []
    slots.forEach((s, lane) => s?.modifiers?.forEach(id => wanted.push({ lane, id })))
    const groupOf = (type: number) => (type === 1 ? 'modifiersGroupA' : 'modifiersGroupB')
    for (let attempt = 0; attempt < 2; attempt++) {
      let missing = false
      for (const { lane, id } of wanted) {
        const item = this.modifier(id)
        if (!item) throw new DriveError('modifier', id)
        if (this.board(keypointId)?.[groupOf(item.type)][lane]?.id === id) continue
        missing = true
        await this.drag(item.el, () => this.slot(`modifier-slot-${item.type}-${lane}`))
      }
      if (!missing) return
    }
    for (const { lane, id } of wanted) {
      const item = this.modifier(id)
      if (!item || this.board(keypointId)?.[groupOf(item.type)][lane]?.id !== id) throw new DriveError('modifier', id)
    }
  }

  private fleetList(): HTMLElement | null {
    let box = find(p => Boolean((p.card as { code?: unknown } | undefined)?.code) && 'inventoryItem' in p)?.parentElement ?? null
    while (box && box !== document.body && (box.scrollWidth <= box.clientWidth + 2 || getComputedStyle(box).overflowX === 'visible')) box = box.parentElement
    return box && box !== document.body ? box : null
  }

  private async clearBoard(keypointId: string, slots: readonly (PlaySlot | null)[]): Promise<void> {
    const list = this.fleetList()
    if (!list) return
    const inside = (slotId: string, test: (p: Record<string, unknown>) => boolean) => {
      const box = this.slot(slotId)
      return box ? find((p, f) => test(p) && box.contains(hostOf(f))) : null
    }
    for (let lane = 0; lane < slots.length; lane++) {
      const keep = new Set(slots[lane]?.modifiers ?? [])
      for (const [type, group] of [[1, 'modifiersGroupA'], [2, 'modifiersGroupB']] as const) {
        const have = this.board(keypointId)?.[group][lane]?.id
        if (!have || keep.has(have)) continue
        const el = inside(`modifier-slot-${type}-${lane}`, p => p.id === have && 'entityId' in p)
        if (el) await this.drag(el, () => list)
      }
      const card = this.board(keypointId)?.cards[lane]?.code
      if (!card || card === (slots[lane]?.cardCode ?? null)) continue
      const el = inside(`card-slot-${lane}`, p => (p.card as { code?: unknown } | undefined)?.code === card && !('inventoryItem' in p))
      if (el) await this.drag(el, () => list)
    }
  }

  async battle(operationId: string, keypointId: string, slots: readonly (PlaySlot | null)[], label: string): Promise<void> {
    this.cursor.show(label)
    this.block(true)
    try {
      await this.openKeypoint(operationId, keypointId)
      await this.clearBoard(keypointId, slots)
      await this.placeCards(keypointId, slots)
      await this.placeModifiers(keypointId, slots)
      await sleep(700)
      const go = await this.waitFor(() => {
        const b = this.mainButton()
        return b && !b.disabled ? b : null
      }, 3000)
      if (!go) throw new DriveError('battle')
      const since = performance.now()
      await this.click(go)
      const confirm = await this.waitFor(() => keyed('start-mission-button'), 1500)
      if (confirm) await this.click(confirm)
      const rejected = () =>
        performance
          .getEntriesByType('resource')
          .some(e => e.startTime >= since && e.name.includes('/api/v2/keypoint/start/') && ((e as PerformanceResourceTiming).responseStatus ?? 0) >= 400)
      const started = await this.waitFor(() => {
        if (rejected()) throw new DriveError('battle', 'rejected')
        const s = gameStore()?.getState().battleBoard
        return Boolean(s && (s.battleAnimationPhase !== null || STATUS_DONE.has(s.keypointStatuses[keypointId] ?? '')))
      }, 12000)
      if (!started) throw new DriveError('battle')
      const done = await this.waitFor(() => {
        const s = gameStore()?.getState().battleBoard
        return Boolean(s && (s.battleAnimationPhase === null || s.battleAnimationPhase === 'done') && STATUS_DONE.has(s.keypointStatuses[keypointId] ?? ''))
      }, 45000, 200)
      if (!done) throw new DriveError('result')
      await sleep(1200)
    } finally {
      this.block(false)
      this.cursor.hide()
    }
  }

  async advance(operationId: string, label: string): Promise<void> {
    this.cursor.show(label)
    this.block(true)
    try {
      await this.backToMap(operationId)
      const next = await this.waitFor(() => this.stageButton(), 6000)
      if (!next) throw new DriveError('stage', 'button')
      await this.click(next)
      const confirm = await this.waitFor(() => keyed('start-button'), 4000)
      if (!confirm) throw new DriveError('stage', 'confirm')
      await this.click(confirm)
      const closed = await this.waitFor(() => !keyed('start-button') && !this.stageButton(), 10000)
      if (!closed) throw new DriveError('stage', 'pending')
      await sleep(800)
    } finally {
      this.block(false)
      this.cursor.hide()
    }
  }
}
