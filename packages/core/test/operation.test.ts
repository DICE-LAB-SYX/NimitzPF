import { describe, expect, it } from 'vitest'
import type { EnemyUnit } from '../src/model.ts'
import { effectAfterKills, fullRemovalKills, type KeypointInput, type OperationCondition } from '../src/operation.ts'

const foe: EnemyUnit = { code: 'vehicle_6', type: 'cruiser', tier: 2, specs: [60, 50, 50], vulns: {} }
const source: KeypointInput = { id: 'k1', difficulty: 2, status: 'fought', lanes: [0, 1, 2, 3].map(() => ({ enemy: foe, reward: 1 })) }

function condition(patch: Partial<OperationCondition>): OperationCondition {
  return {
    id: 'c1',
    scope: 'global',
    source: 'k1',
    targets: [],
    mitigable: false,
    effect: { kind: 'enemy-power', specs: { 0: 0.2, 1: 0.2, 2: 0.2 } },
    ...patch,
  }
}

describe('condition removal', () => {
  it('removes after the default share of kills', () => {
    const c = condition({})
    expect(effectAfterKills(c, source, 2)).toEqual(c.effect)
    expect(effectAfterKills(c, source, 3)).toBeNull()
    expect(fullRemovalKills(c, source)).toBe(3)
  })

  it('honours a custom kill count', () => {
    const c = condition({ removeAfter: 2 })
    expect(effectAfterKills(c, source, 1)).toEqual(c.effect)
    expect(effectAfterKills(c, source, 2)).toBeNull()
    expect(fullRemovalKills(c, source)).toBe(2)
  })

  it('subtracts the per-kill points from the condition value', () => {
    const c = condition({ mitigable: true, weakenPerKill: 0.04, effect: { kind: 'enemy-power', specs: { 0: 0.16, 1: 0.16, 2: 0.16 } } })
    const one = effectAfterKills(c, source, 1)
    expect(one?.kind === 'enemy-power' && one.specs[0]).toBeCloseTo(0.12, 12)
    const three = effectAfterKills(c, source, 3)
    expect(three?.kind === 'enemy-power' && three.specs[2]).toBeCloseTo(0.04, 12)
    expect(effectAfterKills(c, source, 4)).toBeNull()
    expect(fullRemovalKills(c, source)).toBe(4)
  })

  it('moves negative values and multipliers towards zero', () => {
    const specs = condition({ mitigable: true, weakenPerKill: 0.05, effect: { kind: 'player-specs', specs: { 1: -0.2 } } })
    const after = effectAfterKills(specs, source, 2)
    expect(after?.kind === 'player-specs' && after.specs[1]).toBeCloseTo(-0.1, 12)
    const buffs = condition({ mitigable: true, weakenPerKill: 0.04, effect: { kind: 'player-buffs', multiplier: 0.84 } })
    const weaker = effectAfterKills(buffs, source, 1)
    expect(weaker?.kind === 'player-buffs' && weaker.multiplier).toBeCloseTo(0.88, 12)
    expect(fullRemovalKills(buffs, source)).toBe(4)
  })

  it('drops a remainder that rounds to 0%', () => {
    const c = condition({ mitigable: true, weakenPerKill: 0.066 })
    expect(effectAfterKills(c, source, 2)).not.toBeNull()
    expect(effectAfterKills(c, source, 3)).toBeNull()
    expect(fullRemovalKills(c, source)).toBe(3)
  })

  it('splits the value evenly over the enemies when no step is given', () => {
    const c = condition({ mitigable: true })
    const after = effectAfterKills(c, source, 1)
    expect(after?.kind === 'enemy-power' && after.specs[0]).toBeCloseTo(0.15, 12)
    expect(effectAfterKills(c, source, 0)).toBe(c.effect)
    expect(fullRemovalKills(c, source)).toBe(4)
  })
})
