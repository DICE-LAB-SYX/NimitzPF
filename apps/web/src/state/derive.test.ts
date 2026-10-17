import { CARDS, type ModifierId, type PlanResult } from '@nimitzpf/core'
import { describe, expect, it } from 'vitest'
import { toLiveOperation } from '../live/adapter.ts'
import type { ApiEffect, ApiEffectPayload, ApiEnemy, ApiKeypoint, ApiOperation, ApiRestriction, ApiSlot, ApiStage } from '../live/api.ts'
import {
  activeConditions,
  boostBudget,
  boostedState,
  boostTargets,
  canAttach,
  conditionViews,
  effectivePercentLabel,
  lacksModifiers,
  laneRule,
  modifierLedger,
  modifierRule,
  modifiersLeft,
  modifierUsage,
  removalNeed,
  sweptConditions,
  type Operation,
  type Overrides,
} from './derive.ts'
import { DEFAULT_REWARD_WEIGHTS, type PlacementDraft } from './model.ts'

type Counts = Partial<Record<ModifierId, number>>

const empty: PlacementDraft = { card: null, standard: null, special: null }
const foe: ApiEnemy = { code: 'vehicle_7', type: 'cruiser', tier: 1, specs: { 0: 40, 1: 30, 2: 30 }, vulns: {} }

function place(card: string, standard: ModifierId | null = null, special: ModifierId | null = null): PlacementDraft {
  return { card, standard, special }
}

function keypoint(id: string, status = 'revealed', lanes: readonly (ApiEnemy | ApiSlot | null)[] = [foe, foe, foe, foe]): ApiKeypoint {
  if (status === 'unrevealed') return { id, name: id, status, tags: ['easy'] }
  const slots: Record<string, ApiSlot> = {}
  lanes.forEach((l, i) => {
    if (l) slots[String(i)] = 'code' in l ? { enemy: l } : l
  })
  return { id, name: id, status, tags: ['easy'], slots }
}

function stage(id: string, keypoints: ApiKeypoint[]): ApiStage {
  return { id, condition: { type: 'defeat_vehicles', target: 1 }, keypoints }
}

function effect(source: string | null, payload: ApiEffectPayload, applyTo: string[] = source ? [source] : [], extra: Partial<ApiEffect> = {}): ApiEffect {
  return { source, applyTo, isSubsequent: false, isMitigable: false, payload, ...extra }
}

const disable: ApiEffectPayload = { type: 5 }
const restrict = (restrictions: ApiRestriction): ApiEffectPayload => ({ type: 6, restrictions })

function operation(
  stages: ApiStage[],
  overrides: Overrides,
  extra: { current?: number; effects?: ApiEffect[]; stock?: Counts; hp?: Record<string, number> } = {},
): Operation {
  const current = extra.current ?? 0
  const api: ApiOperation = {
    id: 'o',
    name: 'op1',
    isStarted: true,
    stages: stages.map((s, i) => ({ ...s, isActive: i === current, isFinished: i < current })),
    effects: extra.effects ?? [],
  }
  const inventory = {
    cards: CARDS.map(c => ({ code: c.code, health: extra.hp?.[c.code] ?? 3 })),
    modifiers: Object.entries(extra.stock ?? {}).map(([id, amount]) => ({ id: id as ModifierId, amount: amount ?? 0 })),
  }
  return { ...toLiveOperation(api, { inventory, intel: [], weights: DEFAULT_REWARD_WEIGHTS }), overrides }
}

function plan(keypoints: Record<string, PlacementDraft[]>): PlanResult {
  return {
    stages: [
      {
        index: 0,
        goal: 1,
        goalProbability: 1,
        expectedKills: 1,
        keypoints: Object.entries(keypoints).map(([id, lanes]) => ({
          id,
          stage: 0,
          attack: true,
          lanes: lanes.map(l => ({ ...l, hp: 3, probability: 1 })),
          expectedKills: 1,
          allWinProbability: 1,
          removalProbability: null,
        })),
      },
    ],
  } as unknown as PlanResult
}

const layout = [stage('s0', [keypoint('old', 'missed')]), stage('s1', [keypoint('a'), keypoint('b')]), stage('s2', [keypoint('c'), keypoint('d')])]
const overrides: Overrides = {
  old: [place('card_1', 'gunners-training', 'focused'), empty, empty, empty],
  a: [place('card_7', null, 'focused'), place('card_8', 'gunners-training'), empty, empty],
  c: [place('card_9', 'gunners-training', 'focused'), empty, empty, empty],
}
const op = (stock: Counts = {}) => operation(layout, overrides, { current: 1, stock })

const recommended = plan({
  b: [place('card_13', 'teamwork', 'sea-dog'), empty, empty, empty],
  c: [place('card_21', 'teamwork', 'sea-dog'), empty, empty, empty],
  d: [place('card_22', null, 'focused'), place('card_23', 'rudder-crew-training'), empty, empty],
})

describe('modifier usage', () => {
  it('counts manual placements and the plan from the current stage on', () => {
    const usage = modifierUsage(op(), recommended)
    expect(usage.committed).toEqual({ focused: 2, 'gunners-training': 2 })
    expect(usage.planned).toEqual({ teamwork: 1, 'sea-dog': 1, focused: 1, 'rudder-crew-training': 1 })
  })

  it('limits a lane by what other key points already hold', () => {
    const placements = [place('card_13'), place('card_14', null, 'sea-dog'), empty, empty]
    const { left, plannedElsewhere } = modifiersLeft(op({ focused: 2, 'gunners-training': 3, 'sea-dog': 1 }), recommended, 'b', placements, 0)
    expect(left.focused).toBe(0)
    expect(left['gunners-training']).toBe(1)
    expect(left['sea-dog']).toBe(0)
    expect(plannedElsewhere.focused).toBe(1)
  })

  it('frees the lane being edited', () => {
    const o = op({ focused: 2 })
    expect(modifiersLeft(o, recommended, 'a', overrides.a!, 0).left.focused).toBe(1)
    expect(modifiersLeft(o, recommended, 'a', overrides.a!, 1).left.focused).toBe(0)
  })

  it('frees the modifiers of the lane a card is moved from', () => {
    const k = operation([stage('s0', [keypoint('K')])], { K: [place('card_1', null, 'fast-repair'), empty, empty, empty] }, { stock: { 'fast-repair': 1 } })
    expect(modifiersLeft(k, null, 'K', k.overrides.K!, 1).left['fast-repair']).toBe(0)
    expect(modifiersLeft(k, null, 'K', [empty, place('card_1'), empty, empty], 1).left['fast-repair']).toBe(1)
  })

  it('ignores manual placements left in past stages', () => {
    const undone = operation([stage('s0', [keypoint('A')]), stage('s1', [keypoint('B')])], { A: [place('card_1', null, 'fast-repair'), empty, empty, empty] }, {
      current: 1,
      stock: { 'fast-repair': 1 },
    })
    expect(modifierUsage(undone, null).committed).toEqual({})
    expect(modifiersLeft(undone, null, 'B', [place('card_2'), empty, empty, empty], 0).left['fast-repair']).toBe(1)
  })
})

describe('modifiers the solver cannot use are not counted', () => {
  const ruled = operation(
    [stage('s0', [keypoint('src'), keypoint('off'), keypoint('ban'), keypoint('lone', 'revealed', [foe, null, null, null])]), stage('s1', [keypoint('hit')])],
    {
      off: [place('card_1', 'gunners-training', 'fast-repair'), empty, empty, empty],
      ban: [place('card_2', 'gunners-training'), place('card_3', 'teamwork'), empty, empty],
      lone: [place('card_4', null, 'focused'), place('card_5', null, 'sea-dog'), place('card_6', 'gunners-training'), empty],
      hit: [place('card_10', 'teamwork', 'fast-repair'), empty, empty, empty],
    },
    {
      effects: [effect('off', disable), effect('ban', restrict({ modifiers: ['gunners-training'] })), effect('src', disable, ['hit'])],
      stock: { teamwork: 1, focused: 1, 'gunners-training': 1, 'sea-dog': 1, 'fast-repair': 1 },
    },
  )

  it('skips disabled, banned and needs-enemy placements in every tally', () => {
    expect(modifierUsage(ruled, null).committed).toEqual({ teamwork: 1, focused: 1, 'gunners-training': 1 })
    const { left } = modifiersLeft(ruled, null, 'lone', ruled.overrides.lone!, 3)
    expect(left).toMatchObject({ teamwork: 0, focused: 0, 'gunners-training': 0, 'sea-dog': 1, 'fast-repair': 1 })
  })

  it('skips plan placements that break the same rules', () => {
    const stale = plan({ lone: [place('card_4', null, 'focused'), place('card_5', null, 'sea-dog'), empty, empty] })
    const bare = operation([stage('s0', [keypoint('lone', 'revealed', [foe, null, null, null])])], {})
    expect(modifierUsage(bare, stale).planned).toEqual({ focused: 1 })
  })

  it('treats an unrevealed key point as filled, like the solver does', () => {
    const g = operation([stage('s0', [keypoint('k0')]), stage('s1', [keypoint('e', 'unrevealed')])], { e: [place('card_1', null, 'focused'), empty, empty, empty] })
    expect(modifierUsage(g, null).committed).toEqual({ focused: 1 })
  })

  it('exposes the same rule per lane', () => {
    expect(modifierRule(ruled, 'off')(0, 'teamwork')).toBe(false)
    expect(modifierRule(ruled, 'ban')(0, 'gunners-training')).toBe(false)
    expect(modifierRule(ruled, 'ban')(0, 'teamwork')).toBe(true)
    expect(modifierRule(ruled, 'lone')(0, 'focused')).toBe(true)
    expect(modifierRule(ruled, 'lone')(1, 'focused')).toBe(false)
    expect(modifierRule(ruled, 'lone')(1, 'teamwork')).toBe(true)
    expect(modifierRule(ruled, 'hit')(0, 'teamwork')).toBe(false)
    expect(modifierRule(ruled, 'missing')(0, 'teamwork')).toBe(false)
  })
})

describe('pins the solver drops for card reasons are not counted', () => {
  const pins = (repair: boolean) =>
    operation(
      [stage('s0', [keypoint('B'), keypoint('A'), keypoint('C')]), stage('s1', [keypoint('E')])],
      {
        B: [place('card_1', 'gunners-training'), place('card_7', 'teamwork'), empty, empty],
        A: [place('card_7', 'teamwork'), place('card_8', null, 'focused'), empty, empty],
        C: [place('card_9', 'rudder-crew-training', repair ? 'fast-repair' : null), empty, empty, empty],
        E: [place('card_9', 'rudder-crew-training'), place('card_10', 'damage-control-training'), empty, empty],
      },
      { effects: [effect('B', restrict({ types: ['aircraft'] }))], hp: { card_9: 1 }, stock: { 'fast-repair': 1 } },
    )

  it('skips a banned card, a card used twice in a stage and a card with no HP left', () => {
    expect(modifierUsage(pins(false), null).committed).toEqual({ teamwork: 1, focused: 1, 'rudder-crew-training': 1, 'damage-control-training': 1 })
  })

  it('follows HP through the stages, fast repair included', () => {
    expect(modifierUsage(pins(true), null).committed).toEqual({ teamwork: 1, focused: 1, 'rudder-crew-training': 2, 'fast-repair': 1, 'damage-control-training': 1 })
  })

  it('refuses to attach to a lane the solver would drop', () => {
    const p = pins(false)
    expect(laneRule(p, 'B', p.overrides.B!, 0)('fast-repair')).toBe(false)
    expect(laneRule(p, 'B', p.overrides.B!, 1)('fast-repair')).toBe(true)
    expect(laneRule(p, 'A', p.overrides.A!, 0)('fast-repair')).toBe(false)
    expect(canAttach(p, null, 'B', p.overrides.B!, 0, 'fast-repair')).toBe(false)
    expect(canAttach(p, null, 'B', p.overrides.B!, 1, 'fast-repair')).toBe(true)
    expect(canAttach(p, null, 'E', p.overrides.E!, 0, 'fast-repair')).toBe(false)
  })

  it('drops cards the inventory does not hold', () => {
    const missing = operation([stage('s0', [keypoint('K')])], { K: [place('card_99', 'teamwork'), empty, empty, empty] })
    expect(modifierUsage(missing, null).committed).toEqual({})
  })
})

describe('attaching a modifier', () => {
  const k = operation(
    [stage('s0', [keypoint('K', 'revealed', [foe, null, foe, foe]), keypoint('L'), keypoint('D')])],
    { K: [place('card_1', 'teamwork'), place('card_2'), place('card_3'), empty] },
    {
      effects: [effect('L', restrict({ modifiers: ['gunners-training'] })), effect('D', disable)],
      stock: { teamwork: 1, focused: 1, 'gunners-training': 1, 'fast-repair': 1 },
    },
  )
  const can = (keypointId: string, placements: readonly PlacementDraft[], lane: number, id: ModifierId, p: PlanResult | null = null) =>
    canAttach(k, p, keypointId, placements, lane, id)

  it('needs a card, a free unit and a lane that can use it', () => {
    expect(can('K', k.overrides.K!, 2, 'focused')).toBe(true)
    expect(can('K', k.overrides.K!, 1, 'focused')).toBe(false)
    expect(can('K', k.overrides.K!, 1, 'fast-repair')).toBe(true)
    expect(can('K', k.overrides.K!, 3, 'fast-repair')).toBe(false)
    expect(can('K', k.overrides.K!, 2, 'teamwork')).toBe(false)
    expect(can('K', k.overrides.K!, 0, 'teamwork')).toBe(false)
  })

  it('refuses banned and disabled modifiers', () => {
    const l = [place('card_4'), empty, empty, empty]
    expect(can('L', l, 0, 'gunners-training')).toBe(false)
    expect(can('L', l, 0, 'fast-repair')).toBe(true)
    expect(can('D', l, 0, 'fast-repair')).toBe(false)
  })

  it('allows a unit the plan only uses at another key point', () => {
    const elsewhere = plan({ L: [place('card_4', null, 'fast-repair'), empty, empty, empty] })
    expect(can('K', k.overrides.K!, 1, 'fast-repair', elsewhere)).toBe(true)
  })
})

describe('modifier ledger', () => {
  const stock = { focused: 1, 'fast-repair': 1, 'gunners-training': 1, teamwork: 0 }
  const k = operation([stage('s0', [keypoint('K'), keypoint('L'), keypoint('M')])], { M: [place('card_9', 'gunners-training'), empty, empty, empty] }, { stock })
  const shown = [place('card_1'), place('card_2'), place('card_3', null, 'fast-repair'), empty]
  const p = plan({ K: shown, L: [place('card_4', null, 'focused'), empty, empty, empty] })

  it('marks a unit the plan uses elsewhere as reserved but still usable', () => {
    expect(modifierLedger(k, p, 'K', shown).focused).toEqual({ stock: 1, assigned: 1, left: 0, over: 0, usable: true, reserved: true })
  })

  it('turns off a unit held by manual placements', () => {
    expect(modifierLedger(k, p)['gunners-training']).toEqual({ stock: 1, assigned: 1, left: 0, over: 0, usable: false, reserved: false })
    expect(modifierLedger(k, p).teamwork.usable).toBe(false)
  })

  it('turns off a unit the shown key point would freeze on another lane', () => {
    expect(modifierLedger(k, p)['fast-repair'].usable).toBe(true)
    expect(modifierLedger(k, p, 'K', shown)['fast-repair'].usable).toBe(false)
  })

  it('reports manual placements beyond stock', () => {
    const over = operation(
      [stage('s0', [keypoint('K'), keypoint('L')])],
      { K: [place('card_1', 'gunners-training'), empty, empty, empty], L: [place('card_2', 'gunners-training', 'focused'), empty, empty, empty] },
      { stock: { 'gunners-training': 1, focused: 1 } },
    )
    const ledger = modifierLedger(over, null)
    expect(ledger['gunners-training'].over).toBe(1)
    expect(ledger['gunners-training'].usable).toBe(false)
    expect(ledger.focused.over).toBe(0)
  })
})

describe('mitigable conditions', () => {
  const won = (code: string): ApiSlot => ({ enemy: foe, ally: { code, health: 3, modifiers: [] }, outcome: 'win' })
  const lost = (code: string): ApiSlot => ({ enemy: foe, ally: { code, health: 3, modifiers: [] }, outcome: 'lose' })
  const boost = (delta: number): ApiEffectPayload => ({ type: 4, specs: { 0: 0.16, 1: 0.16, 2: 0.16 }, delta_specs: { 0: -delta, 1: -delta, 2: -delta } })
  const after = (wins: number, delta: number) =>
    operation(
      [stage('s0', [keypoint('src', 'cleared', ['card_1', 'card_2', 'card_3', 'card_4'].map((c, i) => (i < wins ? won(c) : lost(c))))]), stage('s1', [keypoint('next')])],
      {},
      { current: 1, effects: [effect('src', boost(delta), [], { isSubsequent: true, isMitigable: true })] },
    )

  it('shows the value the server has weakened it to', () => {
    const [view] = conditionViews(after(1, 0.04), 'next')
    expect(view?.status).toBe('weakened')
    expect(effectivePercentLabel(view!.effective)).toBe('+12%')
    expect(effectivePercentLabel(conditionViews(after(3, 0.12), 'next')[0]!.effective)).toBe('+4%')
    expect(conditionViews(after(4, 0.16), 'next')[0]?.status).toBe('removed')
  })

  it('needs every enemy of the source for a full removal while it is pending', () => {
    const pending = operation([stage('s0', [keypoint('src')]), stage('s1', [keypoint('next')])], {}, {
      effects: [effect('src', boost(0), [], { isSubsequent: true, isMitigable: true })],
    })
    expect(removalNeed(pending, 'src')).toBe(4)
  })
})

describe('conditions on the swept path', () => {
  const lift = (mitigable: boolean) =>
    operation([stage('s1', [keypoint('a')]), stage('s2', [keypoint('t')])], {}, {
      effects: [effect('a', { type: 4, specs: { 0: 0.2, 1: 0.2, 2: 0.2 } }, [], { isSubsequent: true, isMitigable: mitigable })],
    })

  it('lifts what an earlier open key point brings once it is swept', () => {
    const o = lift(false)
    const swept = sweptConditions(o, null, 't')
    expect(swept?.sources).toEqual(['a'])
    expect(swept?.conditions).toEqual([])
    expect(activeConditions(conditionViews(o, 't'))).toHaveLength(1)
  })

  it('only weakens by the kills the source placement can reach', () => {
    const swept = sweptConditions(lift(true), plan({ a: [place('card_1'), place('card_2'), empty, empty] }), 't')
    expect(swept?.conditions).toHaveLength(1)
    expect(swept?.conditions[0]).toMatchObject({ kind: 'enemy-power', specs: { 0: expect.closeTo(0.1, 9) } })
  })

  it('has nothing to lift when the plan skips the source', () => {
    expect(sweptConditions(lift(false), plan({ a: [empty, empty, empty, empty] }), 't')).toBeNull()
  })
})

describe('effectiveness lanes', () => {
  const tokens = (amount: number, boostable = true): ApiSlot => ({ enemy: foe, rewards: [{ type: 'special', code: 'adeck_progress_points', amount, boostable }] })
  const supply: ApiSlot = { enemy: foe, rewards: [{ type: 'currency', code: 'eventum_1', amount: 12, boostable: true }] }
  const layout = [
    stage('s0', [keypoint('done', 'missed', [tokens(900), foe, null, null])]),
    stage('s1', [keypoint('e', 'revealed', [tokens(650), supply, tokens(2800), tokens(700, false)])]),
    stage('s2', [keypoint('f', 'revealed', [tokens(1200), foe, null, null]), keypoint('g', 'revealed', [tokens(3000), null, null, null])]),
  ]
  const boosted = (manual: Overrides = {}, extra: { effects?: ApiEffect[]; stock?: Counts } = {}) => operation(layout, manual, { current: 1, ...extra })

  it('gives the stock to the lanes with the most tokens from the current stage on', () => {
    expect(boostTargets(boosted(), Infinity)).toEqual({ e: [0, 2], f: [0], g: [0] })
    expect(boostTargets(boosted(), 2)).toEqual({ e: [2], g: [0] })
    expect(boostTargets(boosted(), 0)).toEqual({})
  })

  it('leaves manual lineups and key points that refuse it alone', () => {
    expect(boostTargets(boosted({ g: [place('card_7'), empty, empty, empty] }), Infinity)).toEqual({ e: [0, 2], f: [0] })
    expect(boostTargets(boosted({}, { effects: [effect(null, restrict({ modifiers: ['effectiveness'] }), ['e'])] }), Infinity)).toEqual({ f: [0], g: [0] })
    expect(boostTargets(boosted({}, { effects: [effect(null, disable, ['f'])] }), Infinity)).toEqual({ e: [0, 2], g: [0] })
  })

  it('budgets the stock that manual lineups leave plus what can be bought', () => {
    const manual = { f: [place('card_7', 'effectiveness'), place('card_8', 'effectiveness'), empty, empty] }
    expect(boostBudget(boosted({}, { stock: { effectiveness: 3 } }), 0)).toBe(3)
    expect(boostBudget(boosted(manual, { stock: { effectiveness: 3 } }), 0)).toBe(1)
    expect(boostBudget(boosted(manual, { stock: { effectiveness: 1 } }), 2)).toBe(2)
    expect(boostBudget(boosted(), Infinity)).toBe(Infinity)
  })

  it('hands the boosted lanes to the solver with their lifted reward', () => {
    const o = boosted()
    const base = { ...o.state, pinned: {} }
    const state = boostedState(o, base, 1)
    expect(state.boosted).toEqual({ g: [0] })
    expect(state.stages[2]!.keypoints[1]!.lanes[0]!.reward).toBeGreaterThan(base.stages[2]!.keypoints[1]!.lanes[0]!.reward)
    expect(state.stages[1]).toEqual(base.stages[1])
    expect(boostedState(o, base, 0)).toBe(base)
  })
})

describe('the empty modifier stock notice', () => {
  const odds = (complete: number, perfect: number) => ({ completeProbability: complete, perfectProbability: perfect }) as PlanResult

  it('shows when no standard modifier is left and the objective is not certain', () => {
    expect(lacksModifiers(op(), odds(0.8, 0.2), 'complete')).toBe(true)
    expect(lacksModifiers(op({ 'sea-dog': 3 }), odds(1, 0.2), 'perfect')).toBe(true)
  })

  it('stays quiet with standard stock, a certain plan, no plan or a finished operation', () => {
    expect(lacksModifiers(op({ teamwork: 1 }), odds(0.8, 0.2), 'complete')).toBe(false)
    expect(lacksModifiers(op(), odds(1, 0.2), 'complete')).toBe(false)
    expect(lacksModifiers(op(), odds(1, 1), 'perfect')).toBe(false)
    expect(lacksModifiers(op(), null, 'complete')).toBe(false)
    expect(lacksModifiers({ ...op(), finished: true }, odds(0.8, 0.2), 'complete')).toBe(false)
  })
})
