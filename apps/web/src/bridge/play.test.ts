import { describe, expect, it } from 'vitest'
import type { ApiOperation, ApiState } from '../live/api.ts'
import { DriveError } from './drive.ts'
import { Player, type PlayDriver, type PlayHost } from './play.ts'
import type { PlayRequest, PlaySlot, Snapshot } from './protocol.ts'
import { advanceableStage, battleSlots, openOperation, playableKeypoint } from './rules.ts'

const operation: ApiOperation = {
  id: 7,
  name: 'op1',
  isStarted: true,
  stages: [
    {
      id: 1,
      isActive: true,
      keypoints: [
        { id: 'k1', status: 'revealed' },
        { id: 'k2', status: 'cleared' },
      ],
    },
    { id: 2, keypoints: [{ id: 'k3', status: 'unrevealed' }] },
  ],
}

const state: ApiState = { status: { state: 'in_operation', operationId: 7, stageId: 1, accountId: null, accountNickname: null }, operations: [{ id: 7, name: 'op1' }] }
const idle: ApiState = { ...state, status: { ...state.status, state: 'idle', operationId: null } }
const cleared: ApiOperation = {
  ...operation,
  stages: [{ ...operation.stages[0]!, condition: { type: 'defeat_vehicles', target: 3, total: 3 } }, operation.stages[1]!],
}

function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return {
    at: 1,
    host: 'pacificfront.worldofwarships.asia',
    realm: 'sg',
    build: 'b1',
    settings: null,
    state,
    operations: { '7': operation },
    inventory: null,
    route: { lang: 'zh-sg', operationId: '7', keypointId: null },
    error: null,
    ...patch,
  }
}

interface Call {
  readonly kind: 'battle' | 'advance'
  readonly args: readonly unknown[]
}

function host(patch: Partial<PlayHost> = {}, fail: Error | null = null) {
  const calls: Call[] = []
  const played: string[] = []
  const driver: PlayDriver = {
    battle: async (...args) => {
      calls.push({ kind: 'battle', args })
      if (fail) throw fail
    },
    advance: async (...args) => {
      calls.push({ kind: 'advance', args })
      if (fail) throw fail
    },
  }
  const player = new Player({ snapshot: () => snapshot(), loader: 2, driver, label: () => 'NimitzPF', played: id => played.push(id), ...patch })
  return { player, calls, played }
}

const slots: (PlaySlot | null)[] = [{ cardCode: 'card_7', modifiers: ['teamwork', 'sea-dog'] }, null, { cardCode: 'card_3' }]
const request = { kind: 'battle', operationId: '7', keypointId: 'k1', slots } satisfies PlayRequest

describe('battle setup', () => {
  it('pads to four lanes and keeps the modifier order', () => {
    expect(battleSlots(slots)).toEqual([{ cardCode: 'card_7', modifiers: ['teamwork', 'sea-dog'] }, null, { cardCode: 'card_3' }, null])
    expect(battleSlots([{ cardCode: 'card_1', modifiers: [] }])).toEqual([{ cardCode: 'card_1' }, null, null, null])
  })

  it('refuses anything that is not a plain lineup', () => {
    expect(battleSlots([])).toBeNull()
    expect(battleSlots([null, null])).toBeNull()
    expect(battleSlots([{ cardCode: 'card_1' }, { cardCode: 'card_1' }])).toBeNull()
    expect(battleSlots([{ cardCode: '../x' }])).toBeNull()
    expect(battleSlots([{ cardCode: 'card_1', modifiers: ['a', 'b', 'c'] }])).toBeNull()
    expect(battleSlots([{ cardCode: 'card_1', modifiers: ['Teamwork'] }])).toBeNull()
    expect(battleSlots([{ cardCode: 'card_1', modifiers: ['teamwork', 'teamwork'] }])).toBeNull()
    expect(battleSlots(Array.from({ length: 5 }, (_, i) => ({ cardCode: `card_${i}` })))).toBeNull()
    expect(battleSlots('card_1')).toBeNull()
  })
})

describe('what can be played', () => {
  it('allows the running operation, or any open one when nothing is running', () => {
    expect(openOperation(snapshot(), '7')).toBe(operation)
    expect(openOperation(snapshot({ state: idle, operations: { '7': { ...operation, isStarted: false } } }), '7')).not.toBeNull()
    expect(openOperation(snapshot({ operations: { '7': operation, '8': { ...operation, id: 8 } } }), '8')).toBeNull()
    expect(openOperation(snapshot({ operations: { '7': { ...operation, isFinished: true } } }), '7')).toBeNull()
    expect(openOperation(snapshot({ state: { ...idle, operations: [{ id: 7, name: 'op1', isAllowed: false }] } }), '7')).toBeNull()
  })

  it('only allows revealed key points of the active stage', () => {
    expect(playableKeypoint(snapshot(), '7', 'k1')).toBe('k1')
    expect(playableKeypoint(snapshot(), '7', 'k2')).toBeNull()
    expect(playableKeypoint(snapshot(), '7', 'k3')).toBeNull()
    const unstarted: ApiOperation = { ...operation, isStarted: false, stages: operation.stages.map(s => ({ ...s, isActive: false })) }
    expect(playableKeypoint(snapshot({ state: idle, operations: { '7': unstarted } }), '7', 'k1')).toBe('k1')
  })

  it('moves to the next stage only once the goal is met', () => {
    expect(advanceableStage(snapshot({ operations: { '7': cleared } }), '7', '1')).toBe(true)
    expect(advanceableStage(snapshot(), '7', '1')).toBe(false)
    expect(advanceableStage(snapshot({ operations: { '7': cleared } }), '7', '2')).toBe(false)
    expect(advanceableStage(snapshot({ operations: { '7': { ...cleared, stages: [cleared.stages[0]!] } } }), '7', '1')).toBe(false)
  })
})

describe('playing through the game screen', () => {
  it('hands the lineup to the driver and never sends anything itself', async () => {
    const { player, calls, played } = host()
    expect(await player.play(request)).toEqual({ ok: true, error: null, step: null, detail: null })
    expect(calls).toEqual([{ kind: 'battle', args: ['7', 'k1', [...slots, null], 'NimitzPF'] }])
    expect(played).toEqual(['7'])
  })

  it('moves stages through the driver', async () => {
    const { player, calls } = host({ snapshot: () => snapshot({ operations: { '7': cleared } }) })
    expect(await player.play({ kind: 'advance', operationId: '7', stageId: '1' })).toMatchObject({ ok: true })
    expect(calls).toEqual([{ kind: 'advance', args: ['7', 'NimitzPF'] }])
    expect(await player.play({ kind: 'advance', operationId: '7', stageId: '1' })).toMatchObject({ ok: false, error: 'stale' })
  })

  it('stays read-only for scripts and bookmarks from before auto play', async () => {
    const { player, calls } = host({ loader: 1 })
    expect(await player.play(request)).toMatchObject({ ok: false, error: 'loader' })
    expect(calls).toHaveLength(0)
  })

  it('never plays the same key point twice or two at once', async () => {
    const { player, calls } = host()
    const [first, second] = await Promise.all([player.play(request), player.play(request)])
    expect(first.ok).toBe(true)
    expect(second).toMatchObject({ ok: false, error: 'busy' })
    expect(await player.play(request)).toMatchObject({ ok: false, error: 'stale' })
    expect(calls).toHaveLength(1)
  })

  it('checks the target before touching the game', async () => {
    const { player, calls } = host()
    expect(await player.play({ ...request, keypointId: 'k2' })).toMatchObject({ ok: false, error: 'stale' })
    expect(await player.play({ ...request, operationId: '7/../x' })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await player.play({ ...request, slots: [null, null, null, null] })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await player.play({ kind: 'start', operationId: '7' })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await player.play(null)).toMatchObject({ ok: false, error: 'invalid' })
    expect(calls).toHaveLength(0)
  })

  it('reports which step got stuck', async () => {
    expect(await host({}, new DriveError('modifier', 'focused')).player.play(request)).toEqual({ ok: false, error: 'ui', step: 'modifier', detail: 'focused' })
    expect(await host({}, new DriveError('battle', 'rejected')).player.play(request)).toMatchObject({ ok: false, error: 'rejected', step: 'battle' })
    expect(await host({}, new DriveError('aborted')).player.play(request)).toMatchObject({ ok: false, error: 'aborted' })
    expect(await host({}, new Error('boom')).player.play(request)).toMatchObject({ ok: false, error: 'ui', detail: 'boom' })
  })
})
