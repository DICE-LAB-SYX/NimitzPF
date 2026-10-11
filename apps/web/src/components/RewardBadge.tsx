import { asset } from '../game/assets.ts'
import { useT } from '../i18n/useT.ts'
import type { RewardDraft } from '../state/model.ts'
import { cx } from '../ui/primitives.tsx'
import css from './RewardBadge.module.css'

export function rewardIcon(reward: RewardDraft): string | null {
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

export function RewardBadge({ reward, className }: { reward: RewardDraft; className?: string }) {
  const t = useT()
  const icon = rewardIcon(reward)
  const label = reward.kind === 'modifier' && reward.modifier ? t.modifier(reward.modifier) : t(`reward_${reward.kind}`)
  return (
    <span className={cx(css.badge, className)} title={`${label} ×${reward.amount}`}>
      {icon ? <img src={icon} alt={label} /> : <i className={css.unknown}>?</i>}
      {reward.amount > 0 && <b className="num">{reward.amount}</b>}
    </span>
  )
}
