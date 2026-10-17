import type { PlanResult } from '@nimitzpf/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlayRequest, PlayResult, Snapshot } from '../bridge/protocol.ts'
import type { Operation } from '../state/derive.ts'
import type { ApiStatus } from './api.ts'
import type { PlacementDraft } from '../state/model.ts'
import demo from './fixtures/demo.json' with { type: 'json' }

const { bridge, solver } = vi.hoisted(() => ({
  bridge: { plays: [] as PlayRequest[], refreshes: 0, halts: 0, next: null as PlayResult | null, pending: null as Promise<PlayResult> | null },
  solver: { revision: 1, deep: 0 },
}))

vi.mock('./channel.ts', () => ({
  play: (request: PlayRequest) => {
    bridge.plays.push(request)
    return bridge.pending ?? Promise.resolve(bridge.next)
  },
  send: (message: { type: string }) => {
    if (message.type === 'refresh') bridge.refreshes++
    if (message.type === 'halt') bridge.halts++
  },
}))

vi.mock('../solver/plan.ts', async () => {
  const { create } = await import('zustand')
  return {
    usePlan: create(() => ({ result: null, status: 'idle', revision: -1, operation: null, deep: false, elapsedMs: 0, error: null })),
    requestSolve: (deep: boolean) => {
      if (deep) solver.deep++
    },
    solveRevision: () => solver.revision,
  }
})

const saved = new Map<string, string>()
vi.stubGlobal('window', globalThis)
vi.stubGlobal('localStorage', {
  getItem: (name: string) => saved.get(name) ?? null,
  setItem: (name: string, value: string) => void saved.set(name, value),
  removeItem: (name: string) => void saved.delete(name),
})

type Auto = typeof import('./autoplay.ts')
type Live = typeof import('./store.ts')
type Plan = typeof import('../solver/plan.ts')
type Store = (typeof import('../state/store.ts'))['useStore']

const GAME = '8e451615-25bd-432a-8a56-0d519e38ee4f'
const OTHER = '816b95da-6938-4fdf-8d55-8372876d7a67'
const empty: PlacementDraft = { card: null, standard: null, special: null }
const base = demo as unknown as Snapshot

let auto: Auto
let live: Live
let planStore: Plan['usePlan']
let store: Store

function op(id = GAME): Operation {
  const found = live.liveOperations(live.useLive.getState().snapshot, [], store.getState().rewardWeights, null).get(id)!
  return { ...found, overrides: store.getState().overrides[id] ?? {} }
}

function lineup(...cards: (string | PlacementDraft | null)[]): PlacementDraft[] {
  const lanes = cards.map(c => (typeof c === 'string' ? { card: c, standard: null, special: null } : (c ?? empty)))
  while (lanes.length < 4) lanes.push(empty)
  return lanes
}

function planFor(keypoints: Record<string, PlacementDraft[]>): PlanResult {
  return { stages: [{ index: 0, keypoints: Object.entries(keypoints).map(([id, lanes]) => ({ id, stage: 0, attack: true, lanes })) }] } as unknown as PlanResult
}

function setPlan(result: PlanResult | null, patch: Record<string, unknown> = {}) {
  planStore.setState({ result, status: 'done', revision: solver.revision, operation: GAME, deep: true, error: null, ...patch })
}

function stageKeypoints(): string[] {
  return op().state.stages[0]!.keypoints.map(k => k.id)
}

function stocked(effectiveness: number, supplies?: number): Snapshot {
  const inventory = base.inventory!
  const modifiers = inventory.modifiers!.map(m => (m.id === 'effectiveness' ? { ...m, amount: effectiveness } : m))
  return { ...base, at: Date.now(), inventory: { ...inventory, modifiers, ...(supplies !== undefined && { currencies: { eventum_1: supplies } }) } }
}

function boosted(card: string): PlacementDraft {
  return { card, standard: 'effectiveness', special: null }
}

interface Shape {
  readonly status?: Readonly<Record<string, string>>
  readonly active?: number
  readonly kills?: number
  readonly state?: Partial<ApiStatus>
}

function gameSnapshot(shape: Shape = {}): Snapshot {
  const game = base.operations[GAME]!
  const active = shape.active ?? game.stages.findIndex(s => s.isActive)
  const stages = game.stages.map((s, i) => ({
    ...s,
    isActive: i === active,
    isFinished: i < active,
    ...(i === active && shape.kills !== undefined && { condition: { type: 'defeat_vehicles', target: s.condition?.target ?? 8, total: shape.kills } }),
    keypoints: s.keypoints?.map(k => ({ ...k, status: shape.status?.[String(k.id)] ?? (i === active && k.status === 'unrevealed' ? 'revealed' : k.status) })),
  }))
  const state = base.state!
  return { ...base, at: Date.now(), state: { ...state, status: { ...state.status, ...shape.state } }, operations: { ...base.operations, [GAME]: { ...game, stages } } }
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

beforeEach(async () => {
  vi.resetModules()
  saved.clear()
  bridge.plays.length = 0
  bridge.refreshes = 0
  bridge.halts = 0
  bridge.pending = null
  bridge.next = { ok: true, error: null, step: null, detail: null }
  solver.revision = 1
  solver.deep = 0
  auto = await import('./autoplay.ts')
  live = await import('./store.ts')
  planStore = (await import('../solver/plan.ts')).usePlan
  store = (await import('../state/store.ts')).useStore
  live.receiveSnapshot({ ...base, at: 1 }, 'live')
  live.useLive.setState({ bridge: { protocol: 3, loader: 2 } })
  store.getState().setAutoplay(true)
})

afterEach(() => {
  auto.stopAuto()
  vi.useRealTimers()
})

describe('readiness', () => {
  it('needs a live game and a bridge loaded by a new script or bookmark', () => {
    expect(auto.readiness('live', { protocol: 2, loader: 2 })).toBe('ready')
    expect(auto.readiness('demo', { protocol: 2, loader: 2 })).toBe('demo')
    expect(auto.readiness('unauth', { protocol: 2, loader: 2 })).toBe('offline')
    expect(auto.readiness('live', null)).toBe('old-bridge')
    expect(auto.readiness('live', { protocol: 1, loader: 1 })).toBe('old-bridge')
    expect(auto.readiness('live', { protocol: 2, loader: 1 })).toBe('old-loader')
    expect(auto.canBuy({ protocol: 2, loader: 2 })).toBe(false)
    expect(auto.canBuy({ protocol: 3, loader: 2 })).toBe(true)
    expect(auto.canBuy(null)).toBe(false)
  })

  it('remembers whether an old copy is the userscript or a bookmark', () => {
    const hello = { type: 'hello', protocol: 2, loader: 1, host: 'h', realm: 'sg', engine: null } as const
    live.receive({ ...hello, script: '1.2.0' })
    expect(live.useLive.getState().bridge).toEqual({ protocol: 2, loader: 1, script: '1.2.0' })
    live.receive({ ...hello, script: null })
    expect(live.useLive.getState().bridge).toEqual({ protocol: 2, loader: 1, script: null })
    live.receive(hello)
    expect(live.useLive.getState().bridge).toEqual({ protocol: 2, loader: 1 })
  })
})

describe('lineups', () => {
  it('turns placements into game slots with standard before special', () => {
    expect(auto.playSlots(lineup({ card: 'card_7', standard: 'gunners-training', special: 'sea-dog' }, null, 'card_3'))).toEqual([
      { cardCode: 'card_7', modifiers: ['gunners-training', 'sea-dog'] },
      null,
      { cardCode: 'card_3' },
      null,
    ])
  })

  it('only lets through lineups the game would take', () => {
    const [k1] = stageKeypoints()
    const snapshot = live.useLive.getState().snapshot
    expect(auto.lineupProblem(op(), snapshot, k1!, lineup('card_7'))).toBeNull()
    expect(auto.lineupProblem(op(OTHER), snapshot, op(OTHER).state.stages[0]!.keypoints[0]!.id, lineup('card_7'))).toBe('not-in-game')
    expect(auto.lineupProblem(op(), snapshot, op().state.stages[1]!.keypoints[0]!.id, lineup('card_7'))).toBe('not-open')
    expect(auto.lineupProblem(op(), snapshot, k1!, lineup())).toBe('empty')
    expect(auto.lineupProblem(op(), snapshot, k1!, lineup('card_7', 'card_7'))).toBe('card')
    expect(auto.lineupProblem(op(), snapshot, k1!, lineup('card_99'))).toBe('card')
    expect(auto.lineupProblem(op(), snapshot, k1!, lineup({ card: 'card_7', standard: 'teamwork', special: null }))).toBe('modifier')
    const rudder = (card: string): PlacementDraft => ({ card, standard: 'rudder-crew-training', special: null })
    expect(auto.lineupProblem(op(), snapshot, k1!, lineup(rudder('card_7')))).toBeNull()
    expect(auto.lineupProblem(op(), snapshot, k1!, lineup(rudder('card_7'), rudder('card_3')))).toBe('modifier')
  })

  it('lets auto-buy cover a short effectiveness stock while the supplies last', () => {
    const [k1] = stageKeypoints()
    const two = lineup(boosted('card_7'), boosted('card_3'))
    const four = lineup(boosted('card_7'), boosted('card_3'), boosted('card_8'), boosted('card_9'))
    live.receiveSnapshot(stocked(1, 40), 'live')
    const snapshot = live.useLive.getState().snapshot
    expect(auto.lineupProblem(op(), snapshot, k1!, two)).toBe('modifier')
    expect(auto.lineupProblem(op(), snapshot, k1!, two, true)).toBeNull()
    expect(auto.lineupProblem(op(), snapshot, k1!, four, true)).toBe('funds')
    expect(auto.lineupProblem(op(), snapshot, k1!, lineup({ card: 'card_7', standard: 'teamwork', special: null }), true)).toBe('modifier')
    live.receiveSnapshot(stocked(1), 'live')
    expect(auto.lineupProblem(op(), live.useLive.getState().snapshot, k1!, four, true)).toBeNull()
    expect(auto.shortfall(op(), four)).toBe(3)
    expect(auto.battleRequest(op(), k1!, two, true)).toEqual({
      kind: 'battle',
      operationId: GAME,
      keypointId: k1,
      slots: [{ cardCode: 'card_7', modifiers: ['effectiveness'] }, { cardCode: 'card_3', modifiers: ['effectiveness'] }, null, null],
      buy: ['effectiveness'],
    })
    expect(auto.battleRequest(op(), k1!, two, false)).not.toHaveProperty('buy')
    expect(auto.battleRequest(op(), k1!, lineup('card_7'), true)).not.toHaveProperty('buy')
    live.receiveSnapshot(stocked(2), 'live')
    expect(auto.battleRequest(op(), k1!, two, true)).not.toHaveProperty('buy')
  })

  it('remembers running out of supplies until the wallet grows or auto-buy is switched', () => {
    store.getState().setEffectiveness(true)
    store.getState().setAutoBuy(true)
    live.receiveSnapshot(stocked(0, 30), 'live')
    expect(live.buyingNow()).toBe(true)
    const revision = live.useLive.getState().revision
    live.markBroke()
    expect(live.useLive.getState().revision).toBe(revision + 1)
    expect(live.buyingNow()).toBe(false)
    live.receiveSnapshot(stocked(0, 20), 'live')
    expect(live.buyingNow()).toBe(false)
    live.receiveSnapshot(stocked(0, 80), 'live')
    expect(live.buyingNow()).toBe(true)
    live.receiveSnapshot(stocked(0), 'live')
    live.markBroke()
    expect(live.buyingNow()).toBe(false)
    live.receiveSnapshot(stocked(0, 20), 'live')
    expect(live.buyingNow()).toBe(true)
    live.receiveSnapshot(stocked(0), 'live')
    live.markBroke()
    live.clearBroke()
    expect(live.buyingNow()).toBe(true)
  })

  it('picks the first revealed key point that has units on it, overrides first', () => {
    const [k1, k2] = stageKeypoints()
    expect(auto.nextTarget(op(), planFor({ [k1!]: lineup(), [k2!]: lineup('card_3') }))).toBe(k2)
    store.getState().setPlacements(GAME, k1!, lineup('card_7'))
    expect(auto.nextTarget(op(), planFor({ [k1!]: lineup(), [k2!]: lineup('card_3') }))).toBe(k1)
    expect(auto.nextTarget(op(), null)).toBe(k1)
  })
})

describe('auto play run', () => {
  it('plays the stage, moves on once the goal is met and keeps going', async () => {
    vi.useFakeTimers()
    const [k1, k2, k3] = stageKeypoints()
    const firstStage = String(base.operations[GAME]!.stages[0]!.id)
    setPlan(planFor({ [k1!]: lineup('card_7'), [k2!]: lineup('card_3'), [k3!]: lineup() }))
    auto.startAuto()
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ running: true, phase: 'countdown', action: 'battle', target: k1 })
    expect(store.getState().selection.keypoint).toBe(k1)

    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(bridge.plays).toEqual([{ kind: 'battle', operationId: GAME, keypointId: k1, slots: [{ cardCode: 'card_7' }, null, null, null] }])
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'waiting', target: k1 })
    await vi.advanceTimersByTimeAsync(2600)
    expect(bridge.refreshes).toBeGreaterThan(0)

    solver.revision = 2
    live.receiveSnapshot(gameSnapshot({ status: { [k1!]: 'cleared' } }), 'live')
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'thinking', played: 1 })

    setPlan(planFor({ [k2!]: lineup('card_3'), [k3!]: lineup() }), { status: 'solving' })
    await flush()
    expect(auto.useAuto.getState().phase).toBe('thinking')
    setPlan(planFor({ [k2!]: lineup('card_3'), [k3!]: lineup() }), { deep: false })
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'countdown', target: k2 })
    expect(solver.deep).toBe(0)

    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    solver.revision = 3
    live.receiveSnapshot(gameSnapshot({ status: { [k1!]: 'cleared', [k2!]: 'cleared' }, kills: 8 }), 'live')
    setPlan(planFor({ [k3!]: lineup() }))
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'countdown', action: 'advance', stage: 2, played: 2 })

    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(bridge.plays[2]).toEqual({ kind: 'advance', operationId: GAME, stageId: firstStage })
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'waiting', action: 'advance' })

    solver.revision = 4
    live.receiveSnapshot(gameSnapshot({ active: 1 }), 'live')
    const next = op().state.stages[1]!.keypoints[0]!.id
    setPlan(planFor({ [next]: lineup('card_7') }))
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'countdown', action: 'battle', target: next, played: 2 })
  })

  it('stops after the last stage and leaves the rewards to the player', async () => {
    const last = base.operations[GAME]!.stages.length - 1
    const done = Object.fromEntries(base.operations[GAME]!.stages[last]!.keypoints!.map(k => [String(k.id), 'cleared']))
    live.receiveSnapshot(gameSnapshot({ active: last, status: done, state: { isOperationReadyToComplete: true } }), 'live')
    setPlan(planFor({}))
    auto.startAuto()
    await flush()
    expect(bridge.plays).toHaveLength(0)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'done', key: 'autoAllDone', params: { n: 0 } } })
  })

  it('also stops as done once the server has closed the last stage', async () => {
    const stages = base.operations[GAME]!.stages
    const done = Object.fromEntries(stages.flatMap(s => s.keypoints!.map(k => [String(k.id), 'cleared'])))
    live.receiveSnapshot(gameSnapshot({ active: stages.length, status: done }), 'live')
    setPlan(planFor({}))
    auto.startAuto()
    await flush()
    expect(bridge.plays).toHaveLength(0)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'done', key: 'autoAllDone' } })
  })

  it('does not skip a planned key point that cannot be played yet', async () => {
    const [k1, k2, k3] = stageKeypoints()
    live.receiveSnapshot(gameSnapshot({ status: { [k1!]: 'cleared', [k2!]: 'cleared', [k3!]: 'unrevealed' }, kills: 8 }), 'live')
    setPlan(planFor({ [k3!]: lineup('card_7') }))
    auto.startAuto()
    await flush()
    expect(bridge.plays).toHaveLength(0)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'error', key: 'autoHeld', params: { stage: 1, n: 3 } } })
  })

  it('does not move on when the inventory never loaded', async () => {
    live.receiveSnapshot({ ...gameSnapshot({ kills: 8 }), inventory: null }, 'live')
    setPlan(planFor({}))
    auto.startAuto()
    await flush()
    expect(bridge.plays).toHaveLength(0)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'error', key: 'autoSyncSlow' } })
  })

  it('keeps waiting for its own battle when another operation gets selected', async () => {
    vi.useFakeTimers()
    const [k1] = stageKeypoints()
    setPlan(planFor({ [k1!]: lineup('card_7') }))
    auto.startAuto()
    await flush()
    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'waiting', target: k1 })
    store.getState().select({ operation: OTHER, keypoint: null, lane: null })
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'waiting', target: k1 })
    expect(bridge.plays).toHaveLength(1)
  })

  it('does not move on while the stage goal is still open', async () => {
    const done = Object.fromEntries(stageKeypoints().map(k => [k, 'cleared']))
    live.receiveSnapshot(gameSnapshot({ status: done, kills: 3 }), 'live')
    setPlan(planFor({}))
    auto.startAuto()
    await flush()
    expect(bridge.plays).toHaveLength(0)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'error', key: 'autoStuck', params: { stage: 1 } } })
  })

  it('plays an operation that has not started yet', async () => {
    vi.useFakeTimers()
    live.receiveSnapshot(gameSnapshot({ state: { state: 'idle', operationId: null } }), 'live')
    store.getState().select({ operation: OTHER, keypoint: null, lane: null })
    const snapshot = live.useLive.getState().snapshot
    expect(auto.runPlan(snapshot, op(OTHER))).toEqual({ operation: OTHER, hint: 'autoIdleNotStarted' })
    expect(auto.runPlan(snapshot, { ...op(OTHER), finished: true })).toMatchObject({ operation: null })
    const first = op(OTHER).state.stages[0]!.keypoints[0]!.id
    expect(auto.lineupProblem(op(OTHER), snapshot, first, lineup('card_7'))).toBeNull()
    planStore.setState({ result: planFor({ [first]: lineup('card_7') }), status: 'done', revision: solver.revision, operation: OTHER, deep: true, error: null })
    auto.startAuto()
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'countdown', action: 'battle', target: first })
    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(bridge.plays).toEqual([{ kind: 'battle', operationId: OTHER, keypointId: first, slots: [{ cardCode: 'card_7' }, null, null, null] }])
  })

  it('tells the game to stop when the run is stopped mid-step', async () => {
    vi.useFakeTimers()
    const [k1] = stageKeypoints()
    setPlan(planFor({ [k1!]: lineup('card_7') }))
    let release: (r: PlayResult) => void = () => undefined
    bridge.pending = new Promise<PlayResult>(r => (release = r))
    auto.startAuto()
    await flush()
    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(auto.useAuto.getState().phase).toBe('playing')
    auto.stopAuto()
    expect(bridge.halts).toBe(1)
    release({ ok: false, error: 'aborted', step: 'aborted', detail: null })
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ running: false, phase: 'idle', note: { key: 'autoErrAborted' } })
  })

  it('stops without playing when the lineup changes under the countdown', async () => {
    vi.useFakeTimers()
    const [k1] = stageKeypoints()
    setPlan(planFor({ [k1!]: lineup('card_7') }))
    auto.startAuto()
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    store.getState().setPlacements(GAME, k1!, lineup('card_3'))
    await flush()
    await vi.advanceTimersByTimeAsync(2500)
    expect(bridge.plays).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(bridge.plays[0]).toMatchObject({ kind: 'battle', slots: [{ cardCode: 'card_3' }, null, null, null] })
  })

  it('stops with the reason when the bridge refuses', async () => {
    vi.useFakeTimers()
    const [k1] = stageKeypoints()
    setPlan(planFor({ [k1!]: lineup('card_7') }))
    bridge.next = { ok: false, error: 'ui', step: 'modifier', detail: 'focused' }
    auto.startAuto()
    await flush()
    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, phase: 'idle', note: { tone: 'error', key: 'autoErrUi', step: 'modifier', detail: 'focused' } })
  })

  it('tops up the missing effectiveness on the way into the battle', async () => {
    vi.useFakeTimers()
    store.getState().setEffectiveness(true)
    store.getState().setAutoBuy(true)
    live.receiveSnapshot(stocked(0, 100), 'live')
    const [k1] = stageKeypoints()
    setPlan(planFor({ [k1!]: lineup(boosted('card_7'), 'card_3') }))
    auto.startAuto()
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'countdown', target: k1, buying: 1 })
    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(bridge.plays[0]).toEqual({
      kind: 'battle',
      operationId: GAME,
      keypointId: k1,
      slots: [{ cardCode: 'card_7', modifiers: ['effectiveness'] }, { cardCode: 'card_3' }, null, null],
      buy: ['effectiveness'],
    })
  })

  it('stops before the battle when the supplies cannot cover the missing effectiveness', async () => {
    store.getState().setEffectiveness(true)
    store.getState().setAutoBuy(true)
    live.receiveSnapshot(stocked(0, 10), 'live')
    const [k1] = stageKeypoints()
    setPlan(planFor({ [k1!]: lineup(boosted('card_7')) }))
    auto.startAuto()
    await flush()
    expect(bridge.plays).toHaveLength(0)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'error', key: 'autoNoFunds', params: { stage: 1, n: 1 } } })
  })

  it('asks for a page reload before buying with a bridge that cannot buy yet', async () => {
    store.getState().setEffectiveness(true)
    store.getState().setAutoBuy(true)
    live.useLive.setState({ bridge: { protocol: 2, loader: 2 } })
    live.receiveSnapshot(stocked(0, 100), 'live')
    const [k1, k2] = stageKeypoints()
    await auto.playNow(op(), k1!, lineup(boosted('card_7')))
    expect(bridge.plays).toHaveLength(0)
    expect(auto.useAuto.getState().note).toMatchObject({ tone: 'error', key: 'autoOldBridge' })
    await auto.playNow(op(), k2!, lineup('card_7'))
    expect(bridge.plays).toHaveLength(1)
    setPlan(planFor({ [k1!]: lineup(boosted('card_7')) }))
    auto.startAuto()
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'error', key: 'autoOldBridge' } })
    expect(bridge.plays).toHaveLength(1)
  })

  it('does not buy unless auto-buy is ticked', async () => {
    store.getState().setEffectiveness(true)
    live.receiveSnapshot(stocked(0, 100), 'live')
    const [k1] = stageKeypoints()
    setPlan(planFor({ [k1!]: lineup(boosted('card_7')) }))
    auto.startAuto()
    await flush()
    expect(bridge.plays).toHaveLength(0)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'error', key: 'autoBadModifier' } })
  })

  it('stops buying and keeps playing once the game says the supplies ran out', async () => {
    vi.useFakeTimers()
    store.getState().setEffectiveness(true)
    store.getState().setAutoBuy(true)
    live.receiveSnapshot(stocked(0), 'live')
    const [k1] = stageKeypoints()
    setPlan(planFor({ [k1!]: lineup(boosted('card_7'), 'card_3') }))
    bridge.next = { ok: false, error: 'funds', step: 'buy', detail: 'funds' }
    live.useLive.subscribe(s => {
      if (s.broke) solver.revision = 2
    })
    auto.startAuto()
    await flush()
    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(bridge.plays[0]).toMatchObject({ buy: ['effectiveness'] })
    expect(auto.useAuto.getState()).toMatchObject({ running: true, phase: 'thinking', note: { tone: 'info', key: 'autoBrokeGoOn' } })
    expect(live.isBroke(live.useLive.getState())).toBe(true)
    expect(live.buyingNow()).toBe(false)

    bridge.next = { ok: true, error: null, step: null, detail: null }
    setPlan(planFor({ [k1!]: lineup('card_7', 'card_3') }))
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ running: true, phase: 'countdown', target: k1, buying: 0 })
    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(bridge.plays[1]).toEqual({ kind: 'battle', operationId: GAME, keypointId: k1, slots: [{ cardCode: 'card_7' }, { cardCode: 'card_3' }, null, null] })
  })

  it('stops for good when the supplies run out again', async () => {
    vi.useFakeTimers()
    const [k1] = stageKeypoints()
    live.markBroke()
    setPlan(planFor({ [k1!]: lineup('card_7') }))
    bridge.next = { ok: false, error: 'funds', step: 'buy', detail: 'funds' }
    auto.startAuto()
    await flush()
    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'error', key: 'autoErrFunds', step: 'buy' } })
    expect(auto.useAuto.getState().note).not.toHaveProperty('detail')
  })

  it('says the game refused a purchase instead of a battle', async () => {
    vi.useFakeTimers()
    const [k1] = stageKeypoints()
    setPlan(planFor({ [k1!]: lineup('card_7') }))
    bridge.next = { ok: false, error: 'rejected', step: 'buy', detail: 'rejected' }
    auto.startAuto()
    await flush()
    await vi.advanceTimersByTimeAsync(auto.COUNTDOWN_MS)
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { tone: 'error', key: 'autoErrBuyRejected', step: 'buy' } })
    expect(auto.useAuto.getState().note).not.toHaveProperty('detail')
  })

  it('asks for another click after a single battle runs out of supplies', async () => {
    store.getState().setEffectiveness(true)
    store.getState().setAutoBuy(true)
    live.receiveSnapshot(stocked(0), 'live')
    const [k1] = stageKeypoints()
    bridge.next = { ok: false, error: 'funds', step: 'buy', detail: 'funds' }
    await auto.playNow(op(), k1!, lineup(boosted('card_7')))
    expect(bridge.plays[0]).toMatchObject({ buy: ['effectiveness'] })
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'idle', note: { tone: 'error', key: 'autoBrokeRetry' } })
    expect(live.buyingNow()).toBe(false)
    await auto.playNow(op(), k1!, lineup(boosted('card_7')))
    expect(bridge.plays).toHaveLength(1)
    expect(auto.useAuto.getState().note).toMatchObject({ tone: 'error', key: 'autoBadModifier' })
  })

  it('refuses to start battles with an old script or bookmark', async () => {
    const [k1] = stageKeypoints()
    live.useLive.setState({ bridge: { protocol: 3, loader: 1 } })
    setPlan(planFor({ [k1!]: lineup('card_7') }))
    auto.startAuto()
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ running: false, note: { key: 'autoOldLoader' } })
    expect(bridge.plays).toHaveLength(0)
  })

  it('plays a single key point on request', async () => {
    const [k1] = stageKeypoints()
    await auto.playNow(op(), k1!, lineup('card_7'))
    expect(bridge.plays).toHaveLength(1)
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'idle', note: { tone: 'done', key: 'autoPlayed' } })
    await auto.playNow(op(), k1!, lineup())
    expect(bridge.plays).toHaveLength(1)
    expect(auto.useAuto.getState().note).toMatchObject({ tone: 'error', key: 'autoEmpty' })
  })

  it('can halt a single play', async () => {
    const [k1] = stageKeypoints()
    let release: (r: PlayResult) => void = () => undefined
    bridge.pending = new Promise<PlayResult>(r => (release = r))
    const playing = auto.playNow(op(), k1!, lineup('card_7'))
    await flush()
    expect(auto.useAuto.getState()).toMatchObject({ running: false, phase: 'playing' })
    auto.stopAuto()
    expect(bridge.halts).toBe(1)
    release({ ok: false, error: 'aborted', step: 'aborted', detail: null })
    await playing
    expect(auto.useAuto.getState()).toMatchObject({ phase: 'idle', note: { key: 'autoErrAborted' } })
  })
})
