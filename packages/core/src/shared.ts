import type { Objective } from './planner.ts'

export const NONE = -1
export const GENE = 3

export function primaryMetrics(objective: Objective, complete: number, perfect: number, reward: number, stages: number, kills: number, out: number[] = []): number[] {
  out.length = 0
  if (objective === 'perfect') out.push(perfect, kills, complete)
  else if (objective === 'reward') out.push(reward, complete)
  else out.push(complete, stages)
  return out
}
