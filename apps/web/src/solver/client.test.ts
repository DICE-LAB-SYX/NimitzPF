import { CARDS, ENEMIES, MODIFIERS, economize, searchPrimary, type EnemyUnit, type OperationState } from '@nimitzpf/core'
import { describe, expect, it, vi } from 'vitest'
import { solveInWorkers } from './client.ts'
import type { SolveRequest, SolveResponse } from './worker.ts'

let fail = (_request: SolveRequest) => false

function respond(request: SolveRequest): SolveResponse {
  if (fail(request)) return { id: request.id, error: 'boom' }
  const options = { objective: request.objective, ...request.job, timeBudgetMs: 60 }
  if (request.kind === 'primary') return { id: request.id, elites: searchPrimary(request.state, options) }
  return { id: request.id, results: economize(request.state, { ...options, floor: request.floor, starts: request.starts }) }
}

class FakeWorker {
  onmessage: ((event: { data: SolveResponse }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  postMessage(request: SolveRequest): void {
    setTimeout(() => this.onmessage?.({ data: respond(request) }), 0)
  }
  terminate(): void {}
}

vi.stubGlobal('Worker', FakeWorker)

function fixture(): OperationState {
  const enemies: EnemyUnit[] = ENEMIES.slice(0, 4).map((e, i) => ({ code: e.code, type: e.type, tier: 1, specs: [90 + 20 * i, 0, 0], vulns: {} }))
  const lane = (e: EnemyUnit) => ({ enemy: e, reward: 1 })
  const stages = [2, 1].map((count, s) => ({
    id: `s${s}`,
    goal: count,
    keypoints: Array.from({ length: count }, (_, i) => ({
      id: `k${s}${i}`,
      difficulty: 1,
      status: 'open' as const,
      lanes: [lane(enemies[(s + i) % 4]!), lane(enemies[(s + i + 1) % 4]!), null, null],
    })),
  }))
  const inventory = Object.fromEntries(MODIFIERS.map(m => [m.id, 1]))
  return { stages, currentStage: 0, conditions: [], fleet: CARDS.slice(0, 6).map(c => ({ card: c.code, hp: 3 })), inventory }
}

const state = fixture()

describe('worker solve', () => {
  it('marks the plan as not converged when a job fails', async () => {
    let seen = 0
    fail = request => request.kind === 'thrift' && seen++ === 1
    const outcome = await solveInWorkers(state, 'complete', 'quick', [])
    expect(seen).toBe(3)
    expect(outcome.result.truncated).toBe(true)
  })

  it('rejects when every primary job fails', async () => {
    fail = request => request.kind === 'primary'
    await expect(solveInWorkers(state, 'complete', 'quick', [])).rejects.toThrow('boom')
  })

  it('falls back to the extra candidates when every thrift job fails', async () => {
    fail = () => false
    const first = await solveInWorkers(state, 'complete', 'quick', [])
    fail = request => request.kind === 'thrift'
    const outcome = await solveInWorkers(state, 'complete', 'quick', [first.result])
    expect(outcome.result.stages).toEqual(first.result.stages)
    expect(outcome.result.truncated).toBe(true)
  })

  it('carries the truncation of an extra candidate', async () => {
    fail = () => false
    const first = await solveInWorkers(state, 'complete', 'quick', [])
    const outcome = await solveInWorkers(state, 'complete', 'quick', [{ ...first.result, truncated: true }])
    expect(outcome.result.truncated).toBe(true)
  })
})
