import { DriveError } from './drive.ts'
import { LOADER, type PlayError, type PlayResult, type PlaySlot, type Snapshot } from './protocol.ts'
import { advanceableStage, battleSlots, playableKeypoint, SAFE_ID } from './rules.ts'

export interface PlayDriver {
  battle(operationId: string, keypointId: string, slots: readonly (PlaySlot | null)[], label: string): Promise<void>
  advance(operationId: string, label: string): Promise<void>
}

export interface PlayHost {
  readonly snapshot: () => Snapshot
  readonly loader: number
  readonly driver: PlayDriver
  readonly label: () => string
  readonly played: (operationId: string) => void
}

export class Player {
  private busy = false
  private stopped = false
  private readonly done = new Set<string>()

  constructor(private readonly host: PlayHost) {}

  halt(): void {
    this.stopped = true
  }

  halted(): boolean {
    return this.stopped
  }

  async play(request: unknown): Promise<PlayResult> {
    const fail = (error: PlayError, step: PlayResult['step'] = null, detail: string | null = null): PlayResult => ({ ok: false, error, step, detail })
    if (this.host.loader < LOADER) return fail('loader')
    if (this.busy) return fail('busy')
    if (!request || typeof request !== 'object') return fail('invalid')
    const r = request as Record<string, unknown>
    const operationId = String(r.operationId)
    if (!SAFE_ID.test(operationId)) return fail('invalid')
    const snapshot = this.host.snapshot()
    let key: string
    let run: () => Promise<void>
    if (r.kind === 'battle') {
      const keypointId = String(r.keypointId)
      const slots = battleSlots(r.slots)
      if (!SAFE_ID.test(keypointId) || !slots) return fail('invalid')
      if (playableKeypoint(snapshot, operationId, keypointId) === null) return fail('stale')
      key = `battle:${keypointId}`
      run = () => this.host.driver.battle(operationId, keypointId, slots, this.host.label())
    } else if (r.kind === 'advance') {
      const stageId = String(r.stageId)
      if (!SAFE_ID.test(stageId)) return fail('invalid')
      if (!advanceableStage(snapshot, operationId, stageId)) return fail('stale')
      key = `advance:${stageId}`
      run = () => this.host.driver.advance(operationId, this.host.label())
    } else return fail('invalid')
    if (this.done.has(key)) return fail('stale')
    this.busy = true
    this.stopped = false
    try {
      await run()
      this.done.add(key)
      this.host.played(operationId)
      return { ok: true, error: null, step: null, detail: null }
    } catch (error) {
      if (!(error instanceof DriveError)) return fail('ui', null, error instanceof Error ? error.message.slice(0, 200) : String(error))
      if (error.step === 'aborted') return fail('aborted', 'aborted')
      return fail(error.detail === 'rejected' ? 'rejected' : 'ui', error.step, error.detail)
    } finally {
      this.busy = false
    }
  }
}
