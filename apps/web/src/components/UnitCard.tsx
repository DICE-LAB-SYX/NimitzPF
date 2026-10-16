import {
  CORE_SETTINGS,
  isFlagship,
  powerRange,
  type BuffDef,
  type BuffDirection,
  type CardDef,
  type DebuffDef,
  type DebuffDirection,
  type EnemyUnit,
  type ModifierId,
  type PlayerSideResult,
  type SideResult,
  type SpecIndex,
  type VulnCode,
} from '@nimitzpf/core'
import type { CSSProperties } from 'react'
import { asset } from '../game/assets.ts'
import { useT } from '../i18n/useT.ts'
import { useRealm } from '../live/store.ts'
import { enemyPower, handSpecs, vulnCodes, type RewardDraft } from '../state/model.ts'
import { cx, HpBar } from '../ui/primitives.tsx'
import { RewardBadge } from './RewardBadge.tsx'
import css from './UnitCard.module.css'

const SPECS: readonly SpecIndex[] = [0, 1, 2]

const NOTCH: Readonly<Record<string, number>> = {
  'forward': 0,
  'forward-left': -45,
  'forward-right': 45,
  'left': -90,
  'right': 90,
}

const EFFECT_ORDER: Readonly<Record<BuffDirection | DebuffDirection, number>> = {
  'left': 0,
  'forward-left': 1,
  'forward': 2,
  'forward-right': 3,
  'right': 4,
}

type CardEffect = { readonly kind: 'buff'; readonly effect: BuffDef } | { readonly kind: 'debuff'; readonly effect: DebuffDef }

export function cardEffects(card: CardDef): CardEffect[] {
  const buffs = card.buffs.map((effect): CardEffect => ({ kind: 'buff', effect }))
  const debuffs = card.debuffs.map((effect): CardEffect => ({ kind: 'debuff', effect }))
  return [...buffs, ...debuffs].sort((a, b) => EFFECT_ORDER[a.effect.direction] - EFFECT_ORDER[b.effect.direction])
}

export function vulnHits(vulns: readonly VulnCode[], result: SideResult | null | undefined): Map<VulnCode, number> {
  const hits = new Map<VulnCode, number>()
  if (!result) return hits
  const first = vulns.length ? (Math.min(...vulns) as VulnCode) : null
  for (const { source } of result.contributions) {
    if (source.kind !== 'debuff') continue
    const at = vulns.includes(source.vuln) ? source.vuln : source.ignoredVuln ? first : null
    if (at !== null) hits.set(at, (hits.get(at) ?? 0) + 1)
  }
  return hits
}

function EffectBadge({ effect, kind, universal }: { effect: BuffDef | DebuffDef; kind: 'buff' | 'debuff'; universal: boolean }) {
  const t = useT()
  const src = kind === 'buff' ? asset.spec((effect as BuffDef).spec) : asset.vuln(universal ? 'seadog' : (effect as DebuffDef).vuln)
  const label = kind === 'buff' ? `+${t.spec((effect as BuffDef).spec)}` : `−${t.vuln((effect as DebuffDef).vuln)}`
  return (
    <span
      className={cx(css.effect, kind === 'buff' ? css.effectBuff : css.effectDebuff)}
      style={{ '--notch': `${NOTCH[effect.direction] ?? 0}deg` } as CSSProperties}
      title={label}
    >
      <img src={src} alt={label} />
      <i className={css.notch} />
    </span>
  )
}

function ModifierSlots({ standard, special, compact }: { standard: ModifierId | null; special: ModifierId | null; compact?: boolean }) {
  const t = useT()
  return (
    <div className={cx(css.modSlots, compact && css.modSlotsCompact)}>
      {[standard, special].map((m, i) => (
        <span key={i} className={cx(css.modSlot, i === 0 ? css.modStandard : css.modSpecial, m && css.modFilled)} title={m ? t.modifier(m) : undefined}>
          {m && <img src={asset.modifier(m)} alt={t.modifier(m)} />}
        </span>
      ))}
    </div>
  )
}

export function AllyCard({
  card,
  hp,
  standard,
  special,
  result,
  size = 132,
  highlight,
  dim,
  onClick,
  draggable,
  onDragStart,
  showModifiers = true,
  inlineModifiers = false,
  compactModifiers = false,
  stamp,
}: {
  card: CardDef
  hp: number
  standard: ModifierId | null
  special: ModifierId | null
  result?: PlayerSideResult | null
  size?: number
  highlight?: 'selected' | 'recommended' | null
  dim?: boolean
  onClick?: () => void
  draggable?: boolean
  onDragStart?: (event: React.DragEvent) => void
  showModifiers?: boolean
  inlineModifiers?: boolean
  compactModifiers?: boolean
  stamp?: string | null
}) {
  const t = useT()
  const realm = useRealm()
  const name = t.cardName(card.code)
  const specs = result ? result.specs : handSpecs(card, hp)
  const silenced = special === 'focused'
  const base = card.specs[0] + card.specs[1] + card.specs[2]
  const power = specs[0] + specs[1] + specs[2]
  const style = { '--card-w': `${size}px` } as CSSProperties
  const [low, high] = result ? [result.low, result.high] : powerRange(CORE_SETTINGS, power)
  return (
    <div className={css.unit}>
      <div
        className={cx(css.card, highlight === 'selected' && css.selected, highlight === 'recommended' && css.recommended, dim && css.dim)}
        style={style}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={e => {
          if (onClick && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            onClick()
          }
        }}
        draggable={draggable}
        onDragStart={onDragStart}
        title={name.carrier ? `${name.unit} · ${name.carrier}` : name.unit}
      >
        <img className={css.frame} src={asset.frame('ally', card.tier)} alt="" draggable={false} />
        <div className={css.top}>
          <span className={cx(css.effects, silenced && css.effectsOff)} aria-hidden={silenced || undefined}>
            {cardEffects(card).map(({ kind, effect }, i) => (
              <EffectBadge key={`${kind}${i}`} effect={effect} kind={kind} universal={special === 'sea-dog'} />
            ))}
          </span>
          <span className={cx(css.range, 'num', power > base && css.buffed, power < base && css.debuffed)}>
            {Math.round(low)}
            <i>–</i>
            {Math.round(high)}
          </span>
        </div>
        <img className={css.art} src={asset.card(card.code, realm)} alt="" draggable={false} />
        {inlineModifiers && (standard || special) && (
          <div className={css.inlineMods}>
            {[standard, special].map(m => (m ? <img key={m} src={asset.modifier(m)} alt={t.modifier(m)} /> : null))}
          </div>
        )}
        <div className={css.nameplate}>
          <img src={asset.type(card.type)} alt={t.unitType(card.type)} />
          <span>{name.unit}</span>
        </div>
        <div className={css.specs}>
          {SPECS.map(k => {
            const delta = specs[k] - card.specs[k]
            return (
              <span key={k} className={cx(css.spec, delta > 0 && css.up, delta < 0 && css.down)} title={t.spec(k)}>
                <img src={asset.spec(k)} alt={t.spec(k)} />
                <b className="num">{specs[k]}</b>
              </span>
            )
          })}
        </div>
        <div className={css.hp}>
          <HpBar hp={hp} compact={size < 120} />
        </div>
        {highlight === 'recommended' && <span className={css.recTab}>{t('recommended')}</span>}
        {stamp && <span className={cx(css.stamp, css.stampMiss)}>{stamp}</span>}
      </div>
      {showModifiers && <ModifierSlots standard={standard} special={special} compact={compactModifiers || size < 120} />}
    </div>
  )
}

export function EnemyCard({
  enemy,
  rewards,
  result,
  size = 132,
  destroyed,
  survived,
}: {
  enemy: EnemyUnit
  rewards?: readonly RewardDraft[] | null
  result?: SideResult | null
  size?: number
  destroyed?: boolean
  survived?: boolean
}) {
  const t = useT()
  const realm = useRealm()
  const boss = isFlagship(enemy)
  const power = enemyPower(enemy)
  const finalPower = result ? result.power : power
  const delta = finalPower - power
  const vulns = vulnCodes(enemy.vulns)
  const hits = vulnHits(vulns, result)
  const style = { '--card-w': `${size}px` } as CSSProperties
  return (
    <div className={css.unit}>
      <div className={cx(css.card, css.enemy, boss && css.boss)} style={style} title={t.enemyName(enemy.code)}>
        <img className={css.frame} src={boss ? asset.frame('ally', 'boss') : asset.frame('enemy', enemy.tier)} alt="" draggable={false} />
        <div className={css.top}>
          <span className={css.effects}>
            {vulns.map((v: VulnCode) => {
                const hit = Math.min(hits.get(v) ?? 0, 3)
                return (
                  <span
                    key={v}
                    className={cx(css.effect, css.effectVuln, hit > 0 && css[`hit${hit}`])}
                    style={{ backgroundImage: `url(${asset.vulnRing()})` }}
                    title={(enemy.vulns[v] ?? 1) < 1 ? `${t.vuln(v)} ×${enemy.vulns[v]}` : t.vuln(v)}
                  >
                    <img src={asset.vuln(v)} alt={t.vuln(v)} />
                  </span>
                )
            })}
          </span>
          <span className={cx(css.enemyPower, 'num', delta < 0 && css.debuffed, delta > 0 && css.buffed)}>
            {finalPower}
            {delta !== 0 && <small>{delta > 0 ? `+${delta}` : delta}</small>}
          </span>
        </div>
        <img className={css.art} src={asset.enemy(enemy.code, realm)} alt="" draggable={false} />
        <div className={css.nameplate}>
          <img src={asset.type(enemy.type)} alt={t.unitType(enemy.type)} />
          <span>{t.enemyName(enemy.code)}</span>
        </div>
        {rewards && rewards.length > 0 && (
          <span className={css.reward}>
            {rewards.map((r, i) => (
              <RewardBadge key={i} reward={r} />
            ))}
          </span>
        )}
        {destroyed && <span className={css.stamp}>{t('destroyed')}</span>}
        {survived && <span className={cx(css.stamp, css.stampMiss)}>{t('recordLoss')}</span>}
      </div>
    </div>
  )
}
