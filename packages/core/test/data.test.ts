import { afterEach, describe, expect, it } from 'vitest'
import settings from './fixtures/settings.json' with { type: 'json' }
import {
  BUNDLED_DATA,
  CARDS,
  CLEAR_THRESHOLD,
  CORE_SETTINGS,
  DATA_BUILD,
  cardByCode,
  cardRank,
  installGameData,
  type RawGameData,
} from '../src/data.ts'
import type { EnemyUnit } from '../src/model.ts'
import { removalKills, type KeypointInput, type OperationState } from '../src/operation.ts'
import { solveOperation } from '../src/planner.ts'
import { fromSettings, type GameSettings } from '../src/settings.ts'

function foe(power: number): EnemyUnit {
  return { code: 'vehicle_9', type: 'cruiser', tier: 2, specs: [power, 0, 0], vulns: {} }
}

function single(card: string, enemies: EnemyUnit[]): OperationState {
  const kp: KeypointInput = { id: 'k', difficulty: 2, status: 'open', lanes: enemies.map(e => ({ enemy: e, reward: 1 })) }
  return {
    stages: [{ id: 's', goal: enemies.length, keypoints: [kp] }],
    currentStage: 0,
    conditions: [],
    fleet: [{ card, hp: 3 }],
    inventory: {},
  }
}

afterEach(() => installGameData(BUNDLED_DATA))

describe('game data', () => {
  it('maps the official settings onto the bundled catalog', () => {
    expect(fromSettings(settings as unknown as GameSettings, BUNDLED_DATA.build)).toEqual(BUNDLED_DATA)
  })

  it('swaps every catalog binding when live data is installed', () => {
    const base = cardByCode('card_1')!
    const extra = { ...base, code: 'card_99', specs: [500, 500, 500] as const }
    const live: RawGameData = {
      ...BUNDLED_DATA,
      build: 'live',
      clearThreshold: 0.5,
      core: { ...BUNDLED_DATA.core, HandSize: 4 },
      cards: [...BUNDLED_DATA.cards, extra],
    }
    installGameData(live)
    expect(DATA_BUILD).toBe('live')
    expect(CLEAR_THRESHOLD).toBe(0.5)
    expect(CORE_SETTINGS).toBe(live.core)
    expect(CARDS).toHaveLength(BUNDLED_DATA.cards.length + 1)
    expect(cardByCode('card_99')).toBe(extra)
    expect(cardRank('card_99')).toBe(BUNDLED_DATA.cards.length)
    const kp: KeypointInput = { id: 'k', difficulty: 2, status: 'open', lanes: [foe(1), foe(1), foe(1), foe(1)].map(e => ({ enemy: e, reward: 1 })) }
    expect(removalKills(kp)).toBe(2)
  })

  it('lets the planner use cards that only exist in installed data', () => {
    const state = single('card_99', [foe(400)])
    expect(solveOperation(state, { timeBudgetMs: 50 }).stages[0]!.keypoints[0]!.lanes.some(l => l.card)).toBe(false)
    const base = cardByCode('card_1')!
    installGameData({ ...BUNDLED_DATA, build: 'live', cards: [...BUNDLED_DATA.cards, { ...base, code: 'card_99', specs: [500, 500, 500] }] })
    const lanes = solveOperation(state, { timeBudgetMs: 50 }).stages[0]!.keypoints[0]!.lanes
    expect(lanes.find(l => l.card === 'card_99')?.probability).toBe(1)
  })
})
