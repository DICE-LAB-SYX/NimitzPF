import { describe, expect, it } from 'vitest'
import { GAME_HOSTS } from './protocol.ts'
import { PAGES_BASE, USERSCRIPT_EVENT, USERSCRIPT_VERSION, userscript } from './userscript.ts'

interface FakeElement {
  type?: string
  src?: string
  textContent?: string
  style: { cssText?: string }
  listeners: Record<string, () => void>
  addEventListener(name: string, run: () => void): void
  remove(): void
}

function run(source: string, href: string) {
  const url = new URL(href)
  const head: FakeElement[] = []
  const body: FakeElement[] = []
  const events: string[] = []
  const documentElement = { dataset: {} as Record<string, string> }
  const element = (): FakeElement => ({
    style: {},
    listeners: {},
    addEventListener(name, run) {
      this.listeners[name] = run
    },
    remove() {},
  })
  const document = { documentElement, createElement: element, head: { append: (e: FakeElement) => head.push(e) }, body: { append: (e: FakeElement) => body.push(e) } }
  const window = { dispatchEvent: (e: { type: string }) => events.push(e.type) }
  class CustomEvent {
    constructor(readonly type: string) {}
  }
  const execute = () => new Function('location', 'document', 'window', 'CustomEvent', 'setTimeout', source)(url, document, window, CustomEvent, () => 0)
  execute()
  return { head, body, events, dataset: documentElement.dataset, again: execute }
}

describe('userscript', () => {
  it('matches every game realm and updates from Pages', () => {
    const script = userscript({ base: PAGES_BASE, bridge: 'bridge.js' })
    for (const host of GAME_HOSTS) expect(script).toContain(`// @match        https://${host}/*`)
    expect(script).toContain(`// @match        ${PAGES_BASE}*`)
    expect(script).toContain(`// @updateURL    ${PAGES_BASE}nimitzpf.user.js`)
    expect(script).toContain('// @noframes')
  })

  it('makes a separate dev script without update urls', () => {
    const script = userscript({ base: 'http://localhost:5174/', bridge: 'src/bridge/main.ts', dev: true })
    expect(script).toContain('// @name         NimitzPF (dev)')
    expect(script).toContain('// @include      http://localhost:*/*')
    expect(script).toContain('// @include      http://127.0.0.1:*/*')
    expect(script).not.toContain('@updateURL')
  })

  it('loads the bridge once on the game page', () => {
    const page = run(userscript({ base: PAGES_BASE, bridge: 'bridge.js' }), 'https://pacificfront.worldofwarships.asia/zh-sg/operations')
    expect(page.head).toHaveLength(1)
    expect(page.head[0]!.type).toBe('module')
    expect(page.head[0]!.src).toMatch(/^https:\/\/dice-lab-syx\.github\.io\/NimitzPF\/bridge\.js\?v=\d+$/)
    page.again()
    expect(page.head).toHaveLength(1)
  })

  it('tells the player when the bridge cannot load', () => {
    const page = run(userscript({ base: PAGES_BASE, bridge: 'bridge.js' }), 'https://pacificfront.worldofwarships.asia/zh-sg/operations')
    page.head[0]!.listeners.error!()
    expect(page.body).toHaveLength(1)
    expect(page.body[0]!.textContent).toContain('NimitzPF 加载失败')
    expect(page.body[0]!.textContent).toContain('dice-lab-syx.github.io')
    const dev = run(userscript({ base: 'http://localhost:5174/', bridge: 'src/bridge/main.ts', dev: true }), 'https://pacificfront.worldofwarships.eu/en/operations')
    dev.head[0]!.listeners.error!()
    expect(dev.body[0]!.textContent).toContain('local network access')
  })

  it('announces itself on the NimitzPF site instead of loading the bridge', () => {
    const site = run(userscript({ base: PAGES_BASE, bridge: 'bridge.js' }), `${PAGES_BASE}#bookmark`)
    expect(site.head).toHaveLength(0)
    expect(site.dataset.nimitzpfUserscript).toBe(USERSCRIPT_VERSION)
    expect(site.events).toEqual([USERSCRIPT_EVENT])
    const local = run(userscript({ base: 'http://localhost:5174/', bridge: 'src/bridge/main.ts', dev: true }), 'http://127.0.0.1:5173/')
    expect(local.head).toHaveLength(0)
    expect(local.dataset.nimitzpfUserscript).toBe(USERSCRIPT_VERSION)
  })
})
