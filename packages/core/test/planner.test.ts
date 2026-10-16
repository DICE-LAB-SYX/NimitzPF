import { describe, expect, it } from 'vitest'
import { allocate, allocationCache } from '../src/allocate.ts'
import { CARDS, ENEMIES, MODIFIERS, cardByCode } from '../src/data.ts'
import { evaluateBoard } from '../src/engine.ts'
import type { EnemyUnit, ModifierId } from '../src/model.ts'
import type { KeypointInput, OperationState, StageInput } from '../src/operation.ts'
import { Planner, selectPlan, solveOperation, type Objective, type PlanResult } from '../src/planner.ts'

function modifierCount(plan: PlanResult): number {
  return Object.values(plan.modifiersUsed).reduce((n, c) => n + (c ?? 0), 0)
}

function enemy(code: string, specs: [number, number, number], vulns: EnemyUnit['vulns'] = {}): EnemyUnit {
  return { code, type: 'cruiser', tier: 2, specs, vulns }
}

function foe(power: number, tier = 2, code = 'vehicle_9'): EnemyUnit {
  const fp = Math.round(power * 0.4)
  const sv = Math.round((power - fp) / 2)
  return { ...enemy(code, [fp, sv, power - fp - sv]), tier }
}

const BOSSES = new Set(ENEMIES.filter(e => e.tags.some(t => t === 'epic_boss' || t === 'common_boss')).map(e => e.code))

function leads(e: EnemyUnit): boolean {
  return e.tier >= 4 || BOSSES.has(e.code)
}

function keypoint(id: string, enemies: (EnemyUnit | null)[], rewards: number[] = []): KeypointInput {
  return { id, difficulty: 2, status: 'open', lanes: enemies.map((e, i) => (e ? { enemy: e, reward: rewards[i] ?? 1 } : null)) }
}

function stage(id: string, goal: number, keypoints: KeypointInput[]): StageInput {
  return { id, goal, keypoints }
}

function signature(plan: PlanResult): string {
  return plan.stages
    .map(s => s.keypoints.map(k => k.lanes.map(l => `${l.card ?? '-'}|${l.standard ?? '-'}|${l.special ?? '-'}`).join(',')).join(';'))
    .join('/')
}

function metrics(objective: Objective, complete: number, perfect: number, reward: number, stages: number, kills: number): number[] {
  if (objective === 'perfect') return [perfect, kills, complete]
  if (objective === 'reward') return [reward, complete]
  return [complete, stages]
}

function planMetrics(plan: PlanResult): number[] {
  return metrics(plan.objective, plan.completeProbability, plan.perfectProbability, plan.expectedReward, plan.expectedStages, plan.expectedKills)
}

function floorOf(all: readonly (readonly number[])[]): number[] {
  const floor: number[] = []
  let pool = all
  for (let i = 0; i < (all[0]?.length ?? 0); i++) {
    let top = -Infinity
    for (const m of pool) top = Math.max(top, m[i]!)
    const f = top - 1e-3 * Math.abs(top) - 1e-12
    floor.push(f)
    pool = pool.filter(m => m[i]! >= f)
  }
  return floor
}

function price(stock: Partial<Record<ModifierId, number>>, used: Partial<Record<ModifierId, number>>): number {
  const ramp = (have: number, take: number, base: number, scarcity: number) => {
    let total = 0
    for (let j = 1; j <= take; j++) total += Math.round(1e6 * (base + scarcity / (have + 1 - j)))
    return total
  }
  let total = 0
  const have = { 1: 0, 2: 0 }
  const take = { 1: 0, 2: 0 }
  for (const def of MODIFIERS) {
    const count = Math.max(0, Math.floor(stock[def.id] ?? 0))
    const n = used[def.id] ?? 0
    total += ramp(count, n, 0, 1)
    if (def.id === 'effectiveness') continue
    have[def.type] += count
    take[def.type] += n
  }
  return total + ramp(have[1], take[1], 1, 6) + ramp(have[2], take[2], 2.5, 6)
}

interface Layout {
  readonly signature: string
  readonly metrics: readonly number[]
  readonly cost: number
  readonly uses: number
  readonly specials: number
}

function compareMetrics(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 1e-9) return b[i]! - a[i]!
  return 0
}

interface Outcome {
  readonly p: number
  readonly weight: number
  readonly lead: boolean
}

function stageChance(base: number, needsLead: boolean, goal: number, open: readonly Outcome[]): number {
  let total = 0
  for (let mask = 0; mask < 1 << open.length; mask++) {
    let chance = 1
    let kills = base
    let led = !needsLead
    open.forEach((o, j) => {
      const won = (mask >> j) & 1
      chance *= won ? o.p : 1 - o.p
      if (!won) return
      kills += o.weight
      if (o.lead) led = true
    })
    if (led && kills >= goal) total += chance
  }
  return total
}

function judge(state: OperationState, planner: Planner, genes: Int32Array, objective: Objective): number[] {
  const ev = planner.evaluate(genes, false, undefined, true)
  const index = new Map(planner.keypoints.map((kp, k) => [kp.input.id, k]))
  let complete = 1
  let reach = 1
  let stages = 0
  let reward = 0
  let kills = 0
  let perfect = 1
  state.stages.forEach((st, s) => {
    for (const kp of st.keypoints) {
      if (kp.status === 'open' && s >= state.currentStage) continue
      kp.lanes.forEach((l, i) => {
        if (!l) return
        if (kp.status === 'fought' && kp.record?.[i]?.won) {
          reward += l.reward
          kills++
        } else perfect = 0
      })
    }
  })
  for (let s = state.currentStage; s < state.stages.length; s++) {
    const st = state.stages[s]!
    let base = 0
    let flagged = false
    let down = false
    let stageReward = 0
    let stageKills = 0
    const open: Outcome[] = []
    for (const kp of st.keypoints) {
      const k = index.get(kp.id)
      kp.lanes.forEach((l, i) => {
        if (!l) return
        if (leads(l.enemy)) flagged = true
        if (k === undefined) {
          const record = kp.status === 'fought' ? kp.record?.[i] : null
          if (!record?.won) return
          base += record.modifiers.includes('moral-impact') ? 2 : 1
          if (leads(l.enemy)) down = true
          return
        }
        const raw = ev.laneProbabilities[k * planner.size + i]!
        const p = Number.isNaN(raw) ? 0 : raw
        const swept = ev.clearedProbabilities[k * planner.size + i]!
        const std = genes[(k * planner.size + i) * 3 + 1]!
        open.push({ p, weight: std >= 0 && planner.modifiers[std] === 'moral-impact' ? 2 : 1, lead: leads(l.enemy) })
        stageReward += p * l.reward
        stageKills += p
        perfect *= Number.isNaN(swept) ? 0 : swept
      })
    }
    const g = stageChance(base, flagged && !down, st.goal, open)
    reward += reach * stageReward
    kills += reach * stageKills
    reach *= g
    stages += reach
    complete *= g
  }
  return metrics(objective, complete, perfect, reward, stages, kills)
}

function oracle(state: OperationState, objective: Objective): { floor: number[]; cost: number; metrics: readonly number[]; ties: Set<string> } {
  const planner = new Planner(state, { objective })
  const genes = planner.emptyGenes()
  const all: Layout[] = []
  const record = () => {
    const used: Partial<Record<ModifierId, number>> = {}
    let uses = 0
    let specials = 0
    const lane = (k: number, i: number) => {
      const g = (k * planner.size + i) * 3
      const name = (m: number) => (genes[g]! < 0 || m < 0 ? '-' : planner.modifiers[m]!)
      for (const slot of [1, 2]) {
        const m = genes[g + slot]!
        if (m < 0) continue
        used[planner.modifiers[m]!] = (used[planner.modifiers[m]!] ?? 0) + 1
        uses++
        if (slot === 2) specials++
      }
      return `${genes[g]! < 0 ? '-' : planner.cards[genes[g]!]!.code}|${name(genes[g + 1]!)}|${name(genes[g + 2]!)}`
    }
    const signature = planner.stages
      .map(st => st.keypoints.map(k => Array.from({ length: planner.size }, (_, i) => lane(k, i)).join(',')).join(';'))
      .join('/')
    all.push({
      signature,
      metrics: judge(state, planner, genes, objective),
      cost: price(state.inventory, used),
      uses,
      specials,
    })
  }
  const walk = (gene: number) => {
    if (gene === planner.geneCount) {
      if (planner.feasible(genes)) record()
      return
    }
    if (planner.isPinned(gene)) return walk(gene + 1)
    genes.fill(-1, gene * 3, gene * 3 + 3)
    walk(gene + 1)
    for (const c of planner.candidateCards(genes, gene)) {
      genes[gene * 3] = c
      for (const a of [-1, ...planner.modifierOptions(gene, 1)]) {
        for (const b of [-1, ...planner.modifierOptions(gene, 2)]) {
          genes[gene * 3 + 1] = a
          genes[gene * 3 + 2] = b
          walk(gene + 1)
        }
      }
    }
    genes.fill(-1, gene * 3, gene * 3 + 3)
  }
  walk(0)
  const least = (list: readonly Layout[], key: (l: Layout) => number) => list.reduce((n, l) => Math.min(n, key(l)), Infinity)
  const floor = floorOf(all.map(l => l.metrics))
  let pool = all.filter(l => l.metrics.every((v, i) => v >= floor[i]!))
  const cost = least(pool, l => l.cost)
  pool = pool.filter(l => l.cost === cost)
  const best = pool.reduce((a, b) => (compareMetrics(b.metrics, a.metrics) < 0 ? b : a)).metrics
  pool = pool.filter(l => compareMetrics(l.metrics, best) === 0)
  const uses = least(pool, l => l.uses)
  pool = pool.filter(l => l.uses === uses)
  const specials = least(pool, l => l.specials)
  pool = pool.filter(l => l.specials === specials)
  return { floor, cost, metrics: best, ties: new Set(pool.map(l => l.signature)) }
}

const contested: OperationState = {
  currentStage: 0,
  stages: [
    stage('s1', 3, [
      keypoint('k1', [
        enemy('vehicle_6', [70, 60, 50], { 105: 1 }),
        enemy('vehicle_7', [80, 70, 40], { 103: 1 }),
        enemy('vehicle_8', [60, 50, 50], { 101: 1 }),
        null,
      ]),
    ]),
  ],
  conditions: [],
  fleet: [
    { card: 'card_7', hp: 3 },
    { card: 'card_13', hp: 3 },
    { card: 'card_1', hp: 2 },
    { card: 'card_9', hp: 3 },
  ],
  inventory: { 'gunners-training': 1, focused: 1 },
}

const linked: OperationState = {
  currentStage: 0,
  stages: [stage('s1', 1, [keypoint('k1', [foe(205), null, null, null])]), stage('s2', 1, [keypoint('k2', [foe(262), null, null, null])])],
  conditions: [],
  fleet: [
    { card: 'card_7', hp: 3 },
    { card: 'card_13', hp: 3 },
  ],
  inventory: { 'gunners-training': 2, focused: 1 },
}

const crowded: OperationState = {
  currentStage: 0,
  stages: [stage('s1', 3, [keypoint('k1', [foe(190), foe(150), foe(240), null], [1, 3, 2])])],
  conditions: [],
  fleet: [
    { card: 'card_8', hp: 3 },
    { card: 'card_22', hp: 3 },
  ],
  inventory: { 'moral-impact': 1, 'gunners-training': 1, focused: 1 },
}

const buffed: OperationState = {
  currentStage: 0,
  stages: [
    stage('s1', 2, [
      keypoint('k1', [enemy('vehicle_9', [73, 71, 70], { 101: 1 }), enemy('vehicle_9', [73, 40, 40], { 101: 1, 105: 1 }), null, null], [40, 1]),
    ]),
  ],
  conditions: [],
  fleet: [
    { card: 'card_1', hp: 3 },
    { card: 'card_2', hp: 3 },
  ],
  inventory: { teamwork: 3, 'gunners-training': 3, focused: 2, effectiveness: 1 },
}

const guarded: OperationState = {
  currentStage: 0,
  stages: [stage('s1', 3, [keypoint('k1', [foe(175), foe(235, 4), foe(185), foe(150)])])],
  conditions: [],
  fleet: [
    { card: 'card_7', hp: 3 },
    { card: 'card_13', hp: 3 },
    { card: 'card_21', hp: 3 },
    { card: 'card_9', hp: 3 },
  ],
  inventory: { 'gunners-training': 1 },
}

const twin: OperationState = {
  ...guarded,
  stages: [stage('s1', 2, [keypoint('k1', [foe(160), foe(188, 4), foe(170), foe(200, 4)])])],
}

describe('lexicographic optimum', () => {
  const cases: [string, OperationState, Objective][] = [
    ['contested / complete', contested, 'complete'],
    ['contested / perfect', contested, 'perfect'],
    ['contested / reward', contested, 'reward'],
    ['linked stages / complete', linked, 'complete'],
    ['crowded / complete', crowded, 'complete'],
    ['crowded / perfect', crowded, 'perfect'],
    ['crowded / reward', crowded, 'reward'],
    ['buffed / complete', buffed, 'complete'],
    ['buffed / reward', buffed, 'reward'],
    ['guarded flagship / complete', guarded, 'complete'],
    ['guarded flagship / perfect', guarded, 'perfect'],
    ['guarded flagship / reward', guarded, 'reward'],
    ['twin flagships / complete', twin, 'complete'],
    ['twin flagships / reward', twin, 'reward'],
  ]
  for (const [name, state, objective] of cases) {
    it(`reaches the brute force optimum: ${name}`, () => {
      const expected = oracle(state, objective)
      const result = solveOperation(state, { objective, timeBudgetMs: 500 })
      const reached = planMetrics(result)
      expect(reached.every((v, i) => v >= expected.floor[i]!)).toBe(true)
      expect(price(state.inventory, result.modifiersUsed)).toBe(expected.cost)
      expect(result.modifierCost).toBe(expected.cost)
      expect(compareMetrics(reached, expected.metrics)).toBe(0)
      expect(expected.ties.has(signature(result))).toBe(true)
    })
  }

  it('keeps the shared focused for the stage that cannot be won without it', () => {
    const result = solveOperation(linked, { objective: 'complete', timeBudgetMs: 500 })
    const special = result.stages.flatMap(s => s.keypoints.flatMap(k => k.lanes)).filter(l => l.special === 'focused')
    expect(special).toHaveLength(1)
    expect(result.completeProbability).toBeGreaterThan(0.5)
  })
})

describe('modifier cost', () => {
  const lone = (inventory: Partial<Record<ModifierId, number>>, win: number): OperationState => ({
    currentStage: 0,
    stages: [stage('s1', 1, [keypoint('k1', [foe(win), null, null, null])])],
    conditions: [],
    fleet: [{ card: 'card_7', hp: 3 }],
    inventory,
  })

  it('prices units by category stock and id stock', () => {
    const planner = new Planner(lone({ 'gunners-training': 3, 'damage-control-training': 3, 'rudder-crew-training': 3, focused: 2, 'sea-dog': 1 }, 205))
    const use = (ids: Partial<Record<ModifierId, number>>) => planner.usageCost(planner.modifiers.map(id => ids[id] ?? 0))
    expect(use({ focused: 1 })).toBe(5_000_000)
    expect(use({ 'gunners-training': 1, 'damage-control-training': 1 })).toBe(4_083_333)
    expect(use({ 'gunners-training': 1, 'damage-control-training': 1, 'rudder-crew-training': 1 })).toBeGreaterThan(use({ focused: 1 }))
    expect(use({})).toBe(0)
  })

  it('prefers a training while standards are plentiful', () => {
    const result = solveOperation(lone({ 'gunners-training': 3, 'damage-control-training': 3, 'rudder-crew-training': 3, focused: 2, 'sea-dog': 1 }, 205), {
      objective: 'complete',
      timeBudgetMs: 300,
    })
    expect(result.completeProbability).toBeCloseTo(1, 9)
    expect(modifierCount(result)).toBe(1)
    expect(result.stages[0]!.keypoints[0]!.lanes[0]!.special).toBeNull()
  })

  it('switches to a special when standards run short', () => {
    const result = solveOperation(lone({ 'gunners-training': 1, focused: 3, 'sea-dog': 3 }, 205), { objective: 'complete', timeBudgetMs: 300 })
    expect(result.completeProbability).toBeCloseTo(1, 9)
    expect(result.modifiersUsed).toEqual({ focused: 1 })
  })

  it('spends only the modifier that the win needs', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [stage('s1', 1, [keypoint('hard', [enemy('vehicle_4', [100, 80, 50]), null, null, null])])],
      conditions: [],
      fleet: [{ card: 'card_7', hp: 3 }],
      inventory: { focused: 2, 'gunners-training': 3, 'damage-control-training': 3 },
    }
    const result = solveOperation(state, { objective: 'complete', timeBudgetMs: 250 })
    expect(result.completeProbability).toBeCloseTo(1, 9)
    expect(result.modifiersUsed).toEqual({ focused: 1 })
  })

  it('spends no modifiers when the fleet wins without them', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [stage('s1', 2, [keypoint('easy', [enemy('vehicle_9', [20, 20, 20]), enemy('vehicle_9', [20, 20, 20]), null, null])])],
      conditions: [],
      fleet: [
        { card: 'card_7', hp: 3 },
        { card: 'card_13', hp: 3 },
        { card: 'card_9', hp: 3 },
      ],
      inventory: { 'gunners-training': 5, 'damage-control-training': 5, teamwork: 5, focused: 5, 'sea-dog': 5, 'fast-repair': 5 },
    }
    for (const objective of ['complete', 'perfect', 'reward'] as const) {
      const result = solveOperation(state, { objective, timeBudgetMs: 250 })
      expect(result.completeProbability).toBeCloseTo(1, 9)
      expect(modifierCount(result)).toBe(0)
    }
  })
})

describe('unique result', () => {
  it('gives the same plan on every run', () => {
    const a = solveOperation(contested, { objective: 'complete', timeBudgetMs: 300 })
    const b = solveOperation(contested, { objective: 'complete', timeBudgetMs: 300 })
    expect(signature(a)).toBe(signature(b))
  })

  it('ignores the order of the fleet and the stock', () => {
    const shuffled: OperationState = {
      ...contested,
      fleet: [...contested.fleet].reverse(),
      inventory: { focused: 1, 'gunners-training': 1 },
    }
    const a = solveOperation(contested, { objective: 'complete', timeBudgetMs: 300 })
    const b = solveOperation(shuffled, { objective: 'complete', timeBudgetMs: 300 })
    expect(signature(b)).toBe(signature(a))
  })

  it('picks the same plan whatever order the candidates arrive in', () => {
    const fake = (complete: number, cost: number, card: string): PlanResult => ({
      objective: 'complete',
      stages: [
        {
          index: 0,
          goal: 1,
          goalProbability: complete,
          expectedKills: complete,
          keypoints: [
            {
              id: 'k',
              stage: 0,
              attack: true,
              lanes: [{ card, standard: null, special: null, hp: 3, probability: complete }],
              expectedKills: complete,
              allWinProbability: complete,
              clearedWinProbability: complete,
              removalProbability: null,
            },
          ],
        },
      ],
      completeProbability: complete,
      perfectProbability: complete,
      expectedKills: complete,
      expectedReward: complete,
      expectedStages: complete,
      enemyTotal: 1,
      modifiersUsed: {},
      fleetHp: {},
      modifierCost: cost,
      elapsedMs: 0,
      truncated: false,
    })
    const a = fake(1, 3, 'card_1')
    const b = fake(0.9993, 2, 'card_2')
    const c = fake(0.9986, 1, 'card_3')
    for (const order of [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ]) {
      expect(selectPlan(order)).toBe(b)
    }
  })
})

describe('operation planner', () => {
  it('never uses a card twice in one stage or past its hit points', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [
        stage('s1', 2, [
          keypoint('a', [enemy('vehicle_9', [40, 40, 40]), enemy('vehicle_9', [40, 40, 40]), null, null]),
          keypoint('b', [enemy('vehicle_9', [40, 40, 40]), enemy('vehicle_9', [40, 40, 40]), null, null]),
        ]),
        stage('s2', 2, [keypoint('c', [enemy('vehicle_4', [90, 80, 40]), enemy('vehicle_4', [90, 80, 40]), null, null])]),
      ],
      conditions: [],
      fleet: [
        { card: 'card_7', hp: 1 },
        { card: 'card_8', hp: 3 },
        { card: 'card_21', hp: 3 },
      ],
      inventory: {},
    }
    const result = solveOperation(state, { objective: 'perfect', timeBudgetMs: 300 })
    for (const s of result.stages) {
      const used = s.keypoints.flatMap(k => k.lanes.map(l => l.card)).filter(Boolean)
      expect(new Set(used).size).toBe(used.length)
    }
    const missouriUses = result.stages.flatMap(s => s.keypoints.flatMap(k => k.lanes)).filter(l => l.card === 'card_7')
    expect(missouriUses.length).toBeLessThanOrEqual(1)
  })

  it('values clearing the source of a removable condition', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [
        stage('s1', 1, [
          keypoint('src', [enemy('vehicle_10', [30, 30, 30]), enemy('vehicle_10', [30, 30, 30]), enemy('vehicle_10', [30, 30, 30]), enemy('vehicle_10', [30, 30, 30])]),
          keypoint('easy', [enemy('vehicle_11', [20, 20, 20]), null, null, null]),
        ]),
        stage('s2', 1, [keypoint('target', [enemy('vehicle_5', [70, 60, 50]), null, null, null])]),
      ],
      conditions: [
        {
          id: 'c1',
          scope: 'targeted',
          source: 'src',
          targets: ['target'],
          mitigable: false,
          effect: { kind: 'enemy-power', specs: { 0: 0.5, 1: 0.5, 2: 0.5 } },
        },
      ],
      fleet: [
        { card: 'card_26', hp: 3 },
        { card: 'card_27', hp: 3 },
        { card: 'card_28', hp: 3 },
        { card: 'card_29', hp: 3 },
        { card: 'card_7', hp: 3 },
      ],
      inventory: {},
    }
    const result = solveOperation(state, { objective: 'complete', timeBudgetMs: 400 })
    const src = result.stages[0]!.keypoints.find(k => k.id === 'src')!
    expect(src.attack).toBe(true)
    expect(src.removalProbability).toBeGreaterThan(0.9)
    expect(result.completeProbability).toBeGreaterThan(0.9)
  })

  it('scores perfect on the path where every earlier key point is swept', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [
        stage('s1', 1, [keypoint('src', [foe(215), null, null, null])]),
        stage('s2', 3, [keypoint('target', [foe(150), foe(160), foe(155), foe(150)])]),
      ],
      conditions: [{ id: 'c', scope: 'global', source: 'src', targets: [], mitigable: false, effect: { kind: 'enemy-power', specs: { 0: 0.4 } } }],
      fleet: CARDS.slice(0, 9).map(c => ({ card: c.code, hp: 3 })),
      inventory: {},
    }
    const result = solveOperation(state, { objective: 'perfect', timeBudgetMs: 400 })
    const src = result.stages[0]!.keypoints[0]!
    const target = result.stages[1]!.keypoints[0]!
    const board = evaluateBoard({
      player: target.lanes.map(l => (l.card ? { card: cardByCode(l.card)!, hp: l.hp ?? 3, modifiers: [] } : null)),
      enemy: state.stages[1]!.keypoints[0]!.lanes.map(l => l?.enemy ?? null),
      conditions: [],
    })
    const swept = board.ok ? board.lanes.reduce((n, l) => n * (l.probability ?? 0), 1) : 0
    expect(src.allWinProbability).toBeGreaterThan(0.5)
    expect(src.allWinProbability).toBeLessThan(1)
    expect(target.clearedWinProbability).toBeCloseTo(swept, 9)
    expect(target.clearedWinProbability).toBeGreaterThan(target.allWinProbability)
    expect(result.perfectProbability).toBeCloseTo(src.allWinProbability * target.clearedWinProbability, 9)
  })

  it('falls back to the most kills when no plan can sweep the operation', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [
        stage('s1', 2, [keypoint('a', [foe(91), foe(100), foe(84), foe(110)]), keypoint('b', [foe(90), foe(95), foe(85), foe(100)])]),
        stage('s2', 3, [keypoint('c', [foe(110), foe(105), foe(100), foe(115)])]),
      ],
      conditions: [],
      fleet: ['card_11', 'card_30', 'card_12', 'card_5', 'card_27', 'card_29'].map(card => ({ card, hp: 3 })),
      inventory: {},
    }
    expect(new Planner(state, { objective: 'perfect' }).sweepable).toBe(false)
    const perfect = solveOperation(state, { objective: 'perfect', timeBudgetMs: 400 })
    const complete = solveOperation(state, { objective: 'complete', timeBudgetMs: 400 })
    expect(perfect.perfectProbability).toBe(0)
    expect(perfect.stages[0]!.keypoints.flatMap(k => k.lanes).filter(l => l.card)).toHaveLength(6)
    expect(perfect.expectedKills).toBeGreaterThan(complete.expectedKills + 0.5)
  })

  it('uses each condition own kill count for removal', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [
        stage('s1', 1, [
          keypoint('src', [enemy('vehicle_10', [40, 40, 40]), enemy('vehicle_10', [40, 40, 40]), enemy('vehicle_10', [40, 40, 40]), enemy('vehicle_10', [40, 40, 40])]),
        ]),
        stage('s2', 1, [keypoint('target', [enemy('vehicle_5', [70, 60, 50]), null, null, null])]),
      ],
      conditions: [
        { id: 'c1', scope: 'targeted', source: 'src', targets: ['target'], mitigable: false, removeAfter: 1, effect: { kind: 'enemy-power', specs: { 0: 0.3, 1: 0.3, 2: 0.3 } } },
        { id: 'c2', scope: 'targeted', source: 'src', targets: ['target'], mitigable: false, removeAfter: 4, effect: { kind: 'enemy-power', specs: { 0: 0.3, 1: 0.3, 2: 0.3 } } },
      ],
      fleet: [
        { card: 'card_26', hp: 3 },
        { card: 'card_27', hp: 3 },
        { card: 'card_28', hp: 3 },
        { card: 'card_29', hp: 3 },
        { card: 'card_7', hp: 3 },
      ],
      inventory: {},
    }
    const result = solveOperation(state, { objective: 'complete', timeBudgetMs: 300 })
    const src = result.stages[0]!.keypoints.find(k => k.id === 'src')!
    expect(src.removalProbability).toBeCloseTo(src.allWinProbability, 9)
  })

  it('keeps pinned placements and plans around them', () => {
    const pinned: OperationState = {
      ...contested,
      pinned: {
        k1: [
          { card: 'card_9', standard: null, special: null },
          { card: null, standard: null, special: null },
          { card: null, standard: null, special: null },
          { card: null, standard: null, special: null },
        ],
      },
    }
    const result = solveOperation(pinned, { objective: 'complete', timeBudgetMs: 300 })
    const lanes = result.stages[0]!.keypoints[0]!.lanes
    expect(lanes[0]!.card).toBe('card_9')
    expect(lanes.filter(l => l.card === 'card_9')).toHaveLength(1)
  })

  it('drops only the pinned modifiers the stock cannot cover', () => {
    const empty = { card: null, standard: null, special: null }
    const state: OperationState = {
      ...linked,
      pinned: {
        k1: [{ card: 'card_7', standard: null, special: 'focused' }, empty, empty, empty],
        k2: [{ card: 'card_13', standard: null, special: 'focused' }, empty, empty, empty],
      },
    }
    const result = solveOperation(state, { objective: 'complete', timeBudgetMs: 300 })
    expect(result.stages[0]!.keypoints[0]!.lanes[0]).toMatchObject({ card: 'card_7', special: 'focused' })
    expect(result.stages[1]!.keypoints[0]!.lanes[0]).toMatchObject({ card: 'card_13', special: null })
  })

  it('keeps later pins when an earlier pin breaks a restriction', () => {
    const empty = { card: null, standard: null, special: null }
    const state: OperationState = {
      currentStage: 0,
      stages: [stage('s1', 1, [keypoint('a', [foe(150), null, null, null])]), stage('s2', 1, [keypoint('b', [foe(170), null, null, null])])],
      conditions: [{ id: 'ban', scope: 'targeted', source: null, targets: ['a'], mitigable: false, effect: { kind: 'restrictions', banned: { types: ['destroyer'] } } }],
      fleet: [
        { card: 'card_23', hp: 3 },
        { card: 'card_13', hp: 3 },
        { card: 'card_7', hp: 3 },
      ],
      inventory: { 'gunners-training': 2 },
      pinned: {
        a: [{ card: 'card_23', standard: null, special: null }, empty, empty, empty],
        b: [{ card: 'card_13', standard: 'gunners-training', special: null }, empty, empty, empty],
      },
    }
    const planner = new Planner(state)
    expect(planner.isPinned(0)).toBe(false)
    expect(planner.isPinned(planner.size)).toBe(true)
    const result = solveOperation(state, { objective: 'complete', timeBudgetMs: 300 })
    expect(result.stages[0]!.keypoints[0]!.lanes[0]!.card).not.toBe('card_23')
    expect(result.stages[1]!.keypoints[0]!.lanes[0]).toMatchObject({ card: 'card_13', standard: 'gunners-training' })
  })

  it('returns a fully pinned plan without searching', () => {
    const pin = (card: string | null) => ({ card, standard: null, special: null })
    const state: OperationState = { ...contested, pinned: { k1: [pin('card_7'), pin('card_13'), pin('card_9'), pin(null)] } }
    const result = solveOperation(state, { objective: 'complete', timeBudgetMs: 300 })
    expect(result.truncated).toBe(false)
    expect(signature(result)).toBe('card_7|-|-,card_13|-|-,card_9|-|-,-|-|-')
  })
})

describe('flagship', () => {
  const fleet = (...cards: string[]) => cards.map(card => ({ card, hp: 3 }))

  it('commits strength to a flagship that the kill goal could skip', () => {
    const plain: OperationState = { ...guarded, stages: [stage('s1', 3, [keypoint('k1', [foe(175), foe(235), foe(185), foe(150)])])] }
    const loose = solveOperation(plain, { objective: 'complete', timeBudgetMs: 500 })
    expect(loose.completeProbability).toBeCloseTo(1, 9)
    expect(modifierCount(loose)).toBe(0)

    const result = solveOperation(guarded, { objective: 'complete', timeBudgetMs: 500 })
    const lanes = result.stages[0]!.keypoints[0]!.lanes
    expect(lanes[1]!.card).not.toBeNull()
    expect(lanes[1]!.standard).toBe('gunners-training')
    const [a, f, b, c] = lanes.map(l => l.probability ?? 0) as [number, number, number, number]
    expect(f).toBeGreaterThan(0)
    expect(f).toBeLessThan(1)
    const escortsTwo = a * b * c + a * b * (1 - c) + a * (1 - b) * c + (1 - a) * b * c
    expect(escortsTwo).toBeLessThan(1)
    expect(result.stages[0]!.goalProbability).toBeCloseTo(f * escortsTwo, 12)
    expect(result.completeProbability).toBeCloseTo(f * escortsTwo, 12)
  })

  it('fails a stage whose flagship was already lost', () => {
    const boss = foe(235, 2, 'boss_1')
    const first = (status: 'fought' | 'missed', won: boolean): KeypointInput => ({
      id: 'k0',
      difficulty: 2,
      status,
      lanes: [{ enemy: boss, reward: 1 }, { enemy: foe(150), reward: 1 }, null, null],
      ...(status === 'fought' ? { record: [{ card: 'card_7', modifiers: [], won }, { card: 'card_13', modifiers: [], won: true }, null, null] } : {}),
    })
    const at = (k0: KeypointInput): OperationState => ({
      currentStage: 0,
      stages: [stage('s1', 2, [k0, keypoint('k1', [foe(150), foe(150), null, null])]), stage('s2', 1, [keypoint('k2', [foe(150), null, null, null])])],
      conditions: [],
      fleet: fleet('card_7', 'card_13', 'card_21', 'card_9'),
      inventory: {},
    })
    const won = solveOperation(at(first('fought', true)), { objective: 'complete', timeBudgetMs: 300 })
    expect(won.stages[0]!.goalProbability).toBeCloseTo(1, 9)
    expect(won.completeProbability).toBeGreaterThan(0.9)

    for (const k0 of [first('fought', false), first('missed', false)]) {
      const lost = solveOperation(at(k0), { objective: 'complete', timeBudgetMs: 300 })
      expect(lost.stages[0]!.expectedKills).toBeGreaterThanOrEqual(2)
      expect(lost.stages[0]!.goalProbability).toBe(0)
      expect(lost.completeProbability).toBe(0)
      expect(lost.expectedStages).toBe(0)
    }
  })

  it('counts the primary target as met once any flagship is destroyed', () => {
    const fought = (won: readonly boolean[]): KeypointInput => ({
      id: 'k0',
      difficulty: 2,
      status: 'fought',
      lanes: [foe(220, 4), foe(220, 4), foe(150), foe(150)].map(enemy => ({ enemy, reward: 1 })),
      record: won.map((w, i) => ({ card: ['card_7', 'card_13', 'card_21', 'card_9'][i]!, modifiers: [], won: w })),
    })
    const at = (k0: KeypointInput, rest: KeypointInput[] = []): OperationState => ({
      currentStage: 0,
      stages: [stage('s1', 3, [k0, ...rest])],
      conditions: [],
      fleet: fleet('card_7', 'card_13', 'card_21', 'card_9', 'card_22'),
      inventory: {},
    })
    const one = solveOperation(at(fought([true, false, true, true])), { objective: 'complete', timeBudgetMs: 300 })
    expect(one.stages[0]!.goalProbability).toBe(1)
    expect(one.completeProbability).toBe(1)

    const none = solveOperation(at(fought([false, false, true, true])), { objective: 'complete', timeBudgetMs: 300 })
    expect(none.stages[0]!.goalProbability).toBe(0)

    const later = solveOperation(at(fought([false, false, true, true]), [keypoint('k1', [foe(150, 4), null, null, null])]), {
      objective: 'complete',
      timeBudgetMs: 300,
    })
    const lane = later.stages[0]!.keypoints[0]!.lanes[0]!
    expect(lane.card).toBe('card_22')
    expect(lane.probability).toBeGreaterThan(0)
    expect(later.stages[0]!.goalProbability).toBeCloseTo(lane.probability!, 12)
  })

  it('needs only one of two open flagships', () => {
    const planner = new Planner(twin)
    const genes = planner.emptyGenes()
    for (const [lane, code] of [[0, 'card_9'], [1, 'card_13'], [2, 'card_21'], [3, 'card_7']] as const) genes[lane * 3] = planner.cards.findIndex(c => c.code === code)
    const ev = planner.evaluate(genes, false, undefined, true)
    const open = [0, 1, 2, 3].map(lane => ({ p: ev.laneProbabilities[lane]!, weight: 1, lead: lane === 1 || lane === 3 }))
    expect(open[1]!.p).toBeGreaterThan(0)
    expect(open[3]!.p).toBeGreaterThan(0)
    expect(open[1]!.p * open[3]!.p).toBeLessThan(1)
    const either = stageChance(0, true, 2, open)
    expect(ev.stageGoal[0]).toBeCloseTo(either, 12)
    expect(either).toBeGreaterThan(open[1]!.p * open[3]!.p)
  })

  it('rates a losing card on a flagship above an empty lane', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [stage('s1', 1, [keypoint('k1', [foe(120), foe(285, 4), foe(120), null])])],
      conditions: [],
      fleet: fleet('card_7', 'card_9', 'card_10'),
      inventory: { focused: 1 },
    }
    const planner = new Planner(state)
    const empty = planner.emptyGenes()
    empty[0] = planner.cards.findIndex(c => c.code === 'card_9')
    empty[6] = planner.cards.findIndex(c => c.code === 'card_10')
    const placed = empty.slice()
    placed[3] = planner.cards.findIndex(c => c.code === 'card_7')
    expect(planner.evaluate(placed, false).laneProbabilities[1]).toBe(0)
    expect(planner.evaluate(placed).score).toBeGreaterThan(planner.evaluate(empty).score)
  })

  it('counts a moral impact flagship kill twice toward the goal', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [stage('s1', 2, [keypoint('k1', [foe(205, 2, 'boss_1'), foe(175), null, null])])],
      conditions: [],
      fleet: fleet('card_7', 'card_13'),
      inventory: { 'moral-impact': 1 },
    }
    const planner = new Planner(state)
    const impact = planner.modifiers.indexOf('moral-impact')
    const judgeImpact = (lane: number | null) => {
      const genes = planner.emptyGenes()
      genes[0] = planner.cards.findIndex(c => c.code === 'card_7')
      genes[3] = planner.cards.findIndex(c => c.code === 'card_13')
      if (lane !== null) genes[lane * 3 + 1] = impact
      const ev = planner.evaluate(genes, false, undefined, true)
      return { goal: ev.stageGoal[0]!, f: ev.laneProbabilities[0]!, e: ev.laneProbabilities[1]! }
    }
    const none = judgeImpact(null)
    expect(none.f).toBeGreaterThan(0)
    expect(none.f).toBeLessThan(1)
    expect(none.e).toBeGreaterThan(0)
    expect(none.e).toBeLessThan(1)
    expect(none.goal).toBeCloseTo(none.f * none.e, 12)
    const onFlagship = judgeImpact(0)
    expect(onFlagship.goal).toBeCloseTo(onFlagship.f, 12)
    const onEscort = judgeImpact(1)
    expect(onEscort.goal).toBeCloseTo(onEscort.f * onEscort.e, 12)

    const result = solveOperation(state, { objective: 'complete', timeBudgetMs: 300 })
    const lanes = result.stages[0]!.keypoints[0]!.lanes
    expect(lanes[0]).toMatchObject({ card: 'card_7', standard: 'moral-impact' })
    expect(result.stages[0]!.goalProbability).toBeCloseTo(lanes[0]!.probability!, 12)
  })

  it('allocates modifiers by the same flagship rule as the evaluation', () => {
    const state: OperationState = {
      currentStage: 0,
      stages: [stage('s1', 3, [keypoint('k1', [foe(165), foe(220, 4), foe(175), null]), keypoint('k2', [foe(185), null, null, null])])],
      conditions: [],
      fleet: fleet('card_9', 'card_7', 'card_13', 'card_21'),
      inventory: { 'gunners-training': 2 },
    }
    const planner = new Planner(state)
    const skeleton = planner.emptyGenes()
    const placed: [number, string][] = [
      [0, 'card_9'],
      [1, 'card_7'],
      [2, 'card_13'],
      [4, 'card_21'],
    ]
    for (const [gene, code] of placed) skeleton[gene * 3] = planner.cards.findIndex(c => c.code === code)
    const gunners = planner.modifiers.indexOf('gunners-training')
    const genesOf = (picks: readonly number[]) => {
      const genes = skeleton.slice()
      for (const gene of picks) genes[gene * 3 + 1] = gunners
      return genes
    }
    const options: { picks: number[]; goal: number; kills: number }[] = []
    for (let mask = 0; mask < 1 << placed.length; mask++) {
      const picks = placed.map(([gene]) => gene).filter((_, i) => (mask >> i) & 1)
      if (picks.length > 2) continue
      const ev = planner.evaluate(genesOf(picks), false, undefined, true)
      const open = placed.map(([gene]) => ({ p: ev.laneProbabilities[gene]!, weight: 1, lead: false }))
      options.push({ picks, goal: ev.stageGoal[0]!, kills: stageChance(0, false, 3, open) })
    }
    const best = options.reduce((x, y) => (y.goal > x.goal ? y : x))
    const crowd = options.reduce((x, y) => (y.kills > x.kills ? y : x))
    expect(best.picks).toContain(1)
    expect(crowd.picks).not.toContain(1)

    const dists = planner.evaluate(skeleton, false).killDistributions
    const limits = { cap: 2, menuSize: 20000, frontier: 2500, candidates: 6 }
    const found = allocate(planner, skeleton, dists, [2, 2], limits, Infinity, () => 0, allocationCache())
    expect(found).toHaveLength(1)
    const genes = found![0]!.genes
    expect(genes[1 * 3 + 1]).toBe(gunners)
    expect(planner.evaluate(genes, false, undefined, true).complete).toBeCloseTo(best.goal, 12)
  })
})
