import type { ModifierId, UnitType } from '@nimitzpf/core'

export type ApiId = string | number

export interface ApiStatus {
  readonly state: string
  readonly operationId: ApiId | null
  readonly stageId: ApiId | null
  readonly onboardingStep?: number
  readonly isOperationReadyToComplete?: boolean
  readonly isStaff?: boolean
  readonly accountId: ApiId | null
  readonly accountNickname: string | null
}

export interface ApiReward {
  readonly type: string
  readonly code: string
  readonly amount: number
  readonly boostable?: boolean
}

export interface ApiBoss {
  readonly code: string
  readonly tags?: readonly string[]
}

export interface ApiOperationBrief {
  readonly id: ApiId
  readonly name: string
  readonly tags?: readonly string[]
  readonly isFinished?: boolean
  readonly isAllowed?: boolean
  readonly expireAt?: number
  readonly bosses?: readonly ApiBoss[]
  readonly rewards?: readonly ApiReward[]
}

export interface ApiState {
  readonly timestamp?: number
  readonly status: ApiStatus
  readonly progress?: { readonly progressPoints: number; readonly spentProgressPoints: number } | null
  readonly operations: readonly ApiOperationBrief[]
}

export type ApiSpecs = Readonly<Partial<Record<'0' | '1' | '2', number>>>

export interface ApiEnemy {
  readonly code: string
  readonly type: UnitType
  readonly tier: number
  readonly specs?: ApiSpecs
  readonly vulns?: Readonly<Record<string, number>>
  readonly tags?: readonly string[]
}

export interface ApiAlly {
  readonly code: string
  readonly health?: number
  readonly modifiers?: readonly ModifierId[]
}

export interface ApiSlot {
  readonly enemy?: ApiEnemy | null
  readonly ally?: ApiAlly | null
  readonly outcome?: 'win' | 'lose' | null
  readonly rewards?: readonly ApiReward[]
}

export interface ApiKeypoint {
  readonly id: ApiId
  readonly name?: string
  readonly status: string
  readonly tags?: readonly string[]
  readonly position?: readonly number[]
  readonly restrictions?: ApiRestriction | null
  readonly slots?: Readonly<Record<string, ApiSlot | null>> | null
}

export interface ApiStageCondition {
  readonly type: string
  readonly target?: number
  readonly total?: number
}

export interface ApiStage {
  readonly id: ApiId
  readonly isActive?: boolean
  readonly isFinished?: boolean
  readonly isRevealed?: boolean
  readonly condition?: ApiStageCondition | null
  readonly keypoints?: readonly ApiKeypoint[]
}

export interface ApiRestriction {
  readonly cards?: readonly string[]
  readonly types?: readonly UnitType[]
  readonly tier?: readonly number[]
  readonly modifiers?: readonly ModifierId[]
}

export type ApiEffectType = 1 | 2 | 3 | 4 | 5 | 6

export interface ApiEffectPayload {
  readonly type: ApiEffectType
  readonly specs?: ApiSpecs
  readonly delta_specs?: ApiSpecs
  readonly multiplier?: number
  readonly delta_multiplier?: number
  readonly delta_disabled?: boolean
  readonly apply_restrictions?: ApiRestriction | null
  readonly restrictions?: ApiRestriction | null
}

export interface ApiEffect {
  readonly source?: ApiId | null
  readonly applyTo?: readonly ApiId[] | null
  readonly isSubsequent?: boolean
  readonly isMitigable?: boolean
  readonly payload: ApiEffectPayload
}

export interface ApiOperation {
  readonly id: ApiId
  readonly name: string
  readonly tags?: readonly string[]
  readonly isStarted?: boolean
  readonly isFinished?: boolean
  readonly expireAt?: number
  readonly stages: readonly ApiStage[]
  readonly effects?: readonly ApiEffect[]
  readonly bosses?: readonly ApiBoss[]
  readonly totalDefeatedVehicles?: number
  readonly finishCondition?: ApiFinishCondition | null
}

export interface ApiFinishCondition {
  readonly clearStages?: boolean
  readonly defeatBoss?: boolean
  readonly defeatEpicBoss?: boolean
  readonly lastStageDefeatTarget?: number
}

export interface ApiInventory {
  readonly cards?: readonly { readonly code: string; readonly health: number; readonly isPlayed?: boolean }[]
  readonly modifiers?: readonly { readonly id: ModifierId; readonly amount: number }[]
  readonly currencies?: Readonly<Record<string, number>>
}
