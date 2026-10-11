import { DATA_BUILD } from '@nimitzpf/core'
import { useEffect } from 'react'
import css from './App.module.css'
import { Crt } from './components/Crt.tsx'
import { Dock } from './components/Dock.tsx'
import { KeypointSheet, useKeypointContext } from './components/KeypointSheet.tsx'
import { StageChart } from './components/StageChart.tsx'
import { StageStrip } from './components/StageStrip.tsx'
import { TopBar } from './components/TopBar.tsx'
import { useT } from './i18n/useT.ts'
import { downloadSnapshot } from './live/export.ts'
import { currentOperation, useLive, useOperation, type Connection } from './live/store.ts'
import { requestSolve, useAutoSolve } from './solver/plan.ts'
import type { Operation } from './state/derive.ts'
import { useStore } from './state/store.ts'
import { loadLocaleFonts } from './styles/fonts.ts'

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, dialog[open]') || target.isContentEditable)) return
      if (document.querySelector('dialog[open]')) return
      const s = useStore.getState()
      const op = currentOperation()
      if (!op) return
      const flat = op.state.stages.flatMap((stage, si) => stage.keypoints.map(k => ({ id: k.id, stage: si })))
      const at = Math.max(0, flat.findIndex(k => k.id === s.selection.keypoint))
      if (/^[1-4]$/.test(e.key)) {
        s.select({ lane: (Number(e.key) - 1) as 0 | 1 | 2 | 3 })
        e.preventDefault()
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = flat[Math.min(flat.length - 1, Math.max(0, at + (e.key === 'ArrowRight' ? 1 : -1)))]
        if (next) s.select({ keypoint: next.id, lane: null })
        e.preventDefault()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const stage = (flat[at]?.stage ?? 0) + (e.key === 'ArrowDown' ? 1 : -1)
        const first = op.state.stages[stage]?.keypoints[0]
        if (first) s.select({ keypoint: first.id, lane: null })
        e.preventDefault()
      } else if (e.key === 'Enter' && (!target || target === document.body)) {
        requestSolve(true)
        e.preventDefault()
      } else if (e.key === 'Escape') {
        s.select({ lane: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

const STATUS_KEY = {
  waiting: 'statusWaiting',
  live: 'statusNoOperation',
  unauth: 'statusUnauth',
  'no-season': 'statusNoSeason',
  offline: 'statusOffline',
  demo: 'statusNoOperation',
} as const satisfies Record<Connection, string>

function StatusScreen({ connection }: { connection: Connection }) {
  const t = useT()
  return (
    <main className={css.status}>
      <div className={css.statusCard}>
        <h1>{t(STATUS_KEY[connection])}</h1>
        <p>{t(`${STATUS_KEY[connection]}Hint`)}</p>
      </div>
    </main>
  )
}

function Notices({ op }: { op: Operation }) {
  const t = useT()
  const data = useLive(s => s.data)
  const notes: string[] = []
  if (data) notes.push(t('noticeNewerData', { build: data.build }))
  if (op.finished) notes.push(t('noticeFinished'))
  for (const issue of op.issues) {
    if (issue.kind === 'kills') notes.push(t('noticeKills', { n: issue.stage + 1, server: issue.server, local: issue.local }))
    else notes.push(t('noticeGoal', { n: issue.stage + 1, type: issue.type }))
  }
  if (!notes.length) return null
  return (
    <ul className={css.notices}>
      {notes.map(n => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  )
}

function Battle({ op }: { op: Operation }) {
  const ctx = useKeypointContext()
  const selected = ctx?.kp.id ?? null
  return (
    <>
      <main className={css.battle}>
        <div className={css.left}>
          <StageChart op={op} selected={selected} />
        </div>
        <div className={css.center}>
          <StageStrip op={op} selected={selected} />
          <Notices op={op} />
          {ctx && <KeypointSheet ctx={ctx} />}
        </div>
        <div className={css.right}>{ctx && <Crt ctx={ctx} />}</div>
      </main>
      <Dock op={op} ctx={ctx} />
    </>
  )
}

export function App() {
  const t = useT()
  const locale = useStore(s => s.locale)
  const connection = useLive(s => s.connection)
  const snapshot = useLive(s => s.snapshot)
  const op = useOperation()
  useAutoSolve()
  useShortcuts()
  useEffect(() => {
    document.documentElement.lang = locale
    void loadLocaleFonts(locale)
  }, [locale])
  return (
    <div className={css.app}>
      <TopBar />
      {op && (connection === 'live' || connection === 'demo') ? <Battle op={op} /> : <StatusScreen connection={connection} />}
      <footer className={css.footer}>
        <span>{t('disclaimer')}</span>
        <span className={css.shortcuts}>
          <b>{t('shortcuts')}</b> {t('shortcutsList')}
        </span>
        <span className={css.footerEnd}>
          {snapshot && connection === 'live' && (
            <button type="button" className={css.export} title={t('exportDataHint')} onClick={() => downloadSnapshot(snapshot)}>
              {t('exportData')}
            </button>
          )}
          <span className="num">{t('dataBuild', { build: DATA_BUILD })}</span>
        </span>
      </footer>
    </div>
  )
}
