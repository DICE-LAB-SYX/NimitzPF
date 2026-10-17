import type { PlanResult } from '@nimitzpf/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '../bridge/protocol.ts'
import demo from '../live/fixtures/demo.json' with { type: 'json' }
import type { SolveOutcome, SolveTier } from './client.ts'

interface Call {
  readonly tier: SolveTier
  readonly extra: readonly PlanResult[]
  readonly resolve: (outcome: SolveOutcome) => void
}

const { calls, cancels } = vi.hoisted(() => ({ calls: [] as Call[], cancels: { count: 0 } }))

vi.mock('./client.ts', () => ({
  cancelSolve: () => {
    cancels.count++
  },
  solveInWorkers: (_state: unknown, _objective: unknown, tier: SolveTier, extra: readonly PlanResult[]) =>
    new Promise<SolveOutcome>(resolve => calls.push({ tier, extra, resolve })),
}))

const saved = new Map<string, string>()

vi.stubGlobal('window', globalThis)
vi.stubGlobal('localStorage', {
  getItem: (name: string) => saved.get(name) ?? null,
  setItem: (name: string, value: string) => void saved.set(name, value),
  removeItem: (name: string) => void saved.delete(name),
})

type Plan = typeof import('./plan.ts')
type Store = (typeof import('../state/store.ts'))['useStore']

let plan: Plan
let store: Store

function outcome(name: string, truncated = false): SolveOutcome {
  return { result: { name, truncated } as unknown as PlanResult, elapsedMs: 10 }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function tiers(): SolveTier[] {
  return calls.map(c => c.tier)
}

beforeEach(async () => {
  vi.resetModules()
  calls.length = 0
  cancels.count = 0
  plan = await import('./plan.ts')
  store = (await import('../state/store.ts')).useStore
  const live = await import('../live/store.ts')
  live.receiveSnapshot(demo as unknown as Snapshot)
  store.setState({ revision: 1 })
})

describe('solve requests', () => {
  it('runs quick before deep and keeps the quick plan as a deep candidate', async () => {
    const quick = outcome('quick')
    const deep = outcome('deep')
    plan.requestSolve(true)
    expect(tiers()).toEqual(['quick'])
    calls[0]!.resolve(quick)
    await flush()
    expect(plan.usePlan.getState()).toMatchObject({ status: 'solving', result: quick.result })
    expect(calls[1]).toMatchObject({ tier: 'deep', extra: [quick.result] })
    calls[1]!.resolve(deep)
    await flush()
    expect(plan.usePlan.getState()).toMatchObject({ status: 'done', deep: true, result: deep.result, elapsedMs: 20 })
  })

  it('reuses a running quick solve when a deep solve is requested', async () => {
    const quick = outcome('quick')
    const deep = outcome('deep')
    plan.requestSolve(false)
    plan.requestSolve(true)
    expect(tiers()).toEqual(['quick'])
    expect(cancels.count).toBe(0)
    calls[0]!.resolve(quick)
    await flush()
    expect(calls[1]).toMatchObject({ tier: 'deep', extra: [quick.result] })
    calls[1]!.resolve(deep)
    await flush()
    expect(plan.usePlan.getState()).toMatchObject({ status: 'done', deep: true, result: deep.result })
    store.setState({ revision: 2 })
    plan.requestSolve(false)
    expect(calls).toHaveLength(2)
    expect(plan.usePlan.getState()).toMatchObject({ status: 'done', deep: true, result: deep.result, revision: plan.solveRevision() })
  })

  it('builds deep on the memoized quick plan', async () => {
    const quick = outcome('quick')
    plan.requestSolve(false)
    calls[0]!.resolve(quick)
    await flush()
    expect(plan.usePlan.getState()).toMatchObject({ status: 'done', deep: false, result: quick.result })
    plan.requestSolve(true)
    await flush()
    expect(tiers()).toEqual(['quick', 'deep'])
    expect(calls[1]!.extra).toEqual([quick.result])
  })

  it('lets a quick request for the same state join a running deep solve', async () => {
    const quick = outcome('quick')
    const deep = outcome('deep')
    plan.requestSolve(true)
    plan.requestSolve(false)
    calls[0]!.resolve(quick)
    await flush()
    plan.requestSolve(false)
    expect(tiers()).toEqual(['quick', 'deep'])
    expect(cancels.count).toBe(0)
    calls[1]!.resolve(deep)
    await flush()
    expect(plan.usePlan.getState()).toMatchObject({ status: 'done', deep: true, result: deep.result })
  })

  it('shows the quick plan while a joined deep solve runs', async () => {
    const quick = outcome('quick')
    plan.requestSolve(true)
    plan.requestSolve(true)
    expect(tiers()).toEqual(['quick'])
    calls[0]!.resolve(quick)
    await flush()
    expect(plan.usePlan.getState()).toMatchObject({ status: 'solving', result: quick.result })
    expect(tiers()).toEqual(['quick', 'deep'])
  })

  it('does not memoize truncated plans', async () => {
    plan.requestSolve(false)
    calls[0]!.resolve(outcome('quick', true))
    await flush()
    store.setState({ revision: 2 })
    plan.requestSolve(false)
    expect(tiers()).toEqual(['quick', 'quick'])
  })
})

describe('effectiveness', () => {
  async function current() {
    const live = await import('../live/store.ts')
    return { live, op: live.currentOperation()! }
  }

  function stocked(effectiveness: number, supplies: number): Snapshot {
    const base = demo as unknown as Snapshot
    const modifiers = base.inventory!.modifiers!.map(m => (m.id === 'effectiveness' ? { ...m, amount: effectiveness } : m))
    return { ...base, inventory: { ...base.inventory!, modifiers, currencies: { eventum_1: supplies } } }
  }

  it('hands the token lanes to the solver only once it is switched on', async () => {
    const { op } = await current()
    const last = op.state.stages[3]!.keypoints[0]!.id
    expect(plan.solveState(op).boosted).toBeUndefined()
    store.getState().setEffectiveness(true)
    expect(plan.solveState(op).boosted).toEqual({ [last]: [0, 2, 3] })
  })

  it('counts what auto-buy can afford on top of the stock', async () => {
    const { live } = await current()
    live.receiveSnapshot(stocked(1, 20))
    const op = live.currentOperation()!
    const last = op.state.stages[3]!.keypoints[0]!.id
    store.getState().setEffectiveness(true)
    expect(plan.solveState(op).boosted).toEqual({ [last]: [2] })
    store.getState().setAutoBuy(true)
    expect(plan.solveState(op).boosted).toEqual({ [last]: [2] })
    store.getState().setAutoplay(true)
    expect(plan.solveState(op).boosted).toEqual({ [last]: [2, 3] })
  })
})

describe('effectiveness after the supplies ran out', () => {
  it('plans from stock only until the wallet grows again', async () => {
    const live = await import('../live/store.ts')
    const base = demo as unknown as Snapshot
    const wallet = (supplies: number): Snapshot => {
      const modifiers = base.inventory!.modifiers!.map(m => (m.id === 'effectiveness' ? { ...m, amount: 1 } : m))
      return { ...base, inventory: { ...base.inventory!, modifiers, currencies: { eventum_1: supplies } } }
    }
    store.getState().setEffectiveness(true)
    store.getState().setAutoBuy(true)
    store.getState().setAutoplay(true)
    live.receiveSnapshot(wallet(36))
    const last = live.currentOperation()!.state.stages[3]!.keypoints[0]!.id
    expect(plan.solveState(live.currentOperation()!).boosted).toEqual({ [last]: [0, 2, 3] })
    live.markBroke()
    expect(plan.solveState(live.currentOperation()!).boosted).toEqual({ [last]: [2] })
    live.receiveSnapshot(wallet(54))
    expect(plan.solveState(live.currentOperation()!).boosted).toEqual({ [last]: [0, 2, 3] })
  })
})
