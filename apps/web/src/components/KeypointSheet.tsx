import { cardByCode, collectRestrictions, modifierById, roundPercent, type BoardEvaluation, type Condition, type KeypointInput, type ModifierId } from '@nimitzpf/core'
import { useMemo, useRef, useState } from 'react'
import type { LiveKeypoint } from '../live/adapter.ts'
import { useLive, useOperation } from '../live/store.ts'
import { useT } from '../i18n/useT.ts'
import { usePlanFor } from '../solver/plan.ts'
import {
  activeConditions,
  canAttach,
  conditionViews,
  EMPTY_PLACEMENT,
  EMPTY_PLACEMENTS,
  evaluatePlacements,
  locate,
  plannedKeypoint,
  recommendedPlacements,
  recordHp,
  recordPlacements,
  stageUsage,
  sweptConditions,
  type Operation,
} from '../state/derive.ts'
import { LANES, type LaneIndex, type PlacementDraft } from '../state/model.ts'
import { useStore } from '../state/store.ts'
import { Button, cx, Odds, Stars } from '../ui/primitives.tsx'
import { Icon } from '../ui/Icon.tsx'
import { useSize } from '../ui/useSize.ts'
import { ConditionsPanel, keypointName } from './ConditionsPanel.tsx'
import css from './KeypointSheet.module.css'
import { SlotDialog } from './SlotDialog.tsx'
import { AllyCard, EnemyCard } from './UnitCard.tsx'

export interface KeypointContext {
  readonly op: Operation
  readonly kp: KeypointInput
  readonly meta: LiveKeypoint
  readonly stage: number
  readonly index: number
  readonly placements: readonly PlacementDraft[]
  readonly manual: boolean
  readonly hp: Readonly<Record<string, number>>
  readonly conditions: readonly Condition[]
  readonly evaluation: BoardEvaluation | null
  readonly pending: PendingOdds | null
}

export interface PendingOdds {
  readonly sources: readonly string[]
  readonly other: BoardEvaluation | null
}

function defaultKeypoint(op: Operation): string | null {
  const stage = op.state.stages[op.state.currentStage]
  const open = stage?.keypoints.find(k => k.status === 'open' && op.keypoints.get(k.id)?.revealed)
  return open?.id ?? stage?.keypoints[0]?.id ?? null
}

export function useKeypointContext(): KeypointContext | null {
  const op = useOperation()
  const selected = useStore(s => s.selection.keypoint)
  const plan = usePlanFor(op?.id)
  return useMemo(() => {
    if (!op) return null
    const at = locate(op, selected) ?? locate(op, defaultKeypoint(op))
    const meta = at && op.keypoints.get(at.kp.id)
    if (!at || !meta) return null
    const { kp, stage, index } = at
    const active = activeConditions(conditionViews(op, kp.id))
    const swept = sweptConditions(op, plan, kp.id)
    const conditions = swept ? swept.conditions : active
    const fought = kp.status === 'fought'
    const override = op.overrides[kp.id]
    const placements = fought ? (recordPlacements(kp) ?? EMPTY_PLACEMENTS) : (override ?? recommendedPlacements(plan, kp.id) ?? EMPTY_PLACEMENTS)
    let hp: Record<string, number> = { ...op.hp }
    if (fought) hp = recordHp(op, kp)
    else if (plan && stage > op.state.currentStage) {
      for (const [code, series] of Object.entries(plan.fleetHp)) {
        const v = series[stage - op.state.currentStage]
        if (v !== undefined) hp[code] = v
      }
    }
    const evaluation = meta.revealed ? evaluatePlacements(kp, placements, conditions, hp) : null
    const pending = swept && meta.revealed ? { sources: swept.sources, other: evaluatePlacements(kp, placements, active, hp) } : null
    return { op, kp, meta, stage, index, placements, manual: Boolean(override), hp, conditions, evaluation, pending }
  }, [op, selected, plan])
}

function laneGeometry(lane: number) {
  return 12.5 + lane * 25
}

function ArrowLayer({ evaluation }: { evaluation: BoardEvaluation | null }) {
  if (!evaluation || !evaluation.ok) return null
  const arrows: { from: number; to: number; kind: 'buff' | 'debuff' }[] = []
  evaluation.lanes.forEach((lane, target) => {
    for (const c of lane.enemy?.contributions ?? []) {
      if (c.source.kind === 'debuff') arrows.push({ from: c.source.from, to: target, kind: 'debuff' })
    }
    for (const c of lane.player?.contributions ?? []) {
      if (c.source.kind === 'buff') arrows.push({ from: c.source.from, to: target, kind: 'buff' })
    }
  })
  return (
    <svg className={css.arrows} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="debuffHead" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="#d8402b" />
        </marker>
        <marker id="buffHead" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="#58b368" />
        </marker>
      </defs>
      {arrows.map((a, i) => {
        const x1 = laneGeometry(a.from)
        const x2 = laneGeometry(a.to)
        if (a.kind === 'debuff') {
          const d = `M ${x1} 100 C ${x1} 62, ${x2} 40, ${x2} 3`
          return <path key={i} d={d} className={css.debuffPath} markerEnd="url(#debuffHead)" vectorEffect="non-scaling-stroke" />
        }
        const dir = Math.sign(x2 - x1)
        const d = `M ${x1 + dir * 6} 98 Q ${(x1 + x2) / 2} 80, ${x2 - dir * 6} 98`
        return <path key={i} d={d} className={css.buffPath} markerEnd="url(#buffHead)" vectorEffect="non-scaling-stroke" />
      })}
    </svg>
  )
}

function statusLabel(raw: string, t: ReturnType<typeof useT>): string {
  if (raw === 'cleared') return t('statusFought')
  if (raw === 'missed') return t('statusMissed')
  if (raw === 'in_processing') return t('statusProcessing')
  if (raw === 'unrevealed') return t('statusHidden')
  return t('statusOpen')
}

export function KeypointSheet({ ctx }: { ctx: KeypointContext }) {
  const t = useT()
  const plan = usePlanFor(ctx.op.id)
  const route = useLive(s => s.snapshot?.route)
  const select = useStore(s => s.select)
  const selectedLane = useStore(s => s.selection.lane)
  const clearPlacements = useStore(s => s.clearPlacements)
  const setPlacements = useStore(s => s.setPlacements)
  const [slotLane, setSlotLane] = useState<LaneIndex | null>(null)
  const [dragOver, setDragOver] = useState<LaneIndex | null>(null)
  const sheetRef = useRef<HTMLElement>(null)
  const area = useSize(sheetRef, true)
  const compact = area.width > 0 && area.width < 480
  const narrow = area.width > 0 && area.width < 760
  const byWidth = compact ? (area.width - 24) / 4 - 8 : (area.width - 40) / 4 - (narrow ? 30 : 42)
  const byHeight = (area.height - 250) / 2.6
  const cardSize = compact
    ? Math.round(Math.max(64, Math.min(120, byWidth)))
    : Math.round(Math.max(96, Math.min(150, byWidth || 136, byHeight > 0 ? byHeight : 136)))

  const { op, kp, meta, stage, placements, manual, evaluation, hp, pending } = ctx
  const planned = plannedKeypoint(plan, kp.id)
  const fought = kp.status === 'fought'
  const editable = kp.status === 'open' && !op.finished
  const lanesOk = evaluation && evaluation.ok ? evaluation.lanes : null
  const otherLanes = pending?.other && pending.other.ok ? pending.other.lanes : null
  const restrictions = collectRestrictions(activeConditions(conditionViews(op, kp.id)))
  const estimated = !meta.revealed
  const inGame = route?.keypointId === kp.id

  const update = (next: readonly PlacementDraft[]) => setPlacements(op.id, kp.id, next)

  const onDrop = (lane: LaneIndex, event: React.DragEvent) => {
    event.preventDefault()
    setDragOver(null)
    if (!editable) return
    const card = event.dataTransfer.getData('application/x-nimitz-card')
    const modifier = event.dataTransfer.getData('application/x-nimitz-modifier') as ModifierId
    if (card) {
      const def = cardByCode(card)
      if (!def || placements[lane]!.card === card || restrictions.isBanned(def) || (hp[card] ?? 0) <= 0 || stageUsage(op, stage).has(card)) return
      update(placements.map((p, i) => (i === lane ? { ...p, card } : p.card === card ? EMPTY_PLACEMENT : p)))
    } else if (modifier && canAttach(op, plan, kp.id, placements, lane, modifier)) {
      const standard = modifierById(modifier)?.type === 1
      update(placements.map((p, i) => (i !== lane ? p : standard ? { ...p, standard: modifier } : { ...p, special: modifier })))
    }
  }

  return (
    <section ref={sheetRef} className={cx(css.sheet, compact && css.compact)} aria-label={t('board')} style={{ '--slot-w': `${cardSize}px` } as React.CSSProperties}>
      <header className={css.header}>
        <div className={css.title}>
          <h1>
            {t('stageN', { n: stage + 1 })} · {t('keypointN', { n: meta.number })}
            <Stars count={meta.difficulty} size={15} />
            {estimated && <em className={css.estimated}>{t('stageEstimated')}</em>}
          </h1>
        </div>
        <div className={css.headerTools}>
          {inGame && <span className={css.inGame}>{t('openInGame')}</span>}
          <span className={cx(css.status, css[`status_${kp.status}`], meta.raw === 'in_processing' && css.status_processing)}>{statusLabel(meta.raw, t)}</span>
          {editable && planned && (
            <span className={cx(css.advice, !planned.attack && css.adviceSkip)}>{planned.attack ? t('recommended') : t('skipKeypoint')}</span>
          )}
          {editable && manual && (
            <Button variant="ghost" onClick={() => clearPlacements(op.id, kp.id)}>
              {t('useRecommendation')}
            </Button>
          )}
        </div>
      </header>

      <div className={css.board}>
        <div className={css.row}>
          {LANES.map(lane => {
            const slot = kp.lanes[lane]
            const won = fought && kp.record?.[lane]?.won
            return (
              <div key={lane} className={css.cell}>
                {estimated ? (
                  <div className={css.hiddenEnemy}>?</div>
                ) : slot ? (
                  <EnemyCard
                    enemy={slot.enemy}
                    rewards={meta.rewards[lane]}
                    result={lanesOk?.[lane]?.enemy ?? null}
                    destroyed={Boolean(won)}
                    survived={fought && !won && Boolean(kp.record?.[lane])}
                    size={cardSize}
                  />
                ) : (
                  <div className={css.emptyEnemy} />
                )}
              </div>
            )
          })}
        </div>

        <div className={css.oddsRow}>
          {LANES.map(lane => {
            const l = lanesOk?.[lane]
            const alt = otherLanes?.[lane]?.probability ?? null
            return (
              <div key={lane} className={css.oddsCell}>
                <span className={css.laneTag}>{lane + 1}</span>
                {l && l.probability !== null ? (
                  <span className={css.oddsStack}>
                    <Odds probability={l.probability} size={compact ? 'sm' : 'lg'} />
                    {pending && alt !== null && (
                      <small className={cx(css.oddsAlt, 'num')}>{compact ? `${roundPercent(alt)}%` : t('oddsIfActive', { p: roundPercent(alt) })}</small>
                    )}
                  </span>
                ) : (
                  <span className={css.noBattle}>{kp.lanes[lane] || estimated ? '' : t('noBattle')}</span>
                )}
              </div>
            )
          })}
          <ArrowLayer evaluation={evaluation} />
        </div>

        <div className={css.row}>
          {LANES.map(lane => {
            const p = placements[lane]!
            const card = p.card ? cardByCode(p.card) : null
            const recommendedLane = !manual && !fought && planned?.lanes[lane]?.card === p.card && Boolean(p.card)
            return (
              <div
                key={lane}
                className={cx(css.cell, dragOver === lane && css.dropTarget)}
                onDragOver={e => {
                  if (!editable) return
                  e.preventDefault()
                  setDragOver(lane)
                }}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => onDrop(lane, e)}
              >
                {card ? (
                  <AllyCard
                    card={card}
                    hp={hp[card.code] ?? 0}
                    standard={p.standard}
                    special={p.special}
                    result={lanesOk?.[lane]?.player ?? null}
                    showModifiers={!compact}
                    inlineModifiers={compact}
                    compactModifiers={narrow}
                    highlight={selectedLane === lane ? 'selected' : recommendedLane ? 'recommended' : null}
                    onClick={() => {
                      select({ lane })
                      if (editable) setSlotLane(lane)
                    }}
                    size={cardSize}
                  />
                ) : editable && (kp.lanes[lane] || estimated) ? (
                  <button
                    type="button"
                    className={cx(css.addAlly, selectedLane === lane && css.addAllySelected)}
                    onClick={() => {
                      select({ lane })
                      setSlotLane(lane)
                    }}
                  >
                    <Icon name="plus" size={compact ? 20 : 28} />
                    {t('placeCard')}
                  </button>
                ) : (
                  <div className={css.emptyAlly} />
                )}
              </div>
            )
          })}
        </div>
        {evaluation && !evaluation.ok && <p className={css.warning}>{t('noPrediction')}</p>}
        {estimated && editable && <p className={css.assumption}>{t('estimatedHint')}</p>}
        {pending && <p className={css.assumption}>{t('oddsSwept', { name: pending.sources.map(id => keypointName(op, id, t)).join('、') })}</p>}
      </div>

      <ConditionsPanel op={op} keypoint={kp.id} />

      {slotLane !== null && <SlotDialog context={ctx} lane={slotLane} restrictions={restrictions} onClose={() => setSlotLane(null)} />}
    </section>
  )
}
