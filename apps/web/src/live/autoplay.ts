import { cardByCode, collectRestrictions, modifierById, type ModifierId, type PlanResult } from '@nimitzpf/core'
import { create } from 'zustand'
import { LOADER, type DriveStep, type PlayError, type PlayRequest, type PlayResult, type PlaySlot, type Snapshot } from '../bridge/protocol.ts'
import { advanceableStage, openOperation, stageCleared } from '../bridge/rules.ts'
import type { Params } from '../i18n/index.ts'
import type { UiKey } from '../i18n/ui.ts'
import { solveRevision, usePlan } from '../solver/plan.ts'
import { activeConditions, conditionViews, evaluatePlacements, locate, modifierRule, recommendedPlacements, stageUsage, type Operation } from '../state/derive.ts'
import type { PlacementDraft } from '../state/model.ts'
import { useStore } from '../state/store.ts'
import type { ApiStage } from './api.ts'
import { play, send } from './channel.ts'
import { currentOperation, useLive, type BridgeInfo, type Connection } from './store.ts'

export const PLAY_PROTOCOL = 2
export const COUNTDOWN_MS = 3000
const SETTLE_MS = 30000
const POLL_MS = 2500

export type Readiness = 'ready' | 'demo' | 'offline' | 'old-bridge' | 'old-loader'

export function readiness(connection: Connection, bridge: BridgeInfo | null): Readiness {
  if (connection === 'demo') return 'demo'
  if (connection !== 'live') return 'offline'
  if (!bridge || bridge.protocol < PLAY_PROTOCOL) return 'old-bridge'
  if (bridge.loader < LOADER) return 'old-loader'
  return 'ready'
}

export type LineupProblem = 'not-in-game' | 'not-open' | 'empty' | 'invalid' | 'card' | 'modifier'

export function inGameOperation(snapshot: Snapshot | null): string | null {
  const status = snapshot?.state?.status
  return status?.state === 'in_operation' && status.operationId != null ? String(status.operationId) : null
}

export function lineupOf(op: Operation, plan: PlanResult | null, keypointId: string): readonly PlacementDraft[] | null {
  return op.overrides[keypointId] ?? recommendedPlacements(plan, keypointId)
}

export function playSlots(placements: readonly PlacementDraft[]): (PlaySlot | null)[] {
  return placements.map(p => {
    if (!p.card) return null
    const modifiers = [p.standard, p.special].filter((m): m is ModifierId => m !== null)
    return modifiers.length ? { cardCode: p.card, modifiers } : { cardCode: p.card }
  })
}

export function lineupProblem(op: Operation, snapshot: Snapshot | null, keypointId: string, placements: readonly PlacementDraft[] | null): LineupProblem | null {
  if (op.finished || !snapshot || !openOperation(snapshot, op.id)) return 'not-in-game'
  const at = locate(op, keypointId)
  if (!at || at.stage !== op.state.currentStage || op.keypoints.get(keypointId)?.raw !== 'revealed') return 'not-open'
  if (!placements?.some(p => p.card)) return 'empty'
  const conditions = activeConditions(conditionViews(op, keypointId))
  if (!evaluatePlacements(at.kp, placements, conditions, op.hp)?.ok) return 'invalid'
  const restrictions = collectRestrictions(conditions)
  const used = stageUsage(op, at.stage)
  const allowed = modifierRule(op, keypointId)
  const cards = new Set<string>()
  const spend: Partial<Record<ModifierId, number>> = {}
  for (const [lane, p] of placements.entries()) {
    if (!p.card) continue
    const card = cardByCode(p.card)
    const owned = op.state.fleet.some(f => f.card === p.card)
    if (!card || !owned || cards.has(p.card) || (op.hp[p.card] ?? 0) < 1 || used.has(p.card) || restrictions.isBanned(card)) return 'card'
    cards.add(p.card)
    for (const [id, slot] of [[p.standard, 1], [p.special, 2]] as const) {
      if (!id) continue
      if (modifierById(id)?.type !== slot || !allowed(lane, id)) return 'modifier'
      spend[id] = (spend[id] ?? 0) + 1
    }
  }
  for (const [id, n] of Object.entries(spend) as [ModifierId, number][]) if (n > (op.state.inventory[id] ?? 0)) return 'modifier'
  return null
}

export function nextTarget(op: Operation, plan: PlanResult | null): string | null {
  for (const kp of op.state.stages[op.state.currentStage]?.keypoints ?? []) {
    if (op.keypoints.get(kp.id)?.raw !== 'revealed') continue
    if (lineupOf(op, plan, kp.id)?.some(p => p.card)) return kp.id
  }
  return null
}

export function heldTarget(op: Operation, plan: PlanResult | null): string | null {
  for (const kp of op.state.stages[op.state.currentStage]?.keypoints ?? []) {
    if (kp.status !== 'open' || op.keypoints.get(kp.id)?.raw === 'revealed') continue
    if (lineupOf(op, plan, kp.id)?.some(p => p.card)) return kp.id
  }
  return null
}

export interface RunPlan {
  readonly operation: string | null
  readonly hint: UiKey
}

export function runPlan(snapshot: Snapshot | null, selected: Operation | null): RunPlan {
  const gameId = inGameOperation(snapshot)
  if (gameId) return { operation: gameId, hint: !selected || selected.id === gameId ? 'autoIdle' : 'autoIdleOther' }
  if (!selected) return { operation: null, hint: 'autoCannotStart' }
  if (selected.finished) return { operation: null, hint: 'autoOperationDone' }
  if (snapshot && openOperation(snapshot, selected.id)) return { operation: selected.id, hint: 'autoIdleNotStarted' }
  return { operation: null, hint: 'autoCannotStart' }
}

export type AutoPhase = 'idle' | 'thinking' | 'countdown' | 'playing' | 'waiting'
export type AutoAction = PlayRequest['kind']

export interface AutoNote {
  readonly tone: 'info' | 'done' | 'error'
  readonly key: UiKey
  readonly params?: Params
  readonly detail?: string
  readonly step?: DriveStep
}

interface AutoState {
  readonly running: boolean
  readonly phase: AutoPhase
  readonly action: AutoAction | null
  readonly target: string | null
  readonly stage: number | null
  readonly deadline: number | null
  readonly played: number
  readonly note: AutoNote | null
}

const IDLE = { phase: 'idle', action: null, target: null, stage: null, deadline: null } as const

export const useAuto = create<AutoState>()(() => ({ running: false, ...IDLE, played: 0, note: null }))

export const READINESS_NOTE: Readonly<Record<Exclude<Readiness, 'ready'>, UiKey>> = {
  demo: 'autoDemo',
  offline: 'autoOffline',
  'old-bridge': 'autoOldBridge',
  'old-loader': 'autoOldLoader',
}

export const PROBLEM_NOTE: Readonly<Record<LineupProblem, UiKey>> = {
  'not-in-game': 'autoNotInGame',
  'not-open': 'autoNotOpen',
  empty: 'autoEmpty',
  invalid: 'autoInvalid',
  card: 'autoBadCard',
  modifier: 'autoBadModifier',
}

const ERROR_NOTE: Readonly<Record<PlayError, UiKey>> = {
  loader: 'autoOldLoader',
  busy: 'autoErrBusy',
  invalid: 'autoErrInvalid',
  stale: 'autoErrStale',
  ui: 'autoErrUi',
  rejected: 'autoErrRejected',
  aborted: 'autoErrAborted',
  timeout: 'autoErrTimeout',
}

function failure(result: PlayResult | null): AutoNote {
  const error = result?.error ?? 'timeout'
  return { tone: 'error', key: ERROR_NOTE[error], ...(result?.step && { step: result.step }), ...(result?.detail && { detail: result.detail }) }
}

function keypointLabel(op: Operation, keypointId: string): Params {
  const meta = op.keypoints.get(keypointId)
  return { stage: (meta?.stage ?? 0) + 1, n: meta?.number ?? 1 }
}

function activeStage(snapshot: Snapshot | null, operationId: string): { readonly index: number; readonly stage: ApiStage | null } {
  const stages = snapshot?.operations[operationId]?.stages ?? []
  const index = stages.findIndex(s => s.isActive)
  return { index, stage: stages[index] ?? null }
}

function rawStatus(snapshot: Snapshot | null, operationId: string, keypointId: string): string | null {
  for (const stage of snapshot?.operations[operationId]?.stages ?? []) for (const kp of stage.keypoints ?? []) if (String(kp.id) === keypointId) return kp.status
  return null
}

type Decision =
  | { readonly kind: 'wait'; readonly then?: () => void }
  | { readonly kind: 'stop'; readonly note: AutoNote | null }
  | { readonly kind: 'act'; readonly key: string; readonly request: PlayRequest; readonly target: string | null; readonly stage: number | null }

let queued = false
let countdown = 0
let poll = 0
let armed: string | null = null
let waitingSince = 0
let waitFrom: string | null = null
let runOp: string | null = null
let unsubscribe: (() => void) | null = null

function stopWith(tone: AutoNote['tone'], key: UiKey, params?: Params): Decision {
  return { kind: 'stop', note: { tone, key, ...(params && { params }) } }
}

function decide(): Decision {
  const live = useLive.getState()
  const prefs = useStore.getState()
  const id = runOp
  if (!prefs.autoplay || !id) return { kind: 'stop', note: null }
  const ready = readiness(live.connection, live.bridge)
  if (ready !== 'ready') return stopWith('error', READINESS_NOTE[ready])
  const snapshot = live.snapshot
  const gameId = inGameOperation(snapshot)
  if (gameId && gameId !== id) return stopWith('error', 'autoOtherOperation')
  if (prefs.selection.operation !== id) return { kind: 'wait', then: () => prefs.select({ operation: id, keypoint: null, lane: null }) }
  const op = currentOperation()
  if (!op || op.id !== id || !snapshot) return { kind: 'wait' }
  if (op.finished) return stopWith('done', 'autoOperationDone')
  if (!openOperation(snapshot, id)) return stopWith('error', 'autoCannotStart')
  if (!snapshot.inventory) return stopWith('error', 'autoSyncSlow')
  const plan = usePlan.getState()
  if (plan.status === 'error') return { kind: 'stop', note: { tone: 'error', key: 'autoSolveFailed', ...(plan.error && { detail: plan.error }) } }
  if (plan.operation !== id || plan.revision !== solveRevision() || plan.status === 'solving') return { kind: 'wait' }
  const target = nextTarget(op, plan.result)
  if (target) {
    const lineup = lineupOf(op, plan.result, target)
    const problem = lineupProblem(op, snapshot, target, lineup)
    if (problem || !lineup) return stopWith('error', PROBLEM_NOTE[problem ?? 'empty'], keypointLabel(op, target))
    return {
      kind: 'act',
      key: JSON.stringify(['battle', target, lineup]),
      request: { kind: 'battle', operationId: id, keypointId: target, slots: playSlots(lineup) },
      target,
      stage: null,
    }
  }
  const held = heldTarget(op, plan.result)
  if (held) return stopWith('error', 'autoHeld', keypointLabel(op, held))
  const { index, stage } = activeStage(snapshot, id)
  if (stage && advanceableStage(snapshot, id, String(stage.id))) {
    const stageId = String(stage.id)
    return { kind: 'act', key: JSON.stringify(['advance', stageId]), request: { kind: 'advance', operationId: id, stageId }, target: null, stage: index + 2 }
  }
  const stages = snapshot.operations[id]?.stages ?? []
  const last = stages[stages.length - 1]
  if (snapshot.state?.status.isOperationReadyToComplete || (last && stageCleared(last))) return stopWith('done', 'autoAllDone', { n: useAuto.getState().played })
  const at = index >= 0 ? index : op.state.currentStage
  if (at < stages.length - 1) return stopWith('error', 'autoStuck', { stage: at + 1 })
  return stopWith('error', 'autoGoalMissed')
}

function settled(auto: AutoState): boolean {
  const snapshot = useLive.getState().snapshot
  if (!runOp) return true
  if (auto.action === 'advance') {
    const now = activeStage(snapshot, runOp).stage
    return now !== null && String(now.id) !== waitFrom
  }
  const raw = auto.target ? rawStatus(snapshot, runOp, auto.target) : null
  return raw !== 'revealed' && raw !== 'in_processing'
}

function schedule(): void {
  if (queued) return
  queued = true
  queueMicrotask(() => {
    queued = false
    step()
  })
}

export function stopAuto(note: AutoNote | null = null): void {
  if (useAuto.getState().phase === 'playing') send({ type: 'halt' })
  window.clearTimeout(countdown)
  window.clearInterval(poll)
  armed = null
  runOp = null
  unsubscribe?.()
  unsubscribe = null
  useAuto.setState(s => (s.phase === 'playing' ? { running: false, deadline: null, note } : { running: false, ...IDLE, note }))
}

export function startAuto(): void {
  const auto = useAuto.getState()
  if (auto.running || auto.phase !== 'idle') return
  const target = runPlan(useLive.getState().snapshot, currentOperation()).operation
  if (!target) return
  runOp = target
  const subscriptions = [useLive.subscribe(schedule), usePlan.subscribe(schedule), useStore.subscribe(schedule)]
  unsubscribe = () => subscriptions.forEach(u => u())
  useAuto.setState({ running: true, ...IDLE, phase: 'thinking', played: 0, note: null })
  schedule()
}

function step(): void {
  const auto = useAuto.getState()
  if (!auto.running || auto.phase === 'playing') return
  if (auto.phase === 'waiting') {
    if (!settled(auto)) return
    window.clearInterval(poll)
    useAuto.setState({ ...IDLE, phase: 'thinking', played: auto.played + (auto.action === 'battle' ? 1 : 0) })
  }
  const decision = decide()
  if (decision.kind === 'stop') return stopAuto(decision.note)
  if (decision.kind === 'wait') {
    window.clearTimeout(countdown)
    armed = null
    if (useAuto.getState().phase !== 'thinking') useAuto.setState({ ...IDLE, phase: 'thinking' })
    decision.then?.()
    return
  }
  if (useAuto.getState().phase === 'countdown' && armed === decision.key) return
  const key = decision.key
  armed = key
  window.clearTimeout(countdown)
  useAuto.setState({ phase: 'countdown', action: decision.request.kind, target: decision.target, stage: decision.stage, deadline: Date.now() + COUNTDOWN_MS })
  const prefs = useStore.getState()
  if (decision.target && prefs.selection.keypoint !== decision.target) prefs.select({ keypoint: decision.target, lane: null })
  countdown = window.setTimeout(() => void fire(key), COUNTDOWN_MS)
}

async function fire(key: string): Promise<void> {
  const auto = useAuto.getState()
  const operationId = runOp
  if (!auto.running || auto.phase !== 'countdown' || armed !== key || !operationId) return
  const decision = decide()
  if (decision.kind !== 'act' || decision.key !== key) {
    armed = null
    schedule()
    return
  }
  if (decision.request.kind === 'advance') waitFrom = decision.request.stageId
  useAuto.setState({ phase: 'playing', deadline: null })
  const result = await play(decision.request)
  if (!useAuto.getState().running) {
    useAuto.setState(s => ({ ...IDLE, note: result?.ok ? s.note : failure(result) }))
    return
  }
  if (!result?.ok) {
    useAuto.setState({ phase: 'idle' })
    return stopAuto(failure(result))
  }
  waitingSince = Date.now()
  useAuto.setState({ phase: 'waiting' })
  window.clearInterval(poll)
  poll = window.setInterval(() => {
    if (Date.now() - waitingSince > SETTLE_MS || runOp !== operationId) return stopAuto({ tone: 'error', key: 'autoSyncSlow' })
    send({ type: 'refresh' })
  }, POLL_MS)
  schedule()
}

export async function playNow(op: Operation, keypointId: string, placements: readonly PlacementDraft[]): Promise<void> {
  const auto = useAuto.getState()
  if (auto.running || auto.phase !== 'idle') return
  const problem = lineupProblem(op, useLive.getState().snapshot, keypointId, placements)
  if (problem) {
    useAuto.setState({ note: { tone: 'error', key: PROBLEM_NOTE[problem], params: keypointLabel(op, keypointId) } })
    return
  }
  useAuto.setState({ phase: 'playing', action: 'battle', target: keypointId, note: null })
  const result = await play({ kind: 'battle', operationId: op.id, keypointId, slots: playSlots(placements) })
  useAuto.setState({
    ...IDLE,
    note: !result?.ok ? failure(result) : { tone: 'done', key: 'autoPlayed', params: keypointLabel(op, keypointId) },
  })
  if (result?.ok) window.setTimeout(() => send({ type: 'refresh' }), POLL_MS)
}
