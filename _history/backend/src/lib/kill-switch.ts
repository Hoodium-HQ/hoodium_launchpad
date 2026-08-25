/**
 * Global kill switch — T1.5 / AL-N8.
 *
 * "A global kill switch SHALL halt execution for all users within 10 seconds."
 *
 * Polled every 5 seconds, so the worst-case observation delay is 5s plus one DB
 * round trip — inside the 10s budget with room for a slow read.
 *
 * Fail-safe: if the poll *fails*, the switch reads as engaged. An execution layer
 * that cannot confirm it is allowed to act must not act.
 */
import { componentLogger } from './logger.js'
import { KILL_SWITCH_KEY, SystemFlagModel } from '../db/models/system-flag.js'

const POLL_INTERVAL_MS = 5_000

export class KillSwitch {
  private engaged: boolean
  private reason: string | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly log = componentLogger('kill-switch')

  /** `envDefault` comes from KILL_SWITCH in config (004 section 9) and pins the switch on. */
  constructor(private readonly envDefault: boolean) {
    this.engaged = envDefault
    if (envDefault) this.reason = 'KILL_SWITCH=true in configuration'
  }

  /** True when execution must not proceed. Callers check this, never a cached copy. */
  isEngaged(): boolean {
    return this.engaged
  }

  getReason(): string | null {
    return this.reason
  }

  async start(): Promise<void> {
    await this.poll()
    this.timer = setInterval(() => {
      void this.poll()
    }, POLL_INTERVAL_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async poll(): Promise<void> {
    // Configuration wins: an operator who set KILL_SWITCH=true should not have it
    // undone by a stale flag document.
    if (this.envDefault) return

    try {
      const flag = await SystemFlagModel.findOne({ key: KILL_SWITCH_KEY }).lean()
      const next = flag?.enabled === true
      if (next !== this.engaged) {
        this.engaged = next
        this.reason = next ? (flag?.reason ?? 'kill switch engaged') : null
        this.log.warn({ engaged: next, reason: this.reason }, 'kill switch changed')
      }
    } catch (err) {
      // Fail closed.
      if (!this.engaged) {
        this.engaged = true
        this.reason = 'kill-switch poll failed — failing closed'
        this.log.error({ err }, 'kill switch poll failed; halting execution')
      }
    }
  }
}

let instance: KillSwitch | null = null

export function initKillSwitch(envDefault: boolean): KillSwitch {
  instance = new KillSwitch(envDefault)
  return instance
}

export function killSwitch(): KillSwitch {
  if (!instance) throw new Error('kill switch not initialised — call initKillSwitch() during boot')
  return instance
}

/** Operator control surface, used by the admin route and by ops scripts. */
export async function setKillSwitch(enabled: boolean, reason: string, setBy: string): Promise<void> {
  await SystemFlagModel.updateOne(
    { key: KILL_SWITCH_KEY },
    { $set: { enabled, reason: enabled ? reason : null, setBy } },
    { upsert: true },
  )
  if (instance) await instance.poll()
}
