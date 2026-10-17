import type { Objective } from '@nimitzpf/core'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Locale } from '../i18n/index.ts'
import type { Overrides } from './derive.ts'
import { DEFAULT_REWARD_WEIGHTS, intelKey, type IntelRecord, type LaneIndex, type PlacementDraft, type RewardKind, type RewardWeights } from './model.ts'

export interface Selection {
  readonly operation: string | null
  readonly keypoint: string | null
  readonly lane: LaneIndex | null
}

interface PersistedState {
  readonly locale: Locale
  readonly localeAuto: boolean
  readonly objective: Objective
  readonly rewardWeights: RewardWeights
  readonly intel: readonly IntelRecord[]
  readonly overrides: Readonly<Record<string, Overrides>>
  readonly autoplay: boolean
  readonly updateDismissed: number
  readonly effectiveness: boolean
  readonly autoBuy: boolean
}

interface TransientState {
  readonly selection: Selection
  readonly revision: number
}

interface Actions {
  setLocale(locale: Locale, auto?: boolean): void
  setObjective(objective: Objective): void
  select(selection: Partial<Selection>): void
  setPlacements(operation: string, keypoint: string, placements: readonly PlacementDraft[]): void
  clearPlacements(operation: string, keypoint: string): void
  pruneOverrides(operations: readonly string[]): void
  learn(records: readonly IntelRecord[]): void
  clearIntel(): void
  setRewardWeight(kind: RewardKind, weight: number): void
  setAutoplay(on: boolean): void
  dismissUpdate(loader: number): void
  setEffectiveness(on: boolean): void
  setAutoBuy(on: boolean): void
}

type AppState = PersistedState & TransientState & Actions

export const INTEL_LIMIT = 400

export function autoBuying(s: Pick<PersistedState, 'autoplay' | 'effectiveness' | 'autoBuy'>): boolean {
  return s.autoplay && s.effectiveness && s.autoBuy
}

export function mergeIntel(intel: readonly IntelRecord[], records: readonly IntelRecord[]): readonly IntelRecord[] | null {
  const known = new Set(intel.map(intelKey))
  const fresh: IntelRecord[] = []
  for (const r of records) {
    const key = intelKey(r)
    if (known.has(key)) continue
    known.add(key)
    fresh.push(r)
  }
  return fresh.length ? [...fresh, ...intel].slice(0, INTEL_LIMIT) : null
}

function validIntel(value: unknown): value is IntelRecord {
  const r = value as Partial<IntelRecord> | null
  return Boolean(r && typeof r.code === 'string' && Array.isArray(r.specs) && r.specs.length === 3 && typeof r.tier === 'number')
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => {
      const bump = (patch: Partial<AppState>) => set(s => ({ ...patch, revision: s.revision + 1 }))
      const patchOverrides = (operation: string, keypoint: string, placements: readonly PlacementDraft[] | null) => {
        const current = { ...(get().overrides[operation] ?? {}) }
        if (placements) current[keypoint] = [...placements]
        else delete current[keypoint]
        bump({ overrides: { ...get().overrides, [operation]: current } })
      }
      return {
        locale: 'zh-Hans',
        localeAuto: true,
        objective: 'complete',
        rewardWeights: DEFAULT_REWARD_WEIGHTS,
        intel: [],
        overrides: {},
        autoplay: false,
        updateDismissed: 0,
        effectiveness: false,
        autoBuy: false,
        selection: { operation: null, keypoint: null, lane: null },
        revision: 0,

        setLocale: (locale, auto = false) => set({ locale, localeAuto: auto }),
        setObjective: objective => bump({ objective }),
        select: selection => set(s => ({ selection: { ...s.selection, ...selection } })),
        setPlacements: (operation, keypoint, placements) => patchOverrides(operation, keypoint, placements),
        clearPlacements: (operation, keypoint) => patchOverrides(operation, keypoint, null),
        pruneOverrides: operations => {
          const keep = new Set(operations)
          const current = get().overrides
          if (Object.keys(current).every(id => keep.has(id))) return
          set({ overrides: Object.fromEntries(Object.entries(current).filter(([id]) => keep.has(id))) })
        },
        learn: records => {
          const next = mergeIntel(get().intel, records)
          if (next) bump({ intel: next })
        },
        clearIntel: () => bump({ intel: [] }),
        setRewardWeight: (kind, weight) =>
          bump({ rewardWeights: { ...get().rewardWeights, [kind]: Math.max(0, Math.min(10, Math.round(weight * 10) / 10)) } }),
        setAutoplay: on => bump({ autoplay: on }),
        dismissUpdate: loader => set({ updateDismissed: loader }),
        setEffectiveness: on => bump({ effectiveness: on }),
        setAutoBuy: on => bump({ autoBuy: on }),
      }
    },
    {
      name: 'nimitzpf',
      version: 10,
      migrate: (persisted, version) => {
        const raw = (persisted ?? {}) as Partial<PersistedState>
        const boost = { effectiveness: false, autoBuy: false }
        if (version >= 10) return raw as never
        if (version === 9) return { ...raw, ...boost } as never
        if (version === 8) return { ...raw, updateDismissed: 0, ...boost } as never
        if (version === 7) return { ...raw, autoplay: false, updateDismissed: 0, ...boost } as never
        return {
          ...(raw.locale && { locale: raw.locale, localeAuto: false }),
          ...(raw.objective && { objective: raw.objective }),
          ...(raw.rewardWeights && { rewardWeights: { ...DEFAULT_REWARD_WEIGHTS, ...raw.rewardWeights } }),
          intel: (raw.intel ?? []).filter(validIntel),
          overrides: {},
        } as never
      },
      partialize: s => ({
        locale: s.locale,
        localeAuto: s.localeAuto,
        objective: s.objective,
        rewardWeights: s.rewardWeights,
        intel: s.intel,
        overrides: s.overrides,
        autoplay: s.autoplay,
        updateDismissed: s.updateDismissed,
        effectiveness: s.effectiveness,
        autoBuy: s.autoBuy,
      }),
    },
  ),
)
