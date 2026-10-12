import type { ApiInventory, ApiOperation, ApiState } from '../live/api.ts'
import { parseRoute, type Route, type Snapshot, type SyncError } from './protocol.ts'

export const OWN_MARK = 'nimitzpf=1'

export type Resource = 'state' | 'inventory' | `operation:${string}`

const API = '/api/v2/'
const ACTIONS = /^\/api\/v2\/(?:keypoint\/start\/(?:dry\/)?|operation\/(?:start|complete|reset|next-stage|previous\/checkout)\/|modifier\/purchase\/|card\/purchase\/confirm\/|progress\/claim\/)$/
const SAFE_ID = /^[\w-]{1,64}$/
const CONCURRENCY = 3

export function resourcesFor(url: string, host: string, current: string | null): Resource[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }
  if (parsed.host !== host || parsed.search.includes(OWN_MARK) || !parsed.pathname.startsWith(API)) return []
  const path = parsed.pathname
  const op: Resource[] = current ? [`operation:${current}`] : []
  if (ACTIONS.test(path)) return ['state', 'inventory', ...op]
  if (path === '/api/v2/state/') return ['state']
  if (path === '/api/v2/inventory/') return ['inventory']
  const detail = /^\/api\/v2\/operation\/([^/]+)\/$/.exec(path)
  if (detail) {
    const id = decodeURIComponent(detail[1]!)
    return id === 'summary' || id === 'previous' || !SAFE_ID.test(id) ? [] : [`operation:${id}`]
  }
  if (/^\/api\/v2\/keypoint\/[^/]+\/$/.test(path)) return op
  return []
}

export interface PageInfo {
  readonly settings: unknown
  readonly realm: string | null
  readonly build: string | null
}

export interface SyncHost {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  readonly location: () => { readonly host: string; readonly pathname: string; readonly search: string }
  readonly page: () => PageInfo
  readonly emit: (snapshot: Snapshot) => void
  readonly busy: (syncing: boolean) => void
  readonly later: (run: () => void, ms: number) => unknown
  readonly cancel: (handle: unknown) => void
  readonly now: () => number
}

interface Envelope<T> {
  readonly result?: T
  readonly timestamp?: number
}

interface WithSettings {
  readonly settings?: unknown
  readonly state?: ApiState
}

export class Sync {
  private state: ApiState | null = null
  private readonly operations = new Map<string, ApiOperation>()
  private inventory: ApiInventory | null = null
  private settings: unknown = null
  private realm: string | null = null
  private build: string | null = null
  private route: Route
  private error: SyncError | null = null
  private readonly dirty = new Set<Resource>()
  private timer: unknown = null
  private running = false
  private again = false

  constructor(private readonly host: SyncHost) {
    const loc = host.location()
    this.route = parseRoute(loc.pathname, loc.search)
    const page = host.page()
    this.settings = page.settings
    this.realm = page.realm
    this.build = page.build
  }

  current(): string | null {
    const id = this.route.operationId ?? (this.state?.status.operationId != null ? String(this.state.status.operationId) : null)
    return id && SAFE_ID.test(id) ? id : null
  }

  snapshot(): Snapshot {
    return {
      at: this.host.now(),
      host: this.host.location().host,
      realm: this.realm,
      build: this.build,
      settings: this.settings,
      state: this.state,
      operations: Object.fromEntries(this.operations),
      inventory: this.inventory,
      route: this.route,
      error: this.error,
    }
  }

  start(): void {
    this.mark(['state', 'inventory'], 0)
  }

  refresh(): void {
    const ops = new Set<Resource>(['state', 'inventory'])
    for (const id of this.operations.keys()) ops.add(`operation:${id}`)
    const current = this.current()
    if (current) ops.add(`operation:${current}`)
    this.mark(ops, 0)
  }

  observe(url: string): void {
    this.mark(resourcesFor(url, this.host.location().host, this.current()))
  }

  checkRoute(): void {
    const loc = this.host.location()
    const next = parseRoute(loc.pathname, loc.search)
    if (next.lang === this.route.lang && next.operationId === this.route.operationId && next.keypointId === this.route.keypointId) return
    this.route = next
    const current = this.current()
    if (current && !this.operations.has(current)) this.mark([`operation:${current}`], 0)
    else this.host.emit(this.snapshot())
  }

  mark(resources: Iterable<Resource>, delay = 400): void {
    let added = false
    for (const r of resources) {
      this.dirty.add(r)
      added = true
    }
    if (!added) return
    if (this.running) {
      this.again = true
      return
    }
    if (this.timer !== null) this.host.cancel(this.timer)
    this.timer = this.host.later(() => {
      this.timer = null
      void this.flush()
    }, delay)
  }

  async flush(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    this.host.busy(true)
    try {
      do {
        this.again = false
        const batch = new Set(this.dirty)
        this.dirty.clear()
        this.error = null
        await this.pull(batch)
        this.host.emit(this.snapshot())
      } while (this.again || this.dirty.size > 0)
    } finally {
      this.running = false
      this.host.busy(false)
    }
  }

  private async pull(batch: Set<Resource>): Promise<void> {
    if (this.settings == null) {
      const seed = await this.get<WithSettings>('/api/v2/state/with-settings/')
      if (seed?.settings) this.settings = seed.settings
    }
    if (batch.has('state') || this.state === null) {
      const body = await this.get<Envelope<ApiState>>('/api/v2/state/')
      if (body?.result) this.state = { ...body.result, timestamp: body.timestamp ?? body.result.timestamp }
      batch.delete('state')
    }
    const listed = new Set((this.state?.operations ?? []).map(o => String(o.id)).filter(id => SAFE_ID.test(id)))
    const current = this.current()
    if (current) listed.add(current)
    for (const id of listed) if (!this.operations.has(id)) batch.add(`operation:${id}`)
    for (const id of [...this.operations.keys()]) if (!listed.has(id)) this.operations.delete(id)
    if (this.inventory === null) batch.add('inventory')
    if (this.state?.status.state === 'unauth') {
      this.error = 'unauth'
      return
    }
    const jobs = [...batch].map(r => () => this.load(r))
    let next = 0
    const worker = async () => {
      while (next < jobs.length) await jobs[next++]!()
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker))
  }

  private async load(resource: Resource): Promise<void> {
    if (resource === 'inventory') {
      const body = await this.get<Envelope<ApiInventory>>('/api/v2/inventory/')
      if (body?.result) this.inventory = body.result
      return
    }
    if (resource === 'state') return
    const id = resource.slice('operation:'.length)
    if (!SAFE_ID.test(id)) return
    const body = await this.get<Envelope<ApiOperation>>(`/api/v2/operation/${encodeURIComponent(id)}/`)
    if (body?.result) this.operations.set(id, body.result)
  }

  private async get<T>(path: string): Promise<T | null> {
    try {
      const res = await this.host.fetch(`${path}?${OWN_MARK}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (res.status === 401 || res.status === 403) {
        this.error = 'unauth'
        return null
      }
      if (!res.ok) {
        this.error ??= 'server'
        return null
      }
      return (await res.json()) as T
    } catch {
      this.error ??= 'network'
      return null
    }
  }
}
