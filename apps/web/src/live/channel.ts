import { envelope, GAME_ORIGINS, opened, type BridgeMessage, type PanelMessage, type Verdict, type VerifyBoard } from '../bridge/protocol.ts'
import { receive } from './store.ts'

let target: { window: Window; origin: string } | null = null
let verifyId = 0
const pending = new Map<number, (verdict: Verdict | null) => void>()

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
    if (message.type === 'verdict') pending.get(message.id)?.(message)
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

export function verify(board: VerifyBoard): Promise<Verdict | null> {
  if (!target) return Promise.resolve(null)
  const id = ++verifyId
  return new Promise(resolve => {
    const timer = window.setTimeout(() => settle(null), 4000)
    const settle = (verdict: Verdict | null) => {
      pending.delete(id)
      window.clearTimeout(timer)
      resolve(verdict)
    }
    pending.set(id, settle)
    send({ type: 'verify', id, board })
  })
}
