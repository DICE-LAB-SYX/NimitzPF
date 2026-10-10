import { CORE_SETTINGS } from './data.ts'
import type {
  Board,
  CoreSettings,
  EnemyUnit,
  ModifierId,
  PlayerUnit,
  Restriction,
  SpecDeltas,
  SpecIndex,
  Specs,
  UnitType,
  VulnCode,
} from './model.ts'
import { roundPercent, roundSpec } from './rounding.ts'

export interface ModifierRule {
  readonly priority: number
  readonly needsEnemy: boolean
}

export const MODIFIER_RULES: Readonly<Record<ModifierId, ModifierRule>> = {
  'focused': { priority: 0, needsEnemy: true },
  'fast-repair': { priority: 1993, needsEnemy: false },
  'sea-dog': { priority: 1994, needsEnemy: true },
  'specialization': { priority: 1995, needsEnemy: true },
  'teamwork': { priority: 1996, needsEnemy: false },
  'rudder-crew-training': { priority: 1998, needsEnemy: false },
  'damage-control-training': { priority: 1999, needsEnemy: false },
  'gunners-training': { priority: 2000, needsEnemy: false },
  'effectiveness': { priority: 3000, needsEnemy: false },
  'moral-impact': { priority: 3000, needsEnemy: false },
  'unstoppable': { priority: 3000, needsEnemy: false },
}

export const STAT_BOOST: Partial<Record<ModifierId, SpecDeltas>> = {
  'gunners-training': { 0: 0.2 },
  'damage-control-training': { 1: 0.2 },
  'rudder-crew-training': { 2: 0.2 },
  'focused': { 0: 0.4, 1: 0.4, 2: 0.4 },
}

export const REPAIR_AMOUNT = 2
export const TEAMWORK_FACTOR = 2
export const SPECIALIZATION_FACTOR = 2

export type ContributionSource =
  | { readonly kind: 'condition'; readonly index: number }
  | { readonly kind: 'modifier'; readonly id: ModifierId }
  | { readonly kind: 'buff'; readonly from: number }
  | { readonly kind: 'debuff'; readonly from: number; readonly vuln: VulnCode; readonly factor: number; readonly ignoredVuln: boolean }

export interface Contribution {
  readonly spec: SpecIndex
  readonly value: number
  readonly source: ContributionSource
}

export interface SideResult {
  readonly base: Specs
  readonly specs: Specs
  readonly power: number
  readonly contributions: readonly Contribution[]
}

export interface PlayerSideResult extends SideResult {
  readonly hp: number
  readonly healthFactor: number
  readonly low: number
  readonly high: number
}

export interface LaneResult {
  readonly player: PlayerSideResult | null
  readonly enemy: SideResult | null
  readonly probability: number | null
  readonly percent: number | null
}

export type BoardError =
  | { readonly kind: 'no-enemy' }
  | { readonly kind: 'modifier-needs-enemy'; readonly lane: number; readonly modifier: ModifierId }

export type BoardEvaluation =
  | { readonly ok: true; readonly lanes: readonly LaneResult[] }
  | { readonly ok: false; readonly error: BoardError }

interface Identity {
  readonly code: string
  readonly type: UnitType
  readonly tier: number
}

export function isExempt(restriction: Restriction | undefined, unit: Identity): boolean {
  if (!restriction) return false
  if (unit.code !== '' && restriction.cards?.includes(unit.code)) return true
  if (restriction.types?.includes(unit.type)) return true
  if (unit.tier !== 0 && restriction.tiers?.includes(unit.tier)) return true
  return false
}

function nearlyZero(x: number): boolean {
  return Math.abs(x) < 1e-9
}

export function deltaEntries(specs: SpecDeltas): [SpecIndex, number][] {
  const out: [SpecIndex, number][] = []
  for (const k of [0, 1, 2] as const) {
    const v = specs[k]
    if (v !== undefined && !nearlyZero(v)) out.push([k, v])
  }
  return out
}

export function allNegative(entries: [SpecIndex, number][]): boolean {
  return entries.every(([, v]) => v < 0 && !nearlyZero(v))
}

export function healthFactor(settings: CoreSettings, hp: number): number {
  const f = settings.HealthFactor
  if (f.length === 0) return 1
  if (hp === 0) return 0
  return f[Math.min(Math.max(hp - 1, 0), f.length - 1)] ?? 1
}

export function winProbability(settings: CoreSettings, power: number, enemyPower: number): number {
  const [low, high] = powerRange(settings, power)
  const p = low >= enemyPower ? 1 : enemyPower > high ? 0 : (high - enemyPower + 1) / (high - low + 1)
  return Math.min(Math.max(p, settings.MinProbabilityOfWin), settings.MaxProbabilityOfWin)
}

export function powerRange(settings: CoreSettings, power: number): [number, number] {
  const low = Math.max(power * (1 - settings.StrengthDispersionLeft) - settings.StrengthDispersionAbsLeft, 0)
  const high = power * (1 + settings.StrengthDispersionRight) + settings.StrengthDispersionAbsRight
  return [low, high]
}

interface PlayerState {
  readonly unit: PlayerUnit
  readonly lane: number
  hp: number
  silenced: boolean
  ignoresVulns: boolean
  readonly unstoppable: boolean
  readonly buffFactors: number[]
  readonly debuffFactors: number[]
  readonly rel: [number, number, number]
  readonly contributions: Contribution[]
}

interface EnemyState {
  readonly unit: EnemyUnit
  readonly lane: number
  readonly rel: [number, number, number]
  readonly contributions: Contribution[]
}

export function evaluateBoard(board: Board, settings: CoreSettings = CORE_SETTINGS, trace = false): BoardEvaluation {
  const size = settings.HandSize
  const players: (PlayerState | null)[] = []
  const enemies: (EnemyState | null)[] = []
  let enemyCount = 0
  for (let i = 0; i < size; i++) {
    const p = board.player[i] ?? null
    players.push(
      p
        ? {
            unit: p,
            lane: i,
            hp: p.hp,
            silenced: false,
            ignoresVulns: false,
            unstoppable: p.modifiers.includes('unstoppable'),
            buffFactors: [],
            debuffFactors: [],
            rel: [0, 0, 0],
            contributions: [],
          }
        : null,
    )
    const e = board.enemy[i] ?? null
    if (e) enemyCount++
    enemies.push(e ? { unit: e, lane: i, rel: [0, 0, 0], contributions: [] } : null)
  }
  if (enemyCount === 0) return { ok: false, error: { kind: 'no-enemy' } }

  board.conditions.forEach((condition, index) => {
    const source: ContributionSource = { kind: 'condition', index }
    switch (condition.kind) {
      case 'player-specs': {
        const entries = deltaEntries(condition.specs)
        const negative = allNegative(entries)
        for (const p of players) {
          if (!p || isExempt(condition.exempt, p.unit.card) || (p.unstoppable && negative)) continue
          for (const [k, v] of entries) {
            p.rel[k] += v
            if (trace) p.contributions.push({ spec: k, value: v, source })
          }
        }
        break
      }
      case 'enemy-power': {
        const entries = deltaEntries(condition.specs)
        for (const e of enemies) {
          if (!e || isExempt(condition.exempt, e.unit)) continue
          for (const [k, v] of entries) {
            e.rel[k] += v
            if (trace) e.contributions.push({ spec: k, value: v, source })
          }
        }
        break
      }
      case 'player-buffs':
      case 'player-debuffs': {
        const negative = condition.multiplier < 1
        for (const p of players) {
          if (!p || isExempt(condition.exempt, p.unit.card) || (p.unstoppable && negative)) continue
          ;(condition.kind === 'player-buffs' ? p.buffFactors : p.debuffFactors).push(condition.multiplier)
        }
        break
      }
      default:
        break
    }
  })

  const located: { lane: number; id: ModifierId; priority: number }[] = []
  for (const p of players) {
    if (!p) continue
    for (const id of p.unit.modifiers) located.push({ lane: p.lane, id, priority: MODIFIER_RULES[id].priority })
  }
  for (let n = 1; n < located.length; n++) {
    for (let r = n; r > 0; r--) {
      const a = located[r]!
      const b = located[r - 1]!
      if (a.priority < b.priority) {
        located[r] = b
        located[r - 1] = a
      } else break
    }
  }
  for (const { lane, id } of located) {
    if (MODIFIER_RULES[id].needsEnemy && !enemies[lane]) {
      return { ok: false, error: { kind: 'modifier-needs-enemy', lane, modifier: id } }
    }
    const p = players[lane]!
    const boost = STAT_BOOST[id]
    if (boost) {
      for (const [k, v] of deltaEntries(boost)) {
        p.rel[k] += v
        if (trace) p.contributions.push({ spec: k, value: v, source: { kind: 'modifier', id } })
      }
    }
    if (id === 'focused') p.silenced = true
    else if (id === 'teamwork') p.buffFactors.push(TEAMWORK_FACTOR)
    else if (id === 'specialization') p.debuffFactors.push(SPECIALIZATION_FACTOR)
    else if (id === 'sea-dog') p.ignoresVulns = true
    else if (id === 'fast-repair') p.hp = Math.min(Math.max(p.hp + REPAIR_AMOUNT, 0), 3)
  }

  for (const giver of players) {
    if (!giver || giver.silenced) continue
    const card = giver.unit.card
    for (const d of card.debuffs) {
      const target = enemies[giver.lane + (d.direction === 'forward' ? 0 : d.direction === 'forward-left' ? -1 : 1)]
      if (!target) continue
      let value = d.value
      for (const f of giver.debuffFactors) value *= f
      let factor: number
      if (giver.ignoresVulns) factor = 1
      else {
        const v = target.unit.vulns[d.vuln]
        if (v === undefined || !(v > 0)) continue
        factor = Math.min(Math.max(v, 0), 1)
      }
      const applied = value * factor
      target.rel[0] -= applied
      if (trace) {
        target.contributions.push({
          spec: 0,
          value: -applied,
          source: { kind: 'debuff', from: giver.lane, vuln: d.vuln, factor, ignoredVuln: giver.ignoresVulns },
        })
      }
    }
    for (const b of card.buffs) {
      const target = players[giver.lane + (b.direction === 'left' ? -1 : 1)]
      if (!target) continue
      let value = b.value
      for (const f of giver.buffFactors) value *= f
      target.rel[b.spec] += value
      if (trace) target.contributions.push({ spec: b.spec, value, source: { kind: 'buff', from: giver.lane } })
    }
  }

  const lanes: LaneResult[] = []
  for (let i = 0; i < size; i++) {
    const p = players[i] ?? null
    const e = enemies[i] ?? null
    let player: PlayerSideResult | null = null
    let enemy: SideResult | null = null
    if (p) {
      const hf = healthFactor(settings, p.hp)
      const base = p.unit.card.specs
      const specs = [0, 1, 2].map(k => {
        let s = base[k as SpecIndex] * hf
        s = s * (1 + Math.max(p.rel[k as SpecIndex], -1))
        return s < 1e-9 ? 0 : roundSpec(s)
      }) as unknown as Specs
      const power = specs[0] + specs[1] + specs[2]
      const [low, high] = powerRange(settings, power)
      player = { base, specs, power, hp: p.hp, healthFactor: hf, low, high, contributions: p.contributions }
    }
    if (e) {
      const base = e.unit.specs
      const specs = [0, 1, 2].map(k => {
        const s = base[k as SpecIndex] * (1 + Math.max(e.rel[k as SpecIndex], -1))
        return s < 1e-9 ? 0 : roundSpec(s)
      }) as unknown as Specs
      enemy = { base, specs, power: specs[0] + specs[1] + specs[2], contributions: e.contributions }
    }
    const probability = player && enemy ? winProbability(settings, player.power, enemy.power) : null
    lanes.push({ player, enemy, probability, percent: probability === null ? null : roundPercent(probability) })
  }
  return { ok: true, lanes }
}
