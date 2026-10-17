import type { BuffDirection, DebuffDirection, SpecIndex, UnitType, VulnCode } from '@nimitzpf/core'
import type { ApiEffectPayload, ApiInventory, ApiOperation, ApiSpecs, ApiState } from '../live/api.ts'

export const PROTOCOL = 3
export const LOADER = 2
const CHANNEL = 'nimitzpf'

export const GAME_HOSTS = ['pacificfront.worldofwarships.asia', 'pacificfront.worldofwarships.eu', 'pacificfront.worldofwarships.com', 'oceanfront.wowsgame.cn'] as const
export const GAME_ORIGINS: readonly string[] = GAME_HOSTS.map(h => `https://${h}`)
export const CN_REALM = 'cn360'

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

export interface PlaySlot {
  readonly cardCode: string
  readonly modifiers?: readonly string[]
}

export type PlayRequest =
  | {
      readonly kind: 'battle'
      readonly operationId: string
      readonly keypointId: string
      readonly slots: readonly (PlaySlot | null)[]
      readonly buy?: readonly string[]
    }
  | { readonly kind: 'advance'; readonly operationId: string; readonly stageId: string }

export type PlayError = 'loader' | 'busy' | 'invalid' | 'stale' | 'ui' | 'rejected' | 'aborted' | 'timeout' | 'funds'

export type DriveStep = 'open' | 'card' | 'buy' | 'modifier' | 'battle' | 'result' | 'stage' | 'aborted'

export interface PlayResult {
  readonly ok: boolean
  readonly error: PlayError | null
  readonly step: DriveStep | null
  readonly detail: string | null
}

export type BridgeMessage =
  | {
      readonly type: 'hello'
      readonly protocol: number
      readonly loader: number
      readonly script?: string | null
      readonly host: string
      readonly realm: string | null
      readonly engine: string | null
    }
  | { readonly type: 'snapshot'; readonly snapshot: Snapshot }
  | { readonly type: 'syncing'; readonly syncing: boolean }
  | ({ readonly type: 'verdict'; readonly id: number } & Verdict)
  | ({ readonly type: 'played'; readonly id: number } & PlayResult)
  | { readonly type: 'layout'; readonly collapsed: boolean; readonly push: boolean }

export type PanelMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | { readonly type: 'verify'; readonly id: number; readonly board: VerifyBoard }
  | { readonly type: 'play'; readonly id: number; readonly request: PlayRequest }
  | { readonly type: 'halt' }
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

export function loaderOf(url: string): number {
  try {
    return Number(new URL(url).searchParams.get('loader')) || 1
  } catch {
    return 1
  }
}

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.split('/').filter(Boolean)
  const lang = parts[0] ?? null
  const at = parts.indexOf('operations')
  const operationId = at >= 0 ? (parts[at + 1] ?? null) : null
  const keypointId = at >= 0 ? (parts[at + 2] ?? new URLSearchParams(search).get('keypoint')) : null
  return { lang, operationId: operationId && decodeURIComponent(operationId), keypointId: keypointId && decodeURIComponent(keypointId) }
}
