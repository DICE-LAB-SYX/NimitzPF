import { CLEAR_THRESHOLD } from './data.ts'
import type { CardDef, Condition, EnemyUnit, ModifierId, UnitType } from './model.ts'

export type KeypointStatus = 'open' | 'fought' | 'missed'

export interface EnemySlot {
  readonly enemy: EnemyUnit
  readonly reward: number
}

export interface LaneRecord {
  readonly card: string
  readonly modifiers: readonly ModifierId[]
  readonly won: boolean
}

export interface KeypointInput {
  readonly id: string
  readonly difficulty: number
  readonly lanes: readonly (EnemySlot | null)[]
  readonly status: KeypointStatus
  readonly record?: readonly (LaneRecord | null)[]
}

export interface StageInput {
  readonly id: string
  readonly goal: number
  readonly keypoints: readonly KeypointInput[]
}

export type ConditionScope = 'local' | 'targeted' | 'global'

export interface OperationCondition {
  readonly id: string
  readonly scope: ConditionScope
  readonly source: string | null
  readonly targets: readonly string[]
  readonly mitigable: boolean
  readonly removeAfter?: number
  readonly weakenPerKill?: number
  readonly effect: Condition
}

export interface FleetEntry {
  readonly card: string
  readonly hp: number
}

export type Inventory = Readonly<Partial<Record<ModifierId, number>>>

export interface PinnedLane {
  readonly card: string | null
  readonly standard: ModifierId | null
  readonly special: ModifierId | null
}

export interface OperationState {
  readonly stages: readonly StageInput[]
  readonly currentStage: number
  readonly conditions: readonly OperationCondition[]
  readonly fleet: readonly FleetEntry[]
  readonly inventory: Inventory
  readonly pinned?: Readonly<Record<string, readonly PinnedLane[]>>
  readonly boosted?: Readonly<Record<string, readonly number[]>>
}

export interface KeypointLocation {
  readonly stage: number
  readonly index: number
  readonly keypoint: KeypointInput
}

export function locateKeypoints(state: OperationState): Map<string, KeypointLocation> {
  const map = new Map<string, KeypointLocation>()
  state.stages.forEach((stage, s) => {
    stage.keypoints.forEach((keypoint, index) => map.set(keypoint.id, { stage: s, index, keypoint }))
  })
  return map
}

export function enemyCount(keypoint: KeypointInput): number {
  return keypoint.lanes.reduce((n, l) => n + (l ? 1 : 0), 0)
}

export function weightedWins(keypoint: KeypointInput): number {
  if (!keypoint.record) return 0
  let total = 0
  keypoint.record.forEach((r, i) => {
    if (r && r.won && keypoint.lanes[i]) total += r.modifiers.includes('moral-impact') ? 2 : 1
  })
  return total
}

export function removalKills(keypoint: KeypointInput): number {
  const count = enemyCount(keypoint)
  return count === 0 ? 0 : Math.ceil(CLEAR_THRESHOLD * count - 1e-9)
}

export function isMitigable(condition: OperationCondition): boolean {
  return condition.mitigable && condition.effect.kind !== 'disable-modifiers' && condition.effect.kind !== 'restrictions'
}

export function conditionRemovalKills(condition: OperationCondition, source: KeypointInput): number {
  return condition.removeAfter ?? removalKills(source)
}

export function fullRemovalKills(condition: OperationCondition, source: KeypointInput): number {
  if (!isMitigable(condition)) return conditionRemovalKills(condition, source)
  const step = weakenStep(condition, source)
  if (step <= 0) return enemyCount(source)
  let kills = Math.max(0, Math.floor((effectMagnitude(condition.effect) - NEGLIGIBLE) / step))
  while (effectAfterKills(condition, source, kills) !== null) kills++
  return kills
}

export function conditionApplies(
  condition: OperationCondition,
  target: KeypointLocation,
  locations: Map<string, KeypointLocation>,
): boolean {
  if (condition.scope === 'global') {
    if (!condition.source || condition.source === target.keypoint.id) return false
    const source = locations.get(condition.source)
    return source !== undefined && source.stage < target.stage
  }
  return condition.targets.includes(target.keypoint.id)
}

const NEGLIGIBLE = 0.005

export function effectMagnitude(effect: Condition): number {
  switch (effect.kind) {
    case 'player-specs':
    case 'enemy-power':
      return Math.max(0, ...Object.values(effect.specs).map(v => Math.abs(v ?? 0)))
    case 'player-buffs':
    case 'player-debuffs':
      return Math.abs(effect.multiplier - 1)
    default:
      return 0
  }
}

function weakenStep(condition: OperationCondition, source: KeypointInput): number {
  if (condition.weakenPerKill !== undefined) return condition.weakenPerKill
  const count = enemyCount(source)
  return count === 0 ? 0 : effectMagnitude(condition.effect) / count
}

function weakenCondition(effect: Condition, cut: number): Condition | null {
  if (cut <= 0) return effect
  const shrink = (v: number) => {
    const left = Math.abs(v) - cut
    return left < NEGLIGIBLE ? 0 : Math.sign(v) * left
  }
  switch (effect.kind) {
    case 'player-specs':
    case 'enemy-power': {
      const specs: Partial<Record<0 | 1 | 2, number>> = {}
      for (const k of [0, 1, 2] as const) {
        const v = effect.specs[k]
        if (v !== undefined) specs[k] = shrink(v)
      }
      return Object.values(specs).some(v => v !== 0) ? { ...effect, specs } : null
    }
    case 'player-buffs':
    case 'player-debuffs': {
      const left = shrink(effect.multiplier - 1)
      return left === 0 ? null : { ...effect, multiplier: 1 + left }
    }
    default:
      return effect
  }
}

export function effectAfterKills(condition: OperationCondition, source: KeypointInput, kills: number): Condition | null {
  if (isMitigable(condition)) return weakenCondition(condition.effect, kills * weakenStep(condition, source))
  return kills >= conditionRemovalKills(condition, source) ? null : condition.effect
}

export type SourceState =
  | { readonly kind: 'fixed' }
  | { readonly kind: 'resolved'; readonly kills: number }
  | { readonly kind: 'pending'; readonly sourceId: string }

export function sourceState(
  condition: OperationCondition,
  locations: Map<string, KeypointLocation>,
): SourceState {
  if (!condition.source || condition.scope === 'local') return { kind: 'fixed' }
  const source = locations.get(condition.source)
  if (!source) return { kind: 'fixed' }
  if (source.keypoint.status === 'missed') return { kind: 'resolved', kills: 0 }
  if (source.keypoint.status === 'fought') return { kind: 'resolved', kills: weightedWins(source.keypoint) }
  return { kind: 'pending', sourceId: condition.source }
}

export interface Restrictions {
  readonly isBanned: (card: CardDef) => boolean
  readonly bannedModifiers: ReadonlySet<ModifierId>
  readonly modifiersDisabled: boolean
}

export function collectRestrictions(conditions: readonly Condition[]): Restrictions {
  const bannedTypes = new Set<UnitType>()
  const bannedCards = new Set<string>()
  const bannedTiers = new Set<number>()
  const bannedModifiers = new Set<ModifierId>()
  let modifiersDisabled = false
  for (const c of conditions) {
    if (c.kind === 'disable-modifiers') modifiersDisabled = true
    if (c.kind === 'restrictions') {
      for (const t of c.banned.types ?? []) bannedTypes.add(t)
      for (const code of c.banned.cards ?? []) bannedCards.add(code)
      for (const tier of c.banned.tiers ?? []) bannedTiers.add(tier)
      for (const m of c.banned.modifiers ?? []) bannedModifiers.add(m)
    }
  }
  const isBanned = (card: CardDef) => bannedTypes.has(card.type) || bannedCards.has(card.code) || bannedTiers.has(card.tier)
  return { isBanned, bannedModifiers, modifiersDisabled }
}
