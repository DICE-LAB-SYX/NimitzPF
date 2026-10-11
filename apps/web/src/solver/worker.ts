import {
  BUNDLED_DATA,
  DATA_BUILD,
  economize,
  installGameData,
  searchPrimary,
  type Elite,
  type Objective,
  type OperationState,
  type PinnedLane,
  type PlanResult,
  type RawGameData,
  type SolveJob,
} from '@nimitzpf/core'

interface JobRequest {
  readonly id: number
  readonly state: OperationState
  readonly objective: Objective
  readonly budgetMs: number
  readonly job: SolveJob
  readonly data: RawGameData | null
}

interface PrimaryRequest extends JobRequest {
  readonly kind: 'primary'
}

interface ThriftRequest extends JobRequest {
  readonly kind: 'thrift'
  readonly floor: readonly number[]
  readonly starts: readonly Readonly<Record<string, readonly PinnedLane[]>>[]
}

export type SolveRequest = PrimaryRequest | ThriftRequest

export interface SolveResponse {
  readonly id: number
  readonly elites?: readonly Elite[]
  readonly results?: readonly PlanResult[]
  readonly error?: string
}

function run(request: SolveRequest): SolveResponse {
  const data = request.data ?? BUNDLED_DATA
  if (data.build !== DATA_BUILD) installGameData(data)
  const options = { objective: request.objective, ...request.job, timeBudgetMs: request.budgetMs }
  if (request.kind === 'primary') return { id: request.id, elites: searchPrimary(request.state, options) }
  return { id: request.id, results: economize(request.state, { ...options, floor: request.floor, starts: request.starts }) }
}

self.onmessage = (event: MessageEvent<SolveRequest>) => {
  let response: SolveResponse
  try {
    response = run(event.data)
  } catch (error) {
    response = { id: event.data.id, error: error instanceof Error ? error.message : String(error) }
  }
  self.postMessage(response)
}
