import { cardByCode, evaluateBoard, isFlagship, type EnemyUnit, type ModifierId, type PlayerUnit, type VulnCode } from '@nimitzpf/core'
import { describe, expect, it } from 'vitest'
import { enemyPower, estimateProfile, estimatedEnemy, handSpecs, rewardValues, stageHasFlagship, vulnCodes, type IntelRecord } from './model.ts'

function enemy(code: string, tier: number, power: number, vulns: readonly VulnCode[]): EnemyUnit {
  return { code, type: 'destroyer', tier, specs: [power, 0, 0], vulns: Object.fromEntries(vulns.map(v => [v, 1])) }
}

function player(code: string, hp: number, modifiers: readonly ModifierId[]): PlayerUnit {
  return { card: cardByCode(code)!, hp, modifiers }
}

const fubuki = enemy('vehicle_10', 3, 187, [104, 105])
const flagship = enemy('vehicle_10', 4, 220, [104, 105])
const zero = enemy('vehicle_3', 3, 199, [100])
const kate = enemy('vehicle_2', 3, 183, [100, 102])

describe('hand cards', () => {
  it('shows the specs the official hand shows for each hit point', () => {
    expect(handSpecs(cardByCode('card_13')!, 2)).toEqual([59, 59, 45])
    expect(handSpecs(cardByCode('card_21')!, 2)).toEqual([50, 54, 59])
    expect(handSpecs(cardByCode('card_22')!, 2)).toEqual([45, 54, 63])
    expect(handSpecs(cardByCode('card_7')!, 1)).toEqual([64, 64, 32])
    expect(handSpecs(cardByCode('card_13')!, 3)).toEqual([65, 65, 50])
    expect(handSpecs(cardByCode('card_13')!, 0)).toEqual([65, 65, 50])
  })

  it('matches the board engine without effects', () => {
    for (const hp of [1, 2, 3]) {
      const result = evaluateBoard({ player: [player('card_7', hp, []), null, null, null], enemy: [zero, null, null, null], conditions: [] })
      expect(result.ok && result.lanes[0]!.player!.specs).toEqual(handSpecs(cardByCode('card_7')!, hp))
    }
  })
})

describe('enemy units', () => {
  it('reproduces the official board readout', () => {
    const result = evaluateBoard({
      player: [
        player('card_3', 3, ['focused']),
        player('card_13', 2, ['focused']),
        player('card_22', 2, ['rudder-crew-training', 'fast-repair']),
        player('card_21', 2, []),
      ],
      enemy: [fubuki, flagship, zero, kate],
      conditions: [],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lanes.map(l => l.enemy?.power)).toEqual([187, 176, 199, 146])
    expect(result.lanes.map(l => l.player?.specs)).toEqual([
      [84, 35, 84],
      [82, 82, 63],
      [50, 78, 84],
      [50, 70, 59],
    ])
  })

  it('reads power and vulnerabilities from the live unit', () => {
    const live: EnemyUnit = { code: 'vehicle_10', type: 'destroyer', tier: 2, specs: [55, 45, 50], vulns: { 104: 1, 101: 0.5, 100: 0 } }
    expect(enemyPower(live)).toBe(150)
    expect(vulnCodes(live.vulns)).toEqual([101, 104])
  })
})

describe('flagships', () => {
  it('marks tier 4 and boss units as primary targets', () => {
    expect(isFlagship(flagship)).toBe(true)
    expect(isFlagship(enemy('boss_3', 3, 300, []))).toBe(true)
    expect(isFlagship(fubuki)).toBe(false)
  })

  it('finds a flagship anywhere in the stage', () => {
    const lanes = (...enemies: (EnemyUnit | null)[]) => ({ lanes: enemies.map(e => (e ? { enemy: e, reward: 1 } : null)) })
    expect(stageHasFlagship({ keypoints: [{ id: 'a', difficulty: 3, status: 'open', ...lanes(fubuki, null, zero, kate) }] })).toBe(false)
    expect(stageHasFlagship({ keypoints: [{ id: 'b', difficulty: 3, status: 'open', ...lanes(null, flagship, null, null) }] })).toBe(true)
  })
})

describe('estimates for unrevealed key points', () => {
  const record = (code: string, tier: number, specs: [number, number, number], seenAt: number): IntelRecord => ({ code, tier, specs, difficulty: 3, seenAt })

  it('keeps flagships out and takes the upper quartile of what was seen', () => {
    const intel = [
      record('vehicle_10', 4, [100, 60, 60], 0),
      record('boss_3', 3, [120, 80, 60], 1),
      record('vehicle_10', 3, [70, 60, 57], 2),
      record('vehicle_3', 3, [80, 60, 59], 3),
      record('vehicle_2', 3, [60, 60, 63], 4),
      record('vehicle_5', 3, [90, 60, 55], 5),
    ]
    const profile = estimateProfile(3, intel)
    expect(profile).toEqual({ specs: [90, 60, 55], tier: 3 })
    expect(isFlagship({ code: estimatedEnemy(3, intel).code, tier: profile.tier })).toBe(false)
  })

  it('falls back to a default profile with little intel', () => {
    expect(enemyPower({ specs: estimateProfile(2, []).specs })).toBe(150)
  })
})

describe('reward values', () => {
  it('weights each lane by kind and scales by amount within the kind', () => {
    const supplies = (amount: number) => [{ kind: 'supplies' as const, amount, modifier: null }]
    const values = rewardValues([supplies(20), supplies(60), null, [{ kind: 'modifier', amount: 1, modifier: 'teamwork' }]], {
      supplies: 1,
      progress: 1,
      modifier: 2,
      card: 1,
      other: 1,
    })
    expect(values).toEqual([0.5, 1.5, 1, 2])
  })
})
