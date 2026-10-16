import {
  envelope,
  GAME_ORIGINS,
  opened,
  type BridgeMessage,
  type PanelMessage,
  type PlayRequest,
  type PlayResult,
  type Verdict,
  type VerifyBoard,
} from '../bridge/protocol.ts'
import { receive } from './store.ts'

let target: { window: Window; origin: string } | null = null
let messageId = 0
const verdicts = new Map<number, (verdict: Verdict | null) => void>()
const plays = new Map<number, (result: PlayResult | null) => void>()

export const PLAY_TIMEOUT_MS = 120000

export function embedded(): boolean {
  return typeof window !== 'undefined' && window.parent !== window && new URLSearchParams(window.location.search).has('embed')
}

export function send(message: PanelMessage): void {
  if (target) target.window.postMessage(envelope(message), target.origin)
}

export function connect(): void {
  const parent = window.parent
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== parent || !GAME_ORIGINS.includes(event.origin)) return
    const message = opened<BridgeMessage>(event.data)
    if (!message) return
    target = { window: parent, origin: event.origin }
    if (message.type === 'verdict') verdicts.get(message.id)?.(message)
    else if (message.type === 'played') plays.get(message.id)?.(message)
    else receive(message)
  })
  for (const origin of GAME_ORIGINS) {
    try {
      parent.postMessage(envelope<PanelMessage>({ type: 'ready' }), origin)
    } catch {
      continue
    }
  }
}

function ask<T>(pending: Map<number, (value: T | null) => void>, timeout: number, message: (id: number) => PanelMessage): Promise<T | null> {
  if (!target) return Promise.resolve(null)
  const id = ++messageId
  return new Promise(resolve => {
    const timer = window.setTimeout(() => settle(null), timeout)
    const settle = (value: T | null) => {
      pending.delete(id)
      window.clearTimeout(timer)
      resolve(value)
    }
    pending.set(id, settle)
    send(message(id))
  })
}

export function verify(board: VerifyBoard): Promise<Verdict | null> {
  return ask(verdicts, 4000, id => ({ type: 'verify', id, board }))
}

export function play(request: PlayRequest): Promise<PlayResult | null> {
  return ask(plays, PLAY_TIMEOUT_MS, id => ({ type: 'play', id, request }))
}
