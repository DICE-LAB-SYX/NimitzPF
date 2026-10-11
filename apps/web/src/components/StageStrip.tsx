import { asset } from '../game/assets.ts'
import { useT } from '../i18n/useT.ts'
import { markerKind, type Operation } from '../state/derive.ts'
import { useStore } from '../state/store.ts'
import { cx } from '../ui/primitives.tsx'
import css from './StageStrip.module.css'

export function StageStrip({ op, selected }: { op: Operation; selected: string | null }) {
  const t = useT()
  const select = useStore(s => s.select)
  return (
    <nav className={css.strip} aria-label={t('stage')}>
      {op.state.stages.map((stage, s) => (
        <div key={stage.id} className={cx(css.stage, s === op.state.currentStage && css.current, s < op.state.currentStage && css.done)}>
          <span className={cx(css.number, 'num')}>{s + 1}</span>
          {stage.keypoints.map(kp => {
            const meta = op.keypoints.get(kp.id)
            return (
              <button
                key={kp.id}
                type="button"
                className={cx(css.kp, kp.id === selected && css.on, kp.status !== 'open' && css.closed, !meta?.revealed && css.hidden)}
                aria-pressed={kp.id === selected}
                aria-label={`${t('stageN', { n: s + 1 })} ${t('keypointN', { n: meta?.number ?? 0 })}`}
                onClick={() => select({ keypoint: kp.id, lane: null })}
              >
                <img src={asset.marker(markerKind(op, kp.id), meta?.difficulty ?? 2)} alt="" />
              </button>
            )
          })}
        </div>
      ))}
    </nav>
  )
}
