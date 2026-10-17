import type { ApiId, ApiOperation, ApiStage } from '../live/api.ts'
import type { PlaySlot, Snapshot } from './protocol.ts'

export const SAFE_ID = /^[\w-]{1,64}$/
const MODIFIER_ID = /^[a-z][a-z-]{0,39}$/
const HAND = 4

export function battleSlots(slots: unknown): (PlaySlot | null)[] | null {
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > HAND) return null
  const out: (PlaySlot | null)[] = []
  const cards = new Set<string>()
  for (const slot of slots as unknown[]) {
    if (slot === null) {
      out.push(null)
      continue
    }
    if (!slot || typeof slot !== 'object') return null
    const { cardCode, modifiers } = slot as Partial<PlaySlot>
    if (typeof cardCode !== 'string' || !SAFE_ID.test(cardCode) || cards.has(cardCode)) return null
    cards.add(cardCode)
    if (modifiers !== undefined) {
      if (!Array.isArray(modifiers) || modifiers.length > 2) return null
      if (!modifiers.every(m => typeof m === 'string' && MODIFIER_ID.test(m)) || new Set(modifiers).size !== modifiers.length) return null
    }
    out.push(modifiers?.length ? { cardCode, modifiers: [...modifiers] } : { cardCode })
  }
  while (out.length < HAND) out.push(null)
  return cards.size > 0 ? out : null
}

export function purchases(buy: unknown, slots: readonly (PlaySlot | null)[]): string[] | null {
  if (buy === undefined) return []
  if (!Array.isArray(buy) || buy.length > 2) return null
  const fitted = new Set(slots.flatMap(s => s?.modifiers ?? []))
  if (!buy.every(m => typeof m === 'string' && MODIFIER_ID.test(m) && fitted.has(m)) || new Set(buy).size !== buy.length) return null
  return [...(buy as string[])]
}

export function stageCleared(stage: ApiStage): boolean {
  const c = stage.condition
  if (c?.type === 'defeat_vehicles') return typeof c.target === 'number' && (c.total ?? 0) >= c.target
  return Boolean(stage.isFinished)
}

function activeStageOf(op: ApiOperation): ApiStage | null {
  return op.stages.find(s => s.isActive) ?? (op.isStarted ? null : (op.stages[0] ?? null))
}

export function openOperation(snapshot: Snapshot, operationId: string): ApiOperation | null {
  const status = snapshot.state?.status
  const op = snapshot.operations[operationId]
  if (!status || !op || op.isFinished) return null
  if (status.state === 'in_operation') return String(status.operationId) === operationId ? op : null
  if (status.state === 'unauth' || status.state === 'no_active_season') return null
  const brief = snapshot.state?.operations.find(o => String(o.id) === operationId)
  return brief?.isFinished || brief?.isAllowed === false ? null : op
}

export function playableKeypoint(snapshot: Snapshot, operationId: string, keypointId: string): ApiId | null {
  const op = openOperation(snapshot, operationId)
  const keypoint = op ? activeStageOf(op)?.keypoints?.find(k => String(k.id) === keypointId) : undefined
  return keypoint?.status === 'revealed' ? keypoint.id : null
}

export function advanceableStage(snapshot: Snapshot, operationId: string, stageId: string): boolean {
  const status = snapshot.state?.status
  const op = snapshot.operations[operationId]
  if (status?.state !== 'in_operation' || String(status.operationId) !== operationId || !op || op.isFinished) return false
  const at = op.stages.findIndex(s => s.isActive)
  const stage = op.stages[at]
  return Boolean(stage && String(stage.id) === stageId && at < op.stages.length - 1 && stageCleared(stage))
}
