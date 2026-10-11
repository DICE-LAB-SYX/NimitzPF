import {
  CORE_SETTINGS,
  MODIFIER_RULES,
  MODIFIERS,
  cardByCode,
  collectRestrictions,
  effectAfterKills,
  enemyCount,
  evaluateBoard,
  fullRemovalKills,
  isFlagship,
  modifierById,
  type BoardEvaluation,
  type Condition,
  type KeypointInput,
  type ModifierId,
  type PlanResult,
  type PlannedKeypoint,
  type Restrictions,
} from '@nimitzpf/core'
import { appliesTo, type ConditionStatus, type LiveCondition, type LiveOperation } from '../live/adapter.ts'
import type { PlacementDraft } from './model.ts'

export type Overrides = Readonly<Record<string, readonly PlacementDraft[]>>

export interface Operation extends LiveOperation {
  readonly overrides: Overrides
}

export type ConditionBucket = 'local' | 'incoming' | 'targeted' | 'global'

export interface ConditionView {
  readonly condition: LiveCondition
  readonly bucket: ConditionBucket
  readonly status: ConditionStatus
  readonly effective: Condition | null
}

export const EMPTY_PLACEMENT: PlacementDraft = { card: null, standard: null, special: null }
export const EMPTY_PLACEMENTS: readonly PlacementDraft[] = [EMPTY_PLACEMENT, EMPTY_PLACEMENT, EMPTY_PLACEMENT, EMPTY_PLACEMENT]

export interface Located {
  readonly kp: KeypointInput
  readonly stage: number
  readonly index: number
}

export function locate(op: LiveOperation, keypointId: string | null): Located | null {
  if (keypointId === null) return null
  const meta = op.keypoints.get(keypointId)
  const kp = meta && op.state.stages[meta.stage]?.keypoints[meta.index]
  return meta && kp ? { kp, stage: meta.stage, index: meta.index } : null
}

export function conditionViews(op: LiveOperation, keypointId: string): ConditionView[] {
  if (!op.keypoints.has(keypointId)) return []
  const views: ConditionView[] = []
  for (const c of op.conditions) {
    if (c.source === keypointId && c.scope !== 'local') {
      views.push({ condition: c, bucket: c.scope === 'global' ? 'global' : 'targeted', status: c.status, effective: c.effective })
      continue
    }
    if (!appliesTo(c, keypointId, op.keypoints)) continue
    const bucket: ConditionBucket = c.source === null || c.scope === 'local' ? 'local' : 'incoming'
    views.push({ condition: c, bucket, status: c.status, effective: c.effective })
  }
  return views
}

export function activeConditions(views: readonly ConditionView[]): Condition[] {
  return views
    .filter(v => v.bucket === 'local' || v.bucket === 'incoming')
    .map(v => v.effective)
    .filter((c): c is Condition => c !== null)
}

export function activePayloads(op: LiveOperation, keypointId: string): LiveCondition['payload'][] {
  return conditionViews(op, keypointId)
    .filter(v => (v.bucket === 'local' || v.bucket === 'incoming') && v.effective !== null)
    .map(v => v.condition.payload)
}

export interface SweptConditions {
  readonly conditions: readonly Condition[]
  readonly sources: readonly string[]
}

function sweepKills(op: Operation, plan: PlanResult | null, source: KeypointInput): number {
  const placements = op.overrides[source.id] ?? recommendedPlacements(plan, source.id)
  if (!placements) return enemyCount(source)
  const rule = modifierRule(op, source.id)
  return placements.reduce((n, p, lane) => {
    if (!p.card || !source.lanes[lane]) return n
    return n + (p.standard === 'moral-impact' && rule(lane, 'moral-impact') ? 2 : 1)
  }, 0)
}

export function sweptConditions(op: Operation, plan: PlanResult | null, keypointId: string): SweptConditions | null {
  const target = locate(op, keypointId)
  if (!target || target.kp.status !== 'open') return null
  const conditions: Condition[] = []
  const sources = new Set<string>()
  for (const view of conditionViews(op, keypointId)) {
    if (view.bucket !== 'local' && view.bucket !== 'incoming') continue
    const c = view.condition
    const source = view.status === 'pending' && c.source ? locate(op, c.source) : null
    const earlier = source && (source.stage < target.stage || (source.stage === target.stage && source.index < target.index))
    const planned = c.planned[0]
    if (!source || !earlier || !planned) {
      if (view.effective) conditions.push(view.effective)
      continue
    }
    const effect = effectAfterKills(planned, source.kp, sweepKills(op, plan, source.kp))
    if (effect !== planned.effect) sources.add(source.kp.id)
    if (effect) conditions.push(effect)
  }
  return sources.size ? { conditions, sources: [...sources] } : null
}

export function removalNeed(op: LiveOperation, keypointId: string): number | null {
  const source = locate(op, keypointId)
  const outgoing = op.conditions.filter(c => c.source === keypointId && c.scope !== 'local' && c.status === 'pending' && c.planned.length > 0)
  if (!outgoing.length || !source) return null
  return Math.max(...outgoing.map(c => fullRemovalKills(c.planned[0]!, source.kp)))
}

export function markerKind(op: LiveOperation, keypointId: string): 'flagman' | 'negative' | 'positive' {
  const at = locate(op, keypointId)
  if (at && op.keypoints.get(keypointId)?.revealed && at.kp.lanes.some(l => l && isFlagship(l.enemy))) return 'flagman'
  if (op.conditions.some(c => c.source === keypointId && c.scope !== 'local')) return 'negative'
  return 'positive'
}

export function plannedKeypoint(plan: PlanResult | null, id: string): PlannedKeypoint | null {
  if (!plan) return null
  for (const s of plan.stages) for (const k of s.keypoints) if (k.id === id) return k
  return null
}

export function recommendedPlacements(plan: PlanResult | null, id: string): PlacementDraft[] | null {
  const kp = plannedKeypoint(plan, id)
  if (!kp) return null
  return kp.lanes.map(l => ({ card: l.card, standard: l.standard, special: l.special }))
}

export type ModifierCounts = Partial<Record<ModifierId, number>>

type Allowed = (lane: number, id: ModifierId) => boolean

interface ModifierUsage {
  readonly committed: ModifierCounts
  readonly planned: ModifierCounts
}

interface LedgerEntry {
  readonly stock: number
  readonly assigned: number
  readonly left: number
  readonly over: number
  readonly usable: boolean
  readonly reserved: boolean
}

function ruleAt(op: LiveOperation, kp: KeypointInput): Allowed {
  const guessed = !op.keypoints.get(kp.id)?.revealed
  let restrictions: Restrictions | null = null
  return (lane, id) => {
    restrictions ??= collectRestrictions(activeConditions(conditionViews(op, kp.id)))
    if (restrictions.modifiersDisabled || restrictions.bannedModifiers.has(id)) return false
    return !MODIFIER_RULES[id].needsEnemy || guessed || Boolean(kp.lanes[lane])
  }
}

export function modifierRule(op: LiveOperation, keypointId: string): Allowed {
  const at = locate(op, keypointId)
  return at ? ruleAt(op, at.kp) : () => false
}

function laneKey(keypointId: string, lane: number): string {
  return `${keypointId}:${lane}`
}

function droppedLanes(op: Operation): ReadonlySet<string> {
  const dropped = new Set<string>()
  const hp = new Map<string, number>()
  op.state.stages.forEach((stage, s) => {
    if (s < op.state.currentStage) return
    const taken = new Set(stageUsage(op, s).keys())
    for (const kp of stage.keypoints) {
      const override = op.overrides[kp.id]
      if (kp.status !== 'open' || !override) continue
      const rule = ruleAt(op, kp)
      let restrictions: Restrictions | null = null
      override.forEach((p, lane) => {
        if (!p.card) return
        const card = cardByCode(p.card)
        restrictions ??= collectRestrictions(activeConditions(conditionViews(op, kp.id)))
        const left = hp.get(p.card) ?? Math.max(0, Math.min(3, op.hp[p.card] ?? 0))
        if (!card || restrictions.isBanned(card) || taken.has(p.card) || left < 1) {
          dropped.add(laneKey(kp.id, lane))
          return
        }
        taken.add(p.card)
        const repair = p.special === 'fast-repair' && rule(lane, 'fast-repair')
        hp.set(p.card, (repair ? Math.min(left + 2, 3) : left) - 1)
      })
    }
  })
  return dropped
}

function gated(rule: Allowed, keypointId: string, dropped: ReadonlySet<string>): Allowed {
  return (lane, id) => !dropped.has(laneKey(keypointId, lane)) && rule(lane, id)
}

function withOverride(op: Operation, keypointId: string, placements: readonly PlacementDraft[]): Operation {
  return { ...op, overrides: { ...op.overrides, [keypointId]: [...placements] } }
}

function tally(counts: ModifierCounts, placements: readonly PlacementDraft[], allowed: Allowed, skipLane = -1): void {
  placements.forEach((p, i) => {
    if (!p.card || i === skipLane) return
    for (const [id, slot] of [[p.standard, 1], [p.special, 2]] as const) {
      if (id && modifierById(id)?.type === slot && allowed(i, id)) counts[id] = (counts[id] ?? 0) + 1
    }
  })
}

function subtract(inventory: ModifierCounts, held: ModifierCounts): ModifierCounts {
  const out: ModifierCounts = {}
  for (const id of Object.keys(inventory) as ModifierId[]) out[id] = Math.max(0, (inventory[id] ?? 0) - (held[id] ?? 0))
  return out
}

function usageOf(op: Operation, plan: PlanResult | null, skipKeypoint: string | null, dropped: ReadonlySet<string>): ModifierUsage {
  const committed: ModifierCounts = {}
  const planned: ModifierCounts = {}
  op.state.stages.forEach((stage, s) => {
    if (s < op.state.currentStage) return
    for (const kp of stage.keypoints) {
      if (kp.status !== 'open' || kp.id === skipKeypoint) continue
      const override = op.overrides[kp.id]
      if (override) tally(committed, override, gated(ruleAt(op, kp), kp.id, dropped))
      else tally(planned, recommendedPlacements(plan, kp.id) ?? [], ruleAt(op, kp))
    }
  })
  return { committed, planned }
}

export function modifierUsage(op: Operation, plan: PlanResult | null, skipKeypoint: string | null = null): ModifierUsage {
  return usageOf(op, plan, skipKeypoint, droppedLanes(op))
}

export function modifiersLeft(
  op: Operation,
  plan: PlanResult | null,
  keypointId: string,
  placements: readonly PlacementDraft[],
  lane: number,
): { readonly left: ModifierCounts; readonly plannedElsewhere: ModifierCounts } {
  const draft = withOverride(op, keypointId, placements)
  const dropped = droppedLanes(draft)
  const { committed, planned } = usageOf(draft, plan, keypointId, dropped)
  tally(committed, placements, gated(modifierRule(draft, keypointId), keypointId, dropped), lane)
  return { left: subtract(op.state.inventory, committed), plannedElsewhere: planned }
}

export function laneRule(op: Operation, keypointId: string, placements: readonly PlacementDraft[], lane: number): (id: ModifierId) => boolean {
  if (!placements[lane]?.card) return () => false
  const draft = withOverride(op, keypointId, placements)
  const rule = gated(modifierRule(draft, keypointId), keypointId, droppedLanes(draft))
  return id => rule(lane, id)
}

export function canAttach(op: Operation, plan: PlanResult | null, keypointId: string, placements: readonly PlacementDraft[], lane: number, id: ModifierId): boolean {
  const p = placements[lane]
  const def = modifierById(id)
  if (!p?.card || !def || (def.type === 1 ? p.standard : p.special) === id) return false
  if (!laneRule(op, keypointId, placements, lane)(id)) return false
  return (modifiersLeft(op, plan, keypointId, placements, lane).left[id] ?? 0) > 0
}

export function modifierLedger(
  op: Operation,
  plan: PlanResult | null,
  keypointId: string | null = null,
  placements: readonly PlacementDraft[] = EMPTY_PLACEMENTS,
): Readonly<Record<ModifierId, LedgerEntry>> {
  const stock = op.state.inventory
  const { committed, planned } = modifierUsage(op, plan)
  const room = keypointId === null ? null : modifiersLeft(op, plan, keypointId, placements, -1).left
  const entries = MODIFIERS.map(({ id }): [ModifierId, LedgerEntry] => {
    const total = stock[id] ?? 0
    const held = committed[id] ?? 0
    const assigned = held + (planned[id] ?? 0)
    const left = Math.max(0, total - assigned)
    const usable = room ? (room[id] ?? 0) > 0 : held < total
    return [id, { stock: total, assigned, left, over: Math.max(0, held - total), usable, reserved: usable && left === 0 }]
  })
  return Object.fromEntries(entries) as Record<ModifierId, LedgerEntry>
}

export function recordPlacements(kp: KeypointInput): PlacementDraft[] | null {
  if (!kp.record) return null
  return kp.record.map(r => {
    if (!r) return EMPTY_PLACEMENT
    const slot = (type: 1 | 2) => r.modifiers.find(m => modifierById(m)?.type === type) ?? null
    return { card: r.card, standard: slot(1), special: slot(2) }
  })
}

export function recordHp(op: LiveOperation, kp: KeypointInput): Record<string, number> {
  const out: Record<string, number> = { ...op.hp }
  for (const ally of op.keypoints.get(kp.id)?.allies ?? []) if (ally?.code && typeof ally.health === 'number') out[ally.code] = ally.health
  return out
}

export function evaluatePlacements(
  kp: KeypointInput,
  placements: readonly PlacementDraft[],
  conditions: readonly Condition[],
  hp: Readonly<Record<string, number>>,
): BoardEvaluation | null {
  if (!kp.lanes.some(Boolean)) return null
  const player = placements.map(p => {
    if (!p.card) return null
    const card = cardByCode(p.card)
    if (!card) return null
    const modifiers = [p.standard, p.special].filter((m): m is ModifierId => m !== null)
    return { card, hp: hp[p.card] ?? 3, modifiers }
  })
  const enemy = kp.lanes.map(l => l?.enemy ?? null)
  return evaluateBoard({ player, enemy, conditions }, CORE_SETTINGS, true)
}

export function stageUsage(op: LiveOperation, stageIndex: number): Map<string, string> {
  const used = new Map<string, string>()
  const stage = op.state.stages[stageIndex]
  if (!stage) return used
  for (const kp of stage.keypoints) {
    if (kp.status !== 'fought') continue
    for (const r of kp.record ?? []) if (r) used.set(r.card, kp.id)
  }
  return used
}

export function stageAssignments(op: Operation, stageIndex: number, plan: PlanResult | null): Map<string, string> {
  const assigned = new Map<string, string>()
  const stage = op.state.stages[stageIndex]
  if (!stage) return assigned
  for (const kp of stage.keypoints) {
    if (kp.status !== 'open') continue
    const placements = op.overrides[kp.id] ?? recommendedPlacements(plan, kp.id) ?? []
    for (const p of placements) if (p.card) assigned.set(p.card, kp.id)
  }
  return assigned
}

export function openOverrides(op: Operation): Overrides {
  const out: Record<string, readonly PlacementDraft[]> = {}
  for (const [id, placements] of Object.entries(op.overrides)) if (locate(op, id)?.kp.status === 'open') out[id] = placements
  return out
}

export function effectivePercentLabel(effect: Condition | null): string {
  if (!effect) return '0%'
  if (effect.kind === 'player-specs' || effect.kind === 'enemy-power') {
    const values = Object.values(effect.specs).filter((v): v is number => typeof v === 'number')
    const v = Math.round((values.find(x => x !== 0) ?? values[0] ?? 0) * 100)
    return `${v > 0 ? '+' : ''}${v}%`
  }
  if (effect.kind === 'player-buffs' || effect.kind === 'player-debuffs') {
    const v = Math.round((effect.multiplier - 1) * 100)
    return `${v > 0 ? '+' : ''}${v}%`
  }
  return ''
}

export function conditionIsHarmful(effect: Condition): boolean {
  switch (effect.kind) {
    case 'enemy-power':
      return Object.values(effect.specs).some(v => (v ?? 0) > 0)
    case 'player-specs':
      return Object.values(effect.specs).some(v => (v ?? 0) < 0)
    case 'player-buffs':
    case 'player-debuffs':
      return effect.multiplier < 1
    default:
      return true
  }
}
