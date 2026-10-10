import { addBernoulli, convolve, missBernoulli, pointMass, type Distribution } from './distribution.ts'
import type { Variant } from './fast.ts'
import type { Objective, Planner } from './planner.ts'
import { GENE, NONE, primaryMetrics } from './shared.ts'

const LEAF_WORK = 1
const MENU_WORK = 0.09
const MERGE_WORK = 0.04
const STATE_WORK = 0.08
const SCAN_WORK = 0.002
const PAIR_WORK = 0.015
const ENTRY_WORK = 0.3
const BUILD_WORK = 0.12
const SORT_WORK = 0.015
const COST_WORK = 0.1
const CELL_WORK = 0.007
const CALL_WORK = 40
const KEYPOINT_WORK = 12
const CHECK_WORK = 500
const SPILL = 8
const CACHE_LIMIT = 4000

interface Option {
  readonly usage: Int32Array
  readonly mask: number
  readonly count: number
  readonly picks: Int8Array
  readonly p: Float64Array
  readonly q: Float64Array
  readonly w: Uint8Array
  readonly dist: Distribution
  readonly missed: Distribution
  readonly logPerfect: number
  readonly reward: number
  readonly strength: number
}

interface Menu {
  readonly slots: Int32Array
  readonly options: readonly Option[]
}

interface LaneSpec {
  readonly lane: number
  readonly variants: (Variant | null)[][]
  readonly std: readonly number[]
  readonly spc: readonly number[]
  readonly stdAt: number
  readonly spcAt: number
}

export interface AllocationLimits {
  readonly cap: number
  readonly menuSize: number
  readonly frontier: number
  readonly candidates: number
}

interface Meter {
  readonly expired: () => boolean
  readonly spend: (work: number) => boolean
}

function track(planner: Planner, clock: () => number, deadline: number): Meter {
  const expired = () => clock() > deadline
  let due = 0
  return {
    expired,
    spend: (work: number) => {
      planner.work += work
      due += work
      if (due < CHECK_WORK) return false
      due = 0
      return expired()
    },
  }
}

function desc(a: number, b: number): number {
  return a > b ? -1 : a < b ? 1 : 0
}

function sortWork(n: number): number {
  return SORT_WORK * n * Math.log2(n + 1)
}

function maskOf(usage: Int32Array): number {
  let mask = 0
  for (let m = 0; m < usage.length; m++) {
    const n = usage[m]!
    if (n > 0) mask |= 1 << (m & 15)
    if (n > 1) mask |= 1 << (16 + (m & 15))
  }
  return mask
}

function fits(a: Int32Array, b: Int32Array, avail: Int32Array): boolean {
  for (let m = 0; m < avail.length; m++) if (a[m]! + b[m]! > avail[m]!) return false
  return true
}

function sum(a: Int32Array, b: Int32Array): Int32Array {
  const out = new Int32Array(a.length)
  for (let m = 0; m < a.length; m++) out[m] = a[m]! + b[m]!
  return out
}

function within(a: Int32Array, b: Int32Array): boolean {
  for (let m = 0; m < a.length; m++) if (a[m]! > b[m]!) return false
  return true
}

function freeSlots(planner: Planner, genes: Int32Array, k: number): number[] {
  const out: number[] = []
  for (let lane = 0; lane < planner.size; lane++) {
    const gene = k * planner.size + lane
    const g = gene * GENE
    if (genes[g] === NONE || planner.isPinned(gene)) continue
    out.push(g + 1)
    const spc = genes[g + 2]!
    if (spc === NONE || planner.modifiers[spc] !== 'fast-repair') out.push(g + 2)
  }
  return out
}

type Leaf = Omit<Option, 'dist' | 'missed'>

function dominates(a: Leaf, b: Leaf): boolean {
  for (let i = 0; i < a.p.length; i++) if (a.p[i]! < b.p[i]! - 1e-12 || a.q[i]! < b.q[i]! - 1e-12 || a.w[i]! < b.w[i]!) return false
  return true
}

function buildMenu(
  planner: Planner,
  k: number,
  genes: Int32Array,
  hp: Int8Array,
  dists: readonly Distribution[],
  avail: Int32Array,
  limits: AllocationLimits,
  meter: Meter,
): Menu | null {
  const kp = planner.keypoints[k]!
  const size = planner.size
  const stageCount = planner.stages.length
  const modifierCount = planner.modifiers.length
  const enemyLanes: number[] = []
  for (let lane = 0; lane < size; lane++) if (kp.enemies[lane]) enemyLanes.push(lane)
  const mixed = kp.hasEnemies ? planner.scenarios(k, dists) : []
  const clear = kp.hasEnemies && planner.objective === 'perfect' ? planner.clearedContext(k, dists) : null
  const clearAt = clear ? mixed.findIndex(sc => sc.context === clear) : -1
  const scenarios = clear && clearAt < 0 ? [...mixed, { weight: 0, context: clear }] : mixed
  const sweptAt = clear ? (clearAt < 0 ? scenarios.length - 1 : clearAt) : -1
  const slots: number[] = []
  const specs: LaneSpec[] = []
  for (let lane = 0; lane < size; lane++) {
    const gene = k * size + lane
    const g = gene * GENE
    const c = genes[g]!
    if (c === NONE) continue
    const card = planner.cards[c]!
    const cardHp = hp[c * stageCount + kp.stage]!
    const pinned = planner.isPinned(gene)
    let std: number[] = [genes[g + 1]!]
    let spc: number[] = [genes[g + 2]!]
    let stdAt = -1
    let spcAt = -1
    if (!pinned) {
      stdAt = slots.length
      slots.push(g + 1)
      std = [NONE]
      if (kp.hasEnemies) for (const m of planner.modifierOptions(gene, 1)) if (planner.modifiers[m] !== 'effectiveness') std.push(m)
      const current = genes[g + 2]!
      if (current === NONE || planner.modifiers[current] !== 'fast-repair') {
        spcAt = slots.length
        slots.push(g + 2)
        spc = [NONE]
        if (kp.hasEnemies) for (const m of planner.modifierOptions(gene, 2)) if (planner.modifiers[m] !== 'fast-repair') spc.push(m)
      }
    }
    const variants = scenarios.map(sc =>
      std.flatMap(a =>
        spc.map(b => sc.context.variant(card, cardHp, a === NONE ? null : planner.modifiers[a]!, b === NONE ? null : planner.modifiers[b]!)),
      ),
    )
    specs.push({ lane, variants, std, spc, stdAt, spcAt })
  }

  const specAt = new Int32Array(size).fill(-1)
  specs.forEach((spec, i) => {
    specAt[spec.lane] = i
  })
  const raw: Leaf[] = []
  const usage = new Int32Array(modifierCount)
  const picks = new Int8Array(slots.length).fill(NONE)
  const choice = new Int32Array(specs.length)
  const lanes: (Variant | null)[] = new Array(size).fill(null)
  const out = new Float64Array(size)
  const acc = new Float64Array(enemyLanes.length)
  const swept = new Float64Array(enemyLanes.length)
  let full = false
  let aborted = false
  const leaf = (count: number) => {
    if (raw.length >= limits.menuSize) {
      full = true
      return
    }
    if (meter.spend(LEAF_WORK * Math.max(1, scenarios.length))) {
      aborted = true
      return
    }
    acc.fill(0)
    for (let s = 0; s < scenarios.length; s++) {
      lanes.fill(null)
      for (let i = 0; i < specs.length; i++) lanes[specs[i]!.lane] = specs[i]!.variants[s]![choice[i]!]!
      if (!scenarios[s]!.context.evaluate(lanes, out)) return
      for (let i = 0; i < enemyLanes.length; i++) {
        const v = out[enemyLanes[i]!]!
        acc[i] = acc[i]! + (Number.isNaN(v) ? 0 : v) * scenarios[s]!.weight
        if (s === sweptAt) swept[i] = Number.isNaN(v) ? 0 : v
      }
    }
    const p = acc.slice()
    const q = sweptAt < 0 ? p : swept.slice()
    const w = new Uint8Array(enemyLanes.length)
    let logPerfect = 0
    let reward = 0
    let strength = 0
    for (let i = 0; i < enemyLanes.length; i++) {
      const lane = enemyLanes[i]!
      const at = specAt[lane]!
      const spec = at >= 0 ? specs[at]! : null
      const standard = spec ? spec.std[Math.floor(choice[at]! / spec.spc.length)]! : NONE
      w[i] = standard !== NONE && planner.modifiers[standard] === 'moral-impact' ? 2 : 1
      logPerfect += Math.log(Math.max(q[i]!, 1e-300))
      reward += p[i]! * kp.rewards[lane]!
      strength += p[i]! * w[i]!
    }
    const own = usage.slice()
    raw.push({ usage: own, mask: maskOf(own), count, picks: picks.slice(), p, q, w, logPerfect, reward, strength })
  }

  const walk = (i: number, count: number) => {
    if (full || aborted) return
    if (i === specs.length) {
      leaf(count)
      return
    }
    const spec = specs[i]!
    for (let a = 0; a < spec.std.length; a++) {
      const sa = spec.stdAt >= 0 ? spec.std[a]! : NONE
      if (sa !== NONE && (count + 1 > limits.cap || usage[sa]! + 1 > avail[sa]!)) continue
      if (sa !== NONE) usage[sa] = usage[sa]! + 1
      if (spec.stdAt >= 0) picks[spec.stdAt] = sa
      for (let b = 0; b < spec.spc.length; b++) {
        const sb = spec.spcAt >= 0 ? spec.spc[b]! : NONE
        const added = (sa !== NONE ? 1 : 0) + (sb !== NONE ? 1 : 0)
        if (sb !== NONE && (count + added > limits.cap || usage[sb]! + 1 > avail[sb]!)) continue
        if (sb !== NONE) usage[sb] = usage[sb]! + 1
        if (spec.spcAt >= 0) picks[spec.spcAt] = sb
        choice[i] = a * spec.spc.length + b
        walk(i + 1, count + added)
        if (sb !== NONE) usage[sb] = usage[sb]! - 1
      }
      if (spec.spcAt >= 0) picks[spec.spcAt] = NONE
      if (sa !== NONE) usage[sa] = usage[sa]! - 1
    }
    if (spec.stdAt >= 0) picks[spec.stdAt] = NONE
  }
  walk(0, 0)
  if (aborted) return null

  if (meter.spend(sortWork(raw.length))) return null
  raw.sort((a, b) => a.count - b.count || desc(a.strength, b.strength))
  const kept: Leaf[] = []
  for (const option of raw) {
    let j = 0
    let deep = 0
    for (; j < kept.length; j++) {
      const other = kept[j]!
      if ((other.mask & ~option.mask) !== 0) continue
      deep++
      if (within(other.usage, option.usage) && dominates(other, option)) break
    }
    if (j === kept.length) kept.push(option)
    if (meter.spend(SCAN_WORK * j + MENU_WORK * deep)) return null
  }
  const withDistributions = (option: Leaf): Option => {
    let dist = pointMass(0)
    let missed = dist
    for (let i = 0; i < enemyLanes.length; i++) {
      const lane = enemyLanes[i]!
      if (specAt[lane]! < 0) continue
      const p = option.p[i]!
      const w = option.w[i]!
      dist = addBernoulli(dist, p, w)
      if (kp.flagged) missed = kp.flagships[lane] ? missBernoulli(missed, p) : addBernoulli(missed, p, w)
    }
    return { ...option, dist, missed: kp.flagged ? missed : dist }
  }
  return { slots: Int32Array.from(slots), options: kept.map(withDistributions) }
}

interface Entry {
  readonly usage: Int32Array
  readonly mask: number
  readonly total: number
  readonly dist: Distribution
  readonly missed: Distribution
  readonly g: number
  readonly logPerfect: number
  readonly reward: number
  readonly trail: Int32Array
  readonly order: number
}

function survivalCovers(a: Distribution, b: Distribution, goal: number): boolean {
  let sa = 0
  let sb = 0
  for (let x = Math.max(a.length, b.length) - 1; x >= 0; x--) {
    sa += a[x] ?? 0
    sb += b[x] ?? 0
    if (x <= goal && sa < sb - 1e-12) return false
  }
  return true
}

function metCovers(a: Entry, b: Entry, goal: number): boolean {
  let ta = 0
  let tb = 0
  let ma = 0
  let mb = 0
  for (let x = Math.max(a.dist.length, b.dist.length) - 1; x >= 0; x--) {
    ta += a.dist[x] ?? 0
    tb += b.dist[x] ?? 0
    ma += (a.dist[x] ?? 0) - (a.missed[x] ?? 0)
    mb += (b.dist[x] ?? 0) - (b.missed[x] ?? 0)
    if (x <= goal && (ta < tb - 1e-12 || ma < mb - 1e-12)) return false
  }
  return true
}

function byChance(a: Entry, b: Entry): number {
  return desc(a.g, b.g) || a.total - b.total || a.order - b.order
}

interface StageEntry {
  readonly usage: Int32Array
  readonly total: number
  readonly g: number
  readonly logG: number
  readonly logPerfect: number
  readonly reward: number
  readonly trail: Int32Array
}

function stageList(planner: Planner, s: number, menus: readonly Menu[], avail: Int32Array, frontier: number, meter: Meter): StageEntry[] | null {
  const stage = planner.stages[s]!
  const goal = stage.goal
  const perfect = planner.objective === 'perfect'
  const reward = planner.objective === 'reward'
  const bound = SPILL * frontier
  const flagged = stage.flagged
  const start = pointMass(stage.fixedKills)
  let entries: Entry[] = [
    {
      usage: new Int32Array(avail.length),
      mask: 0,
      total: 0,
      dist: start,
      missed: start,
      g: planner.stagePass(s, start, start),
      logPerfect: 0,
      reward: 0,
      trail: new Int32Array(0),
      order: 0,
    },
  ]
  for (const k of stage.keypoints) {
    if (meter.expired()) return null
    const menu = menus[k]!
    const pool: Entry[] = []
    let order = 0
    let work = 0
    for (const entry of entries) {
      for (let o = 0; o < menu.options.length; o++) {
        const option = menu.options[o]!
        work += PAIR_WORK
        if (!fits(entry.usage, option.usage, avail)) continue
        const usage = sum(entry.usage, option.usage)
        const trail = new Int32Array(entry.trail.length + 1)
        trail.set(entry.trail)
        trail[entry.trail.length] = o
        const dist = convolve(entry.dist, option.dist)
        const shared = entry.missed === entry.dist && option.missed === option.dist
        const missed = shared ? dist : convolve(entry.missed, option.missed)
        work += ENTRY_WORK + CELL_WORK * (entry.dist.length * option.dist.length + (shared ? 0 : entry.missed.length * option.missed.length))
        pool.push({
          usage,
          mask: maskOf(usage),
          total: entry.total + option.count,
          dist,
          missed,
          g: planner.stagePass(s, dist, missed),
          logPerfect: entry.logPerfect + option.logPerfect,
          reward: entry.reward + option.reward,
          trail,
          order: order++,
        })
        if (pool.length >= 2 * bound) {
          if (meter.spend(work + sortWork(pool.length))) return null
          work = 0
          pool.sort(byChance)
          pool.length = bound
        }
      }
      if (meter.spend(work)) return null
      work = 0
    }
    if (meter.spend(sortWork(pool.length))) return null
    pool.sort(byChance)
    const kept: Entry[] = []
    for (let i = 0; i < pool.length && kept.length < frontier; i++) {
      const item = pool[i]!
      let j = 0
      let deep = 0
      for (; j < kept.length; j++) {
        const other = kept[j]!
        if ((other.mask & ~item.mask) !== 0 || other.total > item.total) continue
        if (perfect && other.logPerfect < item.logPerfect - 1e-12) continue
        if (reward && other.reward < item.reward - 1e-12) continue
        deep++
        if (within(other.usage, item.usage) && (flagged ? metCovers(other, item, goal) : survivalCovers(other.dist, item.dist, goal))) break
      }
      if (j === kept.length) kept.push(item)
      if (meter.spend(SCAN_WORK * j + MERGE_WORK * deep)) return null
    }
    entries = kept
  }
  return entries.map(e => ({ usage: e.usage, total: e.total, g: e.g, logG: Math.log(Math.max(e.g, 1e-300)), logPerfect: e.logPerfect, reward: e.reward, trail: e.trail }))
}

interface State {
  readonly usage: Int32Array
  readonly mask: number
  readonly total: number
  readonly logComplete: number
  readonly stages: number
  readonly logPerfect: number
  readonly reward: number
  readonly firm: number
  readonly firmReach: number
  readonly parent: State | null
  readonly entry: number
  readonly order: number
}

function rank(objective: Objective, lc: number, st: number, lp: number, rw: number, b: State): number {
  if (objective === 'perfect') return desc(lp, b.logPerfect) || desc(lc, b.logComplete) || desc(st, b.stages)
  if (objective === 'reward') return desc(rw, b.reward) || desc(lc, b.logComplete) || desc(st, b.stages)
  return desc(lc, b.logComplete) || desc(st, b.stages)
}

interface Pick {
  readonly state: State
  readonly entry: number
  readonly metrics: readonly number[]
  readonly cost: number
}

function byMetrics(a: Pick, b: Pick): number {
  for (let i = 0; i < a.metrics.length; i++) if (a.metrics[i] !== b.metrics[i]) return desc(a.metrics[i]!, b.metrics[i]!)
  return a.cost - b.cost
}

function byCost(a: Pick, b: Pick): number {
  return a.cost - b.cost || byMetrics(a, b)
}

interface Allocation {
  readonly genes: Int32Array
}

export interface AllocationCache {
  readonly menus: Map<string, Menu>
  readonly stages: Map<string, StageEntry[]>
}

export function allocationCache(): AllocationCache {
  return { menus: new Map(), stages: new Map() }
}

function menuKey(planner: Planner, k: number, skeleton: Int32Array, hp: Int8Array, dists: readonly Distribution[], availKey: string, limits: AllocationLimits): string {
  const kp = planner.keypoints[k]!
  const stageCount = planner.stages.length
  let key = `${k}|${limits.cap}|${limits.menuSize}|${availKey}|`
  for (let lane = 0; lane < planner.size; lane++) {
    const gene = k * planner.size + lane
    const g = gene * GENE
    const c = skeleton[g]!
    if (c === NONE) {
      key += '-,'
      continue
    }
    const spc = skeleton[g + 2]!
    const repair = spc !== NONE && planner.modifiers[spc] === 'fast-repair'
    key += planner.isPinned(gene) ? `${c}:${hp[c * stageCount + kp.stage]}:${skeleton[g + 1]}:${spc},` : `${c}:${hp[c * stageCount + kp.stage]}:${repair ? 'r' : ''},`
  }
  for (const group of kp.pending) {
    const dist = dists[group.source]!
    key += '|'
    for (let x = 0; x < dist.length; x++) key += `${Math.round(dist[x]! * 1e9)},`
  }
  return key
}

export function allocate(
  planner: Planner,
  skeleton: Int32Array,
  dists: readonly Distribution[],
  floor: readonly number[],
  limits: AllocationLimits,
  deadline: number,
  clock: () => number,
  cache: AllocationCache,
): Allocation[] | null {
  const meter = track(planner, clock, deadline)
  planner.work += CALL_WORK + KEYPOINT_WORK * planner.keypoints.length
  const hp = planner.hpTable(skeleton)
  if (!hp) return null
  const modifierCount = planner.modifiers.length
  const menuSlots = new Set<number>()
  const open: boolean[] = []
  for (let k = 0; k < planner.keypoints.length; k++) {
    const free = freeSlots(planner, skeleton, k)
    open.push(free.length > 0)
    for (const at of free) menuSlots.add(at)
  }
  const fixed = new Int32Array(modifierCount)
  for (let gene = 0; gene < planner.geneCount; gene++) {
    for (const slot of [1, 2]) {
      const at = gene * GENE + slot
      const m = skeleton[at]!
      if (m !== NONE && !menuSlots.has(at)) fixed[m] = fixed[m]! + 1
    }
  }
  const avail = new Int32Array(modifierCount)
  for (let m = 0; m < modifierCount; m++) {
    avail[m] = planner.inventory[m]! - fixed[m]!
    if (avail[m]! < 0) return null
  }
  if (cache.menus.size > CACHE_LIMIT) cache.menus.clear()
  if (cache.stages.size > CACHE_LIMIT) cache.stages.clear()
  const availKey = avail.join(',')
  const menus: Menu[] = []
  const menuKeys: string[] = []
  for (let k = 0; k < planner.keypoints.length; k++) {
    if (meter.expired()) return null
    const key = menuKey(planner, k, skeleton, hp, dists, availKey, limits)
    let menu = cache.menus.get(key)
    if (!menu) {
      const built = buildMenu(planner, k, skeleton, hp, dists, avail, limits, meter)
      if (!built) return null
      menu = built
      cache.menus.set(key, menu)
    }
    menus.push(menu)
    menuKeys.push(key)
  }

  const stageLists: StageEntry[][] = []
  for (let s = 0; s < planner.stages.length; s++) {
    const stageKey = `${limits.frontier}#${planner.stages[s]!.keypoints.map(k => menuKeys[k]).join('#')}`
    let list = cache.stages.get(stageKey)
    if (!list) {
      const built = stageList(planner, s, menus, avail, limits.frontier, meter)
      if (!built) return null
      list = built
      cache.stages.set(stageKey, list)
    }
    stageLists.push(list)
  }
  if (!stageLists.length) return [{ genes: skeleton.slice() }]

  const objective = planner.objective
  const moving: boolean[] = []
  planner.keypoints.forEach((kp, k) => {
    moving.push(open[k]! || kp.pending.some(group => moving[group.source]))
  })
  const stale = planner.stages.map(stage => stage.keypoints.some(k => planner.keypoints[k]!.pending.some(group => moving[group.source])))
  const peak = planner.stages.map(stage =>
    stage.keypoints.reduce((n, k) => n + planner.keypoints[k]!.rewards.reduce((m, r, lane) => m + (planner.keypoints[k]!.enemies[lane] ? r : 0), 0), 0),
  )
  const prune = floor[0]! > 0
  const logFloor = Math.log(Math.max(floor[0]!, 1e-300))
  const last = stageLists.length - 1
  const restG = new Float64Array(stageLists.length + 1)
  const restPerfect = new Float64Array(stageLists.length + 1)
  const restReward = new Float64Array(stageLists.length + 1)
  for (let s = last; s >= 0; s--) {
    const list = stageLists[s]!
    let g = -Infinity
    let lp = -Infinity
    let rw = 0
    for (const e of list) {
      g = Math.max(g, e.logG)
      lp = Math.max(lp, e.logPerfect)
      rw = Math.max(rw, e.reward)
    }
    restG[s] = restG[s + 1]! + (stale[s] ? 0 : g)
    restPerfect[s] = restPerfect[s + 1]! + (stale[s] ? 0 : lp)
    restReward[s] = restReward[s + 1]! + (stale[s] ? peak[s]! : rw)
  }
  const byUsage = (a: State, b: State) => a.total - b.total || rank(objective, a.logComplete, a.stages, a.logPerfect, a.reward, b) || a.order - b.order
  const bound = SPILL * limits.frontier
  const perfect = objective === 'perfect'
  const reward = objective === 'reward'
  let states: State[] = [
    {
      usage: new Int32Array(modifierCount),
      mask: 0,
      total: 0,
      logComplete: 0,
      stages: 0,
      logPerfect: planner.perfectBrokenBefore() ? -Infinity : 0,
      reward: planner.fixedReward(),
      firm: reward ? planner.fixedReward() : perfect && planner.perfectBrokenBefore() ? -Infinity : 0,
      firmReach: 0,
      parent: null,
      entry: NONE,
      order: 0,
    },
  ]
  for (let s = 0; s < last; s++) {
    if (meter.expired()) return null
    const list = stageLists[s]!
    const loose = stale[s]!
    const rest = reward ? restReward[s + 1]! : perfect ? restPerfect[s + 1]! : restG[s + 1]!
    const target = (reward ? floor[0]! : logFloor) - 1e-9
    const pool: State[] = []
    let cutoff = Infinity
    let best: State | null = null
    let order = 0
    let work = 0
    for (const state of states) {
      const reach = Math.exp(state.logComplete)
      const lift = Math.exp(state.firmReach)
      for (let e = 0; e < list.length; e++) {
        const entry = list[e]!
        work += PAIR_WORK
        const total = state.total + entry.total
        const logComplete = state.logComplete + entry.logG
        const stages = state.stages + Math.exp(logComplete)
        const logPerfect = state.logPerfect + entry.logPerfect
        const gain = state.reward + reach * entry.reward
        const versus = best ? rank(objective, logComplete, stages, logPerfect, gain, best) : -1
        const lead = versus < 0 || (versus === 0 && total < best!.total)
        const firmReach = loose ? state.firmReach : state.firmReach + entry.logG
        const firm = reward ? state.firm + lift * (loose ? peak[s]! : entry.reward) : perfect ? state.firm + (loose ? 0 : entry.logPerfect) : firmReach
        const keep = total <= cutoff && !(prune && firm + rest < target)
        if (!lead && !keep) continue
        if (!fits(state.usage, entry.usage, avail)) continue
        work += BUILD_WORK
        const usage = sum(state.usage, entry.usage)
        const next: State = { usage, mask: maskOf(usage), total, logComplete, stages, logPerfect, reward: gain, firm, firmReach, parent: state, entry: e, order: order++ }
        if (lead) best = next
        if (!keep) continue
        pool.push(next)
        if (pool.length >= 2 * bound) {
          if (meter.spend(work + sortWork(pool.length))) return null
          work = 0
          pool.sort(byUsage)
          pool.length = bound
          cutoff = pool[bound - 1]!.total
        }
      }
      if (meter.spend(work)) return null
      work = 0
    }
    if (meter.spend(sortWork(pool.length))) return null
    pool.sort(byUsage)
    const kept: State[] = []
    for (let i = 0; i < pool.length && kept.length < limits.frontier; i++) {
      const state = pool[i]!
      let j = 0
      let deep = 0
      for (; j < kept.length; j++) {
        const other = kept[j]!
        if ((other.mask & ~state.mask) !== 0) continue
        if (other.logComplete < state.logComplete - 1e-12 || other.stages < state.stages - 1e-12) continue
        if (perfect && other.logPerfect < state.logPerfect - 1e-12) continue
        if (reward && other.reward < state.reward - 1e-12) continue
        deep++
        if (within(other.usage, state.usage)) break
      }
      if (j === kept.length) kept.push(state)
      if (meter.spend(SCAN_WORK * j + STATE_WORK * deep)) return null
    }
    if (best && !kept.includes(best)) kept.push(best)
    states = kept
  }

  const list = stageLists[last]!
  const total = new Int32Array(modifierCount)
  const [lowA, lowB] = [0, 1].map(i => floor[i]! - 1e-9 * Math.max(1, Math.abs(floor[i]!)))
  const chosen: Pick[] = []
  const metrics: number[] = []
  let strongest: Pick | null = null
  let work = 0
  for (const state of states) {
    const reach = Math.exp(state.logComplete)
    for (let e = 0; e < list.length; e++) {
      const entry = list[e]!
      work += PAIR_WORK
      const complete = Math.exp(state.logComplete + entry.logG)
      primaryMetrics(objective, complete, Math.exp(state.logPerfect + entry.logPerfect), state.reward + reach * entry.reward, state.stages + complete, metrics)
      const a = metrics[0]!
      const b = metrics[1]!
      const passing = a >= lowA! && b >= lowB!
      const lead = !strongest || (desc(a, strongest.metrics[0]!) || desc(b, strongest.metrics[1]!)) <= 0
      if (!passing && !lead) continue
      if (!fits(state.usage, entry.usage, avail)) continue
      work += COST_WORK
      for (let m = 0; m < modifierCount; m++) total[m] = state.usage[m]! + entry.usage[m]! + fixed[m]!
      const pick: Pick = { state, entry: e, metrics: [a, b], cost: planner.usageCost(total) }
      if (lead && (!strongest || byMetrics(pick, strongest) < 0)) strongest = pick
      if (!passing) continue
      if (chosen.length >= limits.candidates && byCost(pick, chosen[chosen.length - 1]!) >= 0) continue
      let at = chosen.length
      while (at > 0 && byCost(pick, chosen[at - 1]!) < 0) at--
      chosen.splice(at, 0, pick)
      if (chosen.length > limits.candidates) chosen.pop()
    }
    if (meter.spend(work)) return null
    work = 0
  }
  if (strongest && !chosen.includes(strongest)) chosen.push(strongest)
  return chosen.map(pick => {
    const genes = skeleton.slice()
    const trail = [pick.entry]
    for (let state: State | null = pick.state; state && state.entry !== NONE; state = state.parent) trail.push(state.entry)
    trail.reverse()
    trail.forEach((e, s) => {
      const entry = stageLists[s]![e]!
      planner.stages[s]!.keypoints.forEach((k, i) => {
        const menu = menus[k]!
        const option = menu.options[entry.trail[i]!]!
        menu.slots.forEach((at, j) => {
          genes[at] = option.picks[j]!
        })
      })
    })
    return { genes }
  })
}
