(async () => {
  const get = async path => {
    const res = await fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } })
    const text = await res.text()
    try {
      return { status: res.status, body: JSON.parse(text) }
    } catch {
      return { status: res.status, body: text }
    }
  }
  const scrub = value => {
    if (Array.isArray(value)) return value.map(scrub)
    if (!value || typeof value !== 'object') return value
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = k === 'accountId' || k === 'accountNickname' ? null : scrub(v)
    return out
  }
  const state = await get('/api/v2/state/')
  const operations = {}
  const keypoints = {}
  for (const op of state.body?.result?.operations ?? []) {
    const detail = await get(`/api/v2/operation/${op.id}/`)
    operations[op.id] = detail
    const sample = (detail.body?.result?.stages ?? []).flatMap(s => s.keypoints ?? []).filter(k => k.status !== 'unrevealed').slice(0, 3)
    for (const kp of sample) keypoints[kp.id] = await get(`/api/v2/keypoint/${kp.id}/`)
  }
  const snapshot = scrub({
    capturedAt: new Date().toISOString(),
    href: location.href,
    realm: window.settings?.REALM ?? null,
    engine: window.adeck?.version ?? null,
    state,
    operations,
    keypoints,
    inventory: await get('/api/v2/inventory/'),
    summary: await get('/api/v2/operation/summary/'),
  })
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `nimitzpf-snapshot-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  console.log('NimitzPF snapshot', snapshot)
})()
