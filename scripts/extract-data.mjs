import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromSettings } from '../packages/core/src/settings.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const realmArg = process.argv.find(a => a.startsWith('--realm='))
const realm = realmArg ? realmArg.slice('--realm='.length) : 'asia'
const origin = `https://pacificfront.worldofwarships.${realm}`
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

const localeSources = { 'zh-Hans': 'zh-sg', 'zh-Hant': 'zh-tw', en: 'en' }

const coreOut = path.join(root, 'packages/core/src/data')
const webOut = path.join(root, 'apps/web/src/i18n/game')

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': userAgent } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

function readStringLiteral(src, start, quote) {
  let i = start + 1
  let raw = ''
  while (src[i] !== quote) {
    if (i >= src.length) throw new Error('unterminated literal')
    if (src[i] === '\\') {
      raw += src[i] + src[i + 1]
      i += 2
    } else {
      raw += src[i]
      i += 1
    }
  }
  return raw
}

function cook(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/g, (_, esc) => {
    if (esc.startsWith('u{')) return String.fromCodePoint(parseInt(esc.slice(2, -1), 16))
    if (esc.startsWith('u') && esc.length === 5) return String.fromCharCode(parseInt(esc.slice(1), 16))
    if (esc.startsWith('x') && esc.length === 3) return String.fromCharCode(parseInt(esc.slice(1), 16))
    if (esc === '\n' || esc === '\r\n') return ''
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[esc] ?? esc
  })
}

function parseDefaultState(html) {
  const marker = 'window.defaultState=t('
  const at = html.indexOf(marker)
  if (at < 0) throw new Error('defaultState not found')
  const quoteAt = at + marker.length
  return JSON.parse(cook(readStringLiteral(html, quoteAt, html[quoteAt])))
}

function parseLocaleChunk(src) {
  const marker = 'JSON.parse('
  const at = src.indexOf(marker)
  if (at < 0) throw new Error('locale payload not found')
  const quoteAt = at + marker.length
  return JSON.parse(cook(readStringLiteral(src, quoteAt, src[quoteAt])))
}

const keep = [
  /^IDS_CARD_TITLE_\d+$/,
  /^IDS_ENEMY_TITLE_[A-Z0-9_]+$/,
  /^IDS_SHIP_TYPE_[A-Z_]+$/,
  /^IDS_CARD_EFFECT_VALUE_10\d$/,
  /^IDS_CARD_SPEC_\d$/,
  /^IDS_MODIFIER_[A-Z_]+_TITLE$/,
  /^IDS_APPLIED_EFFECT_(MULTIPLY_(PLAYER_SPECS|PLAYER_BUFFS|PLAYER_DEBUFFS|ENEMY_POWER)|DISABLE_ALL_MODIFIERS|AFFECTED_SHIP_TYPES)$/,
  /^IDS_APPLIED_EFFECTS_CATEGORY_RESTRICTED_CLASSES$/,
  /^IDS_OPERATION_NAME_OP_\d+$/,
]

function pickStrings(messages) {
  const out = {}
  for (const key of Object.keys(messages).sort()) {
    if (keep.some(re => re.test(key))) out[key] = messages[key]
  }
  return out
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortKeys(value[k])]))
  }
  return value
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  console.log('wrote', path.relative(root, file))
}

const html = await get(`${origin}/en/`)
const state = parseDefaultState(html)
const settings = state.settings
const staticUrl = new URL(html.match(/STATIC_URL:"([^"]+)"/)[1], origin).href
const build = staticUrl.split('/').filter(Boolean).pop()
const mainJs = await get(`${staticUrl}main.js`)

const collection = settings.collection
const gameData = fromSettings(settings, build)
writeJson(path.join(coreOut, 'game-data.json'), gameData)
writeJson(path.join(root, 'packages/core/test/fixtures/settings.json'), { options: settings.options, collection })

for (const [locale, source] of Object.entries(localeSources)) {
  const m = mainJs.match(new RegExp(`"\\./locales/${source}\\.json":\\(\\)=>[^(]*\\(\\(\\)=>import\\(\`\\./(scripts/${source}-[\\w-]+\\.js)\``))
  if (!m) throw new Error(`locale chunk for ${source} not found`)
  const messages = parseLocaleChunk(await get(`${staticUrl}${m[1]}`))
  writeJson(path.join(webOut, `${locale}.json`), sortKeys(pickStrings(messages)))
}

if (process.argv.includes('--no-assets')) process.exit(0)

const assetOut = path.join(root, 'apps/web/public/game')
const chunkQueue = ['main.js']
const chunkSeen = new Set()
const chunkText = new Map()
const cssFiles = new Set()
while (chunkQueue.length) {
  const rel = chunkQueue.shift()
  if (chunkSeen.has(rel)) continue
  chunkSeen.add(rel)
  const text = rel === 'main.js' ? mainJs : await get(`${staticUrl}${rel}`)
  chunkText.set(rel, text)
  for (const m of text.matchAll(/["'`](\.{1,2}\/[\w./-]+\.js)["'`]/g)) {
    const resolved = new URL(m[1], `${staticUrl}${rel}`).href
    if (resolved.startsWith(staticUrl)) chunkQueue.push(resolved.slice(staticUrl.length))
  }
  for (const m of text.matchAll(/assets\/[\w.-]+\.css/g)) cssFiles.add(m[0])
}
for (const m of html.matchAll(/assets\/[\w.-]+\.css/g)) cssFiles.add(m[0])
const cssText = []
for (const file of cssFiles) {
  try {
    cssText.push(await get(`${staticUrl}${file}`))
  } catch {
    console.log('skip', file)
  }
}

const hashed = new Map()
for (const text of [...chunkText.values(), ...cssText]) {
  for (const m of text.matchAll(/([A-Za-z0-9_]+)-([\w-]{8})\.(webp|png|jpg|svg)/g)) {
    if (!hashed.has(m[1])) hashed.set(m[1], `assets/${m[1]}-${m[2]}.${m[3]}`)
  }
}

function assetIdents(text) {
  const map = new Map()
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)=``\+new URL\(`\.\.\/assets\/([^`]+)`,import\.meta\.url\)\.href/g)) {
    map.set(m[1], `assets/${m[2]}`)
  }
  return map
}

function objectLiterals(text, firstKey) {
  const out = []
  const re = new RegExp(`\\{(${firstKey}:[A-Za-z_$][\\w$]*(?:,[a-z_0-9]+:[A-Za-z_$][\\w$]*)*)\\}`, 'g')
  for (const m of text.matchAll(re)) {
    out.push(Object.fromEntries(m[1].split(',').map(pair => pair.split(':'))))
  }
  return out
}

const wanted = new Map()
let unitArtFound = false
let typeIconsFound = false
for (const text of chunkText.values()) {
  const idents = assetIdents(text)
  if (!idents.size) continue
  for (const literal of objectLiterals(text, 'card_1')) {
    if (!('boss_1' in literal)) continue
    if (!Object.values(literal).every(v => idents.has(v))) continue
    for (const [code, ident] of Object.entries(literal)) {
      wanted.set(`${code.startsWith('card_') ? 'cards' : 'enemies'}/${code}.webp`, idents.get(ident))
    }
    unitArtFound = true
  }
  for (const literal of objectLiterals(text, 'aircraft')) {
    if (!('naval_mine' in literal) || !Object.values(literal).every(v => idents.has(v))) continue
    for (const [type, ident] of Object.entries(literal)) wanted.set(`types/${type}.webp`, idents.get(ident))
    typeIconsFound = true
  }
}
if (!unitArtFound) throw new Error('unit art map not found')
if (!typeIconsFound) throw new Error('unit type icon map not found')

const kebab = s => s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
for (const m of collection.modifiers) {
  const base = m.id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('')
  const file = hashed.get(base)
  if (!file) throw new Error(`modifier art for ${m.id} not found`)
  if (kebab(base) !== m.id) throw new Error(`modifier name mismatch ${base}`)
  wanted.set(`modifiers/${m.id}.webp`, file)
}

const statics = {
  'specs/0.webp': 'images/cards/specs/icon_damage.webp',
  'specs/1.webp': 'images/cards/specs/icon_survivability.webp',
  'specs/2.webp': 'images/cards/specs/icon_evasion.webp',
  'vulns/100.webp': 'images/cards/vulns/anti_aircraft_fire.webp',
  'vulns/101.webp': 'images/cards/vulns/detection.webp',
  'vulns/102.webp': 'images/cards/vulns/smokes.webp',
  'vulns/103.webp': 'images/cards/vulns/large_caliber.webp',
  'vulns/104.webp': 'images/cards/vulns/quick_fire.webp',
  'vulns/105.webp': 'images/cards/vulns/strike_aircraft.webp',
  'vulns/seadog.webp': 'images/cards/vulns/seadog.webp',
  'vulns/ring.webp': 'images/cards/vulns/vulns.webp',
  'conditions/1.webp': 'images/keypoints/fixed_effect_enemy_air_base.webp',
  'conditions/2.webp': 'images/keypoints/fixed_effect_enemy_naval_base.webp',
  'conditions/3.webp': 'images/keypoints/fixed_effect_allied_logistics_disrupted.webp',
  'conditions/4.webp': 'images/keypoints/fixed_effect_enemy_logistics_disrupted.webp',
  'conditions/5.webp': 'images/keypoints/fixed_effect_no_time_to_prepare.webp',
  'conditions/6.webp': 'images/keypoints/fixed_effect_bad_weather_conditions.webp',
  'conditions/multiple.webp': 'images/keypoints/fixed_effect_multiple_effects.webp',
  'markers/finished.webp': 'images/keypoints/key_point_marker_finished.webp',
  'frames/collection-3.webp': 'images/cards/bg/card_tier_3.webp',
  'frames/ally-boss.webp': 'images/cards/bg/card_vertical_form_boss.webp',
  'bg/operation-table.webp': 'images/bg/operation_table.webp',
}
for (const level of [1, 2, 3]) {
  statics[`markers/positive-${level}.webp`] = `images/keypoints/key_point_marker_initiator_positive_level_${level}.webp`
  statics[`markers/negative-${level}.webp`] = `images/keypoints/key_point_marker_initiator_negative_level_${level}.webp`
  statics[`markers/flagman-${level}.webp`] = `images/keypoints/key_point_marker_flagman_${level}.webp`
  statics[`frames/ally-${level}.webp`] = `images/cards/bg/card_vertical_form_tier_${level}.webp`
  statics[`frames/enemy-${level}.webp`] = `images/cards/bg/enemy_card_vertical_form_${level}.webp`
}
for (const [target, source] of Object.entries(statics)) wanted.set(target, source)

const glossary = await fetch(`https://vortex.worldofwarships.${realm}/api/graphql/glossary/`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': userAgent },
  body: JSON.stringify({ query: 'query { currencies { name icons { large } } }' }),
}).then(r => r.json())
const external = new Map()
for (const [name, target] of [['eventum_1', 'rewards/supplies.png'], ['eventum_2', 'rewards/progress.png']]) {
  const entry = glossary.data?.currencies?.find(c => c.name === name)
  if (!entry) throw new Error(`currency ${name} not found in glossary`)
  external.set(target, new URL(entry.icons.large, 'https://wows-gloss-icons.wgcdn.co/').href)
}

const downloads = [...external, ...[...wanted.entries()].sort().map(([target, source]) => [target, `${staticUrl}${source}`])]
fs.rmSync(assetOut, { recursive: true, force: true })
let saved = 0
for (const [target, url] of downloads) {
  const res = await fetch(url, { headers: { 'user-agent': userAgent } })
  if (!res.ok) {
    console.log('missing', res.status, url)
    continue
  }
  const file = path.join(assetOut, target)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
  saved++
}
console.log('assets', saved)
