import { asset } from '../game/assets.ts'
import { useT } from '../i18n/useT.ts'
import { BOOST, boostedAmount, type RewardDraft } from '../state/model.ts'
import { cx } from '../ui/primitives.tsx'
import css from './RewardBadge.module.css'

function rewardIcon(reward: RewardDraft): string | null {
  switch (reward.kind) {
    case 'supplies':
      return asset.reward('supplies')
    case 'progress':
      return asset.reward('progress')
    case 'modifier':
      return reward.modifier ? asset.modifier(reward.modifier) : null
    case 'card':
      return asset.frame('collection', 3)
    default:
      return null
  }
}

export function RewardBadge({ reward, boosted = false, className }: { reward: RewardDraft; boosted?: boolean; className?: string }) {
  const t = useT()
  const icon = rewardIcon(reward)
  const label = reward.kind === 'modifier' && reward.modifier ? t.modifier(reward.modifier) : t(`reward_${reward.kind}`)
  const lifted = boosted && reward.boostable === true
  const amount = lifted ? boostedAmount(reward.amount) : reward.amount
  const title = `${label} ×${amount}${lifted ? ` · ${t('rewardBoost', { m: t.modifier(BOOST) })}` : ''}`
  return (
    <span className={cx(css.badge, lifted && css.boosted, className)} title={title}>
      {icon ? <img src={icon} alt={label} /> : <i className={css.unknown}>?</i>}
      {amount > 0 && <b className="num">{amount}</b>}
    </span>
  )
}
