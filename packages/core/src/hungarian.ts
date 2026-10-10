export function maximizeAssignment(value: readonly (readonly number[])[], rows: number, cols: number): number[] {
  const n = Math.max(rows, cols)
  let max = 0
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const v = value[i]![j]!
    if (Number.isFinite(v) && v > max) max = v
  }
  const forbidden = 1e9
  const cost = (i: number, j: number): number => {
    if (i >= rows || j >= cols) return max
    const v = value[i]![j]!
    return Number.isFinite(v) ? max - v : forbidden
  }
  const u = new Float64Array(n + 1)
  const v = new Float64Array(n + 1)
  const p = new Int32Array(n + 1)
  const way = new Int32Array(n + 1)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Float64Array(n + 1).fill(Infinity)
    const used = new Uint8Array(n + 1)
    do {
      used[j0] = 1
      const i0 = p[j0]!
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost(i0 - 1, j - 1) - u[i0]! - v[j]!
        if (cur < minv[j]!) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j]! < delta) {
          delta = minv[j]!
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta
          v[j] = v[j]! - delta
        } else minv[j] = minv[j]! - delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]!
      p[j0] = p[j1]!
      j0 = j1
    } while (j0)
  }
  const assignment = new Array<number>(rows).fill(-1)
  for (let j = 1; j <= n; j++) {
    const i = p[j]! - 1
    if (i >= 0 && i < rows && j - 1 < cols && Number.isFinite(value[i]![j - 1]!)) assignment[i] = j - 1
  }
  return assignment
}
