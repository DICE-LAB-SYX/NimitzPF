import {
  DEEP_JOBS,
  QUICK_JOBS,
  phaseBudgets,
  primaryFloor,
  rankElites,
  selectPlan,
  startsFor,
  type Objective,
  type OperationState,
  type PlanResult,
  type RawGameData,
} from '@nimitzpf/core'
import type { SolveRequest, SolveResponse } from './worker.ts'

export type SolveTier = 'quick' | 'deep'

export interface SolveOutcome {
  readonly result: PlanResult
  readonly elapsedMs: number
}

interface Phase<T> {
  readonly values: T[]
  readonly failure: string | null
}

const JOB_BUDGET: Readonly<Record<SolveTier, number>> = { quick: 1400, deep: 3000 }
const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2
const workerCount = Math.max(1, Math.min(3, cores - 1))

let pool: Worker[] = []
let requestId = 0
let messageId = 0
let busy = false

function spawn(): Worker {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
}

function ensurePool(size: number): Worker[] {
  while (pool.length < size) pool.push(spawn())
  return pool.slice(0, size)
}

export function cancelSolve(): void {
  requestId++
  if (busy) {
    for (const w of pool) w.terminate()
    pool = []
  }
  busy = false
}

function runPhase<T>(
  id: number,
  workers: readonly Worker[],
  requests: readonly ((message: number) => SolveRequest)[],
  read: (response: SolveResponse) => readonly T[] | undefined,
): Promise<Phase<T>> {
  return new Promise((resolve, reject) => {
    const slots: (readonly T[])[] = requests.map(() => [])
    let failure: string | null = null
    let next = 0
    let done = 0
    const feed = (worker: Worker) => {
      if (next >= requests.length) return
      const index = next++
      const message = ++messageId
      worker.onmessage = (event: MessageEvent<SolveResponse>) => {
        const data = event.data
        if (data.id !== message || id !== requestId) return
        if (data.error !== undefined) failure = data.error
        slots[index] = read(data) ?? []
        if (++done === requests.length) resolve({ values: slots.flat(), failure })
        else feed(worker)
      }
      worker.onerror = event => {
        event.preventDefault()
        if (id === requestId) reject(new Error(event.message || 'solver failed'))
      }
      worker.postMessage(requests[index]!(message))
    }
    workers.forEach(feed)
  })
}

export async function solveInWorkers(
  state: OperationState,
  objective: Objective,
  tier: SolveTier,
  extra: readonly PlanResult[],
  data: RawGameData | null = null,
): Promise<SolveOutcome> {
  cancelSolve()
  const id = ++requestId
  busy = true
  const jobs = tier === 'deep' ? DEEP_JOBS : QUICK_JOBS
  const budgets = phaseBudgets(JOB_BUDGET[tier])
  const workers = ensurePool(Math.min(workerCount, jobs.length))
  const started = performance.now()
  try {
    const primary = await runPhase(
      id,
      workers,
      jobs.map(job => (message: number): SolveRequest => ({ id: message, kind: 'primary', state, objective, budgetMs: budgets.primary, job, data })),
      response => response.elites,
    )
    if (!primary.values.length) throw new Error(primary.failure ?? 'solver failed')
    const floor = primaryFloor(primary.values.map(e => e.metrics))
    const ranked = rankElites(primary.values, floor)
    const thrift = await runPhase(
      id,
      workers,
      jobs.map((job, i) => (message: number): SolveRequest => ({
        id: message,
        kind: 'thrift',
        state,
        objective,
        budgetMs: budgets.thrift,
        job,
        data,
        floor,
        starts: startsFor(ranked, i, jobs.length),
      })),
      response => response.results,
    )
    const candidates = [...thrift.values, ...extra]
    if (!candidates.length) throw new Error(thrift.failure ?? 'solver failed')
    const best = selectPlan(candidates)
    const failed = primary.failure !== null || thrift.failure !== null
    const truncated = failed || primary.values.some(e => e.truncated) || candidates.some(r => r.truncated)
    if (id === requestId) busy = false
    return { result: { ...best, truncated }, elapsedMs: performance.now() - started }
  } catch (error) {
    if (id === requestId) cancelSolve()
    throw error
  }
}
