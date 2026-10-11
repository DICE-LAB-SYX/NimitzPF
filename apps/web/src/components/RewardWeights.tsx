import { useT } from '../i18n/useT.ts'
import { REWARD_KINDS } from '../state/model.ts'
import { useStore } from '../state/store.ts'
import { RewardBadge } from './RewardBadge.tsx'
import css from './RewardWeights.module.css'

export function RewardWeights() {
  const t = useT()
  const weights = useStore(s => s.rewardWeights)
  const setWeight = useStore(s => s.setRewardWeight)
  return (
    <div className={css.panel}>
      <p className={css.hint}>{t('rewardWeightsHint')}</p>
      <ul className={css.list}>
        {REWARD_KINDS.map(kind => {
          const value = weights[kind] ?? 1
          return (
            <li key={kind} className={css.row}>
              <span className={css.label}>
                {kind !== 'other' && <RewardBadge reward={{ kind, amount: 0, modifier: kind === 'modifier' ? 'teamwork' : null }} className={css.badge} />}
                {t(`reward_${kind}`)}
              </span>
              <input
                type="range"
                min={0}
                max={5}
                step={0.5}
                value={value}
                aria-label={t(`reward_${kind}`)}
                onChange={e => setWeight(kind, Number(e.target.value))}
              />
              <output className="num">{value.toFixed(1)}</output>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
