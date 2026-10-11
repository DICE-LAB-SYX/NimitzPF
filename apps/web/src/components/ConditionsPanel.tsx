import type { Condition, Restriction } from '@nimitzpf/core'
import { asset, CONDITION_CODE } from '../game/assets.ts'
import type { LiveOperation } from '../live/adapter.ts'
import { useT } from '../i18n/useT.ts'
import { conditionIsHarmful, conditionViews, effectivePercentLabel, locate, type ConditionBucket, type ConditionView } from '../state/derive.ts'
import { Icon } from '../ui/Icon.tsx'
import { cx } from '../ui/primitives.tsx'
import css from './ConditionsPanel.module.css'

const BUCKETS: readonly ConditionBucket[] = ['local', 'incoming', 'targeted', 'global']

export function keypointName(op: LiveOperation, id: string, t: ReturnType<typeof useT>): string {
  const at = locate(op, id)
  if (!at) return '—'
  const meta = op.keypoints.get(id)
  return `${t('stageN', { n: at.stage + 1 })}·${t('keypointN', { n: meta?.number ?? at.index + 1 })}`
}

function restrictionList(r: Restriction | undefined, t: ReturnType<typeof useT>): string[] {
  if (!r) return []
  return [
    ...(r.types ?? []).map(x => t.unitType(x)),
    ...(r.cards ?? []).map(x => t.cardName(x).unit),
    ...(r.tiers ?? []).map(x => `T${x}`),
    ...(r.modifiers ?? []).map(x => t.modifier(x)),
  ]
}

function details(effect: Condition, t: ReturnType<typeof useT>): string[] {
  const out: string[] = []
  if (effect.kind === 'restrictions') return restrictionList(effect.banned, t)
  if (effect.kind === 'disable-modifiers') return out
  const exempt = restrictionList(effect.exempt, t)
  if (exempt.length) out.push(`${t('conditionExcluded')}: ${exempt.join('、')}`)
  if (effect.kind === 'player-specs' || effect.kind === 'enemy-power') {
    const specs = ([0, 1, 2] as const).filter(k => effect.specs[k])
    if (specs.length && specs.length < 3) out.push(specs.map(k => t.spec(k)).join('、'))
  }
  return out
}

function ConditionRow({ view, op }: { view: ConditionView; op: LiveOperation }) {
  const t = useT()
  const { condition: c, status, bucket } = view
  const shown = view.effective ?? c.base
  const harmful = conditionIsHarmful(c.base)
  const removal = c.mitigable ? t('removalMitigate', { n: c.weakenPercent ?? 0 }) : t('removalKills', { n: c.removeAfter ?? 0 })
  const targets = c.applyTo.filter(id => id !== c.source)
  return (
    <li className={cx(css.row, status === 'removed' && css.removed)}>
      <img className={css.badge} src={asset.condition(CONDITION_CODE[c.kind] ?? 'multiple')} alt="" />
      <div className={css.body}>
        <div className={css.line}>
          <strong>{t.condition(c.kind)}</strong>
          <span className={cx(css.value, 'num', harmful ? css.bad : css.good)}>{effectivePercentLabel(shown)}</span>
          {status === 'pending' && bucket === 'incoming' && <span className={css.pending}>{t('scopeIncoming')}</span>}
          {status === 'removed' && <span className={css.tag}>{t('conditionRemoved')}</span>}
          {status === 'weakened' && <span className={css.tag}>{t('conditionWeakened', { value: effectivePercentLabel(view.effective) })}</span>}
        </div>
        <div className={css.meta}>
          {details(c.base, t).length > 0 && <span>{details(c.base, t).join(' · ')}</span>}
          {bucket === 'incoming' && c.source && <span>{t('conditionFrom', { name: keypointName(op, c.source, t) })}</span>}
          {bucket === 'targeted' && targets.length > 0 && (
            <span className={css.targets}>
              <Icon name="arrowRight" size={13} />
              {targets.map(id => keypointName(op, id, t)).join('、')}
            </span>
          )}
          {bucket !== 'local' && c.source && status === 'pending' && <span>{removal}</span>}
        </div>
      </div>
    </li>
  )
}

export function ConditionsPanel({ op, keypoint }: { op: LiveOperation; keypoint: string }) {
  const t = useT()
  const views = conditionViews(op, keypoint)
  const labels: Record<ConditionBucket, string> = {
    local: t('scopeLocal'),
    incoming: t('scopeIncoming'),
    targeted: t('scopeTargeted'),
    global: t('scopeGlobal'),
  }
  return (
    <section className={css.panel} aria-label={t('conditions')}>
      <header className={css.header}>
        <h2>{t('conditions')}</h2>
      </header>
      {views.length === 0 ? (
        <p className={css.empty}>{t('conditionNone')}</p>
      ) : (
        <div className={css.buckets}>
          {BUCKETS.map(bucket => {
            const list = views.filter(v => v.bucket === bucket)
            if (!list.length) return null
            return (
              <div key={bucket} className={css.bucket}>
                <h3>{labels[bucket]}</h3>
                <ul>
                  {list.map(v => (
                    <ConditionRow key={v.condition.id} view={v} op={op} />
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
