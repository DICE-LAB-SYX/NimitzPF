import type { Objective } from '@nimitzpf/core'
import { useState } from 'react'
import { asset } from '../game/assets.ts'
import { LOCALE_LABEL, LOCALES } from '../i18n/index.ts'
import { useT } from '../i18n/useT.ts'
import { embedded, send } from '../live/channel.ts'
import { defaultOperation, useLive, useOperations, type Connection } from '../live/store.ts'
import { BOOST } from '../state/model.ts'
import { useStore } from '../state/store.ts'
import { Button, cx, Dialog, Segmented, Stars, Toggle } from '../ui/primitives.tsx'
import { AutoToggle, BuyToggle } from './AutoPlay.tsx'
import { RewardWeights } from './RewardWeights.tsx'
import css from './TopBar.module.css'

const REALM: Readonly<Record<string, string>> = { sg: 'ASIA', eu: 'EU', us: 'NA', cn360: 'CN' }

function connectionKey(c: Connection) {
  return (
    {
      waiting: 'connWaiting',
      live: 'connLive',
      unauth: 'connUnauth',
      'no-season': 'connNoSeason',
      offline: 'connOffline',
      demo: 'connDemo',
    } as const
  )[c]
}

function operationName(t: ReturnType<typeof useT>, name: string, n: number): string {
  const key = `IDS_OPERATION_NAME_${name.toUpperCase()}`
  const text = t.game(key)
  return text === key ? t('operationN', { n }) : text
}

function since(at: number, t: ReturnType<typeof useT>): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  return seconds < 60 ? t('syncedSeconds', { n: seconds }) : t('syncedMinutes', { n: Math.round(seconds / 60) })
}

export function TopBar() {
  const t = useT()
  const operations = useOperations()
  const snapshot = useLive(s => s.snapshot)
  const connection = useLive(s => s.connection)
  const syncing = useLive(s => s.syncing)
  const layout = useLive(s => s.layout)
  const selected = useStore(s => s.selection.operation) ?? defaultOperation(snapshot)
  const objective = useStore(s => s.objective)
  const locale = useStore(s => s.locale)
  const boost = useStore(s => s.effectiveness)
  const setEffectiveness = useStore(s => s.setEffectiveness)
  const setObjective = useStore(s => s.setObjective)
  const setLocale = useStore(s => s.setLocale)
  const select = useStore(s => s.select)
  const [weightsOpen, setWeightsOpen] = useState(false)
  const inGame = snapshot?.state?.status.operationId != null ? String(snapshot.state.status.operationId) : null
  const realm = snapshot?.realm ? (REALM[snapshot.realm] ?? snapshot.realm.toUpperCase()) : null
  const nickname = snapshot?.state?.status.accountNickname

  return (
    <header className={css.bar}>
      <div className={css.brand}>
        <span className={css.mark}>
          NIMITZ<b>PF</b>
        </span>
        <span className={cx(css.conn, css[`conn_${connection}`])} title={snapshot ? since(snapshot.at, t) : undefined}>
          <i className={cx(css.dot, syncing && css.dotBusy)} />
          {realm && <b>{realm}</b>}
          {nickname ?? t(connectionKey(connection))}
        </span>
        <span className={css.actions}>
          {embedded() && (
            <button type="button" className={css.refresh} onClick={() => send({ type: 'refresh' })} disabled={syncing} title={t('refresh')}>
              {t('refresh')}
            </button>
          )}
          {layout && (
            <>
              <button
                type="button"
                className={css.refresh}
                onClick={() => send({ type: 'layout', push: !layout.push })}
                title={layout.push ? t('dockOverlayHint') : t('dockPushHint')}
              >
                {layout.push ? t('dockOverlay') : t('dockPush')}
              </button>
              <button type="button" className={css.refresh} onClick={() => send({ type: 'layout', collapsed: true })}>
                {t('dockCollapse')}
              </button>
            </>
          )}
        </span>
      </div>

      <nav className={css.ops} aria-label={t('operation')}>
        {[...operations.values()].map((op, i) => (
          <button
            key={op.id}
            type="button"
            className={cx(css.tab, op.id === selected && css.tabOn, op.finished && css.tabDone)}
            onClick={() => select({ operation: op.id, keypoint: null, lane: null })}
            title={op.finished ? t('operationFinished') : op.id === inGame ? t('operationInProgress') : t('operationPreview')}
          >
            <span className={css.opName}>{operationName(t, op.name, i + 1)}</span>
            <Stars count={op.difficulty} max={op.difficulty} size={10} />
            {op.id === inGame && <i className={css.live} />}
          </button>
        ))}
      </nav>

      <div className={css.tools}>
        <Segmented<Objective>
          label={t('objective')}
          value={objective}
          onChange={setObjective}
          options={[
            { value: 'complete', label: t('objectiveComplete'), title: t('objectiveCompleteHint') },
            { value: 'perfect', label: t('objectivePerfect'), title: t('objectivePerfectHint') },
            { value: 'reward', label: t('objectiveReward'), title: t('objectiveRewardHint') },
          ]}
        />
        {objective === 'reward' && (
          <button type="button" className={css.weights} onClick={() => setWeightsOpen(true)}>
            {t('rewardWeights')}
          </button>
        )}
        <Toggle checked={boost} onChange={setEffectiveness} title={t('boostHint', { m: t.modifier(BOOST) })}>
          <img src={asset.modifier(BOOST)} alt="" />
          {t.modifier(BOOST)}
        </Toggle>
        <AutoToggle />
        <BuyToggle />
        <Segmented size="sm" label={t('language')} value={locale} onChange={l => setLocale(l)} options={LOCALES.map(l => ({ value: l, label: LOCALE_LABEL[l] }))} />
      </div>

      {weightsOpen && (
        <Dialog
          open
          onClose={() => setWeightsOpen(false)}
          title={t('rewardWeights')}
          footer={
            <Button variant="primary" onClick={() => setWeightsOpen(false)}>
              {t('close')}
            </Button>
          }
        >
          <RewardWeights />
        </Dialog>
      )}
    </header>
  )
}
