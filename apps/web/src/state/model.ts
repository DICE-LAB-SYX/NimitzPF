import {
  CORE_SETTINGS,
  enemyByCode,
  healthFactor,
  isFlagship,
  roundSpec,
  type CardDef,
  type EnemyUnit,
  type ModifierId,
  type Specs,
  type StageInput,
  type VulnCode,
  type Vulns,
} from '@nimitzpf/core'

export type LaneIndex = 0 | 1 | 2 | 3
export const LANES: readonly LaneIndex[] = [0, 1, 2, 3]

export type RewardKind = 'supplies' | 'progress' | 'modifier' | 'card' | 'other'

export const REWARD_KINDS: readonly RewardKind[] = ['supplies', 'progress', 'modifier', 'card', 'other']

export interface RewardDraft {
  readonly kind: RewardKind
  readonly amount: number
  readonly modifier: ModifierId | null
  readonly boostable?: boolean
}

export const BOOST: ModifierId = 'effectiveness'
const BOOST_FACTOR = 1.1

export function boostedAmount(amount: number): number {
  return Math.trunc(amount * BOOST_FACTOR)
}

export function boostTokens(rewards: readonly RewardDraft[] | null | undefined): number {
  return (rewards ?? []).reduce((n, r) => n + (r.boostable ? r.amount : 0), 0)
}

export type RewardWeights = Readonly<Record<RewardKind, number>>

export const DEFAULT_REWARD_WEIGHTS: RewardWeights = { supplies: 1, progress: 1, modifier: 1, card: 1, other: 1 }

export interface PlacementDraft {
  readonly card: string | null
  readonly standard: ModifierId | null
  readonly special: ModifierId | null
}

export interface IntelRecord {
  readonly code: string
  readonly tier: number
  readonly specs: Specs
  readonly difficulty: number
  readonly seenAt: number
}

export const ESTIMATE_CODE = 'vehicle_7'

export function stageHasFlagship(stage: Pick<StageInput, 'keypoints'>): boolean {
  return stage.keypoints.some(kp => kp.lanes.some(l => l !== null && isFlagship(l.enemy)))
}

export function handSpecs(card: CardDef, hp: number): Specs {
  if (hp <= 0) return card.specs
  const factor = healthFactor(CORE_SETTINGS, hp)
  return [roundSpec(card.specs[0] * factor), roundSpec(card.specs[1] * factor), roundSpec(card.specs[2] * factor)]
}

export function enemyPower(enemy: Pick<EnemyUnit, 'specs'>): number {
  return enemy.specs[0] + enemy.specs[1] + enemy.specs[2]
}

export function vulnCodes(vulns: Vulns): VulnCode[] {
  return (Object.keys(vulns).map(Number) as VulnCode[]).filter(v => (vulns[v] ?? 0) > 0).sort((a, b) => a - b)
}

export function intelKey(r: Pick<IntelRecord, 'code' | 'tier' | 'specs'>): string {
  return `${r.code}:${r.tier}:${r.specs.join(',')}`
}

interface EstimateProfile {
  readonly specs: Specs
  readonly tier: number
}

function split(power: number): Specs {
  const fp = Math.round(power * 0.4)
  const sv = Math.round((power - fp) / 2)
  return [fp, sv, power - fp - sv]
}

const DEFAULT_PROFILE: Readonly<Record<number, EstimateProfile>> = {
  1: { specs: split(110), tier: 1 },
  2: { specs: split(150), tier: 2 },
  3: { specs: split(190), tier: 3 },
}

export function estimateProfile(difficulty: number, intel: readonly IntelRecord[]): EstimateProfile {
  const seen = intel.filter(r => r.difficulty === difficulty && !isFlagship(r)).sort((a, b) => enemyPower(a) - enemyPower(b))
  const fallback = DEFAULT_PROFILE[difficulty] ?? DEFAULT_PROFILE[2]!
  if (seen.length < 3) return fallback
  const upper = seen[Math.min(seen.length - 1, Math.floor(seen.length * 0.75))]!
  return { specs: upper.specs, tier: Math.round(seen.reduce((n, r) => n + r.tier, 0) / seen.length) }
}

export function estimatedEnemy(difficulty: number, intel: readonly IntelRecord[]): EnemyUnit {
  const profile = estimateProfile(difficulty, intel)
  return { code: ESTIMATE_CODE, type: enemyByCode(ESTIMATE_CODE)?.type ?? 'cruiser', tier: profile.tier, specs: profile.specs, vulns: {} }
}

export function rewardValues(lanes: readonly (readonly RewardDraft[] | null)[], weights: RewardWeights, boost = false): number[] {
  const totals = new Map<RewardKind, { sum: number; count: number }>()
  for (const rewards of lanes) {
    for (const r of rewards ?? []) {
      if (r.amount <= 0) continue
      const t = totals.get(r.kind) ?? { sum: 0, count: 0 }
      t.sum += r.amount
      t.count++
      totals.set(r.kind, t)
    }
  }
  return lanes.map(rewards => {
    if (!rewards || rewards.length === 0) return 1
    return rewards.reduce((value, r) => {
      const weight = Math.max(0, weights[r.kind] ?? 1)
      const t = totals.get(r.kind)
      const amount = boost && r.boostable ? boostedAmount(r.amount) : r.amount
      const scale = t && t.sum > 0 && amount > 0 ? amount / (t.sum / t.count) : 1
      return value + weight * scale
    }, 0)
  })
}
