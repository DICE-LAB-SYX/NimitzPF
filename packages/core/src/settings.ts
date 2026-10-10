import type { RawGameData } from './data.ts'
import type { BuffDirection, CoreSettings, DebuffDirection, ModifierId, SpecIndex, UnitType, VulnCode } from './model.ts'

export interface GameSettingsCard {
  readonly code: string
  readonly tier: number
  readonly type: UnitType
  readonly tags: readonly string[]
  readonly specs: Readonly<Record<SpecIndex, number>>
  readonly buffs: readonly { readonly spec: SpecIndex; readonly direction: BuffDirection; readonly value: number }[]
  readonly debuffs: readonly { readonly vuln: VulnCode; readonly direction: DebuffDirection; readonly value: number }[]
}

export interface GameSettingsPrice {
  readonly type: string
  readonly code?: string
  readonly amount: number
}

export interface GameSettings {
  readonly options: {
    readonly defaultCoreSettings: CoreSettings
    readonly appliedEffectsCancelableClearThreshold: number
    readonly mainCurrencyCode?: string
    readonly progressPointsCurrencyCode?: string
  }
  readonly collection: {
    readonly cards: readonly GameSettingsCard[]
    readonly enemies: readonly { readonly code: string; readonly type: UnitType; readonly tags: readonly string[] }[]
    readonly modifiers: readonly {
      readonly id: ModifierId
      readonly type: 1 | 2
      readonly rarity: 'common' | 'rare'
      readonly price: readonly GameSettingsPrice[] | null
    }[]
  }
}

export function fromSettings(settings: GameSettings, build: string): RawGameData {
  const collection = settings.collection
  return {
    build,
    core: settings.options.defaultCoreSettings,
    clearThreshold: settings.options.appliedEffectsCancelableClearThreshold,
    cards: collection.cards.map(c => ({
      code: c.code,
      tier: c.tier,
      type: c.type,
      tags: c.tags,
      specs: [c.specs[0], c.specs[1], c.specs[2]],
      buffs: c.buffs.map(b => ({ spec: b.spec, direction: b.direction, value: b.value })),
      debuffs: c.debuffs.map(d => ({ vuln: d.vuln, direction: d.direction, value: d.value })),
    })),
    enemies: collection.enemies.map(e => ({ code: e.code, type: e.type, tags: e.tags })),
    modifiers: collection.modifiers.map(m => ({
      id: m.id,
      type: m.type,
      rarity: m.rarity,
      price: m.price ? (m.price.find(p => p.type === 'currency')?.amount ?? null) : null,
    })),
  }
}
