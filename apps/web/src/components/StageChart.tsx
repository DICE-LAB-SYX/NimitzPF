import { roundPercent } from '@nimitzpf/core'
import { asset } from '../game/assets.ts'
import { useT } from '../i18n/useT.ts'
import { usePlanFor } from '../solver/plan.ts'
import { markerKind, plannedKeypoint, type Operation } from '../state/derive.ts'
import { stageHasFlagship } from '../state/model.ts'
import { useStore } from '../state/store.ts'
import { cx } from '../ui/primitives.tsx'
import css from './StageChart.module.css'

const W = 320
const STAGE_H = 176
const ROW_H = 86
const TOP = 8
const SPAN_LEFT = 84
const SPAN_RIGHT = 292
const MARKER_W = 46
const MAX_GAP = 40
const PER_ROW = 4

function rowsOf(count: number): number {
  return Math.max(1, Math.ceil(count / PER_ROW))
}

function spread(count: number): number[] {
  const span = SPAN_RIGHT - SPAN_LEFT
  const total = count * MARKER_W
  const gap = count > 1 ? Math.max(0, Math.min(MAX_GAP, (span - total) / (count - 1))) : 0
  let x = SPAN_LEFT + (span - total - gap * (count - 1)) / 2
  return Array.from({ length: count }, () => {
    const center = x + MARKER_W / 2
    x += MARKER_W + gap
    return center
  })
}

interface StageLayout {
  readonly y0: number
  readonly height: number
  readonly markers: readonly { x: number; y: number }[]
}

function layoutStages(op: Operation): { stages: StageLayout[]; height: number } {
  let y = TOP
  const stages = op.state.stages.map(stage => {
    const n = stage.keypoints.length
    const rows = rowsOf(n)
    const height = STAGE_H + (rows - 1) * ROW_H
    const perRow = Math.max(1, Math.ceil(n / rows))
    const xs = spread(perRow)
    const markers = Array.from({ length: n }, (_, i) => ({ x: xs[i % perRow]!, y: y + (rows === 1 ? 98 : 96 + Math.floor(i / perRow) * ROW_H) }))
    const layout = { y0: y, height, markers }
    y += height
    return layout
  })
  return { stages, height: y + TOP }
}

export function StageChart({ op, selected }: { op: Operation; selected: string | null }) {
  const t = useT()
  const plan = usePlanFor(op.id)
  const select = useStore(s => s.select)
  const { stages: layouts, height } = layoutStages(op)
  const current = op.state.currentStage

  const anchor = new Map<string, { x: number; y: number }>()
  op.state.stages.forEach((stage, s) => stage.keypoints.forEach((kp, i) => anchor.set(kp.id, layouts[s]!.markers[i]!)))

  return (
    <nav className={css.chart} aria-label={t('stage')} style={{ '--table-image': `url(${new URL(asset.table(), document.baseURI).href})` } as React.CSSProperties}>
      <div className={css.canvas}>
        <svg viewBox={`0 0 ${W} ${height}`} className={css.svg} role="presentation">
          <defs>
            <marker id="condHead" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="#b73a2a" />
            </marker>
          </defs>
          {op.state.stages.map((stage, s) => {
            const layout = layouts[s]!
            const { y0 } = layout
            return (
              <g key={stage.id} className={cx(css.stage, s === current && css.current, s < current && css.done)}>
                <rect x={44} y={y0 + 14} width={268} height={layout.height - 22} rx={70} className={css.region} />
                <text x={22} y={y0 + layout.height / 2 + 24} className={css.bigNumber}>
                  {s + 1}
                </text>
                {op.stages[s]?.estimated && (
                  <text x={80} y={y0 + (stageHasFlagship(stage) ? 67 : 54)} className={css.estimated}>
                    {t('stageEstimated')}
                  </text>
                )}
                {stage.keypoints.map((kp, i) => {
                  const at = layout.markers[i]!
                  const meta = op.keypoints.get(kp.id)
                  const kind = markerKind(op, kp.id)
                  const pk = plannedKeypoint(plan, kp.id)
                  const isSel = kp.id === selected
                  const w = kind === 'flagman' ? 50 : 38
                  const h = kind === 'flagman' ? 49 : 59
                  return (
                    <g key={kp.id} className={cx(css.kp, kp.status === 'missed' && css.missed, kp.status === 'fought' && css.fought, !meta?.revealed && css.hidden)}>
                      <g
                        role="button"
                        tabIndex={0}
                        className={css.kpHit}
                        aria-pressed={isSel}
                        aria-label={`${t('stageN', { n: s + 1 })} ${t('keypointN', { n: meta?.number ?? i + 1 })}`}
                        onClick={() => select({ keypoint: kp.id, lane: null })}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            select({ keypoint: kp.id, lane: null })
                          }
                        }}
                      >
                        {isSel && <circle cx={at.x} cy={at.y} r={32} className={css.ring} />}
                        <image href={asset.marker(kind, meta?.difficulty ?? 2)} x={at.x - w / 2} y={at.y - h / 2} width={w} height={h} />
                        {kp.status === 'fought' && <image href={asset.markerFinished()} x={at.x + w / 2 - 12} y={at.y - h / 2 - 4} width={16} height={16} />}
                        <text x={at.x} y={at.y + h / 2 + 15} className={css.kpLabel} textAnchor="middle">
                          {meta?.number ?? i + 1}
                          {kp.status === 'open' && pk ? (pk.attack ? ` · ${roundPercent(pk.clearedWinProbability)}%` : ` · ${t('skipKeypoint')}`) : ''}
                        </text>
                      </g>
                    </g>
                  )
                })}
              </g>
            )
          })}
          {op.conditions
            .filter(c => c.source && !c.subsequent && c.scope === 'targeted' && c.status !== 'removed')
            .flatMap(c =>
              c.applyTo
                .filter(target => target !== c.source)
                .map(target => {
                  const a = anchor.get(c.source!)
                  const b = anchor.get(target)
                  if (!a || !b) return null
                  const mx = (a.x + b.x) / 2 + 40
                  const d = `M ${a.x + 14} ${a.y + 24} Q ${mx} ${(a.y + b.y) / 2}, ${b.x + 10} ${b.y - 34}`
                  return <path key={`${c.id}-${target}`} d={d} className={css.arrow} markerEnd="url(#condHead)" />
                }),
            )}
        </svg>
        <div className={css.heads}>
          {op.state.stages.map((stage, s) => {
            const layout = layouts[s]!
            const kills = op.stages[s]?.kills ?? null
            const probability = plan?.stages.find(p => p.index === s)?.goalProbability ?? null
            return (
              <div
                key={stage.id}
                className={cx(css.head, s < current && css.headDone)}
                style={{ left: `${(76 / W) * 100}%`, width: `${(208 / W) * 100}%`, top: `${((layout.y0 + 19) / height) * 100}%` }}
              >
                <span className={css.goal}>
                  {kills !== null && s <= current ? t('stageGoalProgress', { kills, n: stage.goal }) : t(op.stages[s]?.goalEstimated ? 'stageGoalEstimated' : 'stageGoalUnits', { n: stage.goal })}
                  {stageHasFlagship(stage) && (
                    <span className={css.primary} title={t('stageGoalPrimaryHint')}>
                      + {t('primaryTarget')}
                    </span>
                  )}
                </span>
                <span className={css.fill} />
                {probability !== null && <span className={cx(css.goalP, 'num')}>{roundPercent(probability)}%</span>}
              </div>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
