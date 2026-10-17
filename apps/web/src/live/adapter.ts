import {
  CLEAR_THRESHOLD,
  CORE_SETTINGS,
  VULN_CODES,
  cardByCode,
  effectMagnitude,
  enemyByCode,
  enemyCount,
  isFlagship,
  modifierById,
  weightedWins,
  type Condition,
  type ConditionKind,
  type ConditionScope,
  type EnemyUnit,
  type KeypointInput,
  type KeypointStatus,
  type LaneRecord,
  type ModifierId,
  type OperationCondition,
  type OperationState,
  type Restriction,
  type SpecDeltas,
  type SpecIndex,
  type StageInput,
  type VulnCode,
} from '@nimitzpf/core'
import { estimatedEnemy, rewardValues, type IntelRecord, type RewardDraft, type RewardWeights } from '../state/model.ts'
import type {
  ApiAlly,
  ApiEffect,
  ApiEffectPayload,
  ApiInventory,
  ApiKeypoint,
  ApiOperation,
  ApiReward,
  ApiRestriction,
  ApiSlot,
  ApiSpecs,
} from './api.ts'

export type ConditionStatus = 'active' | 'pending' | 'weakened' | 'removed'

export interface LiveCondition {
  readonly id: string
  readonly kind: ConditionKind
  readonly scope: ConditionScope
  readonly source: string | null
  readonly applyTo: readonly string[]
  readonly subsequent: boolean
  readonly mitigable: boolean
  readonly base: Condition
  readonly effective: Condition | null
  readonly status: ConditionStatus
  readonly removeAfter: number | null
  readonly weakenPercent: number | null
  readonly payload: ApiEffectPayload
  readonly planned: readonly OperationCondition[]
}

export interface LiveKeypoint {
  readonly id: string
  readonly number: number
  readonly stage: number
  readonly index: number
  readonly raw: string
  readonly difficulty: number
  readonly revealed: boolean
  readonly rewards: readonly (readonly RewardDraft[] | null)[]
  readonly boost: readonly (number | null)[]
  readonly allies: readonly (ApiAlly | null)[]
}

export interface LiveStage {
  readonly estimated: boolean
  readonly goalEstimated: boolean
  readonly kills: number | null
}

export type LiveIssue =
  | { readonly kind: 'kills'; readonly stage: number; readonly server: number; readonly local: number }
  | { readonly kind: 'goal'; readonly stage: number; readonly type: string }

export interface LiveOperation {
  readonly id: string
  readonly name: string
  readonly difficulty: number
  readonly started: boolean
  readonly finished: boolean
  readonly expireAt: number | null
  readonly state: OperationState
  readonly stages: readonly LiveStage[]
  readonly keypoints: ReadonlyMap<string, LiveKeypoint>
  readonly conditions: readonly LiveCondition[]
  readonly hp: Readonly<Record<string, number>>
  readonly issues: readonly LiveIssue[]
}

export interface CurrencyCodes {
  readonly main: string
  readonly progress: string
}

export const DEFAULT_CURRENCIES: CurrencyCodes = { main: 'eventum_1', progress: 'eventum_2' }

export interface AdapterContext {
  readonly inventory: ApiInventory | null
  readonly intel: readonly IntelRecord[]
  readonly weights: RewardWeights
  readonly currencies?: CurrencyCodes
}

const OPERATION_DIFFICULTY: Readonly<Record<string, number>> = { very_easy: 1, easy: 2, medium: 3, hard: 4, very_hard: 5 }
const KEYPOINT_DIFFICULTY: Readonly<Record<string, number>> = { easy: 1, medium: 2, hard: 3 }
const KIND: Readonly<Record<number, ConditionKind>> = {
  1: 'player-specs',
  2: 'player-buffs',
  3: 'player-debuffs',
  4: 'enemy-power',
  5: 'disable-modifiers',
  6: 'restrictions',
}
const SPECS: readonly SpecIndex[] = [0, 1, 2]

function tagged(tags: readonly string[] | undefined, table: Readonly<Record<string, number>>, fallback: number): number {
  for (const tag of tags ?? []) if (tag in table) return table[tag]!
  return fallback
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

function spec(specs: ApiSpecs | undefined, k: SpecIndex): number | undefined {
  const v = specs?.[String(k) as '0' | '1' | '2']
  return typeof v === 'number' ? v : undefined
}

function enemyUnit(enemy: NonNullable<ApiSlot['enemy']>): EnemyUnit {
  const vulns: Partial<Record<VulnCode, number>> = {}
  for (const [key, value] of Object.entries(enemy.vulns ?? {})) {
    const code = Number(key) as VulnCode
    if (VULN_CODES.includes(code) && typeof value === 'number' && value > 0) vulns[code] = Math.min(value, 1)
  }
  return {
    code: enemy.code,
    type: enemy.type ?? enemyByCode(enemy.code)?.type ?? 'cruiser',
    tier: enemy.tier,
    specs: [spec(enemy.specs, 0) ?? 0, spec(enemy.specs, 1) ?? 0, spec(enemy.specs, 2) ?? 0],
    vulns,
  }
}

function kebab(camel: string): string {
  return camel.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

const PROGRESS_POINTS = 'adeck_progress_points'

export function rewardDraft(r: ApiReward, currencies: CurrencyCodes): RewardDraft {
  const amount = Math.max(0, Number(r.amount) || 0)
  if (r.type === 'currency' && r.code === currencies.main) return { kind: 'supplies', amount, modifier: null }
  if (r.code === PROGRESS_POINTS && r.boostable === true) return { kind: 'progress', amount, modifier: null, boostable: true }
  if (r.code === currencies.progress || r.code === PROGRESS_POINTS) return { kind: 'progress', amount, modifier: null }
  if (r.code.startsWith('adeck2_card_')) return { kind: 'card', amount, modifier: null }
  if (r.code.startsWith('adeck2_modifier_')) {
    const id = kebab(r.code.slice('adeck2_modifier_'.length)) as ModifierId
    return modifierById(id) ? { kind: 'modifier', amount, modifier: id } : { kind: 'other', amount, modifier: null }
  }
  return { kind: 'other', amount, modifier: null }
}

function restriction(r: ApiRestriction | null | undefined): Restriction | undefined {
  if (!r) return undefined
  const out: Restriction = {
    ...(r.cards?.length ? { cards: r.cards } : {}),
    ...(r.types?.length ? { types: r.types } : {}),
    ...(r.tier?.length ? { tiers: r.tier } : {}),
    ...(r.modifiers?.length ? { modifiers: r.modifiers } : {}),
  }
  return Object.keys(out).length ? out : undefined
}

function deltas(base: ApiSpecs | undefined, delta: ApiSpecs | undefined, final: boolean): SpecDeltas {
  const out: Partial<Record<SpecIndex, number>> = {}
  for (const k of SPECS) {
    const b = spec(base, k)
    if (b === undefined) continue
    out[k] = round(b + (final ? (spec(delta, k) ?? 0) : 0))
  }
  return out
}

function effectOf(p: ApiEffectPayload, final: boolean): Condition | null {
  const exempt = restriction(p.apply_restrictions)
  switch (p.type) {
    case 1:
      return { kind: 'player-specs', specs: deltas(p.specs, p.delta_specs, final), ...(exempt && { exempt }) }
    case 4:
      return { kind: 'enemy-power', specs: deltas(p.specs, p.delta_specs, final), ...(exempt && { exempt }) }
    case 2:
      return { kind: 'player-buffs', multiplier: round((p.multiplier ?? 1) + (final ? (p.delta_multiplier ?? 0) : 0)), ...(exempt && { exempt }) }
    case 3:
      return { kind: 'player-debuffs', multiplier: round((p.multiplier ?? 1) + (final ? (p.delta_multiplier ?? 0) : 0)), ...(exempt && { exempt }) }
    case 5:
      return { kind: 'disable-modifiers' }
    case 6:
      return { kind: 'restrictions', banned: restriction(p.restrictions) ?? {} }
    default:
      return null
  }
}

function isNeutral(c: Condition): boolean {
  switch (c.kind) {
    case 'player-specs':
    case 'enemy-power':
      return Object.values(c.specs).every(v => !v)
    case 'player-buffs':
    case 'player-debuffs':
      return Math.abs(c.multiplier - 1) < 1e-9
    default:
      return false
  }
}

function sameEffect(a: Condition, b: Condition): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function keypointStatus(raw: string): KeypointStatus {
  if (raw === 'cleared') return 'fought'
  if (raw === 'missed') return 'missed'
  return 'open'
}

function slotsOf(kp: ApiKeypoint, size: number): (ApiSlot | null)[] {
  return Array.from({ length: size }, (_, i) => kp.slots?.[String(i)] ?? null)
}

function recordOf(slots: readonly (ApiSlot | null)[]): (LaneRecord | null)[] {
  return slots.map(s => (s?.ally?.code ? { card: s.ally.code, modifiers: s.ally.modifiers ?? [], won: s.outcome === 'win' } : null))
}

interface Location {
  readonly stage: number
  readonly keypoint: KeypointInput
}

function liveCondition(effect: ApiEffect, index: number, at: ReadonlyMap<string, Location>, stageIds: readonly (readonly string[])[]): LiveCondition | null {
  const p = effect.payload
  const kind = KIND[p.type]
  const base = effectOf(p, false)
  const final = effectOf(p, true)
  if (!kind || !base || !final) return null
  const id = `e${index}`
  const source = effect.source != null && at.has(String(effect.source)) ? String(effect.source) : null
  const applyTo = (effect.applyTo ?? []).map(String).filter(k => at.has(k))
  const subsequent = Boolean(effect.isSubsequent) && source !== null
  const mitigable = Boolean(effect.isMitigable) && kind !== 'disable-modifiers' && kind !== 'restrictions'
  const origin = source ? at.get(source)! : null
  const count = origin ? enemyCount(origin.keypoint) : 0
  const removeAfter = origin && !mitigable ? Math.ceil(CLEAR_THRESHOLD * (count || CORE_SETTINGS.HandSize) - 1e-9) : null
  const weakenPercent = origin && mitigable && count > 0 ? Math.round((effectMagnitude(base) * 100 * 10) / count) / 10 : null
  const scope: ConditionScope = subsequent ? 'global' : source && applyTo.length === 1 && applyTo[0] === source ? 'local' : 'targeted'

  let status: ConditionStatus
  let effective: Condition | null = final
  const resolved = origin !== null && origin.keypoint.status !== 'open'
  if (p.delta_disabled || isNeutral(final)) {
    status = 'removed'
    effective = null
  } else if (!origin || scope === 'local') status = 'active'
  else if (!resolved) status = 'pending'
  else if (!mitigable) {
    const ratio = origin.keypoint.status === 'missed' || count === 0 ? 0 : Math.min(weightedWins(origin.keypoint) / count, 1)
    if (ratio >= CLEAR_THRESHOLD) {
      status = 'removed'
      effective = null
    } else status = 'active'
  } else status = sameEffect(final, base) ? 'active' : 'weakened'

  const planned: OperationCondition[] = []
  if (effective) {
    if (status === 'pending' && origin) {
      const later = (k: string) => (at.get(k)?.stage ?? -1) > origin.stage
      const targets = applyTo.filter(k => k !== source && !(subsequent && later(k)))
      if (applyTo.includes(source!)) planned.push({ id: `${id}:l`, scope: 'local', source, targets: [source!], mitigable, effect: effective })
      if (targets.length) planned.push({ id: `${id}:t`, scope: 'targeted', source, targets, mitigable, effect: effective })
      if (subsequent) planned.push({ id: `${id}:g`, scope: 'global', source, targets: [], mitigable, effect: effective })
    } else {
      const targets = new Set(applyTo)
      if (subsequent && origin) stageIds.slice(origin.stage + 1).forEach(ids => ids.forEach(k => targets.add(k)))
      if (source && scope !== 'local') targets.delete(source)
      if (targets.size) planned.push({ id, scope: 'targeted', source: null, targets: [...targets], mitigable: false, effect: effective })
    }
  }
  return { id, kind, scope, source, applyTo, subsequent, mitigable, base, effective, status, removeAfter, weakenPercent, payload: p, planned }
}

export function appliesTo(c: LiveCondition, keypointId: string, keypoints: ReadonlyMap<string, LiveKeypoint>): boolean {
  if (c.applyTo.includes(keypointId)) return true
  if (!c.subsequent || !c.source || c.source === keypointId) return false
  const source = keypoints.get(c.source)
  const target = keypoints.get(keypointId)
  return source !== undefined && target !== undefined && source.stage < target.stage
}

export function currentStageOf(op: Pick<ApiOperation, 'stages' | 'isFinished'>): number {
  const active = op.stages.findIndex(s => s.isActive)
  if (active >= 0) return active
  if (op.isFinished) return Math.max(0, op.stages.length - 1)
  return Math.max(0, op.stages.findIndex(s => !s.isFinished))
}

export const LOCKED_STAGE_GOAL = 0.6
const KILL_GOALS = new Set(['defeat_vehicles', 'cleared_stage'])
const KNOWN_GOALS = new Set([...KILL_GOALS, 'win_previous_stage'])

function stageGoal(api: Pick<ApiOperation, 'stages' | 'finishCondition'>, s: number, keypoints: readonly KeypointInput[]): { value: number; estimated: boolean } {
  const target = api.stages[s]?.condition?.target
  if (typeof target === 'number') return { value: Math.max(0, target), estimated: false }
  const last = api.finishCondition?.lastStageDefeatTarget
  if (s === api.stages.length - 1 && typeof last === 'number') return { value: Math.max(0, last), estimated: false }
  const enemies = keypoints.reduce((n, kp) => n + kp.lanes.filter(Boolean).length, 0)
  return { value: Math.ceil(LOCKED_STAGE_GOAL * enemies), estimated: true }
}

export function toLiveOperation(api: ApiOperation, ctx: AdapterContext): LiveOperation {
  const currencies = ctx.currencies ?? DEFAULT_CURRENCIES
  const size = CORE_SETTINGS.HandSize
  const currentStage = currentStageOf(api)
  const metas = new Map<string, LiveKeypoint>()
  const laneRewards: (readonly RewardDraft[] | null)[] = []
  const stagesRaw = api.stages.map(stage => {
    const kps = (stage.keypoints ?? []).map((kp, index) => {
      const slots = slotsOf(kp, size)
      const rewards = slots.map(x => (x?.enemy && x.rewards?.length ? x.rewards.map(r => rewardDraft(r, currencies)) : null))
      rewards.forEach(r => laneRewards.push(r))
      return { kp, index, slots, rewards }
    })
    return { stage, kps }
  })
  const values = rewardValues(laneRewards, ctx.weights)
  const lifted = rewardValues(laneRewards, ctx.weights, true)
  let cursor = 0
  const flags: { estimated: boolean; goalEstimated: boolean }[] = []
  const stages: StageInput[] = stagesRaw.map(({ stage, kps }, s) => {
    let estimated = false
    const keypoints = kps.map(({ kp, index, slots, rewards }): KeypointInput => {
      const id = String(kp.id)
      const revealed = slots.some(x => x?.enemy)
      const difficulty = tagged(kp.tags, KEYPOINT_DIFFICULTY, 2)
      const status = keypointStatus(kp.status)
      const number = Number(/\d+/.exec(kp.name ?? '')?.[0] ?? index + 1)
      const boost = rewards.map((r, lane) => (r?.some(x => x.boostable) ? (lifted[cursor + lane] ?? null) : null))
      metas.set(id, { id, number, stage: s, index, raw: kp.status, difficulty, revealed, rewards, boost, allies: slots.map(x => x?.ally ?? null) })
      const lanes = slots.map(x => {
        const value = values[cursor++] ?? 1
        return x?.enemy ? { enemy: enemyUnit(x.enemy), reward: value } : null
      })
      if (!revealed && status === 'open') {
        estimated = true
        return { id, difficulty, status, lanes: Array.from({ length: size }, () => ({ enemy: estimatedEnemy(difficulty, ctx.intel), reward: 1 })) }
      }
      const record = status === 'fought' ? recordOf(slots) : undefined
      return { id, difficulty, status, lanes, ...(record && { record }) }
    })
    const goal = stageGoal(api, s, keypoints)
    flags.push({ estimated: (estimated || goal.estimated) && s >= currentStage, goalEstimated: goal.estimated })
    return { id: String(stage.id), goal: goal.value, keypoints }
  })

  const at = new Map<string, Location>()
  stages.forEach((stage, s) => stage.keypoints.forEach(keypoint => at.set(keypoint.id, { stage: s, keypoint })))
  const stageIds = stages.map(s => s.keypoints.map(k => k.id))
  const conditions = (api.effects ?? [])
    .map((e, i) => liveCondition(e, i, at, stageIds))
    .filter((c): c is LiveCondition => c !== null)

  const hp: Record<string, number> = {}
  const fleet = (ctx.inventory?.cards ?? [])
    .filter(c => cardByCode(c.code))
    .map(c => {
      hp[c.code] = Math.max(0, Math.min(3, c.health))
      return { card: c.code, hp: hp[c.code]! }
    })
  const inventory: Partial<Record<ModifierId, number>> = {}
  for (const m of ctx.inventory?.modifiers ?? []) if (modifierById(m.id)) inventory[m.id] = Math.max(0, Math.floor(m.amount))

  const issues: LiveIssue[] = []
  const liveStages: LiveStage[] = api.stages.map((stage, s) => {
    const type = stage.condition?.type ?? 'defeat_vehicles'
    if (!KNOWN_GOALS.has(type)) issues.push({ kind: 'goal', stage: s, type })
    const total = stage.condition?.total
    if (KILL_GOALS.has(type) && typeof total === 'number') {
      const local = stages[s]!.keypoints.reduce((n, k) => n + (k.status === 'fought' ? weightedWins(k) : 0), 0)
      if (local !== total) issues.push({ kind: 'kills', stage: s, server: total, local })
    }
    return { ...flags[s]!, kills: typeof total === 'number' ? total : null }
  })

  return {
    id: String(api.id),
    name: api.name,
    difficulty: tagged(api.tags, OPERATION_DIFFICULTY, 3),
    started: Boolean(api.isStarted),
    finished: Boolean(api.isFinished),
    expireAt: api.expireAt ?? null,
    state: { stages, currentStage, conditions: conditions.flatMap(c => c.planned), fleet, inventory },
    stages: liveStages,
    keypoints: metas,
    conditions,
    hp,
    issues,
  }
}

export function intelFrom(op: LiveOperation, seenAt: number): IntelRecord[] {
  const out: IntelRecord[] = []
  for (const stage of op.state.stages) {
    for (const kp of stage.keypoints) {
      const meta = op.keypoints.get(kp.id)
      if (!meta?.revealed) continue
      for (const lane of kp.lanes) {
        if (!lane || isFlagship(lane.enemy)) continue
        out.push({ code: lane.enemy.code, tier: lane.enemy.tier, specs: lane.enemy.specs, difficulty: meta.difficulty, seenAt })
      }
    }
  }
  return out
}
