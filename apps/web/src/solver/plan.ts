import type { Objective, OperationState, PlanResult, RawGameData } from '@nimitzpf/core'
import { useEffect } from 'react'
import { create } from 'zustand'
import { currentOperation, useLive } from '../live/store.ts'
import { openOverrides, type Operation } from '../state/derive.ts'
import { useStore } from '../state/store.ts'
import { cancelSolve, solveInWorkers, type SolveOutcome, type SolveTier } from './client.ts'

type PlanStatus = 'idle' | 'solving' | 'done' | 'error'

interface PlanState {
  readonly result: PlanResult | null
  readonly status: PlanStatus
  readonly revision: number
  readonly operation: string | null
  readonly deep: boolean
  readonly elapsedMs: number
  readonly workers: number
  readonly error: string | null
}

interface Job {
  readonly key: string
  readonly promise: Promise<SolveOutcome>
  readonly quick: SolveOutcome | Promise<SolveOutcome> | undefined
}

export const usePlan = create<PlanState>()(() => ({
  result: null,
  status: 'idle',
  revision: -1,
  operation: null,
  deep: false,
  elapsedMs: 0,
  workers: 0,
  error: null,
}))

const MEMO_SIZE = 32
const memo = new Map<string, SolveOutcome>()
let ticket = 0
let job: Job | null = null
let auto = 0

function memoKey(objective: Objective, tier: SolveTier, state: OperationState, data: RawGameData | null): string {
  return JSON.stringify([objective, tier, data?.build ?? null, state])
}

function recall(key: string): SolveOutcome | undefined {
  const hit = memo.get(key)
  if (!hit) return undefined
  memo.delete(key)
  memo.set(key, hit)
  return hit
}

function remember(key: string, outcome: SolveOutcome): void {
  if (outcome.result.truncated) return
  memo.delete(key)
  memo.set(key, outcome)
  if (memo.size > MEMO_SIZE) memo.delete([...memo.keys()][0]!)
}

function halt(): void {
  job = null
  cancelSolve()
}

function track(
  key: string,
  start: (live: () => boolean) => Promise<SolveOutcome>,
  quick?: SolveOutcome | Promise<SolveOutcome>,
): Promise<SolveOutcome> {
  let entry: Job | null = null
  const promise = start(() => job === entry)
  entry = { key, promise, quick }
  job = entry
  const settle = () => {
    if (job === entry) job = null
  }
  promise.then(settle, settle)
  return promise
}

async function solveQuick(key: string, state: OperationState, objective: Objective, data: RawGameData | null): Promise<SolveOutcome> {
  const outcome = await solveInWorkers(state, objective, 'quick', [], data)
  remember(key, outcome)
  return outcome
}

async function solveDeep(
  key: string,
  state: OperationState,
  objective: Objective,
  quick: SolveOutcome | Promise<SolveOutcome>,
  live: () => boolean,
  data: RawGameData | null,
): Promise<SolveOutcome> {
  const base = await quick
  if (!live()) throw new Error('superseded')
  const outcome = await solveInWorkers(state, objective, 'deep', [base.result], data)
  const merged = { ...outcome, elapsedMs: outcome.elapsedMs + base.elapsedMs }
  remember(key, merged)
  return merged
}

export function solveState(op: Operation): OperationState {
  return { ...op.state, pinned: openOverrides(op) }
}

export function solveRevision(): number {
  return useStore.getState().revision * 100003 + useLive.getState().revision
}

export function useSolveRevision(): number {
  const prefs = useStore(s => s.revision)
  const live = useLive(s => s.revision)
  return prefs * 100003 + live
}

export function hasWork(op: Operation, state: OperationState): boolean {
  if (op.finished || state.fleet.length === 0) return false
  return state.stages.some((stage, i) => i >= state.currentStage && stage.keypoints.some(k => k.status === 'open' && k.lanes.some(Boolean)))
}

export function requestSolve(deep: boolean): void {
  if (deep) window.clearTimeout(auto)
  const s = useStore.getState()
  const op = currentOperation()
  const revision = solveRevision()
  const current = ++ticket
  const state = op && solveState(op)
  if (!op || !state || !hasWork(op, state)) {
    halt()
    usePlan.setState({ result: null, status: 'idle', revision, operation: op?.id ?? null, deep, error: null })
    return
  }
  const data = useLive.getState().data
  const operation = op.id
  const objective = s.objective
  const quickKey = memoKey(objective, 'quick', state, data)
  const deepKey = memoKey(objective, 'deep', state, data)
  const show = (outcome: SolveOutcome, status: PlanStatus, kind: SolveTier) => {
    if (current !== ticket || currentOperation()?.id !== operation) return
    usePlan.setState({
      result: outcome.result,
      status,
      revision,
      operation,
      deep: kind === 'deep',
      elapsedMs: outcome.elapsedMs,
      workers: outcome.workers,
      error: null,
    })
  }
  const deepHit = recall(deepKey)
  if (deepHit) {
    halt()
    show(deepHit, 'done', 'deep')
    return
  }
  const quickHit = recall(quickKey)
  const adopted = job?.key === deepKey ? job : null
  if (!deep && !adopted && quickHit) {
    halt()
    show(quickHit, 'done', 'quick')
    return
  }
  const pending = job?.key === quickKey ? job.promise : null
  let quick: SolveOutcome | Promise<SolveOutcome> | undefined = quickHit ?? adopted?.quick
  let promise: Promise<SolveOutcome>
  if (adopted) promise = adopted.promise
  else if (!deep) promise = pending ?? track(quickKey, () => solveQuick(quickKey, state, objective, data))
  else {
    const base = quickHit ?? pending ?? solveQuick(quickKey, state, objective, data)
    quick = base
    promise = track(deepKey, live => solveDeep(deepKey, state, objective, base, live, data), base)
  }
  const tier: SolveTier = deep || adopted ? 'deep' : 'quick'
  usePlan.setState({ status: 'solving', deep: tier === 'deep', error: null })
  if (quick) void Promise.resolve(quick).then(outcome => show(outcome, 'solving', 'quick'), () => undefined)
  promise
    .then(outcome => show(outcome, 'done', tier))
    .catch((error: unknown) => {
      if (current !== ticket) return
      usePlan.setState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
    })
}

export function useAutoSolve(): void {
  const prefs = useStore(s => s.revision)
  const live = useLive(s => s.revision)
  const active = useStore(s => s.selection.operation)
  useEffect(() => {
    const plan = usePlan.getState()
    if (plan.revision === solveRevision() && plan.operation === (currentOperation()?.id ?? null) && plan.status !== 'error') return
    const timer = window.setTimeout(() => requestSolve(false), 300)
    auto = timer
    return () => window.clearTimeout(timer)
  }, [prefs, live, active])
}

export function usePlanFor(operationId: string | null | undefined): PlanResult | null {
  return usePlan(s => (operationId && s.operation === operationId ? s.result : null))
}
