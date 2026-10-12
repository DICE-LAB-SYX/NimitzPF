import { describe, expect, it } from 'vitest'
import type { VerifyBoard } from './protocol.ts'
import { predict, type Adeck } from './verify.ts'

function recorder() {
  const calls: string[] = []
  let board: { Player: { Slots: unknown[] }; Enemy: { Slots: unknown[] }; Effects?: unknown[] } | null = null
  const tag = (name: string) => (...args: unknown[]) => {
    calls.push(name)
    return { name, args }
  }
  const adeck = {
    version: 'test',
    newSettings: () => ({ Base: true }),
    newBoard: (size: number) => {
      board = { Player: { Slots: new Array(size).fill(null) }, Enemy: { Slots: new Array(size).fill(null) } }
      return board
    },
    newSlot: tag('newSlot'),
    newCard: tag('newCard'),
    newHealth: tag('newHealth'),
    newFullHealth: tag('newFullHealth'),
    newEffect: tag('newEffect'),
    newBuff: tag('newBuff'),
    newRestriction: tag('newRestriction'),
    newEmptyRestriction: tag('newEmptyRestriction'),
    newMultiplyPlayerSpecsEffect: tag('specs'),
    newMultiplyPlayerBuffsEffect: tag('buffs'),
    newMultiplyPlayerDebuffsEffect: tag('debuffs'),
    newMultiplyEnemyPowerEffect: tag('enemy'),
    newDisableAllModifiersEffect: tag('disable'),
    newExtraRestrictionsEffect: tag('restrict'),
    predict: (_b: unknown, settings: Record<string, unknown>) => {
      calls.push(`predict:${JSON.stringify(settings)}`)
      return [true, '', { Predictions: { 0: 100, 1: 37.5 } }]
    },
  } as unknown as Adeck
  return { adeck, calls, board: () => board }
}

const board: VerifyBoard = {
  settings: { HandSize: 4 },
  enemies: [
    { code: 'vehicle_1', type: 'aircraft', tier: 1, specs: { 0: 10, 1: 10, 2: 10 }, vulns: {} },
    { code: 'vehicle_2', type: 'cruiser', tier: 2, specs: { 0: 50, 1: 40, 2: 30 }, vulns: { 103: 0.5 } },
    null,
    null,
  ],
  players: [
    {
      code: 'card_1',
      type: 'aircraft',
      tier: 3,
      specs: { 0: 75, 1: 30, 2: 75 },
      health: 2,
      buffs: [{ spec: 0, direction: 'left', value: 0.3 }],
      debuffs: [{ vuln: 105, direction: 'forward', value: 0.2 }],
      modifiers: ['focused'],
    },
    null,
    null,
    null,
  ],
  effects: [
    { type: 1, specs: { 0: -0.2 } },
    { type: 4, specs: { 0: 0.1 }, delta_disabled: true },
    { type: 6, restrictions: { types: ['submarine'] } },
  ],
}

describe('official engine check', () => {
  it('builds the board the way the game client does', () => {
    const r = recorder()
    const verdict = predict(r.adeck, board)
    expect(verdict.ok).toBe(true)
    expect(verdict.lanes).toEqual([1, null, null, null])
    expect(r.calls.filter(c => c === 'specs' || c === 'enemy' || c === 'restrict')).toEqual(['specs', 'restrict'])
    expect(r.calls.find(c => c.startsWith('predict:'))).toBe('predict:{"Base":true,"HandSize":4}')
    expect(r.board()!.Effects).toHaveLength(2)
    expect(r.board()!.Player.Slots[0]).toMatchObject({ name: 'newSlot', args: [expect.anything(), 'focused'] })
  })

  it('reports a missing engine instead of throwing', () => {
    expect(predict(undefined, board)).toMatchObject({ ok: false, error: 'engine-missing' })
  })
})
