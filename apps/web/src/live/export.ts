import type { Snapshot } from '../bridge/protocol.ts'

const PRIVATE_KEYS = new Set(['accountId', 'accountNickname'])

export function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrub) as T
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = PRIVATE_KEYS.has(k) ? null : scrub(v)
  return out as T
}

export function exportable(snapshot: Snapshot): Snapshot {
  return scrub({ ...snapshot, settings: null })
}

export function downloadSnapshot(snapshot: Snapshot): void {
  const blob = new Blob([JSON.stringify(exportable(snapshot), null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `nimitzpf-snapshot-${snapshot.realm ?? 'game'}-${snapshot.at}.json`
  document.body.append(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
