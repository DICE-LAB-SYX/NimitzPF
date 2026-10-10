import { CORE_SETTINGS } from './data.ts'
import {
  allNegative,
  deltaEntries,
  healthFactor,
  isExempt,
  MODIFIER_RULES,
  REPAIR_AMOUNT,
  SPECIALIZATION_FACTOR,
  STAT_BOOST,
  TEAMWORK_FACTOR,
  winProbability,
} from './engine.ts'
import type { CardDef, Condition, CoreSettings, EnemyUnit, ModifierId, Restriction, SpecIndex } from './model.ts'
import { roundSpec } from './rounding.ts'

export interface CompiledBuff {
  readonly offset: number
  readonly spec: SpecIndex
  readonly value: number
}

export interface CompiledDebuff {
  readonly offset: number
  readonly vulnIndex: number
  readonly value: number
  readonly pure: boolean
}

export interface Variant {
  readonly card: CardDef
  readonly hp: number
  readonly healthFactor: number
  readonly rel: readonly [number, number, number]
  readonly buffs: readonly CompiledBuff[]
  readonly debuffs: readonly CompiledDebuff[]
  readonly needsEnemy: boolean
  readonly moraleKill: boolean
}

interface PlayerCondition {
  readonly kind: 'specs' | 'buffs' | 'debuffs'
  readonly entries: readonly [SpecIndex, number][]
  readonly multiplier: number
  readonly negative: boolean
  readonly exempt: Restriction | undefined
}

const MODIFIER_ORDINAL = Object.fromEntries(Object.keys(MODIFIER_RULES).map((id, i) => [id, i])) as Record<ModifierId, number>

export class KeypointContext {
  readonly size: number
  readonly settings: CoreSettings
  readonly enemyPresent: Uint8Array
  readonly enemyBase: Float64Array
  readonly enemyRel: Float64Array
  readonly vulnFactor: Float64Array
  private readonly playerConditions: PlayerCondition[]
  private readonly variants = new Map<CardDef, (Variant | undefined)[]>()
  private readonly scratchPlayerRel: Float64Array
  private readonly scratchEnemyRel: Float64Array

  constructor(enemies: readonly (EnemyUnit | null)[], conditions: readonly Condition[], settings: CoreSettings = CORE_SETTINGS) {
    const size = settings.HandSize
    this.size = size
    this.settings = settings
    this.enemyPresent = new Uint8Array(size)
    this.enemyBase = new Float64Array(size * 3)
    this.enemyRel = new Float64Array(size * 3)
    this.vulnFactor = new Float64Array(size * 6).fill(-1)
    this.scratchPlayerRel = new Float64Array(size * 3)
    this.scratchEnemyRel = new Float64Array(size * 3)
    for (let i = 0; i < size; i++) {
      const e = enemies[i]
      if (!e) continue
      this.enemyPresent[i] = 1
      for (let k = 0; k < 3; k++) this.enemyBase[i * 3 + k] = e.specs[k as SpecIndex]
      for (let v = 0; v < 6; v++) {
        const f = e.vulns[(100 + v) as 100]
        if (f !== undefined && f > 0) this.vulnFactor[i * 6 + v] = Math.min(Math.max(f, 0), 1)
      }
    }
    this.playerConditions = []
    for (const condition of conditions) {
      switch (condition.kind) {
        case 'player-specs': {
          const entries = deltaEntries(condition.specs)
          this.playerConditions.push({ kind: 'specs', entries, multiplier: 1, negative: allNegative(entries), exempt: condition.exempt })
          break
        }
        case 'enemy-power': {
          const entries = deltaEntries(condition.specs)
          for (let i = 0; i < size; i++) {
            const e = enemies[i]
            if (!e || isExempt(condition.exempt, e)) continue
            for (const [k, v] of entries) this.enemyRel[i * 3 + k] = this.enemyRel[i * 3 + k]! + v
          }
          break
        }
        case 'player-buffs':
        case 'player-debuffs':
          this.playerConditions.push({
            kind: condition.kind === 'player-buffs' ? 'buffs' : 'debuffs',
            entries: [],
            multiplier: condition.multiplier,
            negative: condition.multiplier < 1,
            exempt: condition.exempt,
          })
          break
        default:
          break
      }
    }
  }

  variant(card: CardDef, hp: number, standard: ModifierId | null, special: ModifierId | null): Variant {
    const slot = hp * 144 + (standard ? MODIFIER_ORDINAL[standard] + 1 : 0) * 12 + (special ? MODIFIER_ORDINAL[special] + 1 : 0)
    let table = this.variants.get(card)
    if (!table) {
      table = []
      this.variants.set(card, table)
    }
    const cached = table[slot]
    if (cached) return cached
    const mods: ModifierId[] = []
    if (standard) mods.push(standard)
    if (special) mods.push(special)
    const unstoppable = mods.includes('unstoppable')
    const rel: [number, number, number] = [0, 0, 0]
    const buffFactors: number[] = []
    const debuffFactors: number[] = []
    for (const pc of this.playerConditions) {
      if (isExempt(pc.exempt, card) || (unstoppable && pc.negative)) continue
      if (pc.kind === 'specs') for (const [k, v] of pc.entries) rel[k] += v
      else if (pc.kind === 'buffs') buffFactors.push(pc.multiplier)
      else debuffFactors.push(pc.multiplier)
    }
    const ordered = [...mods].sort((a, b) => MODIFIER_RULES[a].priority - MODIFIER_RULES[b].priority)
    let silenced = false
    let pure = false
    let repaired = hp
    for (const id of ordered) {
      for (const [k, v] of deltaEntries(STAT_BOOST[id] ?? {})) rel[k] += v
      if (id === 'focused') silenced = true
      else if (id === 'teamwork') buffFactors.push(TEAMWORK_FACTOR)
      else if (id === 'specialization') debuffFactors.push(SPECIALIZATION_FACTOR)
      else if (id === 'sea-dog') pure = true
      else if (id === 'fast-repair') repaired = Math.min(Math.max(repaired + REPAIR_AMOUNT, 0), 3)
    }
    const buffs: CompiledBuff[] = []
    const debuffs: CompiledDebuff[] = []
    if (!silenced) {
      for (const d of card.debuffs) {
        let value = d.value
        for (const f of debuffFactors) value *= f
        debuffs.push({
          offset: d.direction === 'forward' ? 0 : d.direction === 'forward-left' ? -1 : 1,
          vulnIndex: d.vuln - 100,
          value,
          pure,
        })
      }
      for (const b of card.buffs) {
        let value = b.value
        for (const f of buffFactors) value *= f
        buffs.push({ offset: b.direction === 'left' ? -1 : 1, spec: b.spec, value })
      }
    }
    const result: Variant = {
      card,
      hp: repaired,
      healthFactor: healthFactor(this.settings, repaired),
      rel,
      buffs,
      debuffs,
      needsEnemy: mods.some(m => MODIFIER_RULES[m].needsEnemy),
      moraleKill: mods.includes('moral-impact'),
    }
    table[slot] = result
    return result
  }

  evaluate(lanes: readonly (Variant | null)[], out: Float64Array, margins?: Float64Array): boolean {
    const size = this.size
    const pRel = this.scratchPlayerRel
    const eRel = this.scratchEnemyRel
    for (let i = 0; i < size; i++) {
      const v = lanes[i]
      if (v) {
        if (v.needsEnemy && !this.enemyPresent[i]) return false
        pRel[i * 3] = v.rel[0]
        pRel[i * 3 + 1] = v.rel[1]
        pRel[i * 3 + 2] = v.rel[2]
      }
      eRel[i * 3] = this.enemyRel[i * 3]!
      eRel[i * 3 + 1] = this.enemyRel[i * 3 + 1]!
      eRel[i * 3 + 2] = this.enemyRel[i * 3 + 2]!
    }
    for (let j = 0; j < size; j++) {
      const v = lanes[j]
      if (!v) continue
      for (const d of v.debuffs) {
        const t = j + d.offset
        if (t < 0 || t >= size || !this.enemyPresent[t]) continue
        let factor = 1
        if (!d.pure) {
          factor = this.vulnFactor[t * 6 + d.vulnIndex]!
          if (factor <= 0) continue
        }
        eRel[t * 3] = eRel[t * 3]! - d.value * factor
      }
      for (const b of v.buffs) {
        const t = j + b.offset
        if (t < 0 || t >= size || !lanes[t]) continue
        pRel[t * 3 + b.spec] = pRel[t * 3 + b.spec]! + b.value
      }
    }
    for (let i = 0; i < size; i++) {
      const v = lanes[i]
      if (!v || !this.enemyPresent[i]) {
        out[i] = Number.NaN
        continue
      }
      let power = 0
      for (let k = 0; k < 3; k++) {
        const s = v.card.specs[k as SpecIndex] * v.healthFactor * (1 + Math.max(pRel[i * 3 + k]!, -1))
        power += s < 1e-9 ? 0 : roundSpec(s)
      }
      let enemyPower = 0
      for (let k = 0; k < 3; k++) {
        const s = this.enemyBase[i * 3 + k]! * (1 + Math.max(eRel[i * 3 + k]!, -1))
        enemyPower += s < 1e-9 ? 0 : roundSpec(s)
      }
      out[i] = winProbability(this.settings, power, enemyPower)
      if (margins) margins[i] = power + this.settings.StrengthDispersionAbsRight + power * this.settings.StrengthDispersionRight - enemyPower
    }
    return true
  }
}
