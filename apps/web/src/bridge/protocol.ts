import type { BuffDirection, DebuffDirection, SpecIndex, UnitType, VulnCode } from '@nimitzpf/core'
import type { ApiEffectPayload, ApiInventory, ApiOperation, ApiSpecs, ApiState } from '../live/api.ts'

export const PROTOCOL = 1
export const CHANNEL = 'nimitzpf'

export const GAME_HOSTS = ['pacificfront.worldofwarships.asia', 'pacificfront.worldofwarships.eu', 'pacificfront.worldofwarships.com'] as const
export const GAME_ORIGINS: readonly string[] = GAME_HOSTS.map(h => `https://${h}`)

export interface Route {
  readonly lang: string | null
  readonly operationId: string | null
  readonly keypointId: string | null
}

export type SyncError = 'unauth' | 'network' | 'server'

export interface Snapshot {
  readonly at: number
  readonly host: string
  readonly realm: string | null
  readonly build: string | null
  readonly settings: unknown
  readonly state: ApiState | null
  readonly operations: Readonly<Record<string, ApiOperation>>
  readonly inventory: ApiInventory | null
  readonly route: Route
  readonly error: SyncError | null
}

export interface VerifyEnemy {
  readonly code: string
  readonly type: UnitType
  readonly tier: number
  readonly specs: ApiSpecs
  readonly vulns: Readonly<Record<string, number>>
}

export interface VerifyPlayer {
  readonly code: string
  readonly type: UnitType
  readonly tier: number
  readonly specs: ApiSpecs
  readonly health: number
  readonly buffs: readonly { readonly spec: SpecIndex; readonly direction: BuffDirection; readonly value: number }[]
  readonly debuffs: readonly { readonly vuln: VulnCode; readonly direction: DebuffDirection; readonly value: number }[]
  readonly modifiers: readonly string[]
}

export interface Verdict {
  readonly ok: boolean
  readonly error: string | null
  readonly lanes: readonly (number | null)[]
}

export interface VerifyBoard {
  readonly settings: unknown
  readonly enemies: readonly (VerifyEnemy | null)[]
  readonly players: readonly (VerifyPlayer | null)[]
  readonly effects: readonly ApiEffectPayload[]
}

export type BridgeMessage =
  | { readonly type: 'hello'; readonly protocol: number; readonly host: string; readonly realm: string | null; readonly engine: string | null }
  | { readonly type: 'snapshot'; readonly snapshot: Snapshot }
  | { readonly type: 'syncing'; readonly syncing: boolean }
  | ({ readonly type: 'verdict'; readonly id: number } & Verdict)
  | { readonly type: 'layout'; readonly collapsed: boolean; readonly push: boolean }

export type PanelMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | { readonly type: 'verify'; readonly id: number; readonly board: VerifyBoard }
  | { readonly type: 'layout'; readonly collapsed?: boolean; readonly push?: boolean }

export interface Envelope<T> {
  readonly channel: typeof CHANNEL
  readonly message: T
}

export function envelope<T>(message: T): Envelope<T> {
  return { channel: CHANNEL, message }
}

export function opened<T>(data: unknown): T | null {
  if (!data || typeof data !== 'object') return null
  const e = data as Partial<Envelope<T>>
  return e.channel === CHANNEL && e.message && typeof e.message === 'object' ? e.message : null
}

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.split('/').filter(Boolean)
  const lang = parts[0] ?? null
  const at = parts.indexOf('operations')
  const operationId = at >= 0 ? (parts[at + 1] ?? null) : null
  const keypointId = at >= 0 ? (parts[at + 2] ?? new URLSearchParams(search).get('keypoint')) : null
  return { lang, operationId: operationId && decodeURIComponent(operationId), keypointId: keypointId && decodeURIComponent(keypointId) }
}
