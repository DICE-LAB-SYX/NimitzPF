export function roundHalfAway(x: number): number {
  if (!Number.isFinite(x)) return x
  const t = Math.trunc(x)
  return Math.abs(x - t) >= 0.5 ? t + Math.sign(x) : t
}

export function roundSpec(x: number): number {
  return roundHalfAway(roundHalfAway(x * 100) / 100)
}

export function roundPercent(p: number): number {
  return roundHalfAway((roundHalfAway(p * 1e4) / 1e4) * 100)
}
