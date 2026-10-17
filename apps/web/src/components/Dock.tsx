import { cardByCode, collectRestrictions, MODIFIERS, modifierById, type ModifierId } from '@nimitzpf/core'
import { useMemo } from 'react'
import { asset } from '../game/assets.ts'
import { useT } from '../i18n/useT.ts'
import { useBuying } from '../live/store.ts'
import { usePlanFor } from '../solver/plan.ts'
import { activeConditions, canAttach, conditionViews, EMPTY_PLACEMENTS, laneRule, modifierLedger, stageAssignments, stageUsage, type Operation } from '../state/derive.ts'
import { BOOST, handSpecs } from '../state/model.ts'
import { useStore } from '../state/store.ts'
import { cx } from '../ui/primitives.tsx'
import css from './Dock.module.css'
import type { KeypointContext } from './KeypointSheet.tsx'
import { AllyCard } from './UnitCard.tsx'

export function Dock({ op, ctx }: { op: Operation; ctx: KeypointContext | null }) {
  const t = useT()
  const plan = usePlanFor(op.id)
  const owned = useMemo(() => op.state.fleet.map(f => f.card), [op])
  const lane = useStore(s => s.selection.lane)
  const setPlacements = useStore(s => s.setPlacements)
  const stage = ctx?.stage ?? op.state.currentStage
  const used = useMemo(() => stageUsage(op, stage), [op, stage])
  const assigned = useMemo(() => stageAssignments(op, stage, plan), [op, stage, plan])
  const restrictions = useMemo(() => (ctx ? collectRestrictions(activeConditions(conditionViews(op, ctx.kp.id))) : null), [op, ctx])
  const editable = ctx?.kp.status === 'open' && !op.finished
  const ledger = useMemo(
    () => modifierLedger(op, plan, ctx && editable ? ctx.kp.id : null, ctx?.placements ?? EMPTY_PLACEMENTS),
    [op, plan, ctx, editable],
  )
  const accepts = useMemo(() => (ctx && editable && lane !== null ? laneRule(op, ctx.kp.id, ctx.placements, lane) : null), [op, ctx, editable, lane])
  const buying = useBuying()
  const hp = ctx?.hp ?? op.hp

  const cards = useMemo(() => {
    return owned
      .map(code => cardByCode(code))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map(card => {
        const cardHp = hp[card.code] ?? 0
        const status = used.has(card.code)
          ? 'used'
          : cardHp <= 0
            ? 'depleted'
            : restrictions?.isBanned(card)
              ? 'banned'
              : assigned.has(card.code)
                ? 'assigned'
                : 'free'
        const specs = handSpecs(card, cardHp)
        return { card, hp: cardHp, status, at: assigned.get(card.code) ?? null, power: specs[0] + specs[1] + specs[2] }
      })
      .sort((a, b) => {
        const rank = (s: string) => (s === 'free' ? 0 : s === 'assigned' ? 1 : 2)
        return rank(a.status) - rank(b.status) || b.power - a.power
      })
  }, [owned, hp, used, assigned, restrictions])

  const kpLabel = (id: string) => {
    const meta = op.keypoints.get(id)
    return meta ? t('keypointN', { n: meta.number }) : ''
  }

  const place = (code: string) => {
    if (!ctx || !editable || lane === null) return
    const next = ctx.placements.map((p, i) => {
      if (i === lane) return { ...p, card: code }
      if (p.card === code) return { card: null, standard: null, special: null }
      return p
    })
    setPlacements(op.id, ctx.kp.id, next)
  }

  const attach = (id: ModifierId) => {
    if (!ctx || !editable || lane === null || !canAttach(op, plan, ctx.kp.id, ctx.placements, lane, id)) return
    const standard = modifierById(id)?.type === 1
    const next = ctx.placements.map((x, i) => (i === lane ? (standard ? { ...x, standard: id } : { ...x, special: id }) : x))
    setPlacements(op.id, ctx.kp.id, next)
  }

  return (
    <section className={css.dock} aria-label={t('fleet')}>
      <div className={css.mods} aria-label={t('inventory')}>
        {MODIFIERS.map(m => {
          const { stock, assigned, left, over, usable, reserved } = ledger[m.id]
          const banned = Boolean(restrictions?.modifiersDisabled || restrictions?.bannedModifiers.has(m.id))
          const fits = !accepts || accepts(m.id)
          const on = usable && !banned && fits
          const short = buying && m.id === BOOST ? Math.max(0, assigned - stock) : 0
          const title = [
            t.modifier(m.id),
            m.type === 1 ? t('modifierStandard') : t('modifierSpecial'),
            t('modifierLedger', { stock, used: assigned, left }),
            short > 0 ? t('modifierToBuy', { n: short }) : '',
            banned ? t('banned') : over > 0 ? t('modifierOverBy', { n: over }) : !fits ? t('modifierLaneRefuses') : on && reserved ? t('modifierReserved') : '',
          ]
          return (
            <button
              key={m.id}
              type="button"
              className={cx(css.mod, m.type === 2 && css.special, over > 0 ? css.modOver : !on && css.modOff, on && reserved && css.modReserved)}
              style={{ gridRow: m.type, gridColumn: MODIFIERS.filter(x => x.type === m.type).indexOf(m) + 1 }}
              disabled={!on}
              draggable={on}
              onDragStart={e => {
                e.dataTransfer.setData('application/x-nimitz-modifier', m.id)
                e.dataTransfer.effectAllowed = 'copy'
              }}
              onClick={() => attach(m.id)}
              title={title.filter(Boolean).join(' · ')}
            >
              <img src={asset.modifier(m.id)} alt={t.modifier(m.id)} />
              <span className="num">{over > 0 ? `-${over}` : left}</span>
            </button>
          )
        })}
      </div>
      <div className={css.cards} role="list">
        {cards.map(({ card, hp: cardHp, status, at }) => (
          <div key={card.code} role="listitem" className={css.item}>
            <AllyCard
              card={card}
              hp={cardHp}
              standard={null}
              special={null}
              size={94}
              showModifiers={false}
              dim={status === 'used' || status === 'depleted' || status === 'banned'}
              stamp={status === 'used' ? t('usedThisStage') : status === 'depleted' ? t('depleted') : status === 'banned' ? t('banned') : null}
              draggable={status !== 'used' && status !== 'depleted' && status !== 'banned'}
              onDragStart={e => {
                e.dataTransfer.setData('application/x-nimitz-card', card.code)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onClick={status === 'used' || status === 'depleted' || status === 'banned' ? undefined : () => place(card.code)}
            />
            <span className={cx(css.tag, css[`tag_${status}`])}>{status === 'assigned' && at ? kpLabel(at) : ''}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
