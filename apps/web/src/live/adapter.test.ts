import { CARDS, solveOperation } from '@nimitzpf/core'
import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../bridge/protocol.ts'
import { activeConditions, conditionViews } from '../state/derive.ts'
import { DEFAULT_REWARD_WEIGHTS, ESTIMATE_CODE } from '../state/model.ts'
import { currentStageOf, intelFrom, LOCKED_STAGE_GOAL, rewardDraft, toLiveOperation, DEFAULT_CURRENCIES } from './adapter.ts'
import capture from './fixtures/demo.json' with { type: 'json' }
import demo from './fixtures/synthetic.json' with { type: 'json' }

const snapshot = demo as unknown as Snapshot
const ctx = { inventory: snapshot.inventory, intel: [], weights: DEFAULT_REWARD_WEIGHTS }
const op = toLiveOperation(snapshot.operations['101']!, ctx)
const preview = toLiveOperation(snapshot.operations['102']!, ctx)

function lanesOf(id: string) {
  for (const stage of op.state.stages) for (const kp of stage.keypoints) if (kp.id === id) return kp
  throw new Error(id)
}

describe('operation structure', () => {
  it('follows the active stage and maps key point statuses', () => {
    expect(op.state.currentStage).toBe(0)
    expect(op.state.stages.map(s => s.goal)).toEqual([7, 6, 4])
    expect(op.stages.map(s => s.estimated)).toEqual([false, true, true])
    expect(op.state.stages[0]!.keypoints.map(k => k.status)).toEqual(['fought', 'open', 'open'])
    expect(op.keypoints.get('1003')).toMatchObject({ number: 3, stage: 0, index: 2, difficulty: 3, revealed: true })
    expect(op.issues).toEqual([])
  })

  it('starts a preview operation at its first stage', () => {
    expect(preview.started).toBe(false)
    expect(preview.state.currentStage).toBe(0)
    expect(currentStageOf({ stages: [{ id: 1, isFinished: true }, { id: 2 }], isFinished: false })).toBe(1)
  })

  it('keeps the real enemy specs and vulnerability factors', () => {
    expect(lanesOf('1002').lanes[1]?.enemy).toEqual({ code: 'vehicle_10', type: 'destroyer', tier: 2, specs: [55, 45, 50], vulns: { 101: 0.5, 104: 1 } })
    expect(lanesOf('1003').lanes[3]).toBeNull()
  })

  it('records the lanes of a cleared key point', () => {
    expect(lanesOf('1001').record).toEqual([
      { card: 'card_7', modifiers: [], won: true },
      { card: 'card_13', modifiers: ['gunners-training'], won: true },
      { card: 'card_21', modifiers: [], won: true },
      { card: 'card_1', modifiers: [], won: false },
    ])
  })

  it('fills unrevealed key points with estimated enemies', () => {
    const hidden = lanesOf('1005')
    expect(hidden.lanes).toHaveLength(4)
    expect(hidden.lanes.every(l => l?.enemy.code === ESTIMATE_CODE)).toBe(true)
    expect(op.keypoints.get('1005')?.revealed).toBe(false)
  })

  it('takes fleet HP and modifier stock from the inventory', () => {
    expect(op.state.fleet).toHaveLength(15)
    expect(op.hp.card_3).toBe(1)
    expect(op.state.inventory).toMatchObject({ 'moral-impact': 2, 'unstoppable': 0, 'focused': 1 })
  })
})

describe('battle conditions', () => {
  const byId = new Map(op.conditions.map(c => [c.id, c]))

  it('keeps a local condition on its own key point', () => {
    expect(byId.get('e0')).toMatchObject({ scope: 'local', status: 'active', source: '1002' })
    expect(byId.get('e0')!.planned).toEqual([
      {
        id: 'e0',
        scope: 'targeted',
        source: null,
        targets: ['1002'],
        mitigable: false,
        effect: { kind: 'player-specs', specs: { 0: -0.2, 1: -0.2, 2: -0.2 }, exempt: { types: ['destroyer'] } },
      },
    ])
  })

  it('lets the solver lift pending targeted and global conditions', () => {
    expect(byId.get('e1')).toMatchObject({ scope: 'targeted', status: 'pending', removeAfter: 3 })
    expect(byId.get('e1')!.planned).toMatchObject([{ scope: 'targeted', source: '1003', targets: ['1004', '1005'], mitigable: false }])
    expect(byId.get('e2')).toMatchObject({ scope: 'global', status: 'pending', mitigable: true, weakenPercent: 10 })
    expect(byId.get('e2')!.planned).toMatchObject([{ scope: 'global', source: '1003', mitigable: true, effect: { kind: 'player-buffs', multiplier: 0.7 } }])
  })

  it('fixes conditions without a source', () => {
    expect(byId.get('e3')!.planned).toEqual([
      { id: 'e3', scope: 'targeted', source: null, targets: ['1003'], mitigable: false, effect: { kind: 'restrictions', banned: { types: ['aircraft'] } } },
    ])
  })

  it('drops a condition whose source was cleared past the threshold', () => {
    expect(byId.get('e4')).toMatchObject({ status: 'removed', effective: null, planned: [] })
  })

  it('sorts conditions into buckets per key point', () => {
    const view = (kp: string) => conditionViews(op, kp).map(v => `${v.condition.id}:${v.bucket}:${v.status}`)
    expect(view('1002')).toEqual(['e0:local:active', 'e4:incoming:removed'])
    expect(view('1003')).toEqual(['e1:targeted:pending', 'e2:global:pending', 'e3:local:active'])
    expect(view('1004')).toEqual(['e1:incoming:pending', 'e2:incoming:pending'])
    expect(view('1006')).toEqual(['e2:incoming:pending'])
    expect(activeConditions(conditionViews(op, '1004'))).toHaveLength(2)
  })

  it('uses the server deltas once the source is resolved', () => {
    const api = structuredClone(snapshot.operations['101']!) as typeof snapshot.operations['101'] & { effects: { payload: Record<string, unknown> }[] }
    const stage = api.stages[0]!
    const cleared = { ...stage.keypoints![2]!, status: 'cleared' }
    const mitigated = {
      ...api,
      stages: [{ ...stage, keypoints: [stage.keypoints![0]!, stage.keypoints![1]!, cleared] }, ...api.stages.slice(1)],
      effects: api.effects.map((e, i) => (i === 2 ? { ...e, payload: { ...e.payload, delta_multiplier: 0.1 } } : e)),
    }
    const weakened = toLiveOperation(mitigated, ctx).conditions.find(c => c.id === 'e2')!
    expect(weakened).toMatchObject({ status: 'weakened', effective: { kind: 'player-buffs', multiplier: 0.8 } })
    expect(weakened.planned).toMatchObject([{ scope: 'targeted', source: null, mitigable: false, targets: ['1004', '1005', '1006', '1007', '1008'] }])
  })
})

describe('rewards', () => {
  it('names reward kinds from the item codes', () => {
    expect(rewardDraft({ type: 'currency', code: 'eventum_1', amount: 40 }, DEFAULT_CURRENCIES)).toEqual({ kind: 'supplies', amount: 40, modifier: null })
    expect(rewardDraft({ type: 'currency', code: 'eventum_2', amount: 5 }, DEFAULT_CURRENCIES).kind).toBe('progress')
    expect(rewardDraft({ type: 'entitlement', code: 'adeck2_modifier_moralImpact', amount: 1 }, DEFAULT_CURRENCIES)).toEqual({ kind: 'modifier', amount: 1, modifier: 'moral-impact' })
    expect(rewardDraft({ type: 'entitlement', code: 'adeck2_card_card_7', amount: 1 }, DEFAULT_CURRENCIES).kind).toBe('card')
    expect(rewardDraft({ type: 'product', code: 'lootbox', amount: 1 }, DEFAULT_CURRENCIES).kind).toBe('other')
  })

  it('weights each lane against the mean of its reward kind', () => {
    const lanes = lanesOf('1002').lanes.map(l => l?.reward)
    expect(lanes[0]).toBeCloseTo(40 / 37.5)
    expect(lanes[2]).toBe(1)
    const rich = toLiveOperation(snapshot.operations['101']!, { ...ctx, weights: { ...DEFAULT_REWARD_WEIGHTS, modifier: 3 } })
    expect(rich.state.stages[0]!.keypoints[1]!.lanes[2]?.reward).toBe(3)
  })
})

describe('intel', () => {
  it('learns every revealed non-flagship enemy', () => {
    const records = intelFrom(op, 5)
    expect(records).toHaveLength(11)
    expect(records[0]).toEqual({ code: 'vehicle_1', tier: 1, specs: [40, 30, 40], difficulty: 1, seenAt: 5 })
  })
})

describe('planning the live operation', () => {
  it('respects fought cards and condition restrictions', () => {
    const plan = solveOperation(op.state, { timeBudgetMs: 120 })
    const first = plan.stages.find(s => s.index === 0)!
    const used = new Set(['card_7', 'card_13', 'card_21', 'card_1'])
    const cards = first.keypoints.flatMap(k => k.lanes.map(l => l.card)).filter((c): c is string => c !== null)
    expect(cards.some(c => used.has(c))).toBe(false)
    expect(new Set(cards).size).toBe(cards.length)
    const k3 = first.keypoints.find(k => k.id === '1003')!
    const aircraft = new Set(CARDS.filter(c => c.type === 'aircraft').map(c => c.code))
    expect(k3.lanes.some(l => l.card && aircraft.has(l.card))).toBe(false)
  })
})

describe('live capture from the Asia server', () => {
  const live = capture as unknown as Snapshot
  const current = toLiveOperation(live.operations[String(live.state!.status.operationId)]!, { inventory: live.inventory, intel: [], weights: DEFAULT_REWARD_WEIGHTS })
  const metas = [...current.keypoints.values()]

  it('estimates the goals of locked stages and takes the last one from the finish condition', () => {
    expect(current.stages.map(s => s.goalType)).toEqual(['defeat_vehicles', 'win_previous_stage', 'win_previous_stage', 'win_previous_stage'])
    expect(current.state.stages.map(s => s.goal)).toEqual([8, Math.ceil(LOCKED_STAGE_GOAL * 8), Math.ceil(LOCKED_STAGE_GOAL * 8), 3])
    expect(current.stages.map(s => s.goalEstimated)).toEqual([false, true, true, false])
    expect(current.issues).toEqual([])
  })

  it('shows and plans with the real enemies of key points the game has not revealed yet', () => {
    const hidden = metas.filter(m => m.raw === 'unrevealed')
    expect(hidden).toHaveLength(5)
    for (const m of hidden) {
      expect(m.revealed).toBe(true)
      expect(m.rewards.filter(Boolean)).toHaveLength(4)
    }
    expect(current.state.stages[1]!.keypoints[0]!.lanes.map(l => l?.enemy.code)).toEqual(['vehicle_9', 'vehicle_7', 'vehicle_9', 'vehicle_14'])
    expect(current.state.stages[1]!.keypoints[0]!.lanes[2]?.enemy.specs).toEqual([190, 0, 0])
    expect(current.stages.map(s => s.estimated)).toEqual([false, true, true, false])
  })

  it('reads single-power enemies, the fleet and the modifier stock', () => {
    expect(current.state.stages[0]!.keypoints[0]!.lanes[0]?.enemy).toEqual({ code: 'vehicle_9', type: 'destroyer', tier: 3, specs: [167, 0, 0], vulns: { 101: 1, 104: 1 } })
    expect(current.state.fleet).toHaveLength(30)
    expect(current.state.inventory).toMatchObject({ unstoppable: 22, specialization: 26, 'fast-repair': 23 })
  })

  it('keeps a self-applied condition fixed and lets the planner lift a pending one', () => {
    expect(current.conditions.map(c => [c.kind, c.status, c.planned.map(p => p.scope)])).toEqual([
      ['player-specs', 'active', ['targeted']],
      ['player-debuffs', 'pending', ['targeted']],
    ])
  })
})
