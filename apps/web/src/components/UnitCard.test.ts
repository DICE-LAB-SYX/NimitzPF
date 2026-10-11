import { cardByCode, CARDS, CORE_SETTINGS, evaluateBoard, type EnemyUnit, type ModifierId, type PlayerUnit, type VulnCode } from '@nimitzpf/core'
import { describe, expect, it } from 'vitest'
import { vulnCodes } from '../state/model.ts'
import { cardEffects, vulnHits } from './UnitCard.tsx'

function order(code: string): string[] {
  return cardEffects(cardByCode(code)!).map(e => `${e.kind}:${e.effect.direction}`)
}

describe('card effect icons', () => {
  it('follows the official left to right order', () => {
    expect(order('card_22')).toEqual(['debuff:forward-left', 'buff:right'])
    expect(order('card_21')).toEqual(['buff:left', 'debuff:forward'])
    expect(order('card_4')).toEqual(['debuff:forward-left', 'debuff:forward-right'])
    expect(order('card_16')).toEqual(['debuff:forward', 'debuff:forward-right'])
  })

  it('keeps every buff and debuff', () => {
    for (const card of CARDS) expect(cardEffects(card)).toHaveLength(card.buffs.length + card.debuffs.length)
  })
})

describe('enemy vuln hits', () => {
  const enemy = (vulns: readonly VulnCode[]): EnemyUnit => ({ code: 'vehicle_10', type: 'coastal_artillery', tier: 3, specs: [200, 0, 0], vulns: Object.fromEntries(vulns.map(v => [v, 1])) })
  const player = (code: string, modifiers: readonly ModifierId[] = []): PlayerUnit => ({ card: cardByCode(code)!, hp: 3, modifiers })
  const hits = (players: (PlayerUnit | null)[], target: EnemyUnit, lane: number) => {
    const enemies = [null, null, null, null].map((_, i) => (i === lane ? target : null))
    const result = evaluateBoard({ player: players, enemy: enemies, conditions: [] }, CORE_SETTINGS, true)
    if (!result.ok) throw new Error('board')
    return Object.fromEntries(vulnHits(vulnCodes(target.vulns), result.lanes[lane]!.enemy))
  }

  it('lights the vuln each debuff lands on', () => {
    expect(hits([null, null, player('card_22'), null], enemy([104, 105]), 1)).toEqual({ 104: 1 })
    expect(hits([null, null, null, player('card_21')], enemy([100, 102]), 3)).toEqual({ 102: 1 })
    expect(hits([null, null, null, player('card_21')], enemy([100]), 3)).toEqual({})
  })

  it('puts a sea dog hit on the lowest vuln of the target', () => {
    expect(hits([null, null, null, player('card_21', ['sea-dog'])], enemy([105, 100]), 3)).toEqual({ 100: 1 })
    expect(hits([null, null, null, player('card_21', ['sea-dog'])], enemy([]), 3)).toEqual({})
  })

  it('shows nothing without a board result', () => {
    expect(vulnHits([104], null).size).toBe(0)
  })
})
