import { GAME_HOSTS } from './protocol.ts'

export const USERSCRIPT_VERSION = '1.2.0'
export const USERSCRIPT_FILE = 'nimitzpf.user.js'
export const PAGES_BASE = 'https://dice-lab-syx.github.io/NimitzPF/'
export const USERSCRIPT_EVENT = 'nimitzpf:userscript'

export interface UserscriptOptions {
  readonly base: string
  readonly bridge: string
  readonly dev?: boolean
}

export function userscript({ base, bridge, dev = false }: UserscriptOptions): string {
  const header = [
    '// ==UserScript==',
    `// @name         NimitzPF${dev ? ' (dev)' : ''}`,
    `// @namespace    ${base}`,
    `// @version      ${USERSCRIPT_VERSION}`,
    '// @description  太平洋战线（国服：大洋战线）阵容推荐面板：自动读取当前作战并给出推荐 / Pacific Front lineup planner',
    ...GAME_HOSTS.map(h => `// @match        https://${h}/*`),
    ...(dev ? ['// @include      http://localhost:*/*', '// @include      http://127.0.0.1:*/*'] : [`// @match        ${base}*`]),
    '// @grant        none',
    '// @run-at       document-idle',
    '// @noframes',
    `// @homepageURL  ${base}`,
    ...(dev ? [] : [`// @updateURL    ${base}${USERSCRIPT_FILE}`, `// @downloadURL  ${base}${USERSCRIPT_FILE}`]),
    '// ==/UserScript==',
  ]
  const failure = dev
    ? {
        zh: "'NimitzPF 加载失败：连不上本地开发服务器 ' + new URL(BASE).host + '。确认 pnpm dev 在运行，并在地址栏左侧的网站设置里允许“本地网络访问”，然后刷新页面。'",
        en: "'NimitzPF failed to load from the dev server at ' + new URL(BASE).host + '. Make sure pnpm dev is running and allow local network access in the site settings, then reload.'",
      }
    : {
        zh: "'NimitzPF 加载失败：连不上 ' + new URL(BASE).host + '。请检查网络后刷新页面。'",
        en: "'NimitzPF failed to load from ' + new URL(BASE).host + '. Check your connection and reload the page.'",
      }
  const body = `(() => {
  const BASE = ${JSON.stringify(base)}
  const VERSION = ${JSON.stringify(USERSCRIPT_VERSION)}
  if (!${JSON.stringify(GAME_HOSTS)}.includes(location.host)) {
    document.documentElement.dataset.nimitzpfUserscript = VERSION
    window.dispatchEvent(new CustomEvent(${JSON.stringify(USERSCRIPT_EVENT)}, { detail: VERSION }))
    return
  }
  if (document.documentElement.dataset.nimitzpfLoader) return
  document.documentElement.dataset.nimitzpfLoader = VERSION
  const notice = () => {
    const zh = /^\\/zh/.test(location.pathname)
    const box = document.createElement('div')
    box.textContent = zh
      ? ${failure.zh}
      : ${failure.en}
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:360px;padding:10px 14px;border-radius:4px;' +
      'background:#0b2a30;color:#d2e4e3;font:13px/1.5 system-ui,sans-serif;box-shadow:0 1px 0 rgba(0,0,0,.35),0 8px 20px rgba(0,0,0,.45);cursor:pointer'
    box.addEventListener('click', () => box.remove())
    document.body.append(box)
    setTimeout(() => box.remove(), 12000)
  }
  const script = document.createElement('script')
  script.type = 'module'
  script.src = BASE + ${JSON.stringify(bridge)} + '?v=' + Math.floor(Date.now() / 600000)
  script.addEventListener('error', notice)
  document.head.append(script)
})()
`
  return `${header.join('\n')}\n\n${body}`
}
