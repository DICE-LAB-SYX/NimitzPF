import { cardByCode, evaluateBoard, type EnemyUnit } from '@nimitzpf/core'
import { describe, expect, it } from 'vitest'
import { compare } from './verify.ts'

const enemy: EnemyUnit = { code: 'vehicle_10', type: 'destroyer', tier: 2, specs: [70, 60, 60], vulns: {} }
const evaluation = evaluateBoard({ player: [{ card: cardByCode('card_13')!, hp: 3, modifiers: [] }, null, null, null], enemy: [enemy, null, null, null], conditions: [] })
const lane = evaluation.ok ? evaluation.lanes[0]! : null

describe('official engine comparison', () => {
  it('compares against the whole percent the official engine reports', () => {
    expect(lane?.probability).not.toBe(Math.round(lane!.probability! * 100) / 100)
    expect(compare({ ok: true, error: null, lanes: [lane!.percent! / 100, null, null, null] }, evaluation)).toEqual({ kind: 'match' })
  })

  it('reports the lanes that differ', () => {
    const off = (lane!.percent! + 3) / 100
    expect(compare({ ok: true, error: null, lanes: [off, null, null, null] }, evaluation)).toEqual({
      kind: 'mismatch',
      lanes: [{ lane: 0, official: off, ours: lane!.probability }],
    })
  })

  it('treats an invalid board on both sides as agreement', () => {
    const invalid = evaluateBoard({ player: [{ card: cardByCode('card_13')!, hp: 3, modifiers: ['focused'] }, null, null, null], enemy: [null, enemy, null, null], conditions: [] })
    expect(compare({ ok: false, error: 'invalid', lanes: [null, null, null, null] }, invalid)).toEqual({ kind: 'match' })
    expect(compare({ ok: false, error: 'invalid', lanes: [null, null, null, null] }, evaluation)).toMatchObject({ kind: 'error' })
  })
})
