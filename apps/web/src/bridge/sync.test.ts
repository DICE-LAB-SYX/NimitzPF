import { describe, expect, it } from 'vitest'
import type { Snapshot } from './protocol.ts'
import { OWN_MARK, resourcesFor, Sync, type SyncHost } from './sync.ts'

const HOST = 'pacificfront.worldofwarships.asia'
const ORIGIN = `https://${HOST}`

interface Fake {
  readonly host: SyncHost
  readonly requests: string[]
  readonly snapshots: Snapshot[]
  readonly path: { value: string }
  tick(): Promise<void>
}

function fake(responses: Record<string, unknown>, status: Record<string, number> = {}): Fake {
  const requests: string[] = []
  const snapshots: Snapshot[] = []
  const timers: (() => void)[] = []
  const path = { value: '/zh-sg/operations' }
  const host: SyncHost = {
    fetch: async url => {
      requests.push(url)
      const key = url.split('?')[0]!
      const code = status[key] ?? (key in responses ? 200 : 404)
      return new Response(JSON.stringify(responses[key] ?? { detail: 'Not Found' }), { status: code })
    },
    location: () => ({ host: HOST, pathname: path.value, search: '' }),
    page: () => ({ settings: { options: {} }, realm: 'sg', build: 'b1' }),
    emit: s => snapshots.push(s),
    busy: () => undefined,
    later: run => timers.push(run),
    cancel: () => undefined,
    now: () => 1000,
  }
  const tick = async () => {
    while (timers.length) timers.shift()!()
    for (let i = 0; i < 20; i++) await Promise.resolve().then(() => new Promise(r => setTimeout(r, 0)))
  }
  return { host, requests, snapshots, path, tick }
}

const state = {
  timestamp: 5,
  result: {
    status: { state: 'in_operation', operationId: 7, stageId: 1, accountId: null, accountNickname: null },
    operations: [{ id: 7, name: 'op1' }, { id: 8, name: 'op2' }],
  },
}

const responses = {
  '/api/v2/state/': state,
  '/api/v2/inventory/': { result: { cards: [{ code: 'card_1', health: 3 }], modifiers: [] } },
  '/api/v2/operation/7/': { result: { id: 7, name: 'op1', stages: [] } },
  '/api/v2/operation/8/': { result: { id: 8, name: 'op2', stages: [] } },
}

describe('resource triggers', () => {
  it('maps the game requests onto the resources to refetch', () => {
    expect(resourcesFor(`${ORIGIN}/api/v2/state/`, HOST, '7')).toEqual(['state'])
    expect(resourcesFor(`${ORIGIN}/api/v2/inventory/`, HOST, '7')).toEqual(['inventory'])
    expect(resourcesFor(`${ORIGIN}/api/v2/inventory/status/`, HOST, '7')).toEqual([])
    expect(resourcesFor(`${ORIGIN}/api/v2/operation/9/`, HOST, '7')).toEqual(['operation:9'])
    expect(resourcesFor(`${ORIGIN}/api/v2/operation/summary/`, HOST, '7')).toEqual([])
    expect(resourcesFor(`${ORIGIN}/api/v2/keypoint/3/`, HOST, '7')).toEqual(['operation:7'])
    expect(resourcesFor(`${ORIGIN}/api/v2/keypoint/start/`, HOST, '7')).toEqual(['state', 'inventory', 'operation:7'])
    expect(resourcesFor(`${ORIGIN}/api/v2/operation/next-stage/`, HOST, null)).toEqual(['state', 'inventory'])
  })

  it('ignores its own requests and other hosts', () => {
    expect(resourcesFor(`${ORIGIN}/api/v2/state/?${OWN_MARK}`, HOST, '7')).toEqual([])
    expect(resourcesFor('https://vortex.worldofwarships.asia/api/v2/state/', HOST, '7')).toEqual([])
    expect(resourcesFor(`${ORIGIN}/static/main.js`, HOST, '7')).toEqual([])
  })
})

describe('sync', () => {
  it('loads state, every listed operation and the inventory with read-only GETs', async () => {
    const f = fake(responses)
    const sync = new Sync(f.host)
    sync.start()
    await f.tick()
    expect(f.requests.every(r => r.endsWith(`?${OWN_MARK}`))).toBe(true)
    expect(f.requests.map(r => r.split('?')[0]).sort()).toEqual(['/api/v2/inventory/', '/api/v2/operation/7/', '/api/v2/operation/8/', '/api/v2/state/'])
    const last = f.snapshots.at(-1)!
    expect(Object.keys(last.operations).sort()).toEqual(['7', '8'])
    expect(last.state?.timestamp).toBe(5)
    expect(last.inventory?.cards).toHaveLength(1)
    expect(last.realm).toBe('sg')
    expect(last.error).toBeNull()
  })

  it('refetches only what the game touched', async () => {
    const f = fake(responses)
    const sync = new Sync(f.host)
    sync.start()
    await f.tick()
    f.requests.length = 0
    sync.observe(`${ORIGIN}/api/v2/keypoint/start/`)
    await f.tick()
    expect(f.requests.map(r => r.split('?')[0]).sort()).toEqual(['/api/v2/inventory/', '/api/v2/operation/7/', '/api/v2/state/'])
  })

  it('follows the game route', async () => {
    const f = fake(responses)
    const sync = new Sync(f.host)
    sync.start()
    await f.tick()
    f.path.value = '/zh-sg/operations/8/42'
    sync.checkRoute()
    await f.tick()
    expect(f.snapshots.at(-1)!.route).toEqual({ lang: 'zh-sg', operationId: '8', keypointId: '42' })
    expect(sync.current()).toBe('8')
  })

  it('reports a logged-out player without touching private endpoints', async () => {
    const f = fake({ '/api/v2/state/': { result: { status: { state: 'unauth', operationId: null }, operations: [] } } })
    const sync = new Sync(f.host)
    sync.start()
    await f.tick()
    expect(f.requests.map(r => r.split('?')[0])).toEqual(['/api/v2/state/'])
    expect(f.snapshots.at(-1)!.error).toBe('unauth')
  })

  it('never builds a path from an unsafe route segment', async () => {
    const f = fake(responses)
    f.path.value = '/en/operations/..%2F..%2Fadmin/1'
    const sync = new Sync(f.host)
    sync.start()
    await f.tick()
    expect(f.requests.some(r => r.includes('admin'))).toBe(false)
  })
})
