(() => {
  const COUNT = 800
  const SEED = 20261015
  const A = window.adeck
  const collection = window.defaultState?.settings?.collection
  const core = window.defaultState?.settings?.options?.defaultCoreSettings
  if (!A || !collection || !core) throw new Error('open a Pacific Front page first')
  const settings = { ...A.newSettings(), ...core }
  let seed = SEED
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = list => list[Math.floor(random() * list.length)]
  const chance = p => random() < p
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1))
  const TYPES = ['aircraft', 'battleship', 'cruiser', 'destroyer', 'submarine', 'coastal_artillery', 'naval_mine']
  const VULNS = [100, 101, 102, 103, 104, 105]
  const FACTORS = [1, 1, 1, 0.75, 0.67, 0.5, 0.25]
  const NEEDS_ENEMY = new Set(['focused', 'sea-dog', 'specialization'])
  const standard = collection.modifiers.filter(m => m.type === 1).map(m => m.id)
  const special = collection.modifiers.filter(m => m.type === 2).map(m => m.id)
  const specs = s => ({ 0: s[0], 1: s[1], 2: s[2] })
  const list = o => [o[0] ?? 0, o[1] ?? 0, o[2] ?? 0]
  const sum = s => s[0] + s[1] + s[2]
  const subset = (items, max) => items.filter(() => chance(max / items.length))

  const restriction = r => (r ? A.newRestriction(r.cards ?? [], r.types ?? [], r.tiers ?? [], r.modifiers ?? [], false) : A.newEmptyRestriction())
  const effect = c => {
    switch (c.kind) {
      case 'player-specs':
        return A.newMultiplyPlayerSpecsEffect(c.specs, {}, restriction(c.exempt))
      case 'enemy-power':
        return A.newMultiplyEnemyPowerEffect(c.specs, {}, restriction(c.exempt))
      case 'player-buffs':
        return A.newMultiplyPlayerBuffsEffect(c.multiplier, 0, restriction(c.exempt))
      case 'player-debuffs':
        return A.newMultiplyPlayerDebuffsEffect(c.multiplier, 0, restriction(c.exempt))
      case 'disable-modifiers':
        return A.newDisableAllModifiersEffect(false)
      case 'restrictions':
        return A.newExtraRestrictionsEffect(restriction(c.banned), false)
    }
  }

  const delta = () => pick([-0.5, -0.4, -0.3, -0.25, -0.2, -0.15, -0.1, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5])
  const specDeltas = () => {
    const out = {}
    const which = chance(0.6) ? [0, 1, 2] : subset([0, 1, 2], 1.5)
    const value = delta()
    for (const k of which.length ? which : [0]) out[k] = chance(0.8) ? value : delta()
    return out
  }
  const exempt = () => {
    if (!chance(0.35)) return undefined
    const r = chance(0.7) ? { types: subset(TYPES, 1.5) } : { tiers: subset([1, 2, 3], 1) }
    return (r.types ?? r.tiers).length ? r : undefined
  }

  function board() {
    const used = new Set()
    const players = [0, 1, 2, 3].map(() => {
      if (!chance(0.85)) return null
      let card = pick(collection.cards)
      while (used.has(card.code)) card = pick(collection.cards)
      used.add(card.code)
      const modifiers = []
      if (chance(0.45)) modifiers.push(pick(standard))
      if (chance(0.45)) modifiers.push(pick(special))
      return { card: card.code, hp: int(1, 3), modifiers }
    })
    const enemies = [0, 1, 2, 3].map(() => {
      if (!chance(0.8)) return null
      const def = pick(collection.enemies)
      const vulns = {}
      for (const v of subset(VULNS, 1.2).slice(0, 2)) vulns[v] = pick(FACTORS)
      return { code: def.code, type: chance(0.7) ? def.type : pick(TYPES), tier: chance(0.1) ? 4 : int(1, 3), specs: [int(10, 130), int(10, 130), int(10, 130)], vulns }
    })
    if (!enemies.some(Boolean)) enemies[int(0, 3)] = { code: 'vehicle_7', type: 'cruiser', tier: 2, specs: [60, 50, 40], vulns: {} }
    const conditions = []
    const hasModifiers = players.some(p => p && p.modifiers.length)
    for (let i = int(0, 3); i > 0; i--) {
      const kind = pick(['player-specs', 'enemy-power', 'player-buffs', 'player-debuffs', 'disable-modifiers', 'restrictions'])
      if (kind === 'player-specs' || kind === 'enemy-power') {
        const ex = exempt()
        conditions.push({ kind, specs: specDeltas(), ...(ex && { exempt: ex }) })
      }
      else if (kind === 'player-buffs' || kind === 'player-debuffs') conditions.push({ kind, multiplier: pick([0.5, 0.6, 0.7, 0.75, 0.8, 1.2, 1.25, 1.3, 1.5]) })
      else if (kind === 'disable-modifiers' && !hasModifiers) conditions.push({ kind })
      else if (kind === 'restrictions') {
        const present = new Set(players.filter(Boolean).map(p => collection.cards.find(c => c.code === p.card).type))
        const free = TYPES.filter(t => !present.has(t))
        if (free.length) conditions.push({ kind, banned: { types: [pick(free)] } })
      }
    }
    return { players, enemies, conditions }
  }

  function run({ players, enemies, conditions }) {
    const b = A.newBoard(4)
    enemies.forEach((e, i) => {
      if (e) b.Enemy.Slots[i] = A.newSlot(A.newCard(e.code, e.type, e.tier, specs(e.specs), e.vulns, [], A.newFullHealth()))
    })
    players.forEach((p, i) => {
      if (!p) return
      const card = collection.cards.find(c => c.code === p.card)
      const buffs = []
      for (const d of card.debuffs) {
        const e = A.newEffect(d.vuln, false)
        e.Relative = { 0: d.value }
        buffs.push(A.newBuff(d.direction, e))
      }
      for (const x of card.buffs) {
        const e = A.newEffect(0, true)
        e.Relative = { [x.spec]: x.value }
        buffs.push(A.newBuff(x.direction, e))
      }
      b.Player.Slots[i] = A.newSlot(A.newCard(card.code, card.type, card.tier, card.specs, {}, buffs, A.newHealth(p.hp, 3)), ...p.modifiers)
    })
    const effects = conditions.map(effect)
    if (effects.length) b.Effects = effects
    return A.predict(b, settings)
  }

  const cases = []
  let skipped = 0
  while (cases.length < COUNT) {
    const input = board()
    const [ok, error, state] = run(input)
    const needsEnemy = input.players.some((p, i) => p && !input.enemies[i] && p.modifiers.some(m => NEEDS_ENEMY.has(m)))
    const base = { player: input.players, enemy: input.enemies, conditions: input.conditions }
    if (!ok) {
      if (needsEnemy && /no enemy in a slot/.test(error)) cases.push({ ...base, expected: { error: 'modifier-needs-enemy', lanes: null } })
      else skipped++
      continue
    }
    const lanes = [0, 1, 2, 3].map(i => {
      const p = input.players[i]
      const e = input.enemies[i]
      const ps = p && list(state.Player[i].Card.Specs)
      const es = e && list(state.Enemy[i].Card.Specs)
      return {
        player: p ? { specs: ps, power: sum(ps), hp: state.Player[i].Card.Health.Current } : null,
        enemy: e ? { specs: es, power: sum(es) } : null,
        percent: p && e ? state.Predictions[i] : null,
      }
    })
    cases.push({ ...base, expected: { error: null, lanes } })
  }
  const text = JSON.stringify(cases)
  if (typeof document !== 'undefined' && !window.__nimitzpfNoDownload) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    a.download = 'engine-cases.json'
    a.click()
  }
  console.log(`engine ${A.version}: ${cases.length} cases, ${skipped} skipped`)
  return text
})()
