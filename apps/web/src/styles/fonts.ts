import type { Locale } from '../i18n/index.ts'

const LATIN_TEXT = '0123456789%–·ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const CJK_TEXT = '阶段关键据点节战斗条件结果表稳妥通关完美全歼收益最大推荐待攻克作战已连接刷新浮动收起敌方我胜率階關據點戰鬥條件結果穩妥通關殲'
const LATIN_FACES = [
  '500 16px "Barlow Condensed"',
  '600 16px "Barlow Condensed"',
  '700 16px "Barlow Condensed"',
  '400 14px "Barlow Semi Condensed"',
  '500 14px "Barlow Semi Condensed"',
  '600 14px "Barlow Semi Condensed"',
  '700 14px "Barlow Semi Condensed"',
]
export const FONT_WAIT_MS = 2500

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export function loadLocaleFonts(locale: Locale): Promise<unknown> {
  return locale === 'zh-Hant' ? import('@fontsource-variable/noto-sans-tc/wght.css').catch(() => undefined) : Promise.resolve()
}

export async function fontsReady(locale: Locale, fonts: FontFaceSet = document.fonts): Promise<void> {
  const deadline = performance.now() + FONT_WAIT_MS
  while (![...fonts].some(f => f.family.includes('Barlow')) && performance.now() < deadline) await sleep(16)
  const loads = LATIN_FACES.map(face => fonts.load(face, LATIN_TEXT))
  if (locale !== 'en') loads.push(fonts.load(`600 14px "${locale === 'zh-Hant' ? 'Noto Sans TC Variable' : 'Noto Sans SC Variable'}"`, CJK_TEXT))
  await Promise.race([Promise.all(loads).catch(() => undefined), sleep(Math.max(0, deadline - performance.now()))])
}
