import { useEffect, useState, type ReactNode } from 'react'
import { LOADER } from '../bridge/protocol.ts'
import { USERSCRIPT_EVENT, USERSCRIPT_FILE, USERSCRIPT_VERSION } from '../bridge/userscript.ts'
import { LOCALE_LABEL, LOCALES } from '../i18n/index.ts'
import type { UiKey } from '../i18n/ui.ts'
import { useT } from '../i18n/useT.ts'
import { useStore } from '../state/store.ts'
import { loadLocaleFonts } from '../styles/fonts.ts'
import { cx, Segmented } from '../ui/primitives.tsx'
import { DragDemo, Preview, ToggleDemo } from './Illustrations.tsx'
import css from './Landing.module.css'

type Method = 'script' | 'bookmark'
type Browser = 'edge' | 'chrome' | 'firefox'

const REALMS: readonly { key: UiKey; url: string }[] = [
  { key: 'landingRealmAsia', url: 'https://pacificfront.worldofwarships.asia/zh-sg/operations' },
  { key: 'landingRealmEu', url: 'https://pacificfront.worldofwarships.eu/en/operations' },
  { key: 'landingRealmNa', url: 'https://pacificfront.worldofwarships.com/en/operations' },
  { key: 'landingRealmCn', url: 'https://oceanfront.wowsgame.cn/zh-cn/operations' },
]

const STORES: readonly { browser: Browser; key: UiKey; url: string }[] = [
  { browser: 'edge', key: 'landingStoreEdge', url: 'https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd' },
  { browser: 'chrome', key: 'landingStoreChrome', url: 'https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo' },
  { browser: 'firefox', key: 'landingStoreFirefox', url: 'https://addons.mozilla.org/firefox/addon/tampermonkey/' },
]

function bridgeUrl(): string {
  return new URL(import.meta.env.DEV ? 'src/bridge/main.ts' : 'bridge.js', document.baseURI).href
}

function bookmarklet(url: string): string {
  return `javascript:(()=>{const s=document.createElement('script');s.type='module';s.src=${JSON.stringify(url)}+'?loader=${LOADER}&v='+Date.now();document.head.append(s)})()`
}

function olderThan(version: string, latest: string): boolean {
  const a = version.split('.').map(Number)
  const b = latest.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0)
    if (d !== 0) return d < 0
  }
  return false
}

function detectBrowser(): Browser {
  const ua = navigator.userAgent
  return /\bEdg\//.test(ua) ? 'edge' : /\bFirefox\//.test(ua) ? 'firefox' : 'chrome'
}

function shortcutKeys(): readonly string[] {
  return /Macintosh|Mac OS X/.test(navigator.userAgent) ? ['⌘', 'Shift', 'B'] : ['Ctrl', 'Shift', 'B']
}

function useUserscript(): string | null {
  const read = () => document.documentElement.dataset.nimitzpfUserscript ?? null
  const [version, setVersion] = useState(read)
  useEffect(() => {
    const update = () => setVersion(read())
    window.addEventListener(USERSCRIPT_EVENT, update)
    update()
    return () => window.removeEventListener(USERSCRIPT_EVENT, update)
  }, [])
  return version
}

function useMethod(): [Method, (method: Method) => void] {
  const [method, setMethod] = useState<Method>(() => (window.location.hash === '#bookmark' ? 'bookmark' : 'script'))
  const change = (next: Method) => {
    setMethod(next)
    history.replaceState(null, '', next === 'bookmark' ? '#bookmark' : `${window.location.pathname}${window.location.search}`)
  }
  return [method, change]
}

function Step({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <li className={css.step}>
      <span className={css.stepNo}>{n}</span>
      <div className={css.stepBody}>
        <h3>{title}</h3>
        {children}
      </div>
    </li>
  )
}

function Realms() {
  const t = useT()
  return (
    <div className={css.links}>
      {REALMS.map(r => (
        <a key={r.key} className={css.link} href={r.url} target="_blank" rel="noreferrer">
          {t(r.key)}
        </a>
      ))}
    </div>
  )
}

function ScriptSteps() {
  const t = useT()
  const version = useUserscript()
  const outdated = version !== null && olderThan(version, USERSCRIPT_VERSION)
  const [browser] = useState(detectBrowser)
  return (
    <ol className={css.steps}>
      <Step n={1} title={t('landingScript1')}>
        <p>{t('landingScript1Hint')}</p>
        <div className={css.links}>
          {STORES.map(s => (
            <a key={s.browser} className={cx(css.link, s.browser === browser && css.linkOn)} href={s.url} target="_blank" rel="noreferrer">
              {t(s.key)}
              {s.browser === browser && <small>{t('landingStoreCurrent')}</small>}
            </a>
          ))}
        </div>
      </Step>
      <Step n={2} title={t('landingScript2')}>
        {browser === 'firefox' ? (
          <p>{t('landingScript2Firefox')}</p>
        ) : (
          <>
            <p>{t('landingScript2Hint')}</p>
            <ToggleDemo label={t('landingToggleLabel')} />
          </>
        )}
      </Step>
      <Step n={3} title={t('landingScript3')}>
        <p>{t('landingScript3Hint')}</p>
        <div className={css.links}>
          <a className={css.primary} href={USERSCRIPT_FILE}>
            {t('landingScriptInstall')}
          </a>
        </div>
        <p className={cx(css.status, version && !outdated && css.statusOn)} role="status">
          {!version
            ? t('landingScriptMissing')
            : outdated
              ? t('landingScriptOutdated', { version, latest: USERSCRIPT_VERSION })
              : `✓ ${t('landingScriptFound', { version })}`}
        </p>
      </Step>
      <Step n={4} title={t('landingScript4')}>
        <p>{t('landingScript4Hint')}</p>
        <Realms />
      </Step>
    </ol>
  )
}

function BookmarkSteps() {
  const t = useT()
  const code = bookmarklet(bridgeUrl())
  const [copied, setCopied] = useState(false)
  const [nudged, setNudged] = useState(0)
  const [before, after] = t('landingBookmark1Hint').split('{keys}')
  const keys = shortcutKeys().map((k, i) => (
    <span key={k}>
      {i > 0 && ' + '}
      <kbd>{k}</kbd>
    </span>
  ))
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <ol className={css.steps}>
      <Step n={1} title={t('landingBookmark1')}>
        <p>
          {before}
          {keys}
          {after}
        </p>
      </Step>
      <Step n={2} title={t('landingBookmark2')}>
        <p>{t('landingBookmark2Hint')}</p>
        <DragDemo key={nudged} />
        <div className={css.links}>
          <a
            ref={el => el?.setAttribute('href', code)}
            key={nudged}
            className={cx(css.bookmarklet, nudged > 0 && css.nudge)}
            draggable
            onClick={e => {
              e.preventDefault()
              setNudged(n => n + 1)
            }}
          >
            NimitzPF
          </a>
        </div>
        <details className={css.manual}>
          <summary>{t('landingCopy')}</summary>
          <p>{t('landingCopyHint')}</p>
          <textarea readOnly value={code} rows={3} onFocus={e => e.currentTarget.select()} />
          <button type="button" onClick={copy}>
            {copied ? t('landingCopied') : t('landingCopyButton')}
          </button>
        </details>
      </Step>
      <Step n={3} title={t('landingBookmark3')}>
        <p>{t('landingBookmark3Hint')}</p>
        <Realms />
      </Step>
    </ol>
  )
}

const TIPS: readonly (readonly [UiKey, UiKey])[] = [
  ['landingTipModifiers', 'landingTipModifiersHint'],
  ['landingTipBoost', 'landingTipBoostHint'],
  ['landingTipUnits', 'landingTipUnitsHint'],
  ['landingTipManual', 'landingTipManualHint'],
]

function Tips() {
  const t = useT()
  return (
    <section className={css.tips}>
      <h2>{t('landingTipsTitle')}</h2>
      <ul>
        {TIPS.map(([title, hint]) => (
          <li key={title}>
            <b>{t(title)}</b>
            <p>{t(hint)}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Help() {
  const t = useT()
  const items: readonly { q: string; a: readonly string[] }[] = [
    { q: t('landingHelpNothing'), a: [t('landingHelpNothingScript'), t('landingHelpNothingBookmark')] },
    { q: t('landingHelpTab'), a: [t('landingHelpTabHint')] },
    { q: t('landingHelpLogin', { status: t('statusUnauth') }), a: [t('landingHelpLoginHint')] },
    { q: t('landingHelpAuto'), a: [t('landingHelpAutoHint')] },
    { q: t('landingHelpFailed'), a: [t('landingHelpFailedHint')] },
    { q: t('landingHelpClient'), a: [t('landingHelpClientHint')] },
  ]
  return (
    <section className={css.help}>
      <h2>{t('landingHelpTitle')}</h2>
      {items.map(item => (
        <details key={item.q} className={css.faq}>
          <summary>{item.q}</summary>
          {item.a.map(a => (
            <p key={a}>{a}</p>
          ))}
        </details>
      ))}
    </section>
  )
}

export function Landing() {
  const t = useT()
  const locale = useStore(s => s.locale)
  const setLocale = useStore(s => s.setLocale)
  const [method, setMethod] = useMethod()
  useEffect(() => {
    document.documentElement.lang = locale
    void loadLocaleFonts(locale)
  }, [locale])
  const methods: readonly { value: Method; title: string; hint: string; tag?: string }[] = [
    { value: 'script', title: t('landingMethodScript'), hint: t('landingMethodScriptHint'), tag: t('landingMethodScriptTag') },
    { value: 'bookmark', title: t('landingMethodBookmark'), hint: t('landingMethodBookmarkHint') },
  ]
  return (
    <div className={css.page}>
      <header className={css.header}>
        <span className={css.mark}>
          NIMITZ<b>PF</b>
        </span>
        <Segmented size="sm" label={t('language')} value={locale} onChange={l => setLocale(l)} options={LOCALES.map(l => ({ value: l, label: LOCALE_LABEL[l] }))} />
      </header>
      <main className={css.main}>
        <section className={css.hero}>
          <h1>{t('landingTitle')}</h1>
          <p>{t('landingLead')}</p>
          <a className={css.demo} href="?demo">
            {t('landingDemo')}
          </a>
        </section>

        <figure className={css.figure}>
          <Preview game={t('landingPreviewGame')} panel={t('landingPreviewPanel')} />
          <figcaption>{t('landingPreviewCaption')}</figcaption>
        </figure>

        <section className={css.install}>
          <h2>{t('landingInstallTitle')}</h2>
          <div className={css.methods} role="tablist" aria-label={t('landingInstallTitle')}>
            {methods.map(m => (
              <button
                key={m.value}
                type="button"
                role="tab"
                id={`method-${m.value}`}
                aria-selected={method === m.value}
                aria-controls="method-panel"
                className={cx(css.method, method === m.value && css.methodOn)}
                onClick={() => setMethod(m.value)}
              >
                <span className={css.methodTitle}>
                  {m.title}
                  {m.tag && <span className={css.tag}>{m.tag}</span>}
                </span>
                <span className={css.methodHint}>{m.hint}</span>
              </button>
            ))}
          </div>
          <div className={css.sheet} role="tabpanel" id="method-panel" aria-labelledby={`method-${method}`}>
            {method === 'script' ? <ScriptSteps /> : <BookmarkSteps />}
          </div>
        </section>

        <Tips />

        <Help />

        <section className={css.notes}>
          <h2>{t('landingNotes')}</h2>
          <ul>
            <li>{t('landingNoteDesktop')}</li>
            <li>{t('landingNoteReadOnly')}</li>
            <li>{t('landingNoteAuto')}</li>
            <li>{t('landingNotePrivacy')}</li>
            <li>{t('landingNoteExact')}</li>
          </ul>
        </section>
      </main>
      <footer className={css.footer}>{t('disclaimer')}</footer>
    </div>
  )
}
