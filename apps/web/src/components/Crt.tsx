import { addBernoulli, atLeast, MODIFIERS, modifierById, pointMass, roundPercent, type Contribution, type ModifierId, type ModifierSlot, type SpecIndex } from '@nimitzpf/core'
import type { ReactNode } from 'react'
import { useT } from '../i18n/useT.ts'
import { useBuying } from '../live/store.ts'
import { useVerification, type VerificationState } from '../live/verify.ts'
import { requestSolve, usePlan, useSolveRevision } from '../solver/plan.ts'
import { modifierLedger, removalNeed } from '../state/derive.ts'
import { BOOST, enemyPower, stageHasFlagship } from '../state/model.ts'
import { useStore } from '../state/store.ts'
import { Icon } from '../ui/Icon.tsx'
import { Button, cx } from '../ui/primitives.tsx'
import css from './Crt.module.css'
import type { KeypointContext } from './KeypointSheet.tsx'

function pct(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return '—'
  return `${roundPercent(p)}%`
}

function OddsCell({ p }: { p: number | null }) {
  if (p === null) return <td className={css.none}>—</td>
  const v = roundPercent(p)
  return (
    <td className={cx(css.oddsCell, v >= 100 && css.certain, v <= 0 && css.zero)}>
      <span className="num">{v}</span>
      <small>%</small>
    </td>
  )
}

function Breakdown({ ctx, lane }: { ctx: KeypointContext; lane: number }) {
  const t = useT()
  const result = ctx.evaluation && ctx.evaluation.ok ? ctx.evaluation.lanes[lane] : null
  if (!result || !result.player) return null
  const describe = (c: Contribution) => {
    const s = c.source
    if (s.kind === 'buff') return t('buffFrom', { n: s.from + 1 })
    if (s.kind === 'debuff') return t('debuffFrom', { n: s.from + 1 })
    if (s.kind === 'modifier') return t.modifier(s.id)
    return t('conditionEffect')
  }
  const p = result.player
  const rows = [0, 1, 2].map(k => {
    const spec = k as SpecIndex
    const items = p.contributions.filter(c => c.spec === spec)
    const total = items.reduce((n, c) => n + c.value, 0)
    return { spec, items, total }
  })
  return (
    <section className={css.breakdown}>
      <h3>
        {t('breakdown')} · {t('laneN', { n: lane + 1 })}
      </h3>
      <table>
        <tbody>
          {rows.map(r => (
            <tr key={r.spec}>
              <th>{t.spec(r.spec)}</th>
              <td className="num">{p.base[r.spec]}</td>
              <td className="num">×{p.healthFactor}</td>
              <td className={cx('num', r.total > 0 && css.up, r.total < 0 && css.down)}>
                {r.total === 0 ? '' : `×${(1 + Math.max(r.total, -1)).toFixed(2)}`}
              </td>
              <td className={cx('num', css.final)}>{p.specs[r.spec]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className={css.sources}>
        {p.contributions.map((c, i) => (
          <li key={i}>
            <span>{describe(c)}</span>
            <span className={cx('num', c.value > 0 ? css.up : css.down)}>
              {t.spec(c.spec)} {c.value > 0 ? '+' : ''}
              {Math.round(c.value * 100)}%
            </span>
          </li>
        ))}
        {result.enemy?.contributions.filter(c => c.spec === 0).map((c, i) => (
          <li key={`e${i}`}>
            <span>{describe(c)}</span>
            <span className={cx('num', c.value < 0 ? css.up : css.down)}>
              {t('enemyPower')} {c.value > 0 ? '+' : ''}
              {Math.round(c.value * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function VerifyNote({ state }: { state: VerificationState }) {
  const t = useT()
  if (state.kind === 'off') return null
  if (state.kind === 'checking') return <p className={css.verify}>{t('verifyChecking')}</p>
  if (state.kind === 'match') return <p className={cx(css.verify, css.verifyOk)}>✓ {t('verifyMatch')}</p>
  if (state.kind === 'error') return <p className={css.verify} title={state.error}>{t('verifyUnavailable')}</p>
  return (
    <p className={cx(css.verify, css.verifyBad)} role="alert">
      ⚠ {t('verifyMismatch')}
      {state.lanes.map(l => (
        <span key={l.lane} className="num">
          {t('verifyLane', { n: l.lane + 1, official: pct(l.official), ours: pct(l.ours) })}
        </span>
      ))}
    </p>
  )
}

export function Crt({ ctx }: { ctx: KeypointContext }) {
  const t = useT()
  const plan = usePlan()
  const revision = useSolveRevision()
  const selectedLane = useStore(s => s.selection.lane)
  const boostOn = useStore(s => s.effectiveness)
  const buying = useBuying()
  const verification = useVerification(ctx.op, ctx.kp, ctx.placements, ctx.hp, ctx.pending?.other ?? ctx.evaluation)
  const { kp, meta, stage, placements, evaluation, op, pending } = ctx
  const stock = op.state.inventory
  const lanes = evaluation && evaluation.ok ? evaluation.lanes : null
  const result = plan.operation === op.id ? plan.result : null
  const stale = plan.revision !== revision || plan.status === 'solving'

  let dist = pointMass(0)
  let allWin = 1
  let kills = 0
  let enemies = 0
  kp.lanes.forEach((enemy, i) => {
    if (!enemy || !meta.revealed) return
    enemies++
    const p = lanes?.[i]?.probability ?? 0
    allWin *= p
    kills += p
    dist = addBernoulli(dist, p, placements[i]?.standard === 'moral-impact' ? 2 : 1)
  })
  const settled = kp.status !== 'open'
  const won = kp.lanes.filter((enemy, i) => enemy && kp.record?.[i]?.won).length
  const need = removalNeed(op, kp.id)
  const removal = enemies && need !== null ? atLeast(dist, need) : null
  const hasOutgoing = need !== null
  const plannedStage = result?.stages.find(s => s.index === stage) ?? null
  const stageInput = op.state.stages[stage]!
  const stageKills = op.stages[stage]?.kills ?? null

  const statusText =
    plan.status === 'solving'
      ? t('solving')
      : plan.status === 'error'
        ? plan.error ?? ''
        : result
          ? t('solvedInMs', { ms: Math.round(plan.elapsedMs) })
          : t('solveEmpty')

  const budget = (slot: ModifierSlot) => {
    const defs = MODIFIERS.filter(m => m.type === slot)
    const used = (id: ModifierId) => result?.modifiersUsed[id] ?? 0
    return {
      used: defs.reduce((n, m) => n + (buying && m.id === BOOST ? Math.min(used(m.id), stock[m.id] ?? 0) : used(m.id)), 0),
      stock: defs.reduce((n, m) => n + (stock[m.id] ?? 0), 0),
    }
  }
  const standard = budget(1)
  const special = budget(2)
  const ledger = modifierLedger(op, null)
  const over = MODIFIERS.filter(m => ledger[m.id].over > 0).map(m => `${t.modifier(m.id)} +${ledger[m.id].over}`)
  const fitted = result?.modifiersUsed[BOOST] ?? 0
  const short = buying ? Math.max(0, fitted - (stock[BOOST] ?? 0)) : 0
  const boostLine =
    boostOn && fitted > 0
      ? t(short > 0 ? 'boostPlannedBuy' : 'boostPlanned', {
          m: t.modifier(BOOST),
          used: fitted,
          stock: stock[BOOST] ?? 0,
          n: short,
          cost: short * (modifierById(BOOST)?.price ?? 0),
        })
      : null
  const modifierNote = (result || over.length > 0) && (
    <>
      {result && (
        <div className={css.noteLine}>
          <span>
            {t('modifierBudget', {
              standardUsed: standard.used,
              standardStock: standard.stock,
              specialUsed: special.used,
              specialStock: special.stock,
            })}
          </span>
          {result.truncated && (
            <span className={css.badge} title={t('notConvergedHint')}>
              {t('notConverged')}
            </span>
          )}
        </div>
      )}
      {result && boostLine && <div className={css.noteLine}>{boostLine}</div>}
      {over.length > 0 && (
        <div className={cx(css.noteLine, css.over)} role="alert" title={t('modifierOverHint')}>
          {t('modifierOver', { list: over.join(' · ') })}
        </div>
      )}
    </>
  )

  const totals: { group: string; stale: boolean; rows: { label: string; value: string; sub?: string }[]; note?: ReactNode }[] = [
    {
      group: t('keypointN', { n: meta.number }),
      stale: false,
      rows: settled
        ? [{ label: t('destroyed'), value: String(won), sub: `/${enemies}` }]
        : [
            { label: t('allWin'), value: enemies ? pct(allWin) : '—' },
            { label: t('expectedKills'), value: kills.toFixed(2), sub: `/${enemies}` },
            ...(hasOutgoing ? [{ label: t('removalChance'), value: pct(removal) }] : []),
          ],
    },
    {
      group: `${t('stageN', { n: stage + 1 })} · ${t(op.stages[stage]?.goalEstimated ? 'stageGoalEstimated' : 'stageGoalUnits', { n: stageInput.goal })}${stageHasFlagship(stageInput) ? ` + ${t('primaryTarget')}` : ''}`,
      stale,
      rows: [
        ...(stageKills !== null ? [{ label: t('stageProgress'), value: String(stageKills), sub: `/${stageInput.goal}` }] : []),
        { label: t('goalChance'), value: plannedStage ? pct(plannedStage.goalProbability) : '—' },
        { label: t('expectedKills'), value: plannedStage ? plannedStage.expectedKills.toFixed(2) : '—' },
      ],
    },
    {
      group: t('operationTotals'),
      stale,
      rows: [
        { label: t('completeChance'), value: result ? pct(result.completeProbability) : '—' },
        { label: t('perfectChance'), value: result ? pct(result.perfectProbability) : '—' },
        { label: t('expectedKills'), value: result ? result.expectedKills.toFixed(1) : '—', sub: `/${result?.enemyTotal ?? '—'}` },
      ],
      note: modifierNote,
    },
  ]

  return (
    <aside className={cx(css.crt, 'paper')} aria-label={t('crtTitle')}>
      <header className={css.header}>
        <div>
          <h2>{t('crtTitle')}</h2>
          <span>
            {t('stageN', { n: stage + 1 })} · {t('keypointN', { n: meta.number })}
          </span>
        </div>
        <Button variant="primary" disabled={plan.status === 'solving' || !result} onClick={() => requestSolve(true)}>
          <Icon name="bolt" size={15} />
          {plan.status === 'solving' ? t('solving') : t('solveDeep')}
        </Button>
      </header>

      <table className={css.table}>
        <thead>
          <tr>
            <th />
            {[1, 2, 3, 4].map(n => (
              <th key={n} className={cx(selectedLane === n - 1 && css.colOn)}>
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th>{t('ourPower')}</th>
            {[0, 1, 2, 3].map(i => {
              const p = lanes?.[i]?.player
              return (
                <td key={i} className={cx('num', css.range)}>
                  {p ? (
                    <>
                      {Math.round(p.low)}
                      <i>–</i>
                      {Math.round(p.high)}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              )
            })}
          </tr>
          <tr>
            <th>{t('enemyPower')}</th>
            {[0, 1, 2, 3].map(i => {
              const e = lanes?.[i]?.enemy
              const slot = meta.revealed ? kp.lanes[i] : null
              return (
                <td key={i} className="num">
                  {e ? e.power : slot ? enemyPower(slot.enemy) : '—'}
                </td>
              )
            })}
          </tr>
          <tr className={css.oddsRow}>
            <th>{settled ? t('laneResult') : t('winChance')}</th>
            {[0, 1, 2, 3].map(i =>
              settled ? (
                <td key={i} className={kp.lanes[i] ? cx(css.outcome, kp.record?.[i]?.won && css.outcomeWon) : css.none}>
                  {kp.lanes[i] ? (kp.record?.[i]?.won ? t('destroyed') : t('laneSurvived')) : '—'}
                </td>
              ) : (
                <OddsCell key={i} p={lanes?.[i]?.probability ?? null} />
              ),
            )}
          </tr>
        </tbody>
      </table>
      <p className={css.caption} aria-live="polite">
        {statusText}
        {pending && ` · ${t('crtSwept')}`}
      </p>
      <VerifyNote state={verification} />

      <table className={css.totals}>
        {totals.map(block => (
          <tbody key={block.group} className={cx(block.stale && css.stale)}>
            <tr>
              <th colSpan={2} className={css.group}>
                {block.group}
              </th>
            </tr>
            {block.rows.map(row => (
              <tr key={row.label}>
                <th>{row.label}</th>
                <td className="num">
                  {row.value}
                  {row.sub && <small>{row.sub}</small>}
                </td>
              </tr>
            ))}
            {block.note && (
              <tr>
                <td colSpan={2} className={css.note}>
                  {block.note}
                </td>
              </tr>
            )}
          </tbody>
        ))}
      </table>

      {selectedLane !== null && <Breakdown ctx={ctx} lane={selectedLane} />}
    </aside>
  )
}
