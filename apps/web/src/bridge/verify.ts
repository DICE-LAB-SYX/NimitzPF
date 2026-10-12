import type { ApiEffectPayload, ApiRestriction } from '../live/api.ts'
import type { Verdict, VerifyBoard } from './protocol.ts'

type Opaque = Record<string, unknown>

interface AdeckSide {
  Slots: Opaque[] | Record<number, Opaque>
}

interface AdeckBoard {
  Player: AdeckSide
  Enemy: AdeckSide
  Effects?: Opaque[]
}

export interface Adeck {
  readonly version?: string
  newSettings(): Opaque
  newBoard(size: number): AdeckBoard
  newSlot(card: Opaque, ...modifiers: string[]): Opaque
  newCard(code: string, type: string, tier: number, specs: unknown, vulns: unknown, buffs: Opaque[], health: Opaque): Opaque
  newHealth(current: number, max: number): Opaque
  newFullHealth(): Opaque
  newEffect(type: number, positive: boolean): Opaque
  newBuff(direction: string, effect: Opaque): Opaque
  newRestriction(cards: readonly string[], types: readonly string[], tiers: readonly number[], modifiers: readonly string[], deltaDisabled: boolean): Opaque
  newEmptyRestriction(): Opaque
  newMultiplyPlayerSpecsEffect(specs: unknown, delta: unknown, restriction: Opaque): Opaque
  newMultiplyPlayerBuffsEffect(multiplier: number, delta: number, restriction: Opaque): Opaque
  newMultiplyPlayerDebuffsEffect(multiplier: number, delta: number, restriction: Opaque): Opaque
  newMultiplyEnemyPowerEffect(specs: unknown, delta: unknown, restriction: Opaque): Opaque
  newDisableAllModifiersEffect(deltaDisabled: boolean): Opaque
  newExtraRestrictionsEffect(restriction: Opaque, deltaDisabled: boolean): Opaque
  predict(board: AdeckBoard, settings: Opaque): [boolean, string, { Predictions?: Record<number, number> | number[] } | null]
}

function restriction(a: Adeck, r: ApiRestriction | null | undefined): Opaque {
  return r ? a.newRestriction(r.cards ?? [], r.types ?? [], r.tier ?? [], r.modifiers ?? [], false) : a.newEmptyRestriction()
}

function effect(a: Adeck, p: ApiEffectPayload): Opaque | null {
  if (p.delta_disabled) return null
  const applies = restriction(a, p.apply_restrictions)
  switch (p.type) {
    case 1:
      return a.newMultiplyPlayerSpecsEffect(p.specs ?? {}, p.delta_specs ?? {}, applies)
    case 2:
      return a.newMultiplyPlayerBuffsEffect(p.multiplier ?? 1, p.delta_multiplier ?? 0, applies)
    case 3:
      return a.newMultiplyPlayerDebuffsEffect(p.multiplier ?? 1, p.delta_multiplier ?? 0, applies)
    case 4:
      return a.newMultiplyEnemyPowerEffect(p.specs ?? {}, p.delta_specs ?? {}, applies)
    case 5:
      return a.newDisableAllModifiersEffect(false)
    case 6:
      return a.newExtraRestrictionsEffect(restriction(a, p.restrictions), false)
    default:
      return null
  }
}

export function predict(a: Adeck | undefined, board: VerifyBoard): Verdict {
  const size = Math.max(board.enemies.length, board.players.length)
  const empty = Array.from({ length: size }, () => null)
  if (!a || typeof a.predict !== 'function') return { ok: false, error: 'engine-missing', lanes: empty }
  try {
    const settings = { ...a.newSettings(), ...(board.settings as Opaque | null) }
    const b = a.newBoard(size)
    const enemySlots = b.Enemy.Slots as Opaque[]
    const playerSlots = b.Player.Slots as Opaque[]
    board.enemies.forEach((e, i) => {
      if (!e) return
      enemySlots[i] = a.newSlot(a.newCard(e.code, e.type, e.tier, e.specs, e.vulns, [], a.newFullHealth()))
    })
    board.players.forEach((p, i) => {
      if (!p) return
      const buffs: Opaque[] = []
      for (const d of p.debuffs) {
        const e = a.newEffect(d.vuln, false)
        e.Relative = { 0: d.value }
        buffs.push(a.newBuff(d.direction, e))
      }
      for (const x of p.buffs) {
        const e = a.newEffect(0, true)
        e.Relative = { [x.spec]: x.value }
        buffs.push(a.newBuff(x.direction, e))
      }
      const card = a.newCard(p.code, p.type, p.tier, p.specs, {}, buffs, a.newHealth(p.health || 0, 3))
      playerSlots[i] = a.newSlot(card, ...p.modifiers)
    })
    const effects = board.effects.map(p => effect(a, p)).filter((e): e is Opaque => e !== null)
    if (effects.length > 0) b.Effects = effects
    const [ok, error, state] = a.predict(b, settings)
    const predictions = state?.Predictions
    const lanes = empty.map((_, i) => {
      const v = predictions?.[i]
      return typeof v === 'number' && board.enemies[i] && board.players[i] ? v / 100 : null
    })
    return { ok, error: ok ? null : error || 'predict-failed', lanes }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), lanes: empty }
  }
}
