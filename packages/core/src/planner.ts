import { allocate, allocationCache, type AllocationCache, type AllocationLimits } from './allocate.ts'
import { CORE_SETTINGS, MODIFIERS, cardByCode, cardRank, isFlagship } from './data.ts'
import { addBernoulli, atLeast, convolve, mean, metSurvival, missBernoulli, pointMass, type Distribution } from './distribution.ts'
import { MODIFIER_RULES } from './engine.ts'
import { KeypointContext, type Variant } from './fast.ts'
import { maximizeAssignment } from './hungarian.ts'
import type { CardDef, Condition, CoreSettings, EnemyUnit, ModifierId } from './model.ts'
import { GENE, NONE, primaryMetrics } from './shared.ts'
import {
  type PinnedLane,
  collectRestrictions,
  conditionApplies,
  conditionRemovalKills,
  effectAfterKills,
  enemyCount,
  fullRemovalKills,
  isMitigable,
  locateKeypoints,
  removalKills,
  sourceState,
  weightedWins,
  type KeypointInput,
  type OperationCondition,
  type OperationState,
} from './operation.ts'

export type Objective = 'complete' | 'perfect' | 'reward'
export type SearchVariant = 'default' | 'standard'

export interface PlannerOptions {
  readonly objective?: Objective
  readonly timeBudgetMs?: number
  readonly seed?: number
  readonly modifierWeight?: number
  readonly variant?: SearchVariant
}

export interface SolveJob {
  readonly seed: number
  readonly modifierWeight: number
  readonly variant: SearchVariant
}

export const QUICK_JOBS: readonly SolveJob[] = [
  { seed: 20261014, modifierWeight: 1e-4, variant: 'default' },
  { seed: 20261014 + 7919, modifierWeight: 1e-2, variant: 'default' },
  { seed: 20261014 + 2 * 7919, modifierWeight: 1e-3, variant: 'standard' },
]

export const DEEP_JOBS: readonly SolveJob[] = [
  ...QUICK_JOBS,
  { seed: 20261014 + 3 * 7919, modifierWeight: 3e-2, variant: 'default' },
  { seed: 20261014 + 4 * 7919, modifierWeight: 1e-4, variant: 'default' },
  { seed: 20261014 + 5 * 7919, modifierWeight: 1e-2, variant: 'standard' },
]

export interface PlannedLane {
  readonly card: string | null
  readonly standard: ModifierId | null
  readonly special: ModifierId | null
  readonly hp: number | null
  readonly probability: number | null
}

export interface PlannedKeypoint {
  readonly id: string
  readonly stage: number
  readonly attack: boolean
  readonly lanes: readonly PlannedLane[]
  readonly expectedKills: number
  readonly allWinProbability: number
  readonly clearedWinProbability: number
  readonly removalProbability: number | null
}

export interface PlannedStage {
  readonly index: number
  readonly goal: number
  readonly goalProbability: number
  readonly expectedKills: number
  readonly keypoints: readonly PlannedKeypoint[]
}

export interface PlanResult {
  readonly objective: Objective
  readonly stages: readonly PlannedStage[]
  readonly completeProbability: number
  readonly perfectProbability: number
  readonly expectedKills: number
  readonly expectedReward: number
  readonly expectedStages: number
  readonly enemyTotal: number
  readonly modifiersUsed: Readonly<Partial<Record<ModifierId, number>>>
  readonly fleetHp: Readonly<Record<string, readonly number[]>>
  readonly modifierCost: number
  readonly elapsedMs: number
  readonly truncated: boolean
}

interface PendingGroup {
  readonly source: number
  readonly conditions: readonly OperationCondition[]
  readonly sourceInput: KeypointInput
  readonly thresholds: readonly number[] | null
}

interface PlanKeypoint {
  readonly input: KeypointInput
  readonly stage: number
  readonly enemies: readonly (EnemyUnit | null)[]
  readonly rewards: readonly number[]
  readonly fixedConditions: readonly Condition[]
  readonly pending: readonly PendingGroup[]
  readonly isBanned: (card: CardDef) => boolean
  readonly bannedModifiers: ReadonlySet<ModifierId>
  readonly modifiersDisabled: boolean
  readonly eligibleCards: readonly number[]
  readonly hasEnemies: boolean
  readonly flagships: readonly boolean[]
  readonly flagged: boolean
  readonly removalNeed: number
}

interface StageInfo {
  readonly index: number
  readonly goal: number
  readonly fixedKills: number
  readonly usedCards: ReadonlySet<number>
  readonly keypoints: readonly number[]
  readonly perfectBroken: boolean
  readonly flagged: boolean
}

interface Evaluation {
  readonly score: number
  readonly laneProbabilities: Float64Array
  readonly clearedProbabilities: Float64Array
  readonly killDistributions: Distribution[]
  readonly stageGoal: Float64Array
  readonly stageKills: Float64Array
  readonly complete: number
  readonly perfect: number
  readonly expectedKills: number
  readonly expectedReward: number
  readonly expectedStages: number
}

const SOFT_ZERO = 1e-4
const SOFT_SCALE = 4
const SOFT_UNPLANNED = 1e-8
const SOFT_FLOOR = 2e-8
const SOFT_TAIL = 1000
const MODIFIER_WEIGHT = 3e-2
const RESULT_TOLERANCE = 1e-3
const SPLIT_BEAM = 6
const QUANTUM = 1e9
const SOFT_HINT = 1e-3
const LIMITS: AllocationLimits = { cap: 2, menuSize: 20000, frontier: 2500, candidates: 6 }
const KICK_LIMIT = 6
const RAISE_LIMIT = 2
const FULL_SHARE = 0.4
const SKELETON_KICK = 0.12
const SKELETON_SLICE = 0.06
const SKELETON_DRIFT = 0.1
const KICK_STRENGTH = 0.06
const PRIMARY_SHARE = 0.65
const THRIFT_STARTS = 3
const THRIFT_RESULTS = 3
const SAFETY_FACTOR = 3
const WORK_MS = 8.7e-4
const PRICE_UNIT = 1e6
const CLASS_BASE: Readonly<Record<1 | 2, number>> = { 1: 1, 2: 2.5 }
const CLASS_SCARCITY = 6
const KIND_SCARCITY = 1
const OVERDRAW = 1e12
const WORK_EVALUATE = 0.3
const WORK_KEYPOINT = 0.6
const WORK_SCENARIO = 1.4
const WORK_FEASIBLE = 0.04
const WORK_MUTATE = 0.1

function strengthOf(card: CardDef): number {
  return (card.specs[0] + card.specs[1] + card.specs[2]) / 200
}

function depletionTable(stock: number, base: number, scarcity: number): Float64Array {
  const table = new Float64Array(stock + 1)
  for (let j = 1; j <= stock; j++) table[j] = table[j - 1]! + Math.round(PRICE_UNIT * (base + scarcity / (stock + 1 - j)))
  return table
}

function depletion(table: Float64Array, used: number): number {
  const last = table.length - 1
  return used <= last ? table[used]! : table[last]! + (used - last) * OVERDRAW
}

function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Planner {
  readonly settings: CoreSettings
  readonly objective: Objective
  readonly size: number
  readonly cards: readonly CardDef[]
  readonly startHp: readonly number[]
  readonly cardStrength: readonly number[]
  readonly modifiers: readonly ModifierId[]
  readonly inventory: readonly number[]
  readonly modifierSlot: readonly (1 | 2)[]
  readonly keypoints: readonly PlanKeypoint[]
  readonly stages: readonly StageInfo[]
  readonly enemyTotal: number
  readonly rewardTotal: number
  readonly plannedEnemyLanes: number
  readonly sweepable: boolean
  private readonly cardIndex: ReadonlyMap<string, number>
  private readonly fixedKillsOutsidePlan: number
  private readonly fixedRewardOutsidePlan: number
  private readonly perfectAlreadyBroken: boolean
  private readonly tracksCleared: boolean
  private readonly contexts = new Map<string, KeypointContext>()
  private readonly pins = new Map<number, readonly [number, number, number]>()
  private readonly laneCache = new Map<number, Float64Array>()
  private readonly scratch: Float64Array
  private readonly scratchMargins: Float64Array
  private readonly laneVariants: (Variant | null)[]
  private readonly classCost: readonly Float64Array[]
  private readonly kindCost: readonly Float64Array[]
  private readonly costUsage: Int32Array
  private readonly pricedClass: readonly (0 | 1 | 2)[]
  allowModifiers = true
  allowSpecials = true
  scoreObjective: Objective
  readonly allocations: AllocationCache = allocationCache()
  modifierWeight = MODIFIER_WEIGHT
  work = 0

  constructor(state: OperationState, options: PlannerOptions = {}) {
    this.settings = CORE_SETTINGS
    this.objective = options.objective ?? 'complete'
    this.scoreObjective = this.objective
    this.tracksCleared = this.objective === 'perfect'
    this.size = this.settings.HandSize
    this.scratch = new Float64Array(this.size)
    this.scratchMargins = new Float64Array(this.size)
    this.laneVariants = new Array<Variant | null>(this.size).fill(null)
    const cards: CardDef[] = []
    const startHp: number[] = []
    const fleet = [...state.fleet].sort((a, b) => cardRank(a.card) - cardRank(b.card))
    for (const entry of fleet) {
      const card = cardByCode(entry.card)
      if (!card || cards.includes(card)) continue
      cards.push(card)
      startHp.push(Math.max(0, Math.min(3, entry.hp)))
    }
    this.cards = cards
    this.startHp = startHp
    this.cardStrength = cards.map(strengthOf)
    const cardIndex = new Map(cards.map((c, i) => [c.code, i]))
    this.cardIndex = cardIndex
    const modifiers: ModifierId[] = []
    const inventory: number[] = []
    const modifierSlot: (1 | 2)[] = []
    for (const def of MODIFIERS) {
      const count = Math.floor(state.inventory[def.id] ?? 0)
      if (count <= 0) continue
      modifiers.push(def.id)
      inventory.push(count)
      modifierSlot.push(def.type)
    }
    this.modifiers = modifiers
    this.inventory = inventory
    this.modifierSlot = modifierSlot
    this.costUsage = new Int32Array(modifiers.length)
    this.pricedClass = modifiers.map((id, m) => (id === 'effectiveness' ? 0 : modifierSlot[m]!))
    this.kindCost = inventory.map(count => depletionTable(count, 0, KIND_SCARCITY))
    this.classCost = ([1, 2] as const).map(slot =>
      depletionTable(
        inventory.reduce((n, count, m) => n + (this.pricedClass[m] === slot ? count : 0), 0),
        CLASS_BASE[slot],
        CLASS_SCARCITY,
      ),
    )

    const locations = locateKeypoints(state)
    const planIndex = new Map<string, number>()
    const keypoints: PlanKeypoint[] = []
    const stages: StageInfo[] = []
    let enemyTotal = 0
    let rewardTotal = 0
    let fixedKillsOutsidePlan = 0
    let fixedRewardOutsidePlan = 0
    let perfectAlreadyBroken = false

    state.stages.forEach((stage, s) => {
      for (const kp of stage.keypoints) {
        kp.lanes.forEach((lane, i) => {
          if (!lane) return
          enemyTotal++
          rewardTotal += lane.reward
          if (kp.status === 'fought' && kp.record?.[i]?.won) {
            fixedKillsOutsidePlan++
            fixedRewardOutsidePlan += lane.reward
          } else if (kp.status !== 'open' || s < state.currentStage) perfectAlreadyBroken = true
        })
      }
    })

    for (let s = state.currentStage; s < state.stages.length; s++) {
      const stage = state.stages[s]!
      const usedCards = new Set<number>()
      let fixedKills = 0
      let perfectBroken = false
      const flagshipDown = stage.keypoints.some(kp => kp.status === 'fought' && kp.lanes.some((l, i) => l && isFlagship(l.enemy) && kp.record?.[i]?.won))
      const flagged = !flagshipDown && stage.keypoints.some(kp => kp.lanes.some(l => l && isFlagship(l.enemy)))
      const kpIndices: number[] = []
      for (const kp of stage.keypoints) {
        if (kp.status === 'fought') {
          fixedKills += weightedWins(kp)
          kp.record?.forEach((r, i) => {
            if (!r) return
            const idx = cardIndex.get(r.card)
            if (idx !== undefined) usedCards.add(idx)
            if (kp.lanes[i] && !r.won) perfectBroken = true
          })
          kp.lanes.forEach((l, i) => {
            if (l && !kp.record?.[i]) perfectBroken = true
          })
          continue
        }
        if (kp.status === 'missed') {
          if (enemyCount(kp) > 0) perfectBroken = true
          continue
        }
        const location = locations.get(kp.id)!
        const fixedConditions: Condition[] = []
        const pendingBySource = new Map<number, OperationCondition[]>()
        const restrictive: Condition[] = []
        for (const condition of state.conditions) {
          if (!conditionApplies(condition, location, locations)) continue
          const st = sourceState(condition, locations)
          if (st.kind === 'fixed') {
            fixedConditions.push(condition.effect)
            restrictive.push(condition.effect)
          } else if (st.kind === 'resolved') {
            const source = locations.get(condition.source!)!
            const effect = effectAfterKills(condition, source.keypoint, st.kills)
            if (effect) {
              fixedConditions.push(effect)
              restrictive.push(effect)
            }
          } else {
            const srcPlan = planIndex.get(st.sourceId)
            if (srcPlan === undefined) {
              fixedConditions.push(condition.effect)
              restrictive.push(condition.effect)
            } else {
              const list = pendingBySource.get(srcPlan) ?? []
              list.push(condition)
              pendingBySource.set(srcPlan, list)
              restrictive.push(condition.effect)
            }
          }
        }
        const pending: PendingGroup[] = [...pendingBySource.entries()].map(([source, conditions]) => {
          const sourceInput = keypoints[source]!.input
          const thresholds = conditions.some(isMitigable)
            ? null
            : [...new Set(conditions.map(c => conditionRemovalKills(c, sourceInput)))].sort((a, b) => a - b)
          return { source, conditions, sourceInput, thresholds }
        })
        const outgoing = state.conditions.filter(c => c.source === kp.id && c.scope !== 'local')
        const { isBanned, bannedModifiers, modifiersDisabled } = collectRestrictions(restrictive)
        const enemies = kp.lanes.map(l => l?.enemy ?? null)
        const flagships = enemies.map(e => flagged && e !== null && isFlagship(e))
        const eligibleCards = cards.map((_, i) => i).filter(i => !isBanned(cards[i]!))
        const index = keypoints.length
        planIndex.set(kp.id, index)
        kpIndices.push(index)
        keypoints.push({
          input: kp,
          stage: stages.length,
          enemies,
          rewards: kp.lanes.map(l => l?.reward ?? 0),
          fixedConditions,
          pending,
          isBanned,
          bannedModifiers,
          modifiersDisabled,
          eligibleCards,
          hasEnemies: enemies.some(Boolean),
          flagships,
          flagged: flagships.includes(true),
          removalNeed: outgoing.length ? Math.max(...outgoing.map(c => fullRemovalKills(c, kp))) : removalKills(kp),
        })
      }
      stages.push({
        index: s,
        goal: stage.goal,
        fixedKills,
        usedCards,
        keypoints: kpIndices,
        perfectBroken,
        flagged,
      })
    }
    this.keypoints = keypoints
    this.stages = stages
    this.plannedEnemyLanes = keypoints.reduce((n, kp) => n + kp.enemies.filter(Boolean).length, 0)
    if (state.pinned) {
      keypoints.forEach((kp, k) => {
        const lanes = state.pinned?.[kp.input.id]
        if (!lanes) return
        for (let lane = 0; lane < this.size; lane++) this.pins.set(k * this.size + lane, this.encode(lanes[lane]))
      })
      if (!this.feasible(this.emptyGenes())) this.relaxPins()
    }
    this.enemyTotal = enemyTotal
    this.rewardTotal = rewardTotal
    this.fixedKillsOutsidePlan = fixedKillsOutsidePlan
    this.fixedRewardOutsidePlan = fixedRewardOutsidePlan
    this.perfectAlreadyBroken = perfectAlreadyBroken
    this.sweepable =
      !this.perfectBrokenBefore() &&
      stages.every(st => {
        const lanes = st.keypoints.reduce((n, k) => n + keypoints[k]!.enemies.filter(Boolean).length, 0)
        return lanes <= startHp.filter((hp, c) => hp > 0 && !st.usedCards.has(c)).length
      })
  }

  private relaxPins(): void {
    const pins = [...this.pins.entries()].sort((a, b) => a[0] - b[0])
    this.pins.clear()
    const used = new Int32Array(this.modifiers.length)
    const admit = (lanes: readonly (readonly [number, readonly [number, number, number]])[]): boolean => {
      const taken = used.slice()
      for (const [gene, pin] of lanes) {
        const kp = this.keypoints[Math.floor(gene / this.size)]!
        const lane = gene % this.size
        const next: [number, number, number] = [pin[0], pin[1], pin[2]]
        for (const slot of [1, 2] as const) {
          const m = next[slot]
          if (m === NONE) continue
          const id = this.modifiers[m]!
          const allowed =
            next[0] !== NONE &&
            this.modifierSlot[m] === slot &&
            !kp.modifiersDisabled &&
            !kp.bannedModifiers.has(id) &&
            !(MODIFIER_RULES[id].needsEnemy && !kp.enemies[lane]) &&
            taken[m]! < this.inventory[m]!
          if (allowed) taken[m] = taken[m]! + 1
          else next[slot] = NONE
        }
        this.pins.set(gene, next)
      }
      if (this.feasible(this.emptyGenes())) {
        used.set(taken)
        return true
      }
      for (const [gene] of lanes) this.pins.delete(gene)
      return false
    }
    for (let i = 0; i < pins.length; ) {
      const k = Math.floor(pins[i]![0] / this.size)
      let j = i
      while (j < pins.length && Math.floor(pins[j]![0] / this.size) === k) j++
      const lanes = pins.slice(i, j)
      if (!admit(lanes)) for (const lane of lanes) admit([lane])
      i = j
    }
  }

  private encode(pin: PinnedLane | undefined): [number, number, number] {
    const card = pin?.card ? this.cardIndex.get(pin.card) ?? NONE : NONE
    const mod = (id: ModifierId | null | undefined) => (id && card !== NONE ? this.modifiers.indexOf(id) : NONE)
    return [card, mod(pin?.standard), mod(pin?.special)]
  }

  genesFrom(placements: Readonly<Record<string, readonly PinnedLane[]>>): Int32Array {
    const genes = this.emptyGenes()
    this.keypoints.forEach((kp, k) => {
      const lanes = placements[kp.input.id]
      if (!lanes) return
      for (let lane = 0; lane < this.size; lane++) {
        const gene = k * this.size + lane
        if (!this.pins.has(gene)) setGene(genes, gene, ...this.encode(lanes[lane]))
      }
    })
    return genes
  }

  get geneCount(): number {
    return this.keypoints.length * this.size
  }

  emptyGenes(): Int32Array {
    const genes = new Int32Array(this.geneCount * GENE).fill(NONE)
    for (const [gene, [c, std, spc]] of this.pins) {
      genes[gene * GENE] = c
      genes[gene * GENE + 1] = std
      genes[gene * GENE + 2] = spc
    }
    return genes
  }

  perfectBrokenBefore(): boolean {
    return this.perfectAlreadyBroken || this.stages.some(s => s.perfectBroken)
  }

  fixedReward(): number {
    return this.fixedRewardOutsidePlan
  }

  fixedKills(): number {
    return this.fixedKillsOutsidePlan
  }

  isPinned(gene: number): boolean {
    return this.pins.has(gene)
  }

  movable(): boolean {
    const genes = this.emptyGenes()
    for (let gene = 0; gene < this.geneCount; gene++) if (!this.pins.has(gene) && this.candidateCards(genes, gene).length > 0) return true
    return false
  }

  pinnedCardsInStage(stage: number): Set<number> {
    const out = new Set<number>()
    for (const [gene, [c]] of this.pins) {
      if (c !== NONE && this.keypoints[Math.floor(gene / this.size)]!.stage === stage) out.add(c)
    }
    return out
  }

  private context(kp: number, conditions: readonly Condition[], key: string): KeypointContext {
    const full = `${kp}#${key}`
    let ctx = this.contexts.get(full)
    if (!ctx) {
      ctx = new KeypointContext(this.keypoints[kp]!.enemies, conditions, this.settings)
      this.contexts.set(full, ctx)
    }
    return ctx
  }

  hpTable(genes: Int32Array): Int8Array | null {
    const stageCount = this.stages.length
    const table = new Int8Array(this.cards.length * stageCount)
    const usedAt = new Int32Array(this.cards.length * stageCount).fill(NONE)
    for (let k = 0; k < this.keypoints.length; k++) {
      const st = this.keypoints[k]!.stage
      for (let lane = 0; lane < this.size; lane++) {
        const g = (k * this.size + lane) * GENE
        const c = genes[g]!
        if (c === NONE) continue
        const slot = c * stageCount + st
        if (usedAt[slot] !== NONE || this.stages[st]!.usedCards.has(c)) return null
        usedAt[slot] = g
      }
    }
    for (let c = 0; c < this.cards.length; c++) {
      let hp = this.startHp[c]!
      for (let st = 0; st < stageCount; st++) {
        table[c * stageCount + st] = hp
        const g = usedAt[c * stageCount + st]!
        if (g === NONE) continue
        if (hp < 1) return null
        const special = genes[g + 2]!
        const repaired = special !== NONE && this.modifiers[special] === 'fast-repair' ? Math.min(hp + 2, 3) : hp
        hp = repaired - 1
      }
    }
    return table
  }

  private tallyModifiers(genes: Int32Array): number {
    this.work += WORK_FEASIBLE * this.geneCount
    const used = this.costUsage
    used.fill(0)
    let total = 0
    for (let g = 0; g < genes.length; g += GENE) {
      const std = genes[g + 1]!
      const spc = genes[g + 2]!
      if (std !== NONE) {
        used[std] = used[std]! + 1
        total++
      }
      if (spc !== NONE) {
        used[spc] = used[spc]! + 1
        total++
      }
    }
    return total
  }

  usageCost(used: ArrayLike<number>): number {
    let standard = 0
    let special = 0
    let cost = 0
    for (let m = 0; m < used.length; m++) {
      const n = used[m]!
      if (n === 0) continue
      if (this.pricedClass[m] === 1) standard += n
      else if (this.pricedClass[m] === 2) special += n
      cost += depletion(this.kindCost[m]!, n)
    }
    return cost + depletion(this.classCost[0]!, standard) + depletion(this.classCost[1]!, special)
  }

  modifierCost(genes: Int32Array): number {
    if (this.tallyModifiers(genes) === 0) return 0
    return this.usageCost(this.costUsage)
  }

  feasible(genes: Int32Array): boolean {
    return this.feasibleHp(genes) !== null
  }

  feasibleHp(genes: Int32Array): Int8Array | null {
    this.work += WORK_FEASIBLE * this.geneCount
    const used = new Int32Array(this.modifiers.length)
    for (let k = 0; k < this.keypoints.length; k++) {
      const kp = this.keypoints[k]!
      for (let lane = 0; lane < this.size; lane++) {
        const g = (k * this.size + lane) * GENE
        const c = genes[g]!
        const std = genes[g + 1]!
        const spc = genes[g + 2]!
        if (c === NONE) {
          if (std !== NONE || spc !== NONE) return null
          continue
        }
        if (kp.isBanned(this.cards[c]!)) return null
        for (const m of [std, spc]) {
          if (m === NONE) continue
          const id = this.modifiers[m]!
          if (kp.modifiersDisabled || kp.bannedModifiers.has(id)) return null
          if (MODIFIER_RULES[id].needsEnemy && !kp.enemies[lane]) return null
          used[m] = used[m]! + 1
          if (used[m]! > this.inventory[m]!) return null
        }
        if (std !== NONE && this.modifierSlot[std] !== 1) return null
        if (spc !== NONE && this.modifierSlot[spc] !== 2) return null
      }
    }
    return this.hpTable(genes)
  }

  scenarios(k: number, dists: readonly Distribution[]): { weight: number; context: KeypointContext }[] {
    const kp = this.keypoints[k]!
    const scenarios: { weight: number; conditions: Condition[]; key: string }[] = [
      { weight: 1, conditions: [...kp.fixedConditions], key: '' },
    ]
    for (const group of kp.pending) {
      const dist = dists[group.source]!
      const classes: { p: number; kills: number }[] = []
      if (group.thresholds) {
        let above = 1
        let kills = 0
        for (const need of group.thresholds) {
          const p = atLeast(dist, need)
          if (above - p > 1e-12) classes.push({ p: above - p, kills })
          above = p
          kills = need
        }
        if (above > 1e-12) classes.push({ p: above, kills })
      } else if (scenarios.length * dist.length > 32) {
        classes.push({ p: 1, kills: mean(dist) })
      } else {
        for (let x = 0; x < dist.length; x++) if (dist[x]! > 1e-12) classes.push({ p: dist[x]!, kills: x })
      }
      const next: typeof scenarios = []
      for (const sc of scenarios) {
        for (const cl of classes) {
          const extra: Condition[] = []
          for (const c of group.conditions) {
            const e = effectAfterKills(c, group.sourceInput, cl.kills)
            if (e) extra.push(e)
          }
          next.push({
            weight: sc.weight * cl.p,
            conditions: sc.conditions.concat(extra),
            key: `${sc.key}|${group.source}:${cl.kills.toFixed(3)}`,
          })
        }
      }
      scenarios.length = 0
      scenarios.push(...next)
    }
    return scenarios.map(sc => ({ weight: sc.weight, context: this.context(k, sc.conditions, sc.key) }))
  }

  clearedContext(k: number, dists: readonly Distribution[]): KeypointContext {
    const kp = this.keypoints[k]!
    const conditions = [...kp.fixedConditions]
    let key = ''
    for (const group of kp.pending) {
      const top = dists[group.source]!.length - 1
      const kills = group.thresholds ? group.thresholds.reduce((n, need) => (need <= top ? need : n), 0) : top
      for (const c of group.conditions) {
        const e = effectAfterKills(c, group.sourceInput, kills)
        if (e) conditions.push(e)
      }
      key += `|${group.source}:${kills.toFixed(3)}`
    }
    return this.context(k, conditions, key)
  }

  private laneProbabilities(
    k: number,
    genes: Int32Array,
    hp: Int8Array,
    dists: Distribution[],
    out: Float64Array,
    offset: number,
    soft: boolean,
    cleared: Float64Array | null = null,
  ): void {
    const kp = this.keypoints[k]!
    const size = this.size
    const stageCount = this.stages.length
    for (let i = 0; i < size; i++) out[offset + i] = Number.NaN
    if (cleared) for (let i = 0; i < size; i++) cleared[offset + i] = Number.NaN
    let any = false
    for (let lane = 0; lane < size; lane++) if (genes[(k * size + lane) * GENE]! !== NONE) any = true
    if (!any || !kp.hasEnemies) return
    const margins = this.scratchMargins
    const scenarios = this.scenarios(k, dists)
    const clear = cleared ? this.clearedContext(k, dists) : null

    const st = kp.stage
    const lanes = this.laneVariants
    const tmp = this.scratch
    const run = (ctx: KeypointContext): boolean => {
      for (let lane = 0; lane < size; lane++) {
        const g = (k * size + lane) * GENE
        const c = genes[g]!
        if (c === NONE) {
          lanes[lane] = null
          continue
        }
        const std = genes[g + 1]!
        const spc = genes[g + 2]!
        lanes[lane] = ctx.variant(
          this.cards[c]!,
          hp[c * stageCount + st]!,
          std === NONE ? null : this.modifiers[std]!,
          spc === NONE ? null : this.modifiers[spc]!,
        )
      }
      if (!ctx.evaluate(lanes, tmp, margins)) return false
      if (soft) {
        for (let i = 0; i < size; i++) {
          if (tmp[i]! > 0 || Number.isNaN(tmp[i]!)) continue
          const margin = Math.min(margins[i]!, 0)
          tmp[i] = Math.max(SOFT_ZERO * Math.exp(margin / SOFT_SCALE), SOFT_FLOOR * Math.exp(margin / SOFT_TAIL))
        }
      }
      return true
    }
    const fail = () => {
      for (let i = 0; i < size; i++) out[offset + i] = Number.NaN
      if (cleared) for (let i = 0; i < size; i++) cleared[offset + i] = Number.NaN
    }
    let first = true
    let found = false
    this.work += WORK_SCENARIO * scenarios.length
    for (const sc of scenarios) {
      if (!run(sc.context)) return fail()
      for (let i = 0; i < size; i++) {
        const v = tmp[i]!
        if (Number.isNaN(v)) continue
        out[offset + i] = first || Number.isNaN(out[offset + i]!) ? v * sc.weight : out[offset + i]! + v * sc.weight
      }
      first = false
      if (cleared && sc.context === clear) {
        cleared.set(tmp, offset)
        found = true
      }
    }
    if (!cleared || !clear || found) return
    this.work += WORK_SCENARIO
    if (!run(clear)) return fail()
    cleared.set(tmp, offset)
  }

  private keypointKey(k: number, genes: Int32Array, hp: Int8Array, dists: Distribution[], soft: boolean): number {
    const kp = this.keypoints[k]!
    const size = this.size
    const stageCount = this.stages.length
    let a = 0x811c9dc5 ^ (soft ? 1 : 2) ^ (k << 3)
    let b = 0x9e3779b9 ^ k
    const mix = (v: number) => {
      a = Math.imul(a ^ v, 0x01000193)
      b = Math.imul(b ^ (v + 0x7f4a7c15), 0x85ebca6b) ^ (b >>> 13)
    }
    for (let lane = 0; lane < size; lane++) {
      const g = (k * size + lane) * GENE
      const c = genes[g]!
      mix(c + 2)
      if (c !== NONE) {
        mix(genes[g + 1]! + 2)
        mix(genes[g + 2]! + 2)
        mix(hp[c * stageCount + kp.stage]! + 7)
      }
    }
    for (const group of kp.pending) {
      const dist = dists[group.source]!
      if (this.tracksCleared) mix(dist.length)
      if (group.thresholds) for (const need of group.thresholds) mix(Math.round(atLeast(dist, need) * 1e9))
      else for (let x = 0; x < dist.length; x++) mix(Math.round(dist[x]! * 1e9))
    }
    return (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff)
  }

  evaluate(genes: Int32Array, soft = true, knownHp?: Int8Array, exact = false): Evaluation {
    this.work += WORK_EVALUATE + WORK_KEYPOINT * this.keypoints.length
    const hp = knownHp ?? this.hpTable(genes) ?? new Int8Array(this.cards.length * this.stages.length)
    const size = this.size
    const probs = new Float64Array(this.keypoints.length * size)
    const split = exact || this.tracksCleared
    const cleared = split ? new Float64Array(this.keypoints.length * size) : probs
    const dists: Distribution[] = []
    const misses: Distribution[] = []
    for (let k = 0; k < this.keypoints.length; k++) {
      const at = k * size
      if (exact) this.laneProbabilities(k, genes, hp, dists, probs, at, soft, cleared)
      else {
        const key = this.keypointKey(k, genes, hp, dists, soft)
        const cached = this.laneCache.get(key)
        if (cached) {
          probs.set(cached.subarray(0, size), at)
          if (split) cleared.set(cached.subarray(size), at)
        } else {
          this.laneProbabilities(k, genes, hp, dists, probs, at, soft, split ? cleared : null)
          if (this.laneCache.size > 250000) this.laneCache.clear()
          const entry = new Float64Array(split ? size * 2 : size)
          entry.set(probs.subarray(at, at + size))
          if (split) entry.set(cleared.subarray(at, at + size), size)
          this.laneCache.set(key, entry)
        }
      }
      const kp = this.keypoints[k]!
      if (soft) {
        for (let lane = 0; lane < size; lane++) {
          if (!kp.enemies[lane]) continue
          if (Number.isNaN(probs[at + lane]!)) probs[at + lane] = SOFT_UNPLANNED
          if (Number.isNaN(cleared[at + lane]!)) cleared[at + lane] = SOFT_UNPLANNED
        }
      }
      let dist = pointMass(0)
      let missed = dist
      for (let lane = 0; lane < size; lane++) {
        const p = probs[k * size + lane]!
        if (Number.isNaN(p)) continue
        const standard = genes[(k * size + lane) * GENE + 1]!
        const weight = standard !== NONE && this.modifiers[standard] === 'moral-impact' ? 2 : 1
        dist = addBernoulli(dist, p, weight)
        if (kp.flagged) missed = kp.flagships[lane] ? missBernoulli(missed, p) : addBernoulli(missed, p, weight)
      }
      dists.push(dist)
      misses.push(kp.flagged ? missed : dist)
    }

    const stageGoal = new Float64Array(this.stages.length)
    const stageKills = new Float64Array(this.stages.length)
    let logComplete = 0
    let complete = 1
    let reach = 1
    let expectedStages = 0
    let expectedReward = this.fixedRewardOutsidePlan
    let expectedKills = this.fixedKillsOutsidePlan
    let logLanes = 0
    let logPerfect = 0
    let perfectBroken = this.perfectAlreadyBroken
    this.stages.forEach((stage, s) => {
      let dist = pointMass(stage.fixedKills)
      let missed = dist
      let stageReward = 0
      let stageKillMean = 0
      if (stage.perfectBroken) perfectBroken = true
      for (const k of stage.keypoints) {
        const shared = missed === dist && misses[k] === dists[k]
        dist = convolve(dist, dists[k]!)
        missed = shared ? dist : convolve(missed, misses[k]!)
        const kp = this.keypoints[k]!
        for (let lane = 0; lane < size; lane++) {
          if (!kp.enemies[lane]) continue
          const p = probs[k * size + lane]!
          const v = Number.isNaN(p) ? 0 : p
          const c = cleared[k * size + lane]!
          const w = Number.isNaN(c) ? 0 : c
          stageReward += v * kp.rewards[lane]!
          stageKillMean += v
          logLanes += Math.log(Math.max(v, 1e-300))
          logPerfect += Math.log(Math.max(w, 1e-300))
          if (w <= 0) perfectBroken = true
        }
      }
      const g = this.stagePass(s, dist, missed)
      stageGoal[s] = g
      stageKills[s] = stageKillMean + stage.fixedKills
      expectedReward += reach * stageReward
      expectedKills += reach * stageKillMean
      reach *= g
      expectedStages += reach
      complete *= g
      logComplete += Math.log(Math.max(g, 1e-300))
    })

    const perfect = perfectBroken ? 0 : Math.exp(logPerfect)
    const killShare = this.enemyTotal === 0 ? 0 : expectedKills / this.enemyTotal
    const rewardShare = this.rewardTotal === 0 ? 0 : expectedReward / this.rewardTotal
    let deployed = 0
    let strengthSpent = 0
    for (let g = 0; g < genes.length; g += GENE) {
      const c = genes[g]!
      if (c !== NONE) {
        deployed++
        strengthSpent += this.cardStrength[c]!
      }
    }
    const economy = -1e-5 * deployed - (this.modifierWeight * this.modifierCost(genes)) / PRICE_UNIT - 1e-5 * strengthSpent
    const shape = this.plannedEnemyLanes === 0 ? 0 : logLanes / this.plannedEnemyLanes
    let score: number
    const progress = this.stages.length === 0 ? 0 : expectedStages / this.stages.length
    if (this.scoreObjective === 'complete') score = logComplete + 0.1 * progress + 0.03 * shape + 0.01 * killShare + economy
    else if (this.scoreObjective === 'perfect' && this.sweepable) score = logPerfect + 0.2 * logComplete + economy
    else if (this.scoreObjective === 'perfect') score = killShare + 0.05 * complete + 0.01 * shape + economy
    else score = rewardShare + 0.05 * complete + 0.01 * shape + economy

    return {
      score,
      laneProbabilities: probs,
      clearedProbabilities: cleared,
      killDistributions: dists,
      stageGoal,
      stageKills,
      complete,
      perfect,
      expectedKills,
      expectedReward,
      expectedStages,
    }
  }

  stagePass(stage: number, dist: Distribution, missed: Distribution): number {
    const info = this.stages[stage]!
    return info.flagged ? metSurvival(dist, missed, info.goal) : atLeast(dist, info.goal)
  }

  stageLanes(stage: number): number[] {
    const out: number[] = []
    for (const k of this.stages[stage]!.keypoints) {
      const kp = this.keypoints[k]!
      for (let lane = 0; lane < this.size; lane++) {
        const gene = k * this.size + lane
        if (kp.enemies[lane] && !this.pins.has(gene)) out.push(gene)
      }
    }
    return out
  }

  laneValue(p: number, gene: number): number {
    const kp = this.keypoints[Math.floor(gene / this.size)]!
    const lane = gene % this.size
    if ((this.objective === 'perfect' && this.sweepable) || (this.objective === 'complete' && kp.flagships[lane])) return Math.log(Math.max(p, 1e-300))
    if (this.objective === 'reward') return p * (kp.rewards[lane]! || 1)
    return p
  }

  emptyLaneValue(gene: number): number {
    return this.laneValue(SOFT_UNPLANNED, gene)
  }

  assignmentMatrix(genes: Int32Array, stage: number, lanes: readonly number[]): number[][] {
    const size = this.size
    const stageCount = this.stages.length
    const cleared = genes.slice()
    for (const g of lanes) cleared.fill(NONE, g * GENE, g * GENE + GENE)
    const hp = this.hpTable(cleared) ?? new Int8Array(this.cards.length * stageCount)
    const base = this.evaluate(genes)
    const dists = base.killDistributions
    const out = new Float64Array(this.keypoints.length * size)
    const swept = this.tracksCleared ? new Float64Array(this.keypoints.length * size) : null
    const matrix: number[][] = []
    const pinnedHere = this.pinnedCardsInStage(stage)
    for (let c = 0; c < this.cards.length; c++) {
      const row: number[] = []
      const hpHere = hp[c * stageCount + stage]!
      const blocked = hpHere < 1 || this.stages[stage]!.usedCards.has(c) || pinnedHere.has(c)
      for (const g of lanes) {
        const k = Math.floor(g / size)
        const kp = this.keypoints[k]!
        if (blocked || kp.isBanned(this.cards[c]!)) {
          row.push(-Infinity)
          continue
        }
        const trial = genes.slice()
        for (let o = 0; o < this.geneCount; o++) {
          if (o !== g && trial[o * GENE] === c && this.keypoints[Math.floor(o / size)]!.stage === stage) {
            trial.fill(NONE, o * GENE, o * GENE + GENE)
          }
        }
        trial[g * GENE] = c
        trial[g * GENE + 1] = NONE
        trial[g * GENE + 2] = NONE
        const trialHp = this.hpTable(trial)
        if (!trialHp) {
          row.push(-Infinity)
          continue
        }
        this.laneProbabilities(k, trial, trialHp, dists, out, k * size, true, swept)
        const p = (swept ?? out)[k * size + (g % size)]!
        row.push(this.laneValue(Number.isNaN(p) ? SOFT_UNPLANNED : p, g) - 1e-4 * this.cardStrength[c]!)
      }
      matrix.push(row)
    }
    return matrix
  }

  candidateCards(genes: Int32Array, gene: number): number[] {
    const k = Math.floor(gene / this.size)
    const kp = this.keypoints[k]!
    const st = kp.stage
    const blocked = new Set<number>(this.stages[st]!.usedCards)
    for (const other of this.stages[st]!.keypoints) {
      for (let lane = 0; lane < this.size; lane++) {
        const g = other * this.size + lane
        if (g === gene) continue
        const c = genes[g * GENE]!
        if (c !== NONE) blocked.add(c)
      }
    }
    return kp.eligibleCards.filter(c => !blocked.has(c))
  }

  modifierOptions(gene: number, slot: 1 | 2): number[] {
    const k = Math.floor(gene / this.size)
    const kp = this.keypoints[k]!
    const lane = gene % this.size
    if (!this.allowModifiers || kp.modifiersDisabled || (slot === 2 && !this.allowSpecials)) return []
    const out: number[] = []
    this.modifiers.forEach((id, m) => {
      if (this.modifierSlot[m] !== slot || kp.bannedModifiers.has(id)) return
      if (MODIFIER_RULES[id].needsEnemy && !kp.enemies[lane]) return
      out.push(m)
    })
    return out
  }
}

function setGene(genes: Int32Array, gene: number, card: number, std: number, spc: number): void {
  genes[gene * GENE] = card
  genes[gene * GENE + 1] = card === NONE ? NONE : std
  genes[gene * GENE + 2] = card === NONE ? NONE : spc
}

function greedy(
  planner: Planner,
  genes: Int32Array,
  deadline: number,
  clock: () => number,
  order: 'hardest' | 'sequential',
): number {
  let best = planner.evaluate(genes).score
  const lanes: { gene: number; power: number; stage: number }[] = []
  for (let k = 0; k < planner.keypoints.length; k++) {
    const kp = planner.keypoints[k]!
    for (let lane = 0; lane < planner.size; lane++) {
      const e = kp.enemies[lane]
      if (e) lanes.push({ gene: k * planner.size + lane, power: e.specs[0] + e.specs[1] + e.specs[2], stage: kp.stage })
    }
  }
  if (order === 'hardest') lanes.sort((a, b) => b.power - a.power || a.gene - b.gene)
  for (const { gene } of lanes) {
    if (clock() > deadline) break
    if (planner.isPinned(gene)) continue
    let bestCard = NONE
    for (const c of planner.candidateCards(genes, gene)) {
      setGene(genes, gene, c, NONE, NONE)
      if (!planner.feasible(genes)) continue
      const s = planner.evaluate(genes).score
      if (s > best + 1e-12) {
        best = s
        bestCard = c
      }
    }
    setGene(genes, gene, bestCard, NONE, NONE)
  }
  return best
}

function polish(planner: Planner, genes: Int32Array, score: number, deadline: number, clock: () => number): number {
  let best = score
  let improved = true
  const geneCount = planner.geneCount
  while (improved && clock() < deadline) {
    improved = false
    for (let gene = 0; gene < geneCount; gene++) {
      if (clock() > deadline) break
      if (planner.isPinned(gene)) continue
      const base = Array.from(genes.subarray(gene * GENE, gene * GENE + GENE))
      const options: [number, number, number][] = [[NONE, NONE, NONE]]
      for (const c of planner.candidateCards(genes, gene)) {
        options.push([c, base[1]!, base[2]!])
        options.push([c, NONE, NONE])
      }
      if (base[0]! !== NONE) {
        for (const m of [NONE, ...planner.modifierOptions(gene, 1)]) options.push([base[0]!, m, base[2]!])
        for (const m of [NONE, ...planner.modifierOptions(gene, 2)]) options.push([base[0]!, base[1]!, m])
      }
      let bestOption: [number, number, number] | null = null
      for (const [c, s1, s2] of options) {
        setGene(genes, gene, c, s1, s2)
        if (!planner.feasible(genes)) continue
        const s = planner.evaluate(genes).score
        if (s > best + 1e-12) {
          best = s
          bestOption = [c, s1, s2]
        }
      }
      if (bestOption) {
        setGene(genes, gene, ...bestOption)
        improved = true
      } else setGene(genes, gene, base[0]!, base[1]!, base[2]!)
    }
    for (let a = 0; a < geneCount && clock() < deadline; a++) {
      if (planner.isPinned(a)) continue
      for (let b = a + 1; b < geneCount; b++) {
        if (planner.isPinned(b)) continue
        const ka = planner.keypoints[Math.floor(a / planner.size)]!
        const kb = planner.keypoints[Math.floor(b / planner.size)]!
        const ga = Array.from(genes.subarray(a * GENE, a * GENE + GENE))
        const gb = Array.from(genes.subarray(b * GENE, b * GENE + GENE))
        if (ga[0] === gb[0]) continue
        if (ka.stage === kb.stage) {
          setGene(genes, a, gb[0]!, gb[1]!, gb[2]!)
          setGene(genes, b, ga[0]!, ga[1]!, ga[2]!)
        } else {
          setGene(genes, a, gb[0]!, ga[1]!, ga[2]!)
          setGene(genes, b, ga[0]!, gb[1]!, gb[2]!)
        }
        if (planner.feasible(genes)) {
          const s = planner.evaluate(genes).score
          if (s > best + 1e-12) {
            best = s
            improved = true
            continue
          }
        }
        setGene(genes, a, ga[0]!, ga[1]!, ga[2]!)
        setGene(genes, b, gb[0]!, gb[1]!, gb[2]!)
      }
    }
  }
  return best
}

function bestRefill(planner: Planner, genes: Int32Array, gene: number, score: number): number {
  const base = Array.from(genes.subarray(gene * GENE, gene * GENE + GENE))
  let bestScore = -Infinity
  let bestCard = NONE
  for (const c of [NONE, ...planner.candidateCards(genes, gene)]) {
    setGene(genes, gene, c, NONE, NONE)
    if (!planner.feasible(genes)) continue
    const s = planner.evaluate(genes).score
    if (s > bestScore) {
      bestScore = s
      bestCard = c
    }
  }
  if (bestCard === NONE && bestScore === -Infinity) {
    setGene(genes, gene, base[0]!, base[1]!, base[2]!)
    return score
  }
  setGene(genes, gene, bestCard, NONE, NONE)
  return bestScore
}

function ejectionChains(planner: Planner, genes: Int32Array, score: number, deadline: number, clock: () => number): number {
  let best = score
  const size = planner.size
  const ev = planner.evaluate(genes)
  const targets: { gene: number; p: number }[] = []
  for (let k = 0; k < planner.keypoints.length; k++) {
    const kp = planner.keypoints[k]!
    for (let lane = 0; lane < size; lane++) {
      if (!kp.enemies[lane]) continue
      const p = ev.clearedProbabilities[k * size + lane]!
      if (p < 1 - 1e-9) targets.push({ gene: k * size + lane, p })
    }
  }
  targets.sort((x, y) => x.p - y.p)
  for (const { gene } of targets) {
    if (clock() > deadline) break
    if (planner.isPinned(gene)) continue
    const stage = planner.keypoints[Math.floor(gene / size)]!.stage
    const current = genes[gene * GENE]!
    for (let c = 0; c < planner.cards.length; c++) {
      if (c === current || clock() > deadline) continue
      if (planner.keypoints[Math.floor(gene / size)]!.isBanned(planner.cards[c]!)) continue
      const trial = genes.slice()
      const displaced: number[] = []
      for (let g = 0; g < planner.geneCount; g++) {
        if (g === gene || trial[g * GENE] !== c) continue
        displaced.push(g)
      }
      if (displaced.some(g => planner.isPinned(g))) continue
      setGene(trial, gene, c, NONE, NONE)
      const sameStage = displaced.filter(g => planner.keypoints[Math.floor(g / size)]!.stage === stage)
      for (const g of sameStage) setGene(trial, g, current, NONE, NONE)
      let s = -Infinity
      if (planner.feasible(trial)) s = planner.evaluate(trial).score
      else {
        for (const g of sameStage) setGene(trial, g, NONE, NONE, NONE)
        if (!planner.feasible(trial)) {
          const others = displaced.filter(g => !sameStage.includes(g))
          for (const g of others) {
            setGene(trial, g, NONE, NONE, NONE)
            if (planner.feasible(trial)) break
          }
        }
        if (!planner.feasible(trial)) continue
        s = planner.evaluate(trial).score
        for (const g of displaced) {
          if (trial[g * GENE] === NONE) s = bestRefill(planner, trial, g, s)
        }
      }
      if (s > best + 1e-12) {
        best = s
        genes.set(trial)
        break
      }
    }
  }
  return best
}

function stageAssignment(planner: Planner, genes: Int32Array, score: number, deadline: number, clock: () => number): number {
  let best = score
  let improved = true
  let rounds = 0
  while (improved && rounds < 6 && clock() < deadline) {
    improved = false
    rounds++
    for (let stage = 0; stage < planner.stages.length; stage++) {
      if (clock() > deadline) break
      const lanes = planner.stageLanes(stage)
      if (lanes.length === 0) continue
      const matrix = planner.assignmentMatrix(genes, stage, lanes)
      for (const g of lanes) matrix.push(lanes.map(h => (h === g ? planner.emptyLaneValue(g) : -Infinity)))
      const rows = matrix.length
      const assignment = maximizeAssignment(matrix, rows, lanes.length)
      const trial = genes.slice()
      const chosen = new Map<number, number>()
      for (let r = 0; r < planner.cards.length; r++) {
        const col = assignment[r]!
        if (col >= 0) chosen.set(lanes[col]!, r)
      }
      const assignedCards = new Set(chosen.values())
      for (let o = 0; o < planner.geneCount; o++) {
        const kp = planner.keypoints[Math.floor(o / planner.size)]!
        if (kp.stage !== stage || lanes.includes(o)) continue
        if (assignedCards.has(trial[o * GENE]!)) setGene(trial, o, NONE, NONE, NONE)
      }
      for (const g of lanes) {
        const c = chosen.get(g) ?? NONE
        if (c === genes[g * GENE]) continue
        setGene(trial, g, c, NONE, NONE)
      }
      if (!planner.feasible(trial)) continue
      const s = planner.evaluate(trial).score
      if (s > best + 1e-12) {
        best = s
        genes.set(trial)
        improved = true
      }
    }
  }
  return best
}

function mutate(planner: Planner, candidate: Int32Array, random: () => number): boolean {
  if (shift(planner, candidate, random)) return true
  planner.work += WORK_MUTATE
  return false
}

function shift(planner: Planner, candidate: Int32Array, random: () => number): boolean {
  const geneCount = planner.geneCount
  const gene = Math.floor(random() * geneCount)
  if (planner.isPinned(gene)) return false
  const roll = random()
  const cur = candidate[gene * GENE]!
  if (roll < 0.4) {
    const options = planner.candidateCards(candidate, gene)
    const pick = random() < 0.12 || options.length === 0 ? NONE : options[Math.floor(random() * options.length)]!
    if (pick === cur) return false
    setGene(candidate, gene, pick, cur === NONE ? NONE : candidate[gene * GENE + 1]!, cur === NONE ? NONE : candidate[gene * GENE + 2]!)
    if (cur === NONE && pick !== NONE && random() < 0.5) {
      const slot: 1 | 2 = random() < 0.5 ? 1 : 2
      const mods = planner.modifierOptions(gene, slot)
      if (mods.length) candidate[gene * GENE + slot] = mods[Math.floor(random() * mods.length)]!
    }
    return true
  }
  if (roll < 0.7) {
    const other = Math.floor(random() * geneCount)
    if (other === gene || planner.isPinned(other)) return false
    const a = Array.from(candidate.subarray(gene * GENE, gene * GENE + GENE))
    const b = Array.from(candidate.subarray(other * GENE, other * GENE + GENE))
    if (a[0] === b[0]) return false
    const ka = planner.keypoints[Math.floor(gene / planner.size)]!
    const kb = planner.keypoints[Math.floor(other / planner.size)]!
    if (ka.stage === kb.stage && random() < 0.6) {
      setGene(candidate, gene, b[0]!, b[1]!, b[2]!)
      setGene(candidate, other, a[0]!, a[1]!, a[2]!)
    } else {
      setGene(candidate, gene, b[0]!, a[1]!, a[2]!)
      setGene(candidate, other, a[0]!, b[1]!, b[2]!)
    }
    return true
  }
  if (cur === NONE) return false
  const slot: 1 | 2 = roll < 0.85 ? 1 : 2
  const options = planner.modifierOptions(gene, slot)
  const pick = random() < 0.3 || options.length === 0 ? NONE : options[Math.floor(random() * options.length)]!
  if (candidate[gene * GENE + slot] === pick) return false
  candidate[gene * GENE + slot] = pick
  return true
}

function calibrate(planner: Planner, genes: Int32Array, score: number, random: () => number): number {
  const candidate = genes.slice()
  const worse: number[] = []
  for (let n = 0; n < 400 && worse.length < 120; n++) {
    candidate.set(genes)
    if (!mutate(planner, candidate, random) || !planner.feasible(candidate)) continue
    const delta = planner.evaluate(candidate).score - score
    if (delta < -1e-9) worse.push(-delta)
  }
  if (worse.length === 0) return 0.05
  worse.sort((x, y) => x - y)
  const median = worse[Math.floor(worse.length / 2)]!
  return Math.min(Math.max(median * 0.6, 1e-3), 2)
}

function kick(planner: Planner, genes: Int32Array, random: () => number, strength: number): void {
  const candidate = genes.slice()
  const moves = Math.max(2, Math.round(planner.geneCount * strength))
  let applied = 0
  for (let n = 0; n < moves * 8 && applied < moves; n++) {
    candidate.set(genes)
    if (!mutate(planner, candidate, random) || !planner.feasible(candidate)) continue
    genes.set(candidate)
    applied++
  }
}

function anneal(
  planner: Planner,
  start: Int32Array,
  startScore: number,
  deadline: number,
  clock: () => number,
  random: () => number,
  t0: number,
): { genes: Int32Array; score: number } {
  let genes = start.slice()
  let score = startScore
  let best = genes.slice()
  let bestScore = score
  if (planner.geneCount === 0) return { genes: best, score: bestScore }
  const t1 = t0 * 0.004
  const begin = clock()
  const span = Math.max(1, deadline - begin)
  let iterations = 0
  let temperature = t0
  const candidate = genes.slice()
  while (true) {
    if ((iterations & 63) === 0) {
      const now = clock()
      if (now >= deadline) break
      temperature = t0 * Math.pow(t1 / t0, (now - begin) / span)
    }
    iterations++
    candidate.set(genes)
    if (!mutate(planner, candidate, random)) continue
    const hp = planner.feasibleHp(candidate)
    if (!hp) continue
    const s = planner.evaluate(candidate, true, hp).score
    const delta = s - score
    if (delta >= 0 || random() < Math.exp(delta / temperature)) {
      genes = candidate.slice()
      score = s
      if (score > bestScore + 1e-12) {
        bestScore = score
        best = genes.slice()
      }
    }
  }
  return { genes: best, score: bestScore }
}

interface Lead {
  readonly deficit: number
  readonly cost: number
  readonly metrics: readonly number[]
}

interface Standing extends Lead {
  readonly uses: number
  readonly specials: number
  readonly kills: number
  readonly later: number
  readonly strength: number
  readonly deployed: number
}

interface Move {
  readonly genes: Int32Array
  readonly standing: Standing
}

interface Measure {
  readonly metrics: readonly number[]
  readonly kills: number
}

function quantize(v: number): number {
  return Math.round(v * QUANTUM)
}

function shortfall(metrics: readonly number[], floor: readonly number[]): number {
  let deficit = 0
  metrics.forEach((v, i) => {
    const f = floor[i]!
    if (v < f) deficit += (f - v) / Math.max(Math.abs(f), 1e-12)
  })
  return quantize(deficit)
}

function measure(planner: Planner, genes: Int32Array): Measure {
  const hard = planner.evaluate(genes, false)
  return {
    metrics: primaryMetrics(planner.objective, hard.complete, hard.perfect, hard.expectedReward, hard.expectedStages, hard.expectedKills),
    kills: hard.expectedKills,
  }
}

type Visit = (stage: number, strength: number, standard: boolean, special: boolean) => void

function rate(metrics: readonly number[], kills: number, deficit: number, cost: number, last: number, lanes: (visit: Visit) => void): Standing {
  let uses = 0
  let specials = 0
  let later = 0
  let strength = 0
  let deployed = 0
  lanes((stage, power, standard, special) => {
    deployed++
    strength += power
    if (standard) {
      uses++
      later += last - stage
    }
    if (special) {
      uses++
      specials++
      later += last - stage
    }
  })
  return {
    deficit,
    cost,
    metrics: metrics.map(quantize),
    uses,
    specials,
    kills: quantize(kills),
    later,
    strength: Math.round(strength * 1e6),
    deployed,
  }
}

function settle(planner: Planner, genes: Int32Array, m: Measure, deficit: number, cost: number): Standing {
  return rate(m.metrics, m.kills, deficit, cost, planner.stages.length - 1, visit => {
    for (let gene = 0; gene < planner.geneCount; gene++) {
      const g = gene * GENE
      const c = genes[g]!
      if (c !== NONE) visit(stageOf(planner, gene), planner.cardStrength[c]!, genes[g + 1] !== NONE, genes[g + 2] !== NONE)
    }
  })
}

interface Champion {
  genes: Int32Array | null
  metrics: readonly number[]
}

let champion: Champion | null = null

function observe(genes: Int32Array, metrics: readonly number[]): void {
  if (!champion) return
  if (champion.genes && shortfall(champion.metrics, primaryFloor([champion.metrics, metrics])) === 0) return
  champion.genes = genes.slice()
  champion.metrics = metrics
}

function standing(planner: Planner, genes: Int32Array, floor: readonly number[]): Standing {
  const m = measure(planner, genes)
  observe(genes, m.metrics)
  return settle(planner, genes, m, shortfall(m.metrics, floor), planner.modifierCost(genes))
}

function compareLead(a: Lead, b: Lead): number {
  if (a.deficit !== b.deficit) return a.deficit - b.deficit
  if (a.cost !== b.cost) return a.cost - b.cost
  for (let i = 0; i < a.metrics.length; i++) if (a.metrics[i] !== b.metrics[i]) return b.metrics[i]! - a.metrics[i]!
  return 0
}

function compareStanding(a: Standing, b: Standing): number {
  const lead = compareLead(a, b)
  if (lead !== 0) return lead
  if (a.uses !== b.uses) return a.uses - b.uses
  if (a.specials !== b.specials) return a.specials - b.specials
  if (a.kills !== b.kills) return b.kills - a.kills
  if (a.later !== b.later) return a.later - b.later
  if (a.strength !== b.strength) return a.strength - b.strength
  return a.deployed - b.deployed
}

interface Slot {
  readonly gene: number
  readonly slot: 1 | 2
  readonly at: number
}

function usedSlots(planner: Planner, genes: Int32Array): Slot[] {
  const out: (Slot & { saving: number })[] = []
  const base = planner.modifierCost(genes)
  for (let gene = 0; gene < planner.geneCount; gene++) {
    if (planner.isPinned(gene)) continue
    for (const slot of [1, 2] as const) {
      const at = gene * GENE + slot
      const m = genes[at]!
      if (m === NONE) continue
      genes[at] = NONE
      const saving = base - planner.modifierCost(genes)
      genes[at] = m
      out.push({ gene, slot, at, saving })
    }
  }
  return out.sort((a, b) => b.saving - a.saving || a.at - b.at)
}

function openSlots(planner: Planner, genes: Int32Array, stages: ReadonlySet<number> | null): Slot[] {
  const out: Slot[] = []
  for (let gene = 0; gene < planner.geneCount; gene++) {
    if (planner.isPinned(gene) || genes[gene * GENE] === NONE) continue
    if (stages && !stages.has(stageOf(planner, gene))) continue
    for (const slot of [1, 2] as const) if (genes[gene * GENE + slot] === NONE) out.push({ gene, slot, at: gene * GENE + slot })
  }
  return out
}

function stageOf(planner: Planner, gene: number): number {
  return planner.keypoints[Math.floor(gene / planner.size)]!.stage
}

function tryCandidate(planner: Planner, trial: Int32Array, here: Standing, floor: readonly number[]): Standing | null {
  const cost = planner.modifierCost(trial)
  if (here.deficit === 0 && cost > here.cost) return null
  if (!planner.feasible(trial)) return null
  const m = measure(planner, trial)
  observe(trial, m.metrics)
  const deficit = shortfall(m.metrics, floor)
  if (here.deficit === 0 && deficit > 0) return null
  const s = settle(planner, trial, m, deficit, cost)
  return compareStanding(s, here) < 0 ? s : null
}

type Neighborhood = (
  planner: Planner,
  genes: Int32Array,
  here: Standing,
  floor: readonly number[],
  deadline: number,
  clock: () => number,
) => Move | null

const dropMove: Neighborhood = (planner, genes, here, floor, deadline, clock) => {
  for (const used of usedSlots(planner, genes)) {
    if (clock() > deadline) return null
    const trial = genes.slice()
    trial[used.at] = NONE
    const s = tryCandidate(planner, trial, here, floor)
    if (s) return { genes: trial, standing: s }
  }
  return null
}

const swapMove: Neighborhood = (planner, genes, here, floor, deadline, clock) => {
  for (const used of usedSlots(planner, genes)) {
    const original = genes[used.at]!
    const base = genes.slice()
    base[used.at] = NONE
    for (const open of openSlots(planner, base, null)) {
      if (clock() > deadline) return null
      for (const m of planner.modifierOptions(open.gene, open.slot)) {
        if (open.at === used.at && m === original) continue
        const trial = base.slice()
        trial[open.at] = m
        const s = tryCandidate(planner, trial, here, floor)
        if (s) return { genes: trial, standing: s }
      }
    }
  }
  return null
}

const splitMove: Neighborhood = (planner, genes, here, floor, deadline, clock) => {
  for (const used of usedSlots(planner, genes)) {
    const base = genes.slice()
    base[used.at] = NONE
    const stages = new Set([stageOf(planner, used.gene)])
    const firsts: { trial: Int32Array; s: Standing }[] = []
    for (const open of openSlots(planner, base, stages)) {
      if (clock() > deadline) return null
      for (const m of planner.modifierOptions(open.gene, open.slot)) {
        const trial = base.slice()
        trial[open.at] = m
        if (planner.modifierCost(trial) >= here.cost || !planner.feasible(trial)) continue
        const s = standing(planner, trial, floor)
        if (compareStanding(s, here) < 0) return { genes: trial, standing: s }
        firsts.push({ trial, s })
      }
    }
    firsts.sort((a, b) => compareStanding(a.s, b.s))
    for (const first of firsts.slice(0, SPLIT_BEAM)) {
      for (const open of openSlots(planner, first.trial, stages)) {
        if (clock() > deadline) return null
        for (const m of planner.modifierOptions(open.gene, open.slot)) {
          const trial = first.trial.slice()
          trial[open.at] = m
          const s = tryCandidate(planner, trial, here, floor)
          if (s) return { genes: trial, standing: s }
        }
      }
    }
  }
  return null
}

const mergeMove: Neighborhood = (planner, genes, here, floor, deadline, clock) => {
  const used = usedSlots(planner, genes)
  for (let i = 0; i < used.length; i++) {
    for (let j = i + 1; j < used.length; j++) {
      const a = used[i]!
      const b = used[j]!
      const base = genes.slice()
      base[a.at] = NONE
      base[b.at] = NONE
      const stages = new Set([stageOf(planner, a.gene), stageOf(planner, b.gene)])
      for (const open of openSlots(planner, base, stages)) {
        if (clock() > deadline) return null
        for (const m of planner.modifierOptions(open.gene, open.slot)) {
          const trial = base.slice()
          trial[open.at] = m
          const s = tryCandidate(planner, trial, here, floor)
          if (s) return { genes: trial, standing: s }
        }
      }
    }
  }
  return null
}

const reassignMove: Neighborhood = (planner, genes, here, floor, deadline, clock) => {
  const used = usedSlots(planner, genes)
  for (let i = 0; i < used.length; i++) {
    const now = clock()
    if (now > deadline) return null
    const slice = Math.max(1, (deadline - now) / (used.length - i))
    const trial = genes.slice()
    trial[used[i]!.at] = NONE
    if (!planner.feasible(trial)) continue
    planner.allowModifiers = false
    let score = polish(planner, trial, planner.evaluate(trial).score, Math.min(deadline, now + slice * 0.6), clock)
    score = stageAssignment(planner, trial, score, Math.min(deadline, now + slice * 0.8), clock)
    ejectionChains(planner, trial, score, Math.min(deadline, now + slice), clock)
    planner.allowModifiers = true
    const s = tryCandidate(planner, trial, here, floor)
    if (s) return { genes: trial, standing: s }
  }
  return null
}

function laneOptions(planner: Planner, genes: Int32Array, gene: number): [number, number, number][] {
  const g = gene * GENE
  const card = genes[g]!
  const std = genes[g + 1]!
  const spc = genes[g + 2]!
  const out: [number, number, number][] = []
  if (card !== NONE) out.push([NONE, NONE, NONE])
  for (const c of planner.candidateCards(genes, gene)) {
    if (c === card) continue
    out.push([c, NONE, NONE])
    if (card !== NONE && (std !== NONE || spc !== NONE)) out.push([c, std, spc])
  }
  if (card !== NONE) {
    for (const m of [NONE, ...planner.modifierOptions(gene, 1)]) if (m !== std) out.push([card, m, spc])
    for (const m of [NONE, ...planner.modifierOptions(gene, 2)]) if (m !== spc) out.push([card, std, m])
  }
  return out
}

const tidyMove: Neighborhood = (planner, genes, here, floor, deadline, clock) => {
  for (let gene = 0; gene < planner.geneCount; gene++) {
    if (planner.isPinned(gene) || genes[gene * GENE] === NONE) continue
    if (clock() > deadline) return null
    for (const option of laneOptions(planner, genes, gene)) {
      const trial = genes.slice()
      setGene(trial, gene, ...option)
      const s = tryCandidate(planner, trial, here, floor)
      if (s) return { genes: trial, standing: s }
    }
  }
  return null
}

const NEIGHBORHOODS: readonly Neighborhood[] = [dropMove, swapMove, splitMove, mergeMove, reassignMove, tidyMove]

function lanesOf(planner: Planner, genes: Int32Array, k: number): PinnedLane[] {
  const lanes: PinnedLane[] = []
  for (let lane = 0; lane < planner.size; lane++) {
    const g = (k * planner.size + lane) * GENE
    const c = genes[g]!
    lanes.push({
      card: c === NONE ? null : planner.cards[c]!.code,
      standard: c === NONE || genes[g + 1] === NONE ? null : planner.modifiers[genes[g + 1]!]!,
      special: c === NONE || genes[g + 2] === NONE ? null : planner.modifiers[genes[g + 2]!]!,
    })
  }
  return lanes
}

function lanesKey(id: string, lanes: readonly PinnedLane[]): string {
  return `${id}:${lanes.map(l => `${l.card ?? '-'}|${l.standard ?? '-'}|${l.special ?? '-'}`).join(',')}`
}

function genesKey(planner: Planner, genes: Int32Array): string {
  return planner.stages.map(stage => stage.keypoints.map(k => lanesKey(planner.keypoints[k]!.input.id, lanesOf(planner, genes, k))).join(';')).join('/')
}

function canonicalize(planner: Planner, genes: Int32Array, floor: readonly number[], deadline: number, clock: () => number): Standing {
  let here = standing(planner, genes, floor)
  let key = genesKey(planner, genes)
  const consider = (trial: Int32Array): boolean => {
    if (!planner.feasible(trial)) return false
    const s = standing(planner, trial, floor)
    const order = compareStanding(s, here)
    if (order > 0) return false
    const trialKey = genesKey(planner, trial)
    if (order === 0 && trialKey >= key) return false
    genes.set(trial)
    here = s
    key = trialKey
    return true
  }
  let changed = true
  while (changed && clock() < deadline) {
    changed = false
    for (let gene = 0; gene < planner.geneCount && clock() < deadline; gene++) {
      if (planner.isPinned(gene)) continue
      for (const option of laneOptions(planner, genes, gene)) {
        const trial = genes.slice()
        setGene(trial, gene, ...option)
        if (consider(trial)) changed = true
      }
    }
    for (let a = 0; a < planner.geneCount && clock() < deadline; a++) {
      if (planner.isPinned(a)) continue
      for (let b = 0; b < planner.geneCount; b++) {
        if (b === a || planner.isPinned(b) || stageOf(planner, a) !== stageOf(planner, b)) continue
        if (genes[a * GENE] === NONE && genes[b * GENE] === NONE) continue
        if (b > a) {
          const swapped = genes.slice()
          swapped.copyWithin(a * GENE, b * GENE, b * GENE + GENE)
          swapped.set(genes.subarray(a * GENE, a * GENE + GENE), b * GENE)
          if (consider(swapped)) changed = true
        }
        if (genes[a * GENE] === NONE || genes[b * GENE] === NONE) continue
        const taken = genes.slice()
        taken[a * GENE] = genes[b * GENE]!
        taken.fill(NONE, b * GENE, b * GENE + GENE)
        if (consider(taken)) changed = true
      }
    }
  }
  return here
}

function descend(planner: Planner, genes: Int32Array, floor: readonly number[], deadline: number, clock: () => number): Standing {
  let here = standing(planner, genes, floor)
  let k = 0
  while (k < NEIGHBORHOODS.length && clock() < deadline) {
    const move = NEIGHBORHOODS[k]!(planner, genes, here, floor, deadline, clock)
    if (move) {
      genes.set(move.genes)
      here = move.standing
      k = 0
    } else k++
  }
  return here
}

function repairUp(planner: Planner, genes: Int32Array, floor: readonly number[], deadline: number, clock: () => number): Standing {
  let here = standing(planner, genes, floor)
  if (here.deficit === 0) return here
  planner.allowModifiers = false
  polish(planner, genes, planner.evaluate(genes).score, Math.min(deadline, clock() + (deadline - clock()) * 0.25), clock)
  planner.allowModifiers = true
  here = standing(planner, genes, floor)
  let soft = planner.evaluate(genes).score
  while (here.deficit > 0 && clock() < deadline) {
    let pick: { trial: Int32Array; s: Standing; soft: number; rank: number } | null = null
    for (const open of openSlots(planner, genes, null)) {
      if (clock() > deadline) break
      for (const m of planner.modifierOptions(open.gene, open.slot)) {
        const trial = genes.slice()
        trial[open.at] = m
        if (!planner.feasible(trial)) continue
        const s = standing(planner, trial, floor)
        const trialSoft = planner.evaluate(trial).score
        const gain = here.deficit - s.deficit + SOFT_HINT * quantize(trialSoft - soft)
        if (gain <= 0) continue
        const rank = s.deficit === 0 ? Infinity : gain / Math.max(s.cost - here.cost, 1)
        if (!pick || rank > pick.rank || (rank === pick.rank && compareStanding(s, pick.s) < 0)) pick = { trial, s, soft: trialSoft, rank }
      }
    }
    if (!pick) break
    genes.set(pick.trial)
    here = pick.s
    soft = pick.soft
  }
  return here
}

function exactLayer(
  planner: Planner,
  genes: Int32Array,
  floor: readonly number[],
  deadline: number,
  clock: () => number,
  collect?: Int32Array[],
): Standing {
  let here = standing(planner, genes, floor)
  const dists = planner.evaluate(genes, false).killDistributions
  for (const cap of [LIMITS.cap, LIMITS.cap + 1]) {
    const found = allocate(planner, genes, dists, floor, { ...LIMITS, cap }, deadline, clock, planner.allocations)
    if (!found) return here
    let passed = false
    for (const candidate of found) {
      if (!planner.feasible(candidate.genes)) continue
      collect?.push(candidate.genes)
      const s = standing(planner, candidate.genes, floor)
      passed ||= s.deficit === 0
      if (compareStanding(s, here) < 0) {
        genes.set(candidate.genes)
        here = s
      }
    }
    if (passed) break
  }
  return here
}

function skeletonMoves(planner: Planner, genes: Int32Array, gene: number): Int32Array[] {
  const out: Int32Array[] = []
  const size = planner.size
  const stage = stageOf(planner, gene)
  const kp = planner.keypoints[Math.floor(gene / size)]!
  const current = genes[gene * GENE]!
  const strip = (trial: Int32Array, g: number) => {
    trial[g * GENE + 1] = NONE
    if (trial[g * GENE + 2] !== NONE && planner.modifiers[trial[g * GENE + 2]!] !== 'fast-repair') trial[g * GENE + 2] = NONE
  }
  for (let c = 0; c < planner.cards.length; c++) {
    if (c === current || kp.isBanned(planner.cards[c]!)) continue
    const trial = genes.slice()
    for (const other of planner.stages[stage]!.keypoints) {
      for (let lane = 0; lane < size; lane++) {
        const g = other * size + lane
        if (g !== gene && trial[g * GENE] === c) {
          if (planner.isPinned(g)) continue
          trial[g * GENE] = current
          strip(trial, g)
          if (current === NONE) trial[g * GENE + 2] = NONE
        }
      }
    }
    trial[gene * GENE] = c
    strip(trial, gene)
    out.push(trial)
  }
  if (current !== NONE) {
    const dropped = genes.slice()
    dropped.fill(NONE, gene * GENE, gene * GENE + GENE)
    out.push(dropped)
    for (let other = 0; other < planner.geneCount; other++) {
      if (other === gene || planner.isPinned(other) || stageOf(planner, other) === stage || genes[other * GENE] === NONE) continue
      const target = planner.keypoints[Math.floor(other / size)]!
      const theirs = genes[other * GENE]!
      if (theirs === current || target.isBanned(planner.cards[current]!) || kp.isBanned(planner.cards[theirs]!)) continue
      const swapped = genes.slice()
      swapped[gene * GENE] = theirs
      swapped[other * GENE] = current
      strip(swapped, gene)
      strip(swapped, other)
      out.push(swapped)
    }
    const repair = planner.modifiers.indexOf('fast-repair')
    if (repair >= 0) {
      const toggled = genes.slice()
      toggled[gene * GENE + 2] = genes[gene * GENE + 2] === repair ? NONE : repair
      out.push(toggled)
    }
  }
  return out
}

function stageMoves(planner: Planner, genes: Int32Array, deadline: number, clock: () => number): Int32Array[] {
  if (clock() > deadline) return []
  const trial = cardsOnly(planner, genes)
  for (let gene = 0; gene < planner.geneCount; gene++) {
    const spc = genes[gene * GENE + 2]!
    if (spc !== NONE && planner.modifiers[spc] === 'fast-repair') trial[gene * GENE + 2] = spc
  }
  const allow = planner.allowModifiers
  planner.allowModifiers = false
  const before = trial.join(',')
  stageAssignment(planner, trial, planner.evaluate(trial).score, deadline, clock)
  planner.allowModifiers = allow
  return trial.join(',') === before ? [] : [trial]
}

function skeletonDescent(
  planner: Planner,
  genes: Int32Array,
  floor: readonly number[],
  deadline: number,
  clock: () => number,
): Standing {
  let here = standing(planner, genes, floor)
  let improved = true
  while (improved && clock() < deadline) {
    improved = false
    for (const trial of stageMoves(planner, genes, deadline, clock)) {
      if (clock() > deadline || !planner.feasible(trial)) continue
      const s = exactLayer(planner, trial, floor, deadline, clock)
      if (compareStanding(s, here) < 0) {
        genes.set(trial)
        here = s
        improved = true
        break
      }
    }
    if (improved) continue
    const probabilities = planner.evaluate(genes, false).clearedProbabilities
    const order: { gene: number; rank: number }[] = []
    for (let gene = 0; gene < planner.geneCount; gene++) {
      if (planner.isPinned(gene)) continue
      const kp = planner.keypoints[Math.floor(gene / planner.size)]!
      const lane = gene % planner.size
      const g = gene * GENE
      let rank = 0
      if (genes[g + 2] !== NONE) rank = 4
      else if (genes[g + 1] !== NONE) rank = 3
      else if (kp.enemies[lane] && genes[g] !== NONE && probabilities[gene]! < 1 - 1e-9) rank = 2
      else if (kp.enemies[lane] && genes[g] === NONE) rank = 1
      else continue
      order.push({ gene, rank })
    }
    order.sort((a, b) => b.rank - a.rank || a.gene - b.gene)
    for (const { gene } of order) {
      if (improved || clock() > deadline) break
      for (const trial of skeletonMoves(planner, genes, gene)) {
        if (clock() > deadline) break
        if (!planner.feasible(trial)) continue
        const before = here
        const s = exactLayer(planner, trial, floor, deadline, clock)
        if (compareStanding(s, before) < 0) {
          genes.set(trial)
          here = s
          improved = true
          break
        }
      }
    }
  }
  return here
}

function thriftPass(
  planner: Planner,
  starts: readonly Int32Array[],
  floor: readonly number[],
  deadline: number,
  clock: () => number,
  random: () => number,
): Int32Array[] {
  const begin = clock()
  const span = deadline - begin
  const found: Int32Array[] = []
  starts.forEach((start, i) => {
    const slot = begin + (span * 0.45 * (i + 1)) / starts.length
    const exact = start.slice()
    exactLayer(planner, exact, floor, slot, clock)
    found.push(exact)
    if (planner.modifierCost(start) > 0) {
      const local = start.slice()
      repairUp(planner, local, floor, slot, clock)
      descend(planner, local, floor, slot, clock)
      found.push(local)
    }
  })
  const genes = rankGenes(planner, found, floor)[0]!.slice()
  skeletonDescent(planner, genes, floor, begin + span * 0.8, clock)
  let here = descend(planner, genes, floor, begin + span * 0.85, clock)
  let fails = 0
  const kicks = begin + span * 0.93
  while (fails < KICK_LIMIT && clock() < kicks) {
    const trial = genes.slice()
    kick(planner, trial, random, KICK_STRENGTH)
    repairUp(planner, trial, floor, deadline, clock)
    const s = exactLayer(planner, trial, floor, kicks, clock)
    if (compareStanding(s, here) < 0) {
      genes.set(trial)
      here = s
      fails = 0
    } else fails++
  }
  canonicalize(planner, genes, floor, deadline, clock)
  found.push(genes)
  return found
}

function thrift(
  planner: Planner,
  starts: readonly Int32Array[],
  floor: readonly number[],
  deadline: number,
  clock: () => number,
  random: () => number,
): { found: Int32Array[]; floor: readonly number[] } {
  let current = floor
  let pool = starts
  const found: Int32Array[] = []
  champion = { genes: null, metrics: primaryTop(floor) }
  try {
    for (let pass = 0; pass < RAISE_LIMIT && clock() < deadline; pass++) {
      const begin = clock()
      found.push(...thriftPass(planner, pool, current, begin + (deadline - begin) / (RAISE_LIMIT - pass), clock, random))
      current = raiseFloor(current, champion.metrics)
      if (champion.genes) pool = [champion.genes]
      champion = { genes: null, metrics: champion.metrics }
    }
  } finally {
    champion = null
  }
  return { found, floor: current }
}

function primaryTop(floor: readonly number[]): number[] {
  return floor.map(f => (f + 1e-12) / (1 - RESULT_TOLERANCE))
}

function raiseFloor(floor: readonly number[], metrics: readonly number[]): readonly number[] {
  const raised = primaryFloor([metrics, primaryTop(floor)])
  for (let i = 0; i < floor.length; i++) {
    const rise = quantize(raised[i]!) - quantize(floor[i]!)
    if (rise !== 0) return rise > 0 ? raised : floor
  }
  return floor
}

export function describePlan(planner: Planner, genes: Int32Array, elapsedMs: number, truncated = false): PlanResult {
  const ev = planner.evaluate(genes, false, undefined, true)
  const hp = planner.hpTable(genes) ?? new Int8Array(planner.cards.length * planner.stages.length)
  const stageCount = planner.stages.length
  const modifiersUsed: Partial<Record<ModifierId, number>> = {}
  const stages: PlannedStage[] = planner.stages.map((stage, s) => {
    const keypoints: PlannedKeypoint[] = stage.keypoints.map(k => {
      const kp = planner.keypoints[k]!
      const lanes: PlannedLane[] = []
      let attack = false
      let expectedKills = 0
      let allWin = 1
      let clearedWin = 1
      for (let lane = 0; lane < planner.size; lane++) {
        const g = (k * planner.size + lane) * GENE
        const c = genes[g]!
        const std = genes[g + 1]!
        const spc = genes[g + 2]!
        const p = ev.laneProbabilities[k * planner.size + lane]!
        const q = ev.clearedProbabilities[k * planner.size + lane]!
        if (c !== NONE) attack = true
        for (const m of [std, spc]) {
          if (m === NONE) continue
          const id = planner.modifiers[m]!
          modifiersUsed[id] = (modifiersUsed[id] ?? 0) + 1
        }
        if (kp.enemies[lane]) {
          const v = Number.isNaN(p) ? 0 : p
          expectedKills += v
          allWin *= v
          clearedWin *= Number.isNaN(q) ? 0 : q
        }
        lanes.push({
          card: c === NONE ? null : planner.cards[c]!.code,
          standard: std === NONE ? null : planner.modifiers[std]!,
          special: spc === NONE ? null : planner.modifiers[spc]!,
          hp: c === NONE ? null : hp[c * stageCount + kp.stage]!,
          probability: Number.isNaN(p) ? null : p,
        })
      }
      const removal = kp.input.lanes.some(Boolean) ? atLeast(ev.killDistributions[k]!, kp.removalNeed) : null
      return {
        id: kp.input.id,
        stage: stage.index,
        attack,
        lanes,
        expectedKills,
        allWinProbability: kp.hasEnemies ? allWin : 0,
        clearedWinProbability: kp.hasEnemies ? clearedWin : 0,
        removalProbability: removal,
      }
    })
    return {
      index: stage.index,
      goal: stage.goal,
      goalProbability: ev.stageGoal[s]!,
      expectedKills: ev.stageKills[s]!,
      keypoints,
    }
  })
  const fleetHp: Record<string, number[]> = {}
  planner.cards.forEach((card, c) => {
    const series: number[] = []
    for (let s = 0; s < stageCount; s++) series.push(hp[c * stageCount + s]!)
    let last = series.length ? series[series.length - 1]! : planner.startHp[c]!
    for (let k = 0; k < planner.keypoints.length; k++) {
      const kp = planner.keypoints[k]!
      if (kp.stage !== stageCount - 1) continue
      for (let lane = 0; lane < planner.size; lane++) {
        const g = (k * planner.size + lane) * GENE
        if (genes[g] !== c) continue
        const spc = genes[g + 2]!
        const repaired = spc !== NONE && planner.modifiers[spc] === 'fast-repair' ? Math.min(last + 2, 3) : last
        last = repaired - 1
      }
    }
    series.push(last)
    fleetHp[card.code] = series
  })
  return {
    objective: planner.objective,
    stages,
    completeProbability: ev.complete,
    perfectProbability: ev.perfect,
    expectedKills: ev.expectedKills,
    expectedReward: ev.expectedReward,
    expectedStages: ev.expectedStages,
    enemyTotal: planner.enemyTotal,
    modifiersUsed,
    fleetHp,
    modifierCost: planner.modifierCost(genes),
    elapsedMs,
    truncated,
  }
}

export interface Elite {
  readonly placements: Readonly<Record<string, readonly PinnedLane[]>>
  readonly metrics: readonly number[]
  readonly cost: number
  readonly truncated: boolean
}

export interface ThriftOptions extends PlannerOptions {
  readonly floor: readonly number[]
  readonly starts: readonly Readonly<Record<string, readonly PinnedLane[]>>[]
}

export interface SolveOptions extends PlannerOptions {
  readonly jobs?: readonly SolveJob[]
}

interface Session {
  readonly planner: Planner
  readonly clock: () => number
  readonly started: number
  readonly budget: number
  readonly random: () => number
  readonly elapsed: () => number
  readonly truncated: () => boolean
}

function openSession(state: OperationState, options: PlannerOptions): Session {
  const planner = new Planner(state, options)
  if (options.modifierWeight !== undefined) planner.modifierWeight = options.modifierWeight
  const budget = options.timeBudgetMs ?? 1500
  const real = () => performance.now()
  const opened = real()
  let truncated = false
  const clock = () => {
    if (!truncated && real() - opened > budget * SAFETY_FACTOR) truncated = true
    return truncated ? Infinity : planner.work * WORK_MS
  }
  return {
    planner,
    clock,
    started: clock(),
    budget,
    random: mulberry32(options.seed ?? QUICK_JOBS[0]!.seed),
    elapsed: () => real() - opened,
    truncated: () => truncated,
  }
}

function placementsOf(planner: Planner, genes: Int32Array): Record<string, PinnedLane[]> {
  const out: Record<string, PinnedLane[]> = {}
  planner.keypoints.forEach((kp, k) => {
    out[kp.input.id] = lanesOf(planner, genes, k)
  })
  return out
}

function exactMetrics(planner: Planner, genes: Int32Array): number[] {
  const ev = planner.evaluate(genes, false, undefined, true)
  return primaryMetrics(planner.objective, ev.complete, ev.perfect, ev.expectedReward, ev.expectedStages, ev.expectedKills)
}

function cardsOnly(planner: Planner, genes: Int32Array): Int32Array {
  const out = genes.slice()
  for (let gene = 0; gene < planner.geneCount; gene++) {
    if (planner.isPinned(gene)) continue
    out[gene * GENE + 1] = NONE
    out[gene * GENE + 2] = NONE
  }
  return out
}

function primarySearch(session: Session, variant: SearchVariant): Int32Array[] {
  const { planner, clock, started, budget, random } = session
  const at = (share: number) => started + budget * share
  const found: Int32Array[] = []
  planner.allowModifiers = false
  let cards = planner.emptyGenes()
  let cardScore = -Infinity
  for (const order of ['hardest', 'sequential'] as const) {
    const genes = planner.emptyGenes()
    const first = order === 'hardest'
    let score = greedy(planner, genes, at(first ? 0.03 : 0.06), clock, order)
    score = stageAssignment(planner, genes, score, at(first ? 0.04 : 0.07), clock)
    score = polish(planner, genes, score, at(first ? 0.05 : 0.08), clock)
    if (score > cardScore) {
      cardScore = score
      cards = genes
    }
  }
  const cardT0 = calibrate(planner, cards, cardScore, random)
  planner.allowModifiers = true
  planner.allowSpecials = variant !== 'standard'
  const fullEnd = at(FULL_SHARE)
  let best = cards.slice()
  let bestScore = polish(planner, best, planner.evaluate(best).score, at(0.12), clock)
  found.push(best.slice())
  const t0 = calibrate(planner, best, bestScore, random)
  const rounds = 3
  for (let r = 0; r < rounds; r++) {
    const now = clock()
    const remaining = fullEnd - now
    if (remaining <= budget * 0.02) break
    const roundDeadline = now + (remaining * 0.8) / (rounds - r)
    const start = best.slice()
    planner.scoreObjective = r === rounds - 1 ? 'complete' : planner.objective
    if (r > 0) kick(planner, start, random, 0.08 + 0.04 * r)
    const result = anneal(planner, start, planner.evaluate(start).score, roundDeadline, clock, random, r === 0 ? t0 : t0 * 0.6)
    const polished = result.genes.slice()
    const spare = (fullEnd - roundDeadline) / (rounds - r)
    let ps = polish(planner, polished, result.score, roundDeadline + spare * 0.5, clock)
    ps = stageAssignment(planner, polished, ps, roundDeadline + spare * 0.75, clock)
    ejectionChains(planner, polished, ps, roundDeadline + spare, clock)
    planner.scoreObjective = planner.objective
    const own = planner.evaluate(polished).score
    found.push(polished.slice())
    if (own > bestScore + 1e-12) {
      bestScore = own
      best = polished
    }
  }
  planner.allowSpecials = true
  found.push(best)
  const floor = primaryFloor(found.filter(g => planner.feasible(g)).map(g => exactMetrics(planner, g)))
  champion = { genes: null, metrics: primaryTop(floor) }
  try {
    skeletonSearch(planner, cards, floor, at(0.98), clock, random, cardT0, found)
  } finally {
    champion = null
  }
  return found
}

function skeletonSearch(
  planner: Planner,
  start: Int32Array,
  initialFloor: readonly number[],
  deadline: number,
  clock: () => number,
  random: () => number,
  t0: number,
  found: Int32Array[],
): void {
  let floor = initialFloor
  const span = Math.max(1e-9, deadline - clock())
  let current: Int32Array = start.slice()
  let here: Standing | null = null
  for (let round = 0; clock() < deadline; round++) {
    const skeleton = current.slice()
    planner.allowModifiers = false
    planner.scoreObjective = round % 3 === 2 ? 'complete' : planner.objective
    if (round > 0) kick(planner, skeleton, random, SKELETON_KICK + 0.04 * (round % 4))
    const slice = Math.min(deadline, clock() + span * SKELETON_SLICE)
    const annealed = anneal(planner, skeleton, planner.evaluate(skeleton).score, slice, clock, random, t0)
    const shaped = annealed.genes
    const score = polish(planner, shaped, annealed.score, slice, clock)
    stageAssignment(planner, shaped, score, slice, clock)
    planner.scoreObjective = planner.objective
    planner.allowModifiers = true
    found.push(shaped.slice())
    const allocated = shaped.slice()
    let s = exactLayer(planner, allocated, floor, Math.min(deadline, clock() + span * SKELETON_SLICE), clock, found)
    found.push(allocated)
    if (champion?.genes) {
      const raised = raiseFloor(floor, champion.metrics)
      champion.genes = null
      if (raised !== floor) {
        floor = raised
        s = standing(planner, allocated, floor)
        here = null
      }
    }
    if (!here || compareStanding(s, here) < 0 || random() < SKELETON_DRIFT) {
      current = shaped
      here = s
    }
  }
}

export function searchPrimary(state: OperationState, options: PlannerOptions = {}): Elite[] {
  const session = openSession(state, options)
  const { planner } = session
  if (planner.geneCount === 0 || planner.cards.length === 0 || !planner.movable()) {
    const genes = planner.emptyGenes()
    return [{ placements: placementsOf(planner, genes), metrics: exactMetrics(planner, genes), cost: planner.modifierCost(genes), truncated: false }]
  }
  const found = primarySearch(session, options.variant ?? 'default')
  const truncated = session.truncated()
  const elite = (genes: Int32Array): Elite => ({
    placements: placementsOf(planner, genes),
    metrics: exactMetrics(planner, genes),
    cost: planner.modifierCost(genes),
    truncated,
  })
  const seen = new Set<string>()
  const elites: Elite[] = []
  for (const genes of found) {
    if (!planner.feasible(genes)) continue
    const key = genes.join(',')
    if (seen.has(key)) continue
    seen.add(key)
    elites.push(elite(genes))
  }
  return elites
}

export function primaryFloor(metrics: readonly (readonly number[])[]): number[] {
  const floor: number[] = []
  let pool = metrics
  const width = metrics[0]?.length ?? 0
  for (let i = 0; i < width; i++) {
    let top = -Infinity
    for (const m of pool) if (m[i]! > top) top = m[i]!
    const f = top - RESULT_TOLERANCE * Math.abs(top) - 1e-12
    floor.push(f)
    pool = pool.filter(m => m[i]! >= f)
  }
  return floor
}

function placementKey(placements: Readonly<Record<string, readonly PinnedLane[]>>): string {
  return Object.keys(placements)
    .sort()
    .map(id => lanesKey(id, placements[id]!))
    .join(';')
}

export function rankElites(elites: readonly Elite[], floor: readonly number[]): Elite[] {
  const seen = new Set<string>()
  const ranked: { e: Elite; lead: Lead; key: string }[] = []
  for (const e of elites) {
    const key = placementKey(e.placements)
    if (seen.has(key)) continue
    seen.add(key)
    ranked.push({ e, lead: { deficit: shortfall(e.metrics, floor), cost: e.cost, metrics: e.metrics.map(quantize) }, key })
  }
  ranked.sort((a, b) => compareLead(a.lead, b.lead) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return ranked.map(r => r.e)
}

export function startsFor(ranked: readonly Elite[], job: number, jobs: number): Readonly<Record<string, readonly PinnedLane[]>>[] {
  const out: Readonly<Record<string, readonly PinnedLane[]>>[] = []
  for (let i = job; i < ranked.length && out.length < THRIFT_STARTS; i += jobs) out.push(ranked[i]!.placements)
  if (out.length === 0 && ranked.length > 0) out.push(ranked[job % ranked.length]!.placements)
  return out
}

function rankGenes(planner: Planner, candidates: readonly Int32Array[], floor: readonly number[]): Int32Array[] {
  const seen = new Set<string>()
  const scored: { genes: Int32Array; s: Standing; key: string }[] = []
  for (const genes of candidates) {
    const key = genesKey(planner, genes)
    if (seen.has(key)) continue
    seen.add(key)
    scored.push({ genes, s: standing(planner, genes, floor), key })
  }
  scored.sort((a, b) => compareStanding(a.s, b.s) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return scored.map(x => x.genes)
}

export function economize(state: OperationState, options: ThriftOptions): PlanResult[] {
  const session = openSession(state, options)
  const { planner, clock, started, budget, random } = session
  const finish = (genes: Int32Array) => describePlan(planner, genes, session.elapsed(), session.truncated())
  if (planner.geneCount === 0 || planner.cards.length === 0 || !planner.movable()) return [finish(planner.emptyGenes())]
  const starts = options.starts.map(s => planner.genesFrom(s)).filter(g => planner.feasible(g))
  if (starts.length === 0) starts.push(planner.emptyGenes())
  const { found, floor } = thrift(planner, starts, options.floor, started + budget, clock, random)
  return rankGenes(planner, found, floor)
    .slice(0, THRIFT_RESULTS)
    .map(finish)
}

function planMetrics(plan: PlanResult): number[] {
  return primaryMetrics(plan.objective, plan.completeProbability, plan.perfectProbability, plan.expectedReward, plan.expectedStages, plan.expectedKills)
}

function planStanding(plan: PlanResult, floor: readonly number[]): Standing {
  const metrics = planMetrics(plan)
  return rate(metrics, plan.expectedKills, shortfall(metrics, floor), plan.modifierCost, plan.stages.length - 1, visit => {
    plan.stages.forEach((stage, s) => {
      for (const kp of stage.keypoints) {
        for (const lane of kp.lanes) {
          if (!lane.card) continue
          const card = cardByCode(lane.card)
          visit(s, card ? strengthOf(card) : 0, lane.standard !== null, lane.special !== null)
        }
      }
    })
  })
}

function canonicalKey(plan: PlanResult): string {
  return plan.stages.map(s => s.keypoints.map(k => lanesKey(k.id, k.lanes)).join(';')).join('/')
}

export function selectPlan(plans: readonly PlanResult[]): PlanResult {
  const floor = primaryFloor(plans.map(planMetrics))
  const ranked = plans.map(plan => ({ plan, s: planStanding(plan, floor), key: canonicalKey(plan) }))
  ranked.sort((a, b) => compareStanding(a.s, b.s) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return ranked[0]!.plan
}

export function phaseBudgets(total: number): { readonly primary: number; readonly thrift: number } {
  return { primary: total * PRIMARY_SHARE, thrift: total * (1 - PRIMARY_SHARE) }
}

export function solveOperation(state: OperationState, options: SolveOptions = {}): PlanResult {
  const jobs = options.jobs ?? [
    {
      seed: options.seed ?? QUICK_JOBS[0]!.seed,
      modifierWeight: options.modifierWeight ?? QUICK_JOBS[0]!.modifierWeight,
      variant: options.variant ?? QUICK_JOBS[0]!.variant,
    },
  ]
  const budgets = phaseBudgets(options.timeBudgetMs ?? 1500)
  const elites = jobs.flatMap(job => searchPrimary(state, { ...options, ...job, timeBudgetMs: budgets.primary }))
  const floor = primaryFloor(elites.map(e => e.metrics))
  const ranked = rankElites(elites, floor)
  const results = jobs.flatMap((job, i) =>
    economize(state, { ...options, ...job, timeBudgetMs: budgets.thrift, floor, starts: startsFor(ranked, i, jobs.length) }),
  )
  return { ...selectPlan(results), truncated: elites.some(e => e.truncated) || results.some(r => r.truncated) }
}
