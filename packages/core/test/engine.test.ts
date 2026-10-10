import { describe, expect, it } from 'vitest'
import fixtures from './fixtures/engine-cases.json' with { type: 'json' }
import generated from './fixtures/engine-generated.json' with { type: 'json' }
import { CORE_SETTINGS, cardByCode } from '../src/data.ts'
import { evaluateBoard, winProbability } from '../src/engine.ts'
import type { Board, Condition, EnemyUnit, ModifierId } from '../src/model.ts'
import { roundPercent, roundSpec } from '../src/rounding.ts'

interface FixturePlayer {
  card: string
  hp: number
  modifiers: ModifierId[]
}

interface FixtureLane {
  player: { specs: number[]; power: number; hp: number } | null
  enemy: { specs: number[]; power: number } | null
  percent: number | null
}

interface Fixture {
  player: (FixturePlayer | null)[]
  enemy: (EnemyUnit | null)[]
  conditions: Condition[]
  expected: { error: string | null; lanes: FixtureLane[] | null }
}

function toBoard(f: Fixture): Board {
  return {
    player: f.player.map(p => (p ? { card: cardByCode(p.card)!, hp: p.hp, modifiers: p.modifiers } : null)),
    enemy: f.enemy,
    conditions: f.conditions,
  }
}

function enemy(specs: [number, number, number], vulns: EnemyUnit['vulns'] = {}): EnemyUnit {
  return { code: 'vehicle_1', type: 'battleship', tier: 2, specs, vulns }
}

describe('rounding', () => {
  it('rounds half away from zero twice', () => {
    expect(roundSpec(67.5)).toBe(68)
    expect(roundSpec(22.5)).toBe(23)
    expect(roundSpec(10.495)).toBe(11)
    expect(roundPercent(0.525)).toBe(53)
  })
})

describe('win probability', () => {
  const sweep: [number, number][] = [
    [90, 100], [91, 95], [92, 90], [93, 86], [94, 81], [95, 76], [96, 71], [97, 67], [98, 62], [99, 57], [100, 52],
    [101, 48], [102, 43], [103, 38], [104, 33], [105, 29], [106, 24], [107, 19], [108, 14], [109, 10], [110, 5], [111, 0],
  ]
  it.each(sweep)('power 100 against %i shows %i%%', (enemyPower, percent) => {
    expect(roundPercent(winProbability(CORE_SETTINGS, 100, enemyPower))).toBe(percent)
  })
  it('floors the low end of the range at zero', () => {
    expect(winProbability(CORE_SETTINGS, 5, 3)).toBeCloseTo(13 / 16, 12)
  })
})

describe('board evaluation', () => {
  it('stacks percentage effects additively on the health-scaled spec', () => {
    const card = cardByCode('card_7')!
    const result = evaluateBoard({
      player: [{ card, hp: 1, modifiers: ['gunners-training'] }, { card: cardByCode('card_9')!, hp: 3, modifiers: [] }],
      enemy: [enemy([100, 50, 50]), enemy([50, 50, 50])],
      conditions: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const fp = Math.round(card.specs[0] * 0.8 * (1 + 0.3 + 0.2))
    expect(result.lanes[0]!.player!.specs[0]).toBe(fp)
  })

  it('applies debuffs to firepower only and only through a matching vulnerability', () => {
    const giver = cardByCode('card_5')!
    const result = evaluateBoard({
      player: [{ card: giver, hp: 3, modifiers: [] }],
      enemy: [enemy([60, 50, 50], { 105: 1 })],
      conditions: [],
    })
    expect(result.ok && result.lanes[0]!.enemy!.specs).toEqual([48, 50, 50])
    const blocked = evaluateBoard({
      player: [{ card: giver, hp: 3, modifiers: [] }],
      enemy: [enemy([60, 50, 50], { 101: 1 })],
      conditions: [],
    })
    expect(blocked.ok && blocked.lanes[0]!.enemy!.specs).toEqual([60, 50, 50])
  })

  it('rejects precision modifiers in a lane without an enemy', () => {
    const result = evaluateBoard({
      player: [{ card: cardByCode('card_7')!, hp: 3, modifiers: ['focused'] }, { card: cardByCode('card_9')!, hp: 3, modifiers: [] }],
      enemy: [null, enemy([100, 50, 50])],
      conditions: [],
    })
    expect(result).toEqual({ ok: false, error: { kind: 'modifier-needs-enemy', lane: 0, modifier: 'focused' } })
  })
})

describe.each([
  ['recorded', fixtures],
  ['generated', generated],
])('reference engine parity (%s)', (_, data) => {
  const cases = data as unknown as Fixture[]
  it(`matches ${cases.length} reference outcomes`, () => {
    let mismatches = 0
    for (const f of cases) {
      const r = evaluateBoard(toBoard(f), CORE_SETTINGS)
      const actual = r.ok
        ? {
            error: null,
            lanes: r.lanes.map(l => ({
              player: l.player ? { specs: [...l.player.specs], power: l.player.power, hp: l.player.hp } : null,
              enemy: l.enemy ? { specs: [...l.enemy.specs], power: l.enemy.power } : null,
              percent: l.percent,
            })),
          }
        : { error: r.error.kind, lanes: null }
      if (JSON.stringify(actual) !== JSON.stringify(f.expected)) mismatches++
    }
    expect(mismatches).toBe(0)
  })
})
