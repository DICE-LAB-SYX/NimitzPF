import { envelope, opened, PROTOCOL, type BridgeMessage, type PanelMessage } from './protocol.ts'
import { Sync, type PageInfo } from './sync.ts'
import { predict, type Adeck } from './verify.ts'

interface PageGlobals {
  __nimitzpf?: { toggle(): void }
  adeck?: Adeck
  defaultState?: { settings?: unknown }
  settings?: { REALM?: string; STATIC_URL?: string }
}

interface DockLayout {
  width: number
  collapsed: boolean
  push: boolean
}

const page = window as unknown as PageGlobals
const LAYOUT_KEY = 'nimitzpf:dock'
const MIN_WIDTH = 340
const MIN_ZOOM = 0.6

function readLayout(): DockLayout {
  const fallback: DockLayout = { width: 440, collapsed: false, push: true }
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<DockLayout> | null
    return raw ? { ...fallback, ...raw } : fallback
  } catch {
    return fallback
  }
}

function saveLayout(layout: DockLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  } catch {
    return
  }
}

function panelUrl(): URL {
  let override: string | null = null
  try {
    override = localStorage.getItem('nimitzpf:panel')
  } catch {
    override = null
  }
  const url = override ? new URL(override) : new URL(import.meta.url.includes('/src/bridge/') ? '../../' : './', import.meta.url)
  url.searchParams.set('embed', '1')
  url.searchParams.set('p', String(PROTOCOL))
  return url
}

function pageInfo(): PageInfo {
  const staticUrl = page.settings?.STATIC_URL ?? ''
  return {
    settings: page.defaultState?.settings ?? null,
    realm: page.settings?.REALM ?? null,
    build: staticUrl.split('/').filter(Boolean).pop() ?? null,
  }
}

const STYLE = `
:host { all: initial; }
.dock { position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483000; display: flex; background: #0b2a30; box-shadow: -6px 0 18px rgba(0, 0, 0, 0.4); }
.dock.hidden { display: none; }
.grip { flex: none; width: 6px; cursor: ew-resize; background: #143f47; }
.grip:hover, .grip.active { background: #3d7b84; }
iframe { flex: 1; width: 100%; height: 100%; border: 0; background: #0b2a30; color-scheme: dark; }
iframe.dragging { pointer-events: none; }
.tab { position: fixed; right: 0; top: 38%; z-index: 2147483000; display: none; padding: 12px 7px; border: 0; border-radius: 7px 0 0 7px;
  background: #143f47; color: #d2e4e3; font: 600 13px/1.2 system-ui, sans-serif; writing-mode: vertical-rl; letter-spacing: 1px; cursor: pointer;
  box-shadow: -3px 0 10px rgba(0, 0, 0, 0.35); }
.tab.shown { display: block; }
.tab:hover { background: #1a4c55; }
`

function mount(): void {
  const panel = panelUrl()
  const origin = panel.origin
  let layout = readLayout()

  const host = document.createElement('div')
  host.id = 'nimitzpf-dock'
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = STYLE
  const dock = document.createElement('div')
  dock.className = 'dock'
  const grip = document.createElement('div')
  grip.className = 'grip'
  const frame = document.createElement('iframe')
  frame.src = panel.href
  frame.title = 'NimitzPF'
  const tab = document.createElement('button')
  tab.className = 'tab'
  tab.textContent = 'NimitzPF'
  dock.append(grip, frame)
  root.append(style, dock, tab)
  document.documentElement.append(host)

  const fitGame = () => {
    const body = document.body
    if (!body) return
    body.style.removeProperty('zoom')
    if (!layout.push || layout.collapsed) return
    const min = parseFloat(getComputedStyle(body).minWidth) || 0
    const room = document.documentElement.getBoundingClientRect().width
    if (min > room) body.style.setProperty('zoom', String(Math.max(MIN_ZOOM, room / min)))
  }
  const width = () => Math.max(MIN_WIDTH, Math.min(layout.width, window.innerWidth - 320))
  const apply = () => {
    const w = width()
    dock.style.width = `${w}px`
    dock.classList.toggle('hidden', layout.collapsed)
    tab.classList.toggle('shown', layout.collapsed)
    if (layout.push && !layout.collapsed) document.documentElement.style.setProperty('margin-right', `${w}px`, 'important')
    else document.documentElement.style.removeProperty('margin-right')
    fitGame()
    saveLayout(layout)
  }
  const post = (message: BridgeMessage) => frame.contentWindow?.postMessage(envelope(message), origin)
  const setLayout = (patch: Partial<DockLayout>) => {
    layout = { ...layout, ...patch }
    apply()
    post({ type: 'layout', collapsed: layout.collapsed, push: layout.push })
  }
  apply()

  tab.addEventListener('click', () => setLayout({ collapsed: false }))
  grip.addEventListener('pointerdown', e => {
    e.preventDefault()
    grip.setPointerCapture(e.pointerId)
    grip.classList.add('active')
    frame.classList.add('dragging')
    const move = (ev: PointerEvent) => {
      layout = { ...layout, width: Math.round(window.innerWidth - ev.clientX) }
      apply()
    }
    const up = () => {
      grip.classList.remove('active')
      frame.classList.remove('dragging')
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  })
  window.addEventListener('resize', apply)

  const sync = new Sync({
    fetch: (url, init) => window.fetch(url, init),
    location: () => window.location,
    page: pageInfo,
    emit: snapshot => post({ type: 'snapshot', snapshot }),
    busy: syncing => post({ type: 'syncing', syncing }),
    later: (run, ms) => window.setTimeout(run, ms),
    cancel: handle => window.clearTimeout(handle as number),
    now: () => Date.now(),
  })

  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.origin !== origin) return
    const message = opened<PanelMessage>(event.data)
    if (!message) return
    switch (message.type) {
      case 'ready':
        post({ type: 'hello', protocol: PROTOCOL, host: window.location.host, realm: pageInfo().realm, engine: page.adeck?.version ?? null })
        post({ type: 'layout', collapsed: layout.collapsed, push: layout.push })
        post({ type: 'snapshot', snapshot: sync.snapshot() })
        break
      case 'refresh':
        sync.refresh()
        break
      case 'verify': {
        const verdict = predict(page.adeck, message.board)
        post({ type: 'verdict', id: message.id, ...verdict })
        break
      }
      case 'layout':
        setLayout({
          ...(typeof message.collapsed === 'boolean' && { collapsed: message.collapsed }),
          ...(typeof message.push === 'boolean' && { push: message.push }),
        })
        break
    }
  })

  if (typeof PerformanceObserver === 'function') {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) sync.observe(entry.name)
    }).observe({ type: 'resource' })
  }
  window.setInterval(() => sync.checkRoute(), 500)
  let lastWake = 0
  const wake = () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastWake < 3000) return
    lastWake = Date.now()
    const current = sync.current()
    sync.mark(current ? ['state', 'inventory', `operation:${current}`] : ['state', 'inventory'])
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)

  page.__nimitzpf = { toggle: () => setLayout({ collapsed: !layout.collapsed }) }
  sync.start()
}

if (page.__nimitzpf) page.__nimitzpf.toggle()
else mount()
