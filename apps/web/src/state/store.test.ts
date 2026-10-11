import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IntelRecord } from './model.ts'

const saved = new Map<string, string>()

vi.stubGlobal('window', globalThis)
vi.stubGlobal('localStorage', {
  getItem: (name: string) => saved.get(name) ?? null,
  setItem: (name: string, value: string) => void saved.set(name, value),
  removeItem: (name: string) => void saved.delete(name),
})

async function load(state: object, version: number) {
  saved.set('nimitzpf', JSON.stringify({ state, version }))
  return (await import('./store.ts')).useStore.getState()
}

const record = (code: string, specs: [number, number, number]): IntelRecord => ({ code, tier: 2, specs, difficulty: 2, seenAt: 1 })

beforeEach(() => {
  vi.resetModules()
  saved.clear()
})

describe('persisted state migration', () => {
  it('keeps preferences and drops the manual drafts of version 6', async () => {
    const state = await load(
      {
        locale: 'en',
        objective: 'perfect',
        owned: ['card_1'],
        inventory: { teamwork: 3 },
        operations: [{ id: 'o1', stages: [] }],
        activeOperation: 'o1',
        intel: [{ code: 'vehicle_10', tier: 3, power: 187, vulns: [104], difficulty: 3, seenAt: 5 }],
        rewardWeights: { supplies: 2 },
      },
      6,
    )
    expect(state).toMatchObject({ locale: 'en', localeAuto: false, objective: 'perfect', intel: [], overrides: {} })
    expect(state.rewardWeights).toEqual({ supplies: 2, progress: 1, modifier: 1, card: 1, other: 1 })
    expect(state).not.toHaveProperty('operations')
    expect(JSON.parse(saved.get('nimitzpf')!).version).toBe(7)
  })

  it('leaves current data untouched', async () => {
    const overrides = { o1: { k1: [{ card: 'card_1', standard: null, special: null }] } }
    const state = await load({ locale: 'zh-Hant', localeAuto: false, objective: 'reward', intel: [record('vehicle_7', [50, 50, 50])], overrides }, 7)
    expect(state).toMatchObject({ locale: 'zh-Hant', objective: 'reward', overrides })
    expect(state.intel).toHaveLength(1)
  })
})

describe('preferences', () => {
  it('keeps manual placements per operation and prunes expired ones', async () => {
    const store = (await import('./store.ts')).useStore
    const placements = [{ card: 'card_7', standard: null, special: null }]
    store.getState().setPlacements('o1', 'k1', placements)
    store.getState().setPlacements('o2', 'k9', placements)
    expect(store.getState().overrides.o1?.k1).toEqual(placements)
    const before = store.getState().revision
    store.getState().clearPlacements('o1', 'k1')
    expect(store.getState().overrides.o1).toEqual({})
    expect(store.getState().revision).toBe(before + 1)
    store.getState().pruneOverrides(['o1'])
    expect(Object.keys(store.getState().overrides)).toEqual(['o1'])
  })

  it('learns intel once and keeps the newest first', async () => {
    const { mergeIntel, useStore, INTEL_LIMIT } = await import('./store.ts')
    const a = record('vehicle_7', [50, 50, 50])
    const b = record('vehicle_8', [40, 50, 60])
    useStore.getState().learn([a, b, a])
    expect(useStore.getState().intel).toEqual([a, b])
    const revision = useStore.getState().revision
    useStore.getState().learn([a])
    expect(useStore.getState().revision).toBe(revision)
    const many = Array.from({ length: INTEL_LIMIT + 5 }, (_, i) => record('vehicle_7', [i, 0, 0]))
    expect(mergeIntel([], many)).toHaveLength(INTEL_LIMIT)
  })
})
