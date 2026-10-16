import { useEffect, useState } from 'react'
import type { DriveStep } from '../bridge/protocol.ts'
import type { Params } from '../i18n/index.ts'
import type { UiKey } from '../i18n/ui.ts'
import { useT } from '../i18n/useT.ts'
import {
  lineupProblem,
  playNow,
  PROBLEM_NOTE,
  readiness,
  READINESS_NOTE,
  runPlan,
  startAuto,
  stopAuto,
  useAuto,
  type AutoAction,
  type AutoNote,
  type Readiness,
} from '../live/autoplay.ts'
import { useLive } from '../live/store.ts'
import type { Operation } from '../state/derive.ts'
import { useStore } from '../state/store.ts'
import { Icon } from '../ui/Icon.tsx'
import { Button, cx, Dialog } from '../ui/primitives.tsx'
import css from './AutoPlay.module.css'
import type { KeypointContext } from './KeypointSheet.tsx'

const PHASE_TEXT: Readonly<Record<AutoAction, Readonly<Record<'countdown' | 'playing' | 'waiting', UiKey>>>> = {
  battle: { countdown: 'autoCountdown', playing: 'autoPlaying', waiting: 'autoWaiting' },
  advance: { countdown: 'autoCountdownAdvance', playing: 'autoAdvancing', waiting: 'autoWaitingStage' },
}

const STEP_TEXT: Readonly<Record<DriveStep, UiKey>> = {
  open: 'autoStepOpen',
  card: 'autoStepCard',
  modifier: 'autoStepModifier',
  battle: 'autoStepBattle',
  result: 'autoStepResult',
  stage: 'autoStepStage',
  aborted: 'autoStepBattle',
}

function useReadiness(): Readiness {
  const connection = useLive(s => s.connection)
  const bridge = useLive(s => s.bridge)
  return readiness(connection, bridge)
}

function useNow(active: boolean): number {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => tick(n => n + 1), 250)
    return () => window.clearInterval(timer)
  }, [active])
  return Date.now()
}

function installUrl(hash: string): string {
  const url = new URL('./', window.location.href)
  url.hash = hash
  return url.href
}

function useNames(op: Operation | null) {
  const t = useT()
  const label = (stage: number, n: number) => `${t('stageN', { n: stage })}·${t('keypointN', { n })}`
  const of = (keypointId: string | null) => {
    const meta = keypointId ? op?.keypoints.get(keypointId) : undefined
    return meta ? label(meta.stage + 1, meta.number) : ''
  }
  const params = (note: AutoNote): Params => {
    const p: Params = { ...note.params, ...(note.step && { step: t(STEP_TEXT[note.step]) }) }
    return typeof p.stage === 'number' && typeof p.n === 'number' ? { ...p, name: label(p.stage, p.n) } : p
  }
  return { of, params }
}

function Reinstall() {
  const t = useT()
  return (
    <span className={css.links}>
      <a href={installUrl('')} target="_blank" rel="noreferrer">
        {t('autoReinstallScript')}
      </a>
      <a href={installUrl('bookmark')} target="_blank" rel="noreferrer">
        {t('autoReinstallBookmark')}
      </a>
    </span>
  )
}

function Consent({ onAccept, onClose }: { onAccept: () => void; onClose: () => void }) {
  const t = useT()
  const ready = useReadiness()
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('autoConsentTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('autoConsentNo')}</Button>
          <Button variant="primary" onClick={onAccept}>
            {t('autoConsentOk')}
          </Button>
        </>
      }
    >
      <div className={css.consent}>
        <p>{t('autoConsentWhat')}</p>
        <p>{t('autoConsentLimits')}</p>
        <p className={css.stock}>{t('autoConsentStock')}</p>
        <p className={css.risk}>{t('autoConsentRisk')}</p>
        {ready === 'old-loader' || ready === 'old-bridge' ? (
          <p className={css.warn}>
            {t(READINESS_NOTE[ready])}
            {ready === 'old-loader' && <Reinstall />}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}

export function AutoToggle() {
  const t = useT()
  const on = useStore(s => s.autoplay)
  const setAutoplay = useStore(s => s.setAutoplay)
  const [asking, setAsking] = useState(false)
  const toggle = () => {
    if (!on) {
      setAsking(true)
      return
    }
    stopAuto()
    setAutoplay(false)
  }
  return (
    <>
      <label className={css.toggle} title={t('autoplayHint')}>
        <input type="checkbox" checked={on} onChange={toggle} />
        {t('autoplay')}
      </label>
      {asking && (
        <Consent
          onClose={() => setAsking(false)}
          onAccept={() => {
            setAutoplay(true)
            setAsking(false)
          }}
        />
      )}
    </>
  )
}

export function AutoBar({ op }: { op: Operation }) {
  const t = useT()
  const on = useStore(s => s.autoplay)
  const ready = useReadiness()
  const auto = useAuto()
  const snapshot = useLive(s => s.snapshot)
  const now = useNow(auto.phase === 'countdown')
  const names = useNames(op)
  const run = runPlan(snapshot, op)
  if (!on) return null

  const note = auto.note
  const noteText = note ? t(note.key, names.params(note)) : null
  const name = names.of(auto.target)
  let main: string
  let sub: string | null = null
  let tone: AutoNote['tone'] | null = null
  if (ready !== 'ready') {
    main = t(READINESS_NOTE[ready])
    tone = ready === 'old-loader' || ready === 'old-bridge' ? 'error' : 'info'
  } else if (auto.running || auto.phase === 'playing') {
    const params = { s: Math.max(1, Math.ceil(((auto.deadline ?? now) - now) / 1000)), name, n: auto.stage ?? 0 }
    const phase = auto.phase === 'countdown' || auto.phase === 'playing' || auto.phase === 'waiting' ? auto.phase : null
    main = phase && auto.action ? t(PHASE_TEXT[auto.action][phase], params) : t('autoThinking')
    sub = [auto.phase === 'playing' ? t('autoHandsOff') : null, auto.played > 0 ? t('autoPlayedCount', { n: auto.played }) : null, noteText].filter(Boolean).join(' · ') || null
  } else if (note && noteText) {
    main = noteText
    tone = note.tone
  } else {
    main = t(run.hint)
    if (!run.operation) tone = 'info'
    else sub = t('autoIdleTip')
  }

  return (
    <section className={cx(css.bar, auto.running && css.running, tone && css[`tone_${tone}`])} aria-live="polite">
      <span className={css.badge}>
        <i className={css.dot} />
        {t('autoplay')}
      </span>
      <div className={css.text}>
        <p className={css.main}>
          {main}
          {ready === 'old-loader' && <Reinstall />}
        </p>
        {tone && note?.detail && <p className={cx(css.sub, css.detail)}>{note.detail}</p>}
        {sub && <p className={css.sub}>{sub}</p>}
      </div>
      {ready === 'ready' &&
        (auto.running || auto.phase === 'playing' ? (
          <Button variant="danger" onClick={() => stopAuto()}>
            {t('autoStop')}
          </Button>
        ) : (
          <Button variant="primary" disabled={auto.phase !== 'idle' || !run.operation} title={run.operation ? t('autoRunHint') : t(run.hint)} onClick={startAuto}>
            <Icon name="bolt" size={14} />
            {t('autoRun')}
          </Button>
        ))}
    </section>
  )
}

export function PlayButton({ ctx }: { ctx: KeypointContext }) {
  const t = useT()
  const on = useStore(s => s.autoplay)
  const ready = useReadiness()
  const snapshot = useLive(s => s.snapshot)
  const phase = useAuto(s => s.phase)
  const running = useAuto(s => s.running)
  const target = useAuto(s => s.target)
  const names = useNames(ctx.op)
  const { op, kp, meta, stage, placements } = ctx
  if (!on || meta.raw !== 'revealed' || stage !== op.state.currentStage || op.finished) return null
  const problem = lineupProblem(op, snapshot, kp.id, placements)
  const blocked = ready !== 'ready' ? t(READINESS_NOTE[ready]) : problem ? t(PROBLEM_NOTE[problem], { name: names.of(kp.id) }) : null
  const mine = phase === 'playing' && target === kp.id
  return (
    <Button
      variant="primary"
      disabled={running || phase !== 'idle' || blocked !== null}
      title={blocked ?? t('playNowHint')}
      onClick={() => void playNow(op, kp.id, placements)}
    >
      <Icon name="bolt" size={15} />
      {mine ? t('playNowBusy') : t('playNow')}
    </Button>
  )
}
