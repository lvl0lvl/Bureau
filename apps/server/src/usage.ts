import { usageGuard, type PlanUsage, type UsageWindow } from '../../../shared/contract.ts';
import type { Engine } from './engine/types.ts';
import type { Store } from './store.ts';

/**
 * How much of the Claude plan is used, and whether scheduled duties should wait.
 *
 * The office shares one plan with everything else signed in to that account. A busy schedule could
 * spend the week's allowance and leave the owner with none, so past a limit set in Settings the
 * scheduler holds duties back. Only scheduled duties are held: whatever the owner asks for runs.
 *
 * The figures come from Claude Code's own usage screen through the engine, which sends no message
 * and so spends nothing. They cover the office's account only; a member of staff given a second
 * account folder is not counted here.
 */

const DUE_ID = 'due_usage';
const MIN = 60_000;
/** Read again this often while the office is running. */
const EVERY = 10 * MIN;
/** Never start Claude Code for this more often than this. */
const AT_MOST = MIN;

export class UsageWatch {
  private deps: { store: Store; engine: Engine; configDir?: string | null };
  private week: UsageWindow | null = null;
  private checkedAt: number | null = null;
  private error: string | undefined;
  private asking: Promise<PlanUsage> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;
  private stopped = false;
  /** The Desk notice has been put up for the hold now in force. It is put up once, so the owner can clear it. */
  private noticed = false;

  constructor(deps: { store: Store; engine: Engine; configDir?: string | null }) {
    this.deps = deps;
  }

  /** A window that has passed its reset has started again, whatever was last read. */
  private live(w: UsageWindow | null): UsageWindow | null {
    return w && w.resetsAt !== null && w.resetsAt <= Date.now() ? { used: 0, resetsAt: null } : w;
  }

  status(): PlanUsage {
    const guard = usageGuard(this.deps.store.get('settings', 'settings'));
    const week = this.live(this.week);
    const holding: PlanUsage['holding'] = guard.on && week && week.used >= guard.week ? { used: week.used, limit: guard.week } : null;
    return { available: !!this.deps.engine.usage, week, checkedAt: this.checkedAt, guard, holding, ...(this.error ? { error: this.error } : {}) };
  }

  /** Read the figures from Claude now. Calls made while one is in flight share it. */
  refresh(): Promise<PlanUsage> {
    if (!this.deps.engine.usage) return Promise.resolve(this.status());
    this.asking ??= (async () => {
      try {
        const res = await this.deps.engine.usage!({ configDir: this.deps.configDir ?? null });
        this.week = res.week;
        this.error = undefined;
      } catch (e) {
        // Keep the last figures; they are still the best there is.
        this.error = (e as Error).message || 'The usage figures could not be read.';
      }
      this.checkedAt = Date.now();
      this.settle();
      return this.status();
    })().finally(() => { this.asking = null; });
    return this.asking;
  }

  /** The figures, read again first when they are older than `maxAge`. */
  async fresh(maxAge = EVERY): Promise<PlanUsage> {
    if (this.checkedAt !== null && Date.now() - this.checkedAt < Math.max(maxAge, AT_MOST)) return this.status();
    return this.refresh();
  }

  /**
   * Asked by the scheduler before each duty. Returns why the duty must wait, or null to go ahead.
   * When the figures cannot be read the duty goes ahead: a readout that is down should not stop the office.
   */
  async hold(): Promise<string | null> {
    const s = await this.fresh(5 * MIN);
    if (!s.holding) return null;
    const what = 'of the week’s Claude usage';
    const why = `${Math.round(s.holding.used)}% ${what} is spent; duties hold at ${s.holding.limit}%`;
    const owner = this.deps.store.get('settings', 'settings')?.ownerName ?? 'the owner';
    const w = s.week;
    const tz = this.deps.store.get('settings', 'settings')?.timezone ?? 'UTC';
    const back = w?.resetsAt ? new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', hour: 'numeric', minute: '2-digit' }).format(w.resetsAt) : null;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
    const note = `${back ? `Duties start again when it resets, ${back}. ` : ''}Anything ${owner.split(' ')[0]} asks for still runs. The limit is in Settings, under Usage.`.slice(0, 160);
    if (!this.noticed) {
      this.noticed = true;
      const title = `Scheduled duties are on hold: ${Math.round(s.holding.used)}% ${what} is spent`;
      this.deps.store.put('due', { id: DUE_ID, date: today, title, note, attention: true, staffId: null, done: false });
    }
    return why;
  }

  /** Take the notice off the Desk once duties are no longer being held. */
  private settle() {
    if (this.status().holding) return;
    this.noticed = false;
    if (this.deps.store.get('due', DUE_ID)) this.deps.store.del('due', DUE_ID);
  }

  /** A turn has just finished, so the figures have moved. Read them again shortly. */
  touched() {
    if (this.soon || this.stopped || !this.deps.engine.usage) return;
    this.soon = setTimeout(() => { this.soon = null; if (!this.stopped) void this.fresh(AT_MOST); }, 20_000);
    this.soon.unref();
  }

  start() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), EVERY);
    this.timer.unref();
    // A changed limit takes effect at once.
    this.off = this.deps.store.on((e) => { if (e.type === 'changes' && e.changes.some((c) => c.k === 'settings')) this.settle(); });
  }

  stop() {
    this.stopped = true;
    this.off?.();
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = this.soon = null;
  }
}
