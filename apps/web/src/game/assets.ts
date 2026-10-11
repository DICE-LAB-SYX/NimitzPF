import type { ModifierId, SpecIndex, UnitType, VulnCode } from '@nimitzpf/core'

const base = `${import.meta.env.BASE_URL}game/`

export const asset = {
  card: (code: string) => `${base}cards/${code}.webp`,
  enemy: (code: string) => `${base}enemies/${code}.webp`,
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
