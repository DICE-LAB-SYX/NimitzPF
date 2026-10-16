import type { ModifierId, SpecIndex, UnitType, VulnCode } from '@nimitzpf/core'
import { CN_REALM } from '../bridge/protocol.ts'
import cnArt from './cn-art.json' with { type: 'json' }

const base = `${import.meta.env.BASE_URL}game/`

const art = (dir: 'cards' | 'enemies', code: string, realm: string | null) =>
  `${base}${realm === CN_REALM && cnArt[dir].includes(code) ? 'cn/' : ''}${dir}/${code}.webp`

export const asset = {
  card: (code: string, realm: string | null = null) => art('cards', code, realm),
  enemy: (code: string, realm: string | null = null) => art('enemies', code, realm),
  type: (type: UnitType) => `${base}types/${type}.webp`,
  spec: (index: SpecIndex) => `${base}specs/${index}.webp`,
  vuln: (code: VulnCode | 'seadog') => `${base}vulns/${code}.webp`,
  vulnRing: () => `${base}vulns/ring.webp`,
  modifier: (id: ModifierId) => `${base}modifiers/${id}.webp`,
  condition: (code: number | 'multiple') => `${base}conditions/${code}.webp`,
  marker: (kind: 'positive' | 'negative' | 'flagman', level: number) => `${base}markers/${kind}-${Math.min(3, Math.max(1, level))}.webp`,
  markerFinished: () => `${base}markers/finished.webp`,
  frame: (side: 'ally' | 'enemy' | 'collection', tier: number | 'boss') =>
    `${base}frames/${side}-${tier === 'boss' ? 'boss' : Math.min(3, Math.max(1, tier))}.webp`,
  table: () => `${base}bg/operation-table.webp`,
  reward: (kind: 'supplies' | 'progress') => `${base}rewards/${kind}.png`,
}

export const CONDITION_CODE: Readonly<Record<string, number>> = {
  'player-specs': 1,
  'player-buffs': 2,
  'player-debuffs': 3,
  'enemy-power': 4,
  'disable-modifiers': 5,
  'restrictions': 6,
}
