import { cardByCode, type BuffDirection, type DebuffDirection, type UnitType, type VulnCode } from '@nimitzpf/core'
import { asset } from '../game/assets.ts'
import type { Locale } from '../i18n/index.ts'
import { useT } from '../i18n/useT.ts'
import css from './Illustrations.module.css'

interface Marker {
  readonly kind: 'positive' | 'negative' | 'flagman'
  readonly level: number
  readonly x: number
  readonly y: number
  readonly hidden?: boolean
}

interface GameText {
  readonly nav: readonly string[]
  readonly lang: string
  readonly back: string
  readonly rules: string
  readonly title: string
  readonly stage: string
  readonly state: string
  readonly goal: string
  readonly keypoint: string
  readonly difficulty: string
  readonly stamp: string
  readonly enemies: string
  readonly enter: string
}

const GAME_TEXT: Readonly<Record<Locale, GameText>> = {
  'zh-Hans': {
    nav: ['游戏', '服务', '高级商店', '兵工厂', '玩家支持'],
    lang: 'zh-sg',
    back: '← 返回行动',
    rules: '规则',
    title: '“TANGO”行动 ★★★',
    stage: '阶段1',
    state: '进行中',
    goal: '✕ 阶段目标：摧毁8个单位',
    keypoint: '关键据点1',
    difficulty: '困难',
    stamp: '无战斗条件',
    enemies: '敌方单位',
    enter: '进入关键据点',
  },
  'zh-Hant': {
    nav: ['遊戲', '服務', '高級商店', '兵工廠', '玩家支援'],
    lang: 'zh-tw',
    back: '← 返回行動',
    rules: '規則',
    title: '「TANGO」行動 ★★★',
    stage: '階段1',
    state: '進行中',
    goal: '✕ 階段目標：摧毀8個單位',
    keypoint: '關鍵據點1',
    difficulty: '困難',
    stamp: '無戰鬥條件',
    enemies: '敵方單位',
    enter: '進入關鍵據點',
  },
  en: {
    nav: ['Games', 'Services', 'Premium Shop', 'Armory', 'Support'],
    lang: 'en',
    back: '← Back',
    rules: 'Rules',
    title: '“TANGO” Operation ★★★',
    stage: 'Stage 1',
    state: 'In progress',
    goal: '✕ Goal: destroy 8 units',
    keypoint: 'Key point 1',
    difficulty: 'Hard',
    stamp: 'No conditions',
    enemies: 'Enemy units',
    enter: 'Enter key point',
  },
}

const STAGES = [
  { d: 'M50 300C50 240 120 225 180 232C240 240 266 280 262 320C258 365 225 386 175 379C110 372 50 360 50 300Z', n: [204, 366], current: true },
  { d: 'M262 500C258 455 300 435 345 437C395 440 430 470 430 510C430 560 395 586 345 583C295 580 265 545 262 500Z', n: [382, 562] },
  { d: 'M385 300C385 255 420 228 465 228C515 228 550 262 548 300C546 345 512 372 467 370C420 368 385 345 385 300Z', n: [503, 346] },
  { d: 'M548 435C548 398 575 376 608 376C643 376 668 400 668 436C668 472 642 496 608 494C574 492 548 470 548 435Z', n: [627, 478] },
]

const MARKERS: readonly Marker[] = [
  { kind: 'positive', level: 3, x: 101, y: 305 },
  { kind: 'positive', level: 2, x: 147, y: 318 },
  { kind: 'positive', level: 1, x: 199, y: 313 },
  { kind: 'negative', level: 3, x: 309, y: 489, hidden: true },
  { kind: 'positive', level: 2, x: 347, y: 522, hidden: true },
  { kind: 'positive', level: 2, x: 439, y: 299, hidden: true },
  { kind: 'negative', level: 2, x: 485, y: 294, hidden: true },
]

const ISLANDS: readonly (readonly [number, number, number])[] = [
  [134, 333, 9],
  [188, 366, 6],
  [252, 268, 5],
  [146, 425, 8],
  [95, 484, 7],
  [102, 540, 10],
  [404, 482, 6],
  [436, 488, 9],
  [500, 333, 7],
  [598, 228, 9],
  [627, 296, 5],
  [672, 478, 6],
  [697, 120, 12],
  [40, 640, 8],
]

const JITTER = [1, 0.84, 1.12, 0.92, 1.05, 0.78, 0.96, 0.88, 1.1]

function blob(cx: number, cy: number, r: number, seed: number): string {
  const points = JITTER.map((_, i) => {
    const a = (i / JITTER.length) * Math.PI * 2 + seed * 0.7
    const k = r * JITTER[(i * 2 + seed) % JITTER.length]! * (i % 3 ? 1 : 0.7)
    return [cx + Math.cos(a) * k * 1.4, cy + Math.sin(a) * k * 0.85] as const
  })
  const at = (i: number) => points[i % points.length]!
  const mid = (i: number) => `${((at(i)[0] + at(i + 1)[0]) / 2).toFixed(1)} ${((at(i)[1] + at(i + 1)[1]) / 2).toFixed(1)}`
  return `M${mid(0)}${points.map((_, i) => `Q${at(i + 1)[0].toFixed(1)} ${at(i + 1)[1].toFixed(1)} ${mid(i + 1)}`).join('')}Z`
}

function island([cx, cy, r]: readonly [number, number, number], seed: number): string {
  const side = seed % 2 ? 1 : -1
  return [blob(cx, cy, r, seed), blob(cx + side * r * 1.9, cy - r * 0.6, r * 0.45, seed + 3), blob(cx - side * r * 1.1, cy + r * 1.1, r * 0.3, seed + 5)].join('')
}

const LINKS = ['M232 382Q262 428 286 455', 'M386 446Q404 404 424 370', 'M532 352Q552 378 566 396']

const ENEMY_SLOTS: readonly { readonly type: UnitType; readonly reward: number }[] = [
  { type: 'destroyer', reward: 17 },
  { type: 'destroyer', reward: 17 },
  { type: 'coastal_artillery', reward: 14 },
  { type: 'submarine', reward: 15 },
]

interface Lane {
  readonly enemy: string
  readonly enemyType: UnitType
  readonly vulns: readonly VulnCode[]
  readonly power: number
  readonly debuffed: boolean
  readonly reward: number
  readonly ally: string
  readonly range: string
  readonly boosted?: number
}

const LANES: readonly Lane[] = [
  { enemy: 'vehicle_9', enemyType: 'destroyer', vulns: [101, 104], power: 100, debuffed: true, reward: 17, ally: 'card_17', range: '130–150' },
  { enemy: 'vehicle_10', enemyType: 'destroyer', vulns: [104, 105], power: 179, debuffed: false, reward: 17, ally: 'card_13', range: '190–210', boosted: 0 },
  { enemy: 'vehicle_13', enemyType: 'coastal_artillery', vulns: [103], power: 137, debuffed: true, reward: 14, ally: 'card_9', range: '145–165' },
  { enemy: 'vehicle_14', enemyType: 'submarine', vulns: [101, 105], power: 136, debuffed: true, reward: 15, ally: 'card_8', range: '180–200' },
]

const DIRECTION_ORDER: readonly (BuffDirection | DebuffDirection)[] = ['left', 'forward-left', 'forward', 'forward-right', 'right']
const CARD_X = (lane: number) => 1028 + lane * 98
const CARD_W = 86
const CARD_H = 112
const ENEMY_Y = 268
const ALLY_Y = 444

const DEBUFFS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [2, 3],
  [3, 2],
]

const TABS = [
  { name: 'TANGO', stars: 3, on: true },
  { name: 'UNIFORM', stars: 4 },
  { name: 'ROMEO', stars: 5 },
]

const STRIP: readonly (readonly { readonly kind: 'positive' | 'negative'; readonly level: number }[])[] = [
  [
    { kind: 'positive', level: 3 },
    { kind: 'positive', level: 2 },
    { kind: 'positive', level: 1 },
  ],
  [
    { kind: 'negative', level: 3 },
    { kind: 'positive', level: 2 },
  ],
  [
    { kind: 'positive', level: 2 },
    { kind: 'negative', level: 2 },
  ],
]

function stars(n: number): string {
  return '★'.repeat(n)
}

function textWidth(text: string, size: number): number {
  return [...text].reduce((w, ch) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.56), 0)
}

function navX(labels: readonly string[], latin: boolean): number[] {
  let x = 36
  return labels.map(label => {
    const at = x
    x += label.length * (latin ? 6.4 : 12.5) + 16
    return at
  })
}

function Chrome({ address, extension = false }: { address: string; extension?: boolean }) {
  return (
    <div className={css.chrome}>
      <span className={css.dots}>
        <i />
        <i />
        <i />
      </span>
      <span className={css.address}>{address}</span>
      {extension && (
        <span className={css.extension}>
          <b>1</b>
        </span>
      )}
    </div>
  )
}

function Game() {
  const t = useT()
  const g = GAME_TEXT[t.locale]
  const xs = navX(g.nav, t.locale === 'en')
  return (
    <g>
      <image href={asset.table()} x={-260} y={-60} width={1520} height={860} preserveAspectRatio="xMidYMid slice" />
      {ISLANDS.map((spec, i) => (
        <path key={i} d={island(spec, i)} className={css.island} />
      ))}
      <g transform="rotate(-24 150 98)">
        <rect x={84} y={93} width={132} height={9} rx={2} className={css.pencil} />
        <path d="M216 93L232 97.5L216 102Z" className={css.pencilTip} />
        <rect x={84} y={93} width={10} height={9} className={css.pencilEnd} />
      </g>
      <rect width={1000} height={29} fill="#050505" />
      <circle cx={18} cy={14.5} r={7} fill="none" stroke="#bbb" strokeWidth={1.6} />
      {g.nav.map((label, i) => (
        <text key={label} x={xs[i]} y={19} className={css.nav} fill={i === 2 ? '#c9a24a' : i === 3 ? '#5fb0a8' : '#c8c8c8'}>
          {label}
        </text>
      ))}
      <rect x={13} y={37} width={88} height={22} className={css.gameButton} />
      <text x={57} y={52} className={css.gameButtonText}>
        {g.back}
      </text>
      <rect x={114} y={37} width={50} height={22} className={css.gameButton} />
      <text x={139} y={52} className={css.gameButtonText}>
        {g.rules}
      </text>
      <text x={500} y={54} className={css.gameTitle}>
        {g.title}
      </text>
      <text x={866} y={53} className={css.gameStat}>
        1992
      </text>
      <path d="M912 44h4l6-5v18l-6-5h-4Z" className={css.speaker} />
      <path d="M926 43q4 5.5 0 11" className={css.speakerWave} />
      <rect x={940} y={42} width={22} height={13} rx={2} className={css.esc} />
      <text x={951} y={52} className={css.escText}>
        ESC
      </text>
      <path d="M970 44l7 7M977 44l-7 7" className={css.close} />

      {LINKS.map(d => (
        <path key={d} d={d} className={css.link} />
      ))}
      {STAGES.map((s, i) => (
        <g key={s.d}>
          <path d={s.d} className={s.current ? css.regionOn : css.region} />
          <text x={s.n[0]} y={s.n[1]} className={s.current ? css.stageNoOn : css.stageNo}>
            {i + 1}
          </text>
        </g>
      ))}
      <path d="M312 472C322 404 368 346 424 318" className={css.arrow} markerEnd="url(#nimitzpf-arrow)" />
      {MARKERS.map(m => (
        <image
          key={`${m.x}-${m.y}`}
          href={asset.marker(m.kind, m.level)}
          x={m.x - 11}
          y={m.y - 17}
          width={22}
          height={34}
          className={m.hidden ? css.markerHidden : undefined}
        />
      ))}
      <circle cx={101} cy={305} r={24} className={css.selected} />
      <image href={asset.marker('flagman', 3)} x={589} y={417} width={36} height={36} className={css.markerHidden} />

      <g className={css.info}>
        <rect x={719} y={82} width={281} height={522} fill="#c9c2ad" />
        <rect x={719} y={82} width={281} height={80} fill="#3b3833" />
        <text x={737} y={107} className={css.infoTitle}>
          {g.stage}
        </text>
        <text x={982} y={107} className={css.infoState}>
          {g.state}
        </text>
        <text x={740} y={132} className={css.infoGoal}>
          {g.goal}
        </text>
        {[0, 1, 2].map(i => (
          <g key={i}>
            <rect x={721 + i * 54} y={163} width={50} height={29} fill={i === 0 ? '#d9d2bf' : '#77614f'} />
            <text x={746 + i * 54} y={178} className={i === 0 ? css.tabOn : css.tabOff}>
              {i + 1}
            </text>
            <text x={746 + i * 54} y={188} className={i === 0 ? css.tabStarsOn : css.tabStarsOff}>
              {stars(3 - i)}
            </text>
          </g>
        ))}
        <rect x={719} y={192} width={281} height={44} fill="#d9d2bf" />
        <text x={737} y={211} className={css.infoKp}>
          {g.keypoint}
        </text>
        <text x={737} y={227} className={css.infoKpSub}>
          {g.difficulty}
        </text>
        <circle cx={968} cy={214} r={20} className={css.seal} />
        <circle cx={968} cy={214} r={14} className={css.seal} />
        <g transform="rotate(14 860 330)">
          <rect x={790} y={305} width={140} height={50} className={css.stamp} />
          <text x={860} y={337} className={css.stampText}>
            {g.stamp}
          </text>
        </g>
        <rect x={719} y={447} width={281} height={109} fill="#7d6657" />
        <text x={735} y={464} className={css.infoEnemies}>
          {g.enemies}
        </text>
        {ENEMY_SLOTS.map((slot, i) => (
          <g key={i}>
            <rect x={733 + i * 65} y={472} width={56} height={14} fill="#d6a85a" />
            <image href={asset.type(slot.type)} x={754 + i * 65} y={473} width={14} height={12} className={css.slotType} />
            <rect x={733 + i * 65} y={486} width={56} height={58} fill="#d8d2c4" />
            <circle cx={757 + i * 65} cy={514} r={18} className={css.coin} />
            <circle cx={757 + i * 65} cy={514} r={12} className={css.coinRing} />
            <rect x={770 + i * 65} y={526} width={18} height={16} fill="#1c1c1c" />
            <text x={779 + i * 65} y={538} className={css.slotNo}>
              {slot.reward}
            </text>
          </g>
        ))}
        <rect x={769} y={562} width={180} height={34} fill="#b6413a" />
        <text x={859} y={584} className={css.enter}>
          {g.enter}
        </text>
      </g>
    </g>
  )
}

function Roundel({ x, y, buff }: { x: number; y: number; buff: boolean }) {
  return (
    <g>
      <circle cx={x} cy={y} r={6} className={buff ? css.roundelBuff : css.roundelDebuff} />
      <circle cx={x} cy={y} r={3.6} className={css.roundelRing} />
    </g>
  )
}

function EnemyCard({ lane, index }: { lane: Lane; index: number }) {
  const t = useT()
  const x = CARD_X(index)
  const y = ENEMY_Y
  return (
    <g>
      <image href={asset.frame('enemy', 3)} x={x} y={y} width={CARD_W} height={CARD_H} />
      {lane.vulns.map((v, k) => (
        <g key={v}>
          <circle cx={x + 11.5 + k * 15} cy={y + 12.5} r={6.5} className={css.vulnBack} />
          <image href={asset.vuln(v)} x={x + 6.5 + k * 15} y={y + 7.5} width={10} height={10} />
        </g>
      ))}
      <text x={x + 72} y={y + 19} className={lane.debuffed ? css.powerDown : css.power}>
        {lane.power}
      </text>
      <g transform={`rotate(8 ${x + 82} ${y + 14})`}>
        <rect x={x + 74} y={y + 4} width={16} height={20} rx={1.5} className={css.chip} />
        <rect x={x + 76} y={y + 14} width={12} height={9} className={css.chipBox} />
        <text x={x + 82} y={y + 21.5} className={css.chipNo}>
          {lane.reward}
        </text>
      </g>
      <image href={asset.enemy(lane.enemy)} x={x + 4} y={y + 28} width={78} height={40} preserveAspectRatio="xMidYMid meet" />
      <image href={asset.type(lane.enemyType)} x={x + 8} y={y + 70} width={9} height={8} className={css.plateType} />
      <text x={x + 20} y={y + 77} className={css.plate}>
        {t.enemyName(lane.enemy)}
      </text>
    </g>
  )
}

function AllyCard({ lane, index }: { lane: Lane; index: number }) {
  const t = useT()
  const card = cardByCode(lane.ally)
  if (!card) return null
  const x = CARD_X(index)
  const y = ALLY_Y
  const effects = [...card.buffs.map(b => ({ direction: b.direction, buff: true })), ...card.debuffs.map(d => ({ direction: d.direction, buff: false }))].sort(
    (a, b) => DIRECTION_ORDER.indexOf(a.direction) - DIRECTION_ORDER.indexOf(b.direction),
  )
  return (
    <g>
      <image href={asset.frame('ally', card.tier)} x={x} y={y} width={CARD_W} height={CARD_H} />
      {effects.map((e, k) => (
        <Roundel key={k} x={x + 11 + k * 14} y={y + 13} buff={e.buff} />
      ))}
      <text x={x + 80} y={y + 17} className={lane.boosted !== undefined ? css.rangeUp : css.range}>
        {lane.range}
      </text>
      <image href={asset.card(card.code)} x={x + 3} y={y + 27} width={80} height={42} preserveAspectRatio="xMidYMid meet" />
      <image href={asset.type(card.type)} x={x + 8} y={y + 70} width={9} height={8} className={css.plateType} />
      <text x={x + 20} y={y + 77} className={css.plate}>
        {t.cardName(card.code).unit}
      </text>
      {card.specs.map((v, k) => (
        <g key={k}>
          <image href={asset.spec(k as 0 | 1 | 2)} x={x + 7 + k * 26} y={y + 82} width={8} height={8} className={css.specIcon} />
          <text x={x + 17 + k * 26} y={y + 89} className={lane.boosted === k ? css.specUp : css.spec}>
            {lane.boosted === k ? Math.round(v * 1.3) : v}
          </text>
        </g>
      ))}
      {[0, 1, 2].map(k => (
        <rect key={k} x={x + 18 + k * 17} y={y + 101} width={15} height={4} rx={1} className={css.hp} />
      ))}
    </g>
  )
}

function Panel() {
  const t = useT()
  const objectives = [t('objectiveComplete'), t('objectivePerfect'), t('objectiveReward')]
  const recommendW = Math.ceil(textWidth(t('recommended'), 12) + 14)
  const openW = Math.ceil(textWidth(t('statusOpen'), 12) + 14)
  const tagW = Math.min(CARD_W - 4, Math.ceil(textWidth(t('recommended'), 10) + 10))
  return (
    <g className={css.dock}>
      <rect x={1000} width={440} height={700} className={css.dockBg} />
      <rect x={1000} width={440} height={46} className={css.dockHead} />
      <text x={1016} y={31} className={css.mark}>
        NIMITZ
      </text>
      <rect x={1091} y={13} width={23} height={20} rx={3} className={css.markChip} />
      <text x={1102.5} y={28} className={css.markPf}>
        PF
      </text>
      <circle cx={1131} cy={26} r={4} className={css.live} />
      <text x={1141} y={30} className={css.status}>
        <tspan className={css.realm}>ASIA</tspan> {t('connLive')}
      </text>
      <text x={1424} y={30} className={css.tools}>
        {t('refresh')} · {t('dockOverlay')} · {t('dockCollapse')}
      </text>

      {TABS.map((tab, i) => (
        <g key={tab.name}>
          <path d={`M${1016 + i * 140} 92V58a7 7 0 0 1 7-7h120a7 7 0 0 1 7 7V92Z`} className={tab.on ? css.opOn : css.op} />
          <text x={1032 + i * 140} y={76} className={tab.on ? css.opNameOn : css.opName}>
            {tab.name}
            <tspan className={css.opStars} dx={6}>
              {stars(tab.stars)}
            </tspan>
          </text>
          {tab.on && <circle cx={1135} cy={71} r={3.5} className={css.opLive} />}
        </g>
      ))}
      <rect x={1000} y={92} width={440} height={1} className={css.rule} />

      {objectives.map((label, i) => (
        <g key={label}>
          <rect x={1016 + i * 92} y={104} width={92} height={28} className={i === 0 ? css.segOn : css.seg} />
          <text x={1062 + i * 92} y={123} className={i === 0 ? css.segTextOn : css.segText}>
            {label}
          </text>
        </g>
      ))}
      {['简', '繁', 'EN'].map((label, i) => (
        <g key={label}>
          <rect x={1340 + i * 26} y={108} width={26} height={20} className={i === 0 ? css.segOn : css.seg} />
          <text x={1353 + i * 26} y={122} className={i === 0 ? css.langOn : css.lang}>
            {label}
          </text>
        </g>
      ))}

      {STRIP.map((markers, s) => {
        const x = 1016 + [0, 150, 254][s]!
        const w = 38 + markers.length * 33
        return (
          <g key={s}>
            <rect x={x} y={146} width={w} height={48} rx={24} className={s === 0 ? css.pillOn : css.pill} />
            <text x={x + 13} y={178} className={s === 0 ? css.pillNo : css.pillNoDim}>
              {s + 1}
            </text>
            {markers.map((m, i) => (
              <image key={i} href={asset.marker(m.kind, m.level)} x={x + 32 + i * 33} y={152} width={23} height={36} />
            ))}
          </g>
        )
      })}
      <rect x={1046} y={150} width={31} height={41} rx={3} className={css.pillPick} />

      <text x={1018} y={236} className={css.kpTitle}>
        {t('stageN', { n: 1 })} · {t('keypointN', { n: 1 })}
        <tspan className={css.kpStars} dx={8}>
          ★★★
        </tspan>
      </text>
      <rect x={1424 - recommendW - 6 - openW} y={220} width={openW} height={22} rx={2} className={css.chipLine} />
      <text x={1424 - recommendW - 6 - openW / 2} y={235} className={css.chipText}>
        {t('statusOpen')}
      </text>
      <rect x={1424 - recommendW} y={220} width={recommendW} height={22} rx={2} className={css.chipOn} />
      <text x={1424 - recommendW / 2} y={235} className={css.chipTextOn}>
        {t('recommended')}
      </text>

      <rect x={1016} y={254} width={408} height={350} rx={10} className={css.board} />
      {DEBUFFS.map(([from, to]) => (
        <path key={`${from}-${to}`} d={`M${CARD_X(from) + 43} ${ALLY_Y}L${CARD_X(to) + 43} ${ENEMY_Y + CARD_H + 2}`} className={css.debuff} markerEnd="url(#nimitzpf-debuff)" />
      ))}
      <path d={`M${CARD_X(2) + 2} ${ALLY_Y - 6}Q${CARD_X(2) - 6} ${ALLY_Y - 14} ${CARD_X(1) + CARD_W - 4} ${ALLY_Y - 6}`} className={css.buff} />
      {LANES.map((lane, i) => (
        <g key={lane.enemy}>
          <EnemyCard lane={lane} index={i} />
          <rect x={CARD_X(i) + 6} y={393} width={74} height={24} rx={6} className={css.odds} />
          <text x={CARD_X(i) + 43} y={411} className={css.oddsText}>
            100<tspan className={css.unit}>%</tspan>
          </text>
          <rect x={CARD_X(i) + CARD_W - 4 - tagW} y={426} width={tagW} height={16} rx={2} className={css.recommend} />
          <text x={CARD_X(i) + CARD_W - 4 - tagW / 2} y={438} className={css.recommendText}>
            {t('recommended')}
          </text>
          <AllyCard lane={lane} index={i} />
        </g>
      ))}
      <text x={1028} y={590} className={css.verified}>
        ✓ {t('verifyMatch')}
      </text>

      <rect x={1016} y={616} width={408} height={92} className={css.paper} />
      <rect x={1016} y={616} width={408} height={3} className={css.paperTop} />
      <text x={1032} y={644} className={css.paperTitle}>
        {t('crtTitle')}
      </text>
      <rect x={1320} y={627} width={92} height={24} rx={2} className={css.solve} />
      <text x={1366} y={643} className={css.solveText}>
        ⚡ {t('solveDeep')}
      </text>
      <rect x={1032} y={657} width={380} height={1.5} className={css.paperRule} />
      <rect x={1032} y={660} width={380} height={1.5} className={css.paperRule} />
      {[0, 1, 2, 3].map(i => (
        <g key={i}>
          <rect x={1112 + i * 75} y={670} width={73} height={26} className={css.crtHead} />
          <text x={1148.5 + i * 75} y={688} className={css.crtNo}>
            {i + 1}
          </text>
        </g>
      ))}
    </g>
  )
}

export function Preview({ game, panel }: { game: string; panel: string }) {
  const t = useT()
  return (
    <div className={css.preview} aria-hidden="true">
      <Chrome address={`pacificfront.worldofwarships.asia/${GAME_TEXT[t.locale].lang}/operations`} extension />
      <div className={css.stage}>
        <svg viewBox="0 0 1440 700" className={css.svg}>
          <defs>
            <filter id="nimitzpf-unrevealed">
              <feColorMatrix type="saturate" values="0.12" />
            </filter>
            <marker id="nimitzpf-arrow" viewBox="0 0 10 10" refX="3" refY="5" markerWidth="4.2" markerHeight="4.2" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="#b83a2e" />
            </marker>
            <marker id="nimitzpf-debuff" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto">
              <path d="M0 0L10 5L0 10z" fill="#d8402b" />
            </marker>
          </defs>
          <Game />
          <Panel />
        </svg>
      </div>
      <div className={css.legend}>
        <span>{game}</span>
        <span>{panel}</span>
      </div>
    </div>
  )
}

export function DragDemo() {
  return (
    <div className={css.drag} aria-hidden="true">
      <Chrome address="dice-lab-syx.github.io/NimitzPF/" />
      <div className={css.bar}>
        <i />
        <i />
        <span className={css.dropped}>NimitzPF</span>
      </div>
      <div className={css.page}>
        <span className={css.source}>NimitzPF</span>
      </div>
      <div className={css.pointer}>
        <span className={css.ghost}>NimitzPF</span>
        <svg className={css.cursor} viewBox="0 0 16 22">
          <path d="M1 1v17l4.4-4.1 3 6.6 3-1.4-3-6.5H15z" />
        </svg>
      </div>
    </div>
  )
}

export function ToggleDemo({ label }: { label: string }) {
  return (
    <div className={css.toggle} aria-hidden="true">
      <div className={css.toggleHead}>
        <span className={css.monkey}>
          <i />
          <i />
        </span>
        Tampermonkey
      </div>
      <div className={css.toggleRow}>
        <span>{label}</span>
        <span className={css.switch} />
      </div>
    </div>
  )
}
