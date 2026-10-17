import { CORE_SETTINGS, cardByCode, type BoardEvaluation, type KeypointInput, type Specs } from '@nimitzpf/core'
import { useEffect, useMemo, useState } from 'react'
import type { Verdict, VerifyBoard } from '../bridge/protocol.ts'
import { activePayloads, type Operation } from '../state/derive.ts'
import type { PlacementDraft } from '../state/model.ts'
import type { ApiSpecs } from './api.ts'
import { verify } from './channel.ts'
import { useLive } from './store.ts'

const VERIFY_TOLERANCE = 1e-6

function specs(s: Specs): ApiSpecs {
  return { 0: s[0], 1: s[1], 2: s[2] }
}

function verifyBoard(
  op: Operation,
  kp: KeypointInput,
  placements: readonly PlacementDraft[],
  hp: Readonly<Record<string, number>>,
  settings: unknown,
): VerifyBoard | null {
  if (!op.keypoints.get(kp.id)?.revealed || !placements.some(p => p.card)) return null
  const options = (settings as { options?: { defaultCoreSettings?: unknown } } | null)?.options
  return {
    settings: options?.defaultCoreSettings ?? CORE_SETTINGS,
    enemies: kp.lanes.map(l =>
      l ? { code: l.enemy.code, type: l.enemy.type, tier: l.enemy.tier, specs: specs(l.enemy.specs), vulns: { ...l.enemy.vulns } } : null,
    ),
    players: placements.map(p => {
      const card = p.card ? cardByCode(p.card) : undefined
      if (!card) return null
      return {
        code: card.code,
        type: card.type,
        tier: card.tier,
        specs: specs(card.specs),
        health: hp[card.code] ?? 0,
        buffs: card.buffs,
        debuffs: card.debuffs,
        modifiers: [p.standard, p.special].filter((m): m is NonNullable<typeof m> => m !== null),
      }
    }),
    effects: activePayloads(op, kp.id),
  }
}

export interface LaneCheck {
  readonly lane: number
  readonly official: number
  readonly ours: number
}

export type VerificationState =
  | { readonly kind: 'off' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'match' }
  | { readonly kind: 'mismatch'; readonly lanes: readonly LaneCheck[] }
  | { readonly kind: 'error'; readonly error: string }

export function compare(verdict: Verdict, evaluation: BoardEvaluation | null): VerificationState {
  if (!verdict.ok) return evaluation && !evaluation.ok ? { kind: 'match' } : { kind: 'error', error: verdict.error ?? 'predict-failed' }
  if (!evaluation || !evaluation.ok) return { kind: 'error', error: 'local-invalid' }
  const lanes: LaneCheck[] = []
  evaluation.lanes.forEach((l, lane) => {
    const official = verdict.lanes[lane]
    if (official === null || official === undefined || l.probability === null || l.percent === null) return
    if (Math.abs(official * 100 - l.percent) > VERIFY_TOLERANCE) lanes.push({ lane, official, ours: l.probability })
  })
  return lanes.length ? { kind: 'mismatch', lanes } : { kind: 'match' }
}

export function useVerification(
  op: Operation,
  kp: KeypointInput,
  placements: readonly PlacementDraft[],
  hp: Readonly<Record<string, number>>,
  evaluation: BoardEvaluation | null,
): VerificationState {
  const connection = useLive(s => s.connection)
  const engine = useLive(s => s.engine)
  const settings = useLive(s => s.snapshot?.settings ?? null)
  const board = useMemo(
    () => (kp.status === 'open' && connection === 'live' && engine ? verifyBoard(op, kp, placements, hp, settings) : null),
    [op, kp, placements, hp, settings, connection, engine],
  )
  const key = board ? JSON.stringify(board) : null
  const [result, setResult] = useState<{ key: string; verdict: Verdict | null } | null>(null)
  useEffect(() => {
    if (!board || !key) return
    let live = true
    void verify(board).then(verdict => {
      if (live) setResult({ key, verdict })
    })
    return () => {
      live = false
    }
  }, [key])
  if (!board) return { kind: 'off' }
  if (!result || result.key !== key) return { kind: 'checking' }
  if (!result.verdict) return { kind: 'error', error: 'timeout' }
  return compare(result.verdict, evaluation)
}
