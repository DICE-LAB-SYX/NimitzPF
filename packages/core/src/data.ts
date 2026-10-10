import raw from './data/game-data.json' with { type: 'json' }
import type { CardDef, CoreSettings, EnemyDef, ModifierDef, ModifierId } from './model.ts'

export interface RawGameData {
  readonly build: string
  readonly core: CoreSettings
  readonly clearThreshold: number
  readonly cards: readonly CardDef[]
  readonly enemies: readonly EnemyDef[]
  readonly modifiers: readonly ModifierDef[]
}

export const BUNDLED_DATA: RawGameData = raw as unknown as RawGameData

export let DATA_BUILD: string = BUNDLED_DATA.build
export let CORE_SETTINGS: CoreSettings = BUNDLED_DATA.core
export let CLEAR_THRESHOLD: number = BUNDLED_DATA.clearThreshold
export let CARDS: readonly CardDef[] = BUNDLED_DATA.cards
export let ENEMIES: readonly EnemyDef[] = BUNDLED_DATA.enemies
export let MODIFIERS: readonly ModifierDef[] = BUNDLED_DATA.modifiers

let cardIndex = new Map(CARDS.map(c => [c.code, c]))
let cardOrder = new Map(CARDS.map((c, i) => [c.code, i]))
let enemyIndex = new Map(ENEMIES.map(e => [e.code, e]))
let modifierIndex = new Map(MODIFIERS.map(m => [m.id, m]))

export function installGameData(data: RawGameData): void {
  DATA_BUILD = data.build
  CORE_SETTINGS = data.core
  CLEAR_THRESHOLD = data.clearThreshold
  CARDS = data.cards
  ENEMIES = data.enemies
  MODIFIERS = data.modifiers
  cardIndex = new Map(CARDS.map(c => [c.code, c]))
  cardOrder = new Map(CARDS.map((c, i) => [c.code, i]))
  enemyIndex = new Map(ENEMIES.map(e => [e.code, e]))
  modifierIndex = new Map(MODIFIERS.map(m => [m.id, m]))
}

export function cardByCode(code: string): CardDef | undefined {
  return cardIndex.get(code)
}

export function cardRank(code: string): number {
  return cardOrder.get(code) ?? CARDS.length
}

export function enemyByCode(code: string): EnemyDef | undefined {
  return enemyIndex.get(code)
}

export function modifierById(id: ModifierId): ModifierDef | undefined {
  return modifierIndex.get(id)
}

export function isBoss(enemy: { readonly tags: readonly string[] }): boolean {
  return enemy.tags.includes('epic_boss') || enemy.tags.includes('common_boss')
}

export function isFlagship(enemy: { readonly code: string; readonly tier: number }): boolean {
  if (enemy.tier >= 4) return true
  const def = enemyByCode(enemy.code)
  return def ? isBoss(def) : false
}
