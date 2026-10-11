import { cardByCode, MODIFIERS, roundPercent, type CardDef, type ModifierId, type Restrictions } from '@nimitzpf/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { asset } from '../game/assets.ts'
import { useT } from '../i18n/useT.ts'
import { usePlanFor } from '../solver/plan.ts'
import {
  evaluatePlacements,
  modifierRule,
  modifiersLeft,
  stageAssignments,
  stageUsage,
} from '../state/derive.ts'
import { enemyPower, vulnCodes, type LaneIndex, type PlacementDraft } from '../state/model.ts'
import { useStore } from '../state/store.ts'
import { Button, cx, Dialog, HpBar } from '../ui/primitives.tsx'
import type { KeypointContext } from './KeypointSheet.tsx'
import css from './SlotDialog.module.css'

interface Candidate {
  readonly card: CardDef
  readonly hp: number
  readonly lane: number | null
  readonly kills: number
  readonly blocked: 'used' | 'depleted' | 'banned' | null
  readonly elsewhere: string | null
}

export function SlotDialog({
  context,
  lane,
  restrictions,
  onClose,
}: {
  context: KeypointContext
  lane: LaneIndex
  restrictions: Restrictions
  onClose: () => void
}) {
  const t = useT()
  const { op, kp, stage, placements, hp, conditions } = context
  const owned = useMemo(() => op.state.fleet.map(f => f.card), [op])
  const setPlacements = useStore(s => s.setPlacements)
  const commit = (next: readonly PlacementDraft[]) => setPlacements(op.id, kp.id, next)
  const plan = usePlanFor(op.id)
  const current = placements[lane]!
  const [card, setCard] = useState<string | null>(current.card)
  const [standard, setStandard] = useState<ModifierId | null>(current.standard)
  const [special, setSpecial] = useState<ModifierId | null>(current.special)

  const used = useMemo(() => stageUsage(op, stage), [op, stage])
  const assigned = useMemo(() => stageAssignments(op, stage, plan), [op, stage, plan])

  const withCard = (code: string | null, std: ModifierId | null, spc: ModifierId | null): PlacementDraft[] =>
    placements.map((p, i) => {
      if (i === lane) return { card: code, standard: code ? std : null, special: code ? spc : null }
      if (code && p.card === code) return { card: null, standard: null, special: null }
      return p
    })

  const candidates = useMemo<Candidate[]>(() => {
    const list: Candidate[] = []
    for (const code of owned) {
      const def = cardByCode(code)
      if (!def) continue
      const cardHp = hp[code] ?? 0
      const blocked = used.has(code) ? 'used' : cardHp <= 0 ? 'depleted' : restrictions.isBanned(def) ? 'banned' : null
      const ev = evaluatePlacements(kp, withCard(code, standard, special), conditions, hp)
      let kills = 0
      let laneP: number | null = null
      if (ev && ev.ok) {
        ev.lanes.forEach((l, i) => {
          if (l.probability !== null) kills += l.probability
          if (i === lane) laneP = l.probability
        })
      }
      const at = assigned.get(code)
      list.push({ card: def, hp: cardHp, lane: laneP, kills, blocked, elsewhere: at && at !== kp.id ? at : null })
    }
    const strength = (c: CardDef) => c.specs[0] + c.specs[1] + c.specs[2]
    return list.sort(
      (a, b) =>
        Number(Boolean(a.blocked)) - Number(Boolean(b.blocked)) ||
        (Math.abs(b.kills - a.kills) > 1e-9 ? b.kills - a.kills : 0) ||
        (b.lane ?? -1) - (a.lane ?? -1) ||
        strength(a.card) - strength(b.card),
    )
  }, [owned, hp, used, restrictions, kp, conditions, assigned, standard, special, placements])

  const ledger = useMemo(() => modifiersLeft(op, plan, kp.id, withCard(card, null, null), lane), [op, plan, kp.id, placements, lane, card])
  const allowed = useMemo(() => modifierRule(op, kp.id), [op, kp.id])

  const enemy = context.meta.revealed ? (kp.lanes[lane]?.enemy ?? null) : null
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'center' })
  }, [])
  const keypointLabel = (id: string) => {
    const s = op.state.stages[stage]!
    const idx = s.keypoints.findIndex(k => k.id === id)
    return t('keypointN', { n: op.keypoints.get(id)?.number ?? idx + 1 })
  }

  const modifierButtons = (slot: 1 | 2) => {
    const value = slot === 1 ? standard : special
    const set = slot === 1 ? setStandard : setSpecial
    return (
      <div className={css.mods} role="radiogroup" aria-label={slot === 1 ? t('modifierStandard') : t('modifierSpecial')}>
        <button type="button" role="radio" aria-checked={value === null} className={cx(css.mod, value === null && css.modOn)} onClick={() => set(null)}>
          <span className={css.none}>{t('none')}</span>
        </button>
        {MODIFIERS.filter(m => m.type === slot).map(m => {
          const left = ledger.left[m.id] ?? 0
          const elsewhere = ledger.plannedElsewhere[m.id] ?? 0
          const disabled = !allowed(lane, m.id) || (left <= 0 && value !== m.id)
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={value === m.id}
              disabled={disabled}
              title={elsewhere > 0 ? `${t.modifier(m.id)} · ${t('modifierPlannedElsewhere', { n: elsewhere })}` : t.modifier(m.id)}
              className={cx(css.mod, value === m.id && css.modOn)}
              onClick={() => set(m.id)}
            >
              <img src={asset.modifier(m.id)} alt="" />
              <span className={css.modName}>{t.modifier(m.id)}</span>
              <span className={cx(css.count, 'num')}>×{Math.max(0, left)}</span>
            </button>
          )
        })}
      </div>
    )
  }

  const save = () => {
    commit(withCard(card, standard, special))
    onClose()
  }

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={`${t('placeCard')} · ${t('laneN', { n: lane + 1 })}`}
      footer={
        <>
          {current.card && (
            <Button
              variant="danger"
              onClick={() => {
                commit(withCard(null, null, null))
                onClose()
              }}
            >
              {t('clearSlot')}
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" onClick={save}>
            {t('save')}
          </Button>
        </>
      }
    >
      <div className={css.layout}>
        <div ref={listRef} className={css.list} role="listbox" aria-label={t('fleet')}>
          {enemy && (
            <div className={css.target}>
              <img className={css.targetArt} src={asset.enemy(enemy.code)} alt="" />
              <div className={css.targetName}>
                <strong>{t.enemyName(enemy.code)}</strong>
                <span className="num">
                  {t('power')} {enemyPower(enemy)}
                </span>
              </div>
              <div className={css.targetVulns}>
                {vulnCodes(enemy.vulns).map(v => (
                  <img key={v} src={asset.vuln(v)} alt={t.vuln(v)} title={t.vuln(v)} />
                ))}
              </div>
            </div>
          )}
          {candidates.map(c => {
            const name = t.cardName(c.card.code)
            const selected = card === c.card.code
            return (
              <button
                key={c.card.code}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={c.blocked !== null}
                className={cx(css.row, selected && css.rowOn)}
                onClick={() => setCard(c.card.code)}
                onDoubleClick={() => {
                  setCard(c.card.code)
                  commit(withCard(c.card.code, standard, special))
                  onClose()
                }}
              >
                <img className={css.art} src={asset.card(c.card.code)} alt="" />
                <span className={css.name}>
                  <span className={css.nameLine}>
                    <img className={css.type} src={asset.type(c.card.type)} alt={t.unitType(c.card.type)} />
                    <strong>
                      T{c.card.tier} {name.unit}
                    </strong>
                  </span>
                  <small>
                    {c.blocked === 'used'
                      ? t('usedThisStage')
                      : c.blocked === 'depleted'
                        ? t('depleted')
                        : c.blocked === 'banned'
                          ? t('banned')
                          : c.elsewhere
                            ? keypointLabel(c.elsewhere)
                            : name.carrier ?? t.unitType(c.card.type)}
                  </small>
                </span>
                <HpBar hp={c.hp} compact />
                <span className={cx(css.kills, 'num')}>{c.blocked ? '' : c.kills.toFixed(2)}</span>
                <span className={cx(css.p, 'num')}>{c.lane === null || c.blocked ? '—' : `${roundPercent(c.lane)}%`}</span>
              </button>
            )
          })}
        </div>
        <div className={css.side}>
          <section>
            <h3>{t('modifierStandard')}</h3>
            {modifierButtons(1)}
          </section>
          <section>
            <h3>{t('modifierSpecial')}</h3>
            {modifierButtons(2)}
          </section>
        </div>
      </div>
    </Dialog>
  )
}
