export type SpecIndex = 0 | 1 | 2
export type Specs = readonly [number, number, number]

export type VulnCode = 100 | 101 | 102 | 103 | 104 | 105
export const VULN_CODES: readonly VulnCode[] = [100, 101, 102, 103, 104, 105]

export type UnitType =
  | 'aircraft'
  | 'battleship'
  | 'cruiser'
  | 'destroyer'
  | 'submarine'
  | 'coastal_artillery'
  | 'naval_mine'

export type BuffDirection = 'left' | 'right'
export type DebuffDirection = 'forward' | 'forward-left' | 'forward-right'

export type ModifierId =
  | 'gunners-training'
  | 'damage-control-training'
  | 'rudder-crew-training'
  | 'teamwork'
  | 'effectiveness'
  | 'moral-impact'
  | 'focused'
  | 'specialization'
  | 'sea-dog'
  | 'fast-repair'
  | 'unstoppable'

export type ModifierSlot = 1 | 2

export interface BuffDef {
  readonly spec: SpecIndex
  readonly direction: BuffDirection
  readonly value: number
}

export interface DebuffDef {
  readonly vuln: VulnCode
  readonly direction: DebuffDirection
  readonly value: number
}

export interface CardDef {
  readonly code: string
  readonly tier: number
  readonly type: UnitType
  readonly tags: readonly string[]
  readonly specs: Specs
  readonly buffs: readonly BuffDef[]
  readonly debuffs: readonly DebuffDef[]
}

export interface EnemyDef {
  readonly code: string
  readonly type: UnitType
  readonly tags: readonly string[]
}

export interface ModifierDef {
  readonly id: ModifierId
  readonly type: ModifierSlot
  readonly rarity: 'common' | 'rare'
  readonly price: number | null
}

export interface CoreSettings {
  readonly HandSize: number
  readonly MaxModifiersOnCard: number
  readonly MaxModifiersOfTypeOnCard: number
  readonly StrengthDispersionLeft: number
  readonly StrengthDispersionRight: number
  readonly StrengthDispersionAbsLeft: number
  readonly StrengthDispersionAbsRight: number
  readonly MinProbabilityOfWin: number
  readonly MaxProbabilityOfWin: number
  readonly HealthFactor: readonly number[]
}

export type Vulns = Readonly<Partial<Record<VulnCode, number>>>

export interface EnemyUnit {
  readonly code: string
  readonly type: UnitType
  readonly tier: number
  readonly specs: Specs
  readonly vulns: Vulns
}

export interface PlayerUnit {
  readonly card: CardDef
  readonly hp: number
  readonly modifiers: readonly ModifierId[]
}

export interface Restriction {
  readonly cards?: readonly string[]
  readonly types?: readonly UnitType[]
  readonly tiers?: readonly number[]
  readonly modifiers?: readonly ModifierId[]
}

export type SpecDeltas = Readonly<Partial<Record<SpecIndex, number>>>

export type Condition =
  | { readonly kind: 'player-specs'; readonly specs: SpecDeltas; readonly exempt?: Restriction }
  | { readonly kind: 'enemy-power'; readonly specs: SpecDeltas; readonly exempt?: Restriction }
  | { readonly kind: 'player-buffs'; readonly multiplier: number; readonly exempt?: Restriction }
  | { readonly kind: 'player-debuffs'; readonly multiplier: number; readonly exempt?: Restriction }
  | { readonly kind: 'disable-modifiers' }
  | { readonly kind: 'restrictions'; readonly banned: Restriction }

export type ConditionKind = Condition['kind']

export interface Board {
  readonly player: readonly (PlayerUnit | null)[]
  readonly enemy: readonly (EnemyUnit | null)[]
  readonly conditions: readonly Condition[]
}
