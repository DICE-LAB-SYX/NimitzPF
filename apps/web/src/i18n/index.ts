import type { ConditionKind, ModifierId, SpecIndex, UnitType, VulnCode } from '@nimitzpf/core'
import { CN_REALM } from '../bridge/protocol.ts'
import en from './game/en.json' with { type: 'json' }
import zhHansCN from './game/zh-Hans-CN.json' with { type: 'json' }
import zhHans from './game/zh-Hans.json' with { type: 'json' }
import zhHant from './game/zh-Hant.json' with { type: 'json' }
import { UI, type UiKey } from './ui.ts'

export type Locale = 'zh-Hans' | 'zh-Hant' | 'en'
export const LOCALES: readonly Locale[] = ['zh-Hans', 'zh-Hant', 'en']
export const LOCALE_LABEL: Readonly<Record<Locale, string>> = { 'zh-Hans': '简', 'zh-Hant': '繁', en: 'EN' }

type Variant = Locale | 'zh-Hans-CN'

const GAME: Readonly<Record<Variant, Readonly<Record<string, string>>>> = { 'zh-Hans': zhHans, 'zh-Hans-CN': zhHansCN, 'zh-Hant': zhHant, en }

export type Params = Readonly<Record<string, string | number>>

function format(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`))
}

export interface Translator {
  readonly locale: Locale
  (key: UiKey, params?: Params): string
  game(key: string): string
  cardName(code: string): { unit: string; carrier: string | null }
  enemyName(code: string): string
  unitType(type: UnitType): string
  vuln(code: VulnCode): string
  spec(index: SpecIndex): string
  modifier(id: ModifierId): string
  condition(kind: ConditionKind): string
}

const CONDITION_KEY: Readonly<Record<ConditionKind, string>> = {
  'player-specs': 'IDS_APPLIED_EFFECT_MULTIPLY_PLAYER_SPECS',
  'player-buffs': 'IDS_APPLIED_EFFECT_MULTIPLY_PLAYER_BUFFS',
  'player-debuffs': 'IDS_APPLIED_EFFECT_MULTIPLY_PLAYER_DEBUFFS',
  'enemy-power': 'IDS_APPLIED_EFFECT_MULTIPLY_ENEMY_POWER',
  'disable-modifiers': 'IDS_APPLIED_EFFECT_DISABLE_ALL_MODIFIERS',
  'restrictions': 'IDS_APPLIED_EFFECTS_CATEGORY_RESTRICTED_CLASSES',
}

export function createTranslator(locale: Locale, realm: string | null = null): Translator {
  const variant: Variant = locale === 'zh-Hans' && realm === CN_REALM ? 'zh-Hans-CN' : locale
  const ui = UI[variant]
  const game = GAME[variant]
  const fallback = GAME.en
  const g = (key: string) => game[key] ?? fallback[key] ?? key
  const t = ((key: UiKey, params?: Params) => format(ui[key], params)) as Translator
  Object.assign(t, {
    locale,
    game: g,
    cardName(code: string) {
      const raw = g(`IDS_CARD_TITLE_${code.replace('card_', '')}`)
      const [unit, carrier] = raw.split('\n')
      return { unit: unit ?? raw, carrier: carrier ?? null }
    },
    enemyName(code: string) {
      return g(`IDS_ENEMY_TITLE_${code.toUpperCase()}`)
    },
    unitType(type: UnitType) {
      return g(`IDS_SHIP_TYPE_${type.toUpperCase()}`)
    },
    vuln(code: VulnCode) {
      return g(`IDS_CARD_EFFECT_VALUE_${code}`)
    },
    spec(index: SpecIndex) {
      return g(`IDS_CARD_SPEC_${index}`)
    },
    modifier(id: ModifierId) {
      return g(`IDS_MODIFIER_${id.replace(/-/g, '_').toUpperCase()}_TITLE`)
    },
    condition(kind: ConditionKind) {
      return g(CONDITION_KEY[kind])
    },
  })
  return t
}
