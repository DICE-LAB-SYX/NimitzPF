import type { Objective } from './planner.ts'

export const NONE = -1
export const GENE = 3

export function primaryMetrics(objective: Objective, complete: number, perfect: number, reward: number, stages: number, out: number[] = []): number[] {
  out[0] = objective === 'perfect' ? perfect : objective === 'reward' ? reward : complete
  out[1] = objective === 'complete' ? stages : complete
  return out
}
