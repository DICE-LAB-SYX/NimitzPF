export type Distribution = Float64Array

export function pointMass(at: number): Distribution {
  const d = new Float64Array(at + 1)
  d[at] = 1
  return d
}

export function addBernoulli(dist: Distribution, p: number, weight: number): Distribution {
  const out = new Float64Array(dist.length + weight)
  const q = 1 - p
  for (let k = 0; k < dist.length; k++) {
    const m = dist[k]!
    if (m === 0) continue
    out[k] = out[k]! + m * q
    out[k + weight] = out[k + weight]! + m * p
  }
  return out
}

export function missBernoulli(dist: Distribution, p: number): Distribution {
  const out = new Float64Array(dist.length)
  const q = 1 - p
  for (let k = 0; k < dist.length; k++) out[k] = dist[k]! * q
  return out
}

export function convolve(a: Distribution, b: Distribution): Distribution {
  const out = new Float64Array(a.length + b.length - 1)
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    if (x === 0) continue
    for (let j = 0; j < b.length; j++) out[i + j] = out[i + j]! + x * b[j]!
  }
  return out
}

export function atLeast(dist: Distribution, threshold: number): number {
  if (threshold <= 0) return 1
  return survival(dist, threshold)
}

function survival(dist: Distribution, threshold: number): number {
  let total = 0
  for (let k = Math.max(0, Math.ceil(threshold)); k < dist.length; k++) total += dist[k]!
  return Math.min(1, Math.max(0, total))
}

export function metSurvival(dist: Distribution, missed: Distribution, threshold: number): number {
  let total = 0
  for (let k = Math.max(0, Math.ceil(threshold)); k < dist.length; k++) total += dist[k]! - (missed[k] ?? 0)
  return Math.min(1, Math.max(0, total))
}

export function mean(dist: Distribution): number {
  let total = 0
  for (let k = 0; k < dist.length; k++) total += k * dist[k]!
  return total
}
