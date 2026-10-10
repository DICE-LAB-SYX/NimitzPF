import { describe, expect, it } from 'vitest'
import { CARDS, CORE_SETTINGS } from '../src/data.ts'
import { evaluateBoard } from '../src/engine.ts'
import { KeypointContext } from '../src/fast.ts'
import type { Condition, EnemyUnit, ModifierId, PlayerUnit, UnitType } from '../src/model.ts'

function mulberry32(seed: number) {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STANDARD: ModifierId[] = ['gunners-training', 'damage-control-training', 'rudder-crew-training', 'teamwork', 'effectiveness', 'moral-impact']
const SPECIAL: ModifierId[] = ['focused', 'specialization', 'sea-dog', 'fast-repair', 'unstoppable']
const TYPES: UnitType[] = ['aircraft', 'battleship', 'cruiser', 'destroyer', 'submarine']

describe('fast keypoint evaluator', () => {
  it('agrees with the reference evaluator on random boards', () => {
    const random = mulberry32(99)
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
    let compared = 0
    for (let iteration = 0; iteration < 4000; iteration++) {
      const enemies: (EnemyUnit | null)[] = []
      const players: (PlayerUnit | null)[] = []
      const used = new Set<string>()
      for (let i = 0; i < 4; i++) {
        if (random() < 0.85) {
          const total = 80 + Math.floor(random() * 160)
          const a = Math.round(total * (0.2 + random() * 0.4))
          const b = Math.round((total - a) * random())
          const vulns: Partial<Record<100 | 101 | 102 | 103 | 104 | 105, number>> = {}
          const n = Math.floor(random() * 3)
          for (let v = 0; v < n; v++) vulns[pick([100, 101, 102, 103, 104, 105] as const)] = random() < 0.2 ? 0.5 : 1
          enemies.push({ code: 'vehicle_1', type: pick(TYPES), tier: 1 + Math.floor(random() * 3), specs: [a, b, total - a - b], vulns })
        } else enemies.push(null)
        if (random() < 0.85) {
          let card = pick(CARDS)
          while (used.has(card.code)) card = pick(CARDS)
          used.add(card.code)
          const modifiers: ModifierId[] = []
          if (random() < 0.4) modifiers.push(pick(STANDARD))
          if (random() < 0.35) modifiers.push(pick(SPECIAL))
          players.push({ card, hp: 1 + Math.floor(random() * 3), modifiers })
        } else players.push(null)
      }
      if (!enemies.some(Boolean)) continue
      const conditions: Condition[] = []
      const count = random() < 0.4 ? 0 : 1 + Math.floor(random() * 3)
      for (let c = 0; c < count; c++) {
        const v = pick([-0.3, -0.2, -0.1, 0.1, 0.2])
        const exempt = random() < 0.3 ? { types: [pick(TYPES)] } : undefined
        switch (pick(['ps', 'ep', 'pb', 'pd'])) {
          case 'ps':
            conditions.push({ kind: 'player-specs', specs: random() < 0.5 ? { 0: v, 1: v, 2: v } : { 1: v }, exempt })
            break
          case 'ep':
            conditions.push({ kind: 'enemy-power', specs: { 0: v, 1: v, 2: v }, exempt })
            break
          case 'pb':
            conditions.push({ kind: 'player-buffs', multiplier: pick([0, 0.5, 1.5, 2]), exempt })
            break
          default:
            conditions.push({ kind: 'player-debuffs', multiplier: pick([0, 0.5, 1.5, 2]), exempt })
        }
      }
      const reference = evaluateBoard({ player: players, enemy: enemies, conditions }, CORE_SETTINGS)
      const ctx = new KeypointContext(enemies, conditions, CORE_SETTINGS)
      const variants = players.map(p => {
        if (!p) return null
        const std = p.modifiers.find(m => STANDARD.includes(m)) ?? null
        const spc = p.modifiers.find(m => SPECIAL.includes(m)) ?? null
        return ctx.variant(p.card, p.hp, std, spc)
      })
      const out = new Float64Array(4)
      const ok = ctx.evaluate(variants, out)
      expect(ok).toBe(reference.ok)
      if (!reference.ok) continue
      reference.lanes.forEach((lane, i) => {
        if (lane.probability === null) expect(Number.isNaN(out[i]!)).toBe(true)
        else expect(out[i]).toBe(lane.probability)
      })
      compared++
    }
    expect(compared).toBeGreaterThan(3000)
  })
})
