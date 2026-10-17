import { BUNDLED_DATA, fromSettings, installGameData, modifierById, type GameSettings, type ModifierId, type RawGameData } from '@nimitzpf/core'
import { useMemo } from 'react'
import { create } from 'zustand'
import type { BridgeMessage, Route, Snapshot } from '../bridge/protocol.ts'
import type { Locale } from '../i18n/index.ts'
import type { Operation } from '../state/derive.ts'
import type { IntelRecord, RewardWeights } from '../state/model.ts'
import { autoBuying, useStore } from '../state/store.ts'
import { DEFAULT_CURRENCIES, intelFrom, toLiveOperation, type CurrencyCodes, type LiveOperation } from './adapter.ts'

export type Connection = 'waiting' | 'live' | 'unauth' | 'no-season' | 'offline' | 'demo'

export interface BridgeInfo {
  readonly protocol: number
  readonly loader: number
  readonly script?: string | null
}

interface LiveState {
  readonly connection: Connection
  readonly snapshot: Snapshot | null
  readonly syncing: boolean
  readonly engine: string | null
  readonly bridge: BridgeInfo | null
  readonly revision: number
  readonly data: RawGameData | null
  readonly layout: { readonly collapsed: boolean; readonly push: boolean } | null
  readonly broke: { readonly at: number | null } | null
}

export const useLive = create<LiveState>()(() => ({
  connection: 'waiting',
  snapshot: null,
  syncing: false,
  engine: null,
  bridge: null,
  revision: 0,
  data: null,
  layout: null,
  broke: null,
}))

const LOCALE_OF: Readonly<Record<string, Locale>> = { 'zh-cn': 'zh-Hans', 'zh-sg': 'zh-Hans', 'zh-tw': 'zh-Hant' }

export function localeOf(lang: string | null): Locale | null {
  if (!lang) return null
  return LOCALE_OF[lang.toLowerCase()] ?? 'en'
}

function connectionOf(snapshot: Snapshot): Connection {
  if (snapshot.error === 'unauth' || snapshot.state?.status.state === 'unauth') return 'unauth'
  if (snapshot.state?.status.state === 'no_active_season') return 'no-season'
  if (!snapshot.state) return snapshot.error ? 'offline' : 'waiting'
  return 'live'
}

function contentKey(s: Snapshot): string {
  return JSON.stringify([s.state?.status, s.state?.operations, s.operations, s.inventory, s.build])
}

let installed = BUNDLED_DATA.build

function liveData(snapshot: Snapshot): RawGameData | null {
  if (!snapshot.settings || !snapshot.build || snapshot.build === BUNDLED_DATA.build) {
    if (installed !== BUNDLED_DATA.build) {
      installGameData(BUNDLED_DATA)
      installed = BUNDLED_DATA.build
    }
    return null
  }
  try {
    const data = fromSettings(snapshot.settings as GameSettings, snapshot.build)
    if (installed !== data.build) {
      installGameData(data)
      installed = data.build
    }
    return data
  } catch {
    return null
  }
}

export function currencyCodes(snapshot: Snapshot | null): CurrencyCodes {
  const options = (snapshot?.settings as Partial<GameSettings> | null)?.options
  return { main: options?.mainCurrencyCode ?? DEFAULT_CURRENCIES.main, progress: options?.progressPointsCurrencyCode ?? DEFAULT_CURRENCIES.progress }
}

export function supplies(snapshot: Snapshot | null): number | null {
  const balance = snapshot?.inventory?.currencies?.[currencyCodes(snapshot).main]
  return typeof balance === 'number' && Number.isFinite(balance) ? Math.max(0, balance) : null
}

export function buyableCount(snapshot: Snapshot | null, id: ModifierId): number {
  const price = modifierById(id)?.price
  const balance = supplies(snapshot)
  if (!price || price <= 0) return 0
  return balance === null ? Infinity : Math.floor(balance / price)
}

export function isBroke(live: Pick<LiveState, 'broke' | 'snapshot'>): boolean {
  if (!live.broke) return false
  const now = supplies(live.snapshot)
  return now === null || (live.broke.at !== null && now <= live.broke.at)
}

export function markBroke(): void {
  useLive.setState(s => ({ broke: { at: supplies(s.snapshot) }, revision: s.revision + 1 }))
}

export function clearBroke(): void {
  if (useLive.getState().broke) useLive.setState(s => ({ broke: null, revision: s.revision + 1 }))
}

export function buyingNow(): boolean {
  return autoBuying(useStore.getState()) && !isBroke(useLive.getState())
}

export function useBuying(): boolean {
  const on = useStore(autoBuying)
  const broke = useLive(isBroke)
  return on && !broke
}

export function operationOrder(snapshot: Snapshot | null): string[] {
  if (!snapshot) return []
  const listed = (snapshot.state?.operations ?? []).map(o => String(o.id))
  const extra = Object.keys(snapshot.operations).filter(id => !listed.includes(id))
  return [...listed, ...extra].filter(id => id in snapshot.operations)
}

export function defaultOperation(snapshot: Snapshot | null): string | null {
  if (!snapshot) return null
  const order = operationOrder(snapshot)
  const status = snapshot.state?.status.operationId
  const candidates = [snapshot.route.operationId, status != null ? String(status) : null, ...order]
  return candidates.find(id => id !== null && id in snapshot.operations) ?? null
}

let lastKey = ''
let lastRoute: Route | null = null

function sameRoute(a: Route | null, b: Route): boolean {
  return a !== null && a.lang === b.lang && a.operationId === b.operationId && a.keypointId === b.keypointId
}

function follow(snapshot: Snapshot): void {
  const route = snapshot.route
  const prefs = useStore.getState()
  if (!sameRoute(lastRoute, route)) {
    const operation = route.operationId && route.operationId in snapshot.operations ? route.operationId : defaultOperation(snapshot)
    const keypoint = route.keypointId ?? (operation === prefs.selection.operation ? prefs.selection.keypoint : null)
    prefs.select({ operation, keypoint, lane: null })
    lastRoute = route
  } else if (!prefs.selection.operation || !(prefs.selection.operation in snapshot.operations)) {
    prefs.select({ operation: defaultOperation(snapshot), keypoint: null, lane: null })
  }
  const locale = localeOf(route.lang)
  if (prefs.localeAuto && locale && locale !== prefs.locale) prefs.setLocale(locale, true)
}

function learn(snapshot: Snapshot): void {
  const prefs = useStore.getState()
  const at = snapshot.at
  const records: IntelRecord[] = []
  for (const op of Object.values(snapshot.operations)) {
    try {
      records.push(...intelFrom(toLiveOperation(op, { inventory: null, intel: [], weights: prefs.rewardWeights }), at))
    } catch {
      continue
    }
  }
  if (records.length) prefs.learn(records)
  if (snapshot.state) prefs.pruneOverrides(Object.keys(snapshot.operations))
}

export function receiveSnapshot(snapshot: Snapshot, connection?: Connection): void {
  const data = liveData(snapshot)
  const key = contentKey(snapshot)
  const changed = key !== lastKey
  lastKey = key
  useLive.setState(s => ({
    snapshot,
    data,
    connection: connection ?? connectionOf(snapshot),
    revision: changed ? s.revision + 1 : s.revision,
  }))
  follow(snapshot)
  if (changed) learn(snapshot)
}

export function receive(message: BridgeMessage): void {
  switch (message.type) {
    case 'hello':
      useLive.setState({
        engine: message.engine,
        bridge: { protocol: message.protocol, loader: message.loader ?? 1, ...(message.script !== undefined && { script: message.script }) },
      })
      break
    case 'snapshot':
      receiveSnapshot(message.snapshot)
      break
    case 'syncing':
      useLive.setState({ syncing: message.syncing })
      break
    case 'layout':
      useLive.setState({ layout: { collapsed: message.collapsed, push: message.push } })
      break
  }
}

interface Cache {
  snapshot: Snapshot | null
  intel: readonly IntelRecord[]
  weights: RewardWeights | null
  data: RawGameData | null
  operations: ReadonlyMap<string, LiveOperation>
}

const cache: Cache = { snapshot: null, intel: [], weights: null, data: null, operations: new Map() }

export function liveOperations(snapshot: Snapshot | null, intel: readonly IntelRecord[], weights: RewardWeights, data: RawGameData | null): ReadonlyMap<string, LiveOperation> {
  if (cache.snapshot === snapshot && cache.intel === intel && cache.weights === weights && cache.data === data) return cache.operations
  const operations = new Map<string, LiveOperation>()
  if (snapshot) {
    const currencies = currencyCodes(snapshot)
    for (const id of operationOrder(snapshot)) {
      operations.set(id, toLiveOperation(snapshot.operations[id]!, { inventory: snapshot.inventory, intel, weights, currencies }))
    }
  }
  Object.assign(cache, { snapshot, intel, weights, data, operations })
  return operations
}

export function currentOperation(): Operation | null {
  const live = useLive.getState()
  const prefs = useStore.getState()
  const operations = liveOperations(live.snapshot, prefs.intel, prefs.rewardWeights, live.data)
  const id = prefs.selection.operation ?? defaultOperation(live.snapshot)
  const op = id ? operations.get(id) : undefined
  return op ? { ...op, overrides: prefs.overrides[op.id] ?? {} } : null
}

export function useRealm(): string | null {
  return useLive(s => s.snapshot?.realm ?? null)
}

export function useOperations(): ReadonlyMap<string, LiveOperation> {
  const snapshot = useLive(s => s.snapshot)
  const data = useLive(s => s.data)
  const intel = useStore(s => s.intel)
  const weights = useStore(s => s.rewardWeights)
  return liveOperations(snapshot, intel, weights, data)
}

export function useOperation(): Operation | null {
  const operations = useOperations()
  const snapshot = useLive(s => s.snapshot)
  const selected = useStore(s => s.selection.operation)
  const overrides = useStore(s => s.overrides)
  const id = selected ?? defaultOperation(snapshot)
  const op = id ? operations.get(id) : undefined
  const own = op ? overrides[op.id] : undefined
  return useMemo(() => (op ? { ...op, overrides: own ?? {} } : null), [op, own])
}
