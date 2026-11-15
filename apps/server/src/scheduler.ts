import { Cron } from 'croner';
import type { DutyRun } from '../../../shared/contract.ts';
import type { Store } from './store.ts';
import type { Turns } from './turns.ts';
import type { UsageWatch } from './usage.ts';

/** Runs duties on their schedule. A duty that is switched off, or has no schedule, never fires. */
export class Scheduler {
  private jobs = new Map<string, { cron: Cron; pattern: string; tz: string }>();
  private off: (() => void) | null = null;
  private deps: { store: Store; turns: Turns; usage?: UsageWatch };

  constructor(deps: { store: Store; turns: Turns; usage?: UsageWatch }) {
    this.deps = deps;
  }

  start() {
    this.sync();
    this.off = this.deps.store.on((e) => {
      if (e.type === 'changes' && e.changes.some((c) => c.k === 'duty' || c.k === 'settings' || (c.k === 'del' && c.kind === 'duty'))) this.sync();
    });
  }

  stop() {
    this.off?.();
    for (const j of this.jobs.values()) j.cron.stop();
    this.jobs.clear();
  }

  static valid(pattern: string): boolean {
    if (pattern.trim().split(/\s+/).length !== 5) return false;
    try { new Cron(pattern, { paused: true }).stop(); return true; } catch { return false; }
  }

  /**
   * When the duties that are switched on will run between two local dates (inclusive), one entry
   * per duty per day. The range is limited to about three months.
   */
  runsBetween(from: string, to: string): DutyRun[] {
    const { store } = this.deps;
    const tz = store.get('settings', 'settings')?.timezone ?? 'UTC';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const start = Date.parse(`${from}T00:00:00Z`) - 14 * 3_600_000;
    const end = Math.min(Date.parse(`${to}T00:00:00Z`) + 38 * 3_600_000, start + 100 * 86_400_000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
    const out: DutyRun[] = [];
    for (const duty of store.list('duty')) {
      if (!duty.enabled || !duty.cron || !Scheduler.valid(duty.cron) || store.get('staff', duty.staffId)?.retired) continue;
      const cron = new Cron(duty.cron, { timezone: tz, paused: true });
      const byDay = new Map<string, DutyRun>();
      let at: Date | null = new Date(start);
      for (let i = 0; i < 3000; i += 1) {
        at = cron.nextRun(at);
        if (!at || at.getTime() > end) break;
        const d = day.format(at);
        if (d < from || d > to) continue;
        const cur = byDay.get(d);
        if (cur) cur.count += 1;
        else byDay.set(d, { dutyId: duty.id, day: d, first: at.getTime(), count: 1 });
      }
      cron.stop();
      out.push(...byDay.values());
    }
    return out.sort((a, b) => a.first - b.first);
  }

  /**
   * A duty's time has come. It runs, unless the plan's usage has reached the limit set in Settings,
   * in which case this run is skipped and the duty says why. The next scheduled run is tried as usual.
   */
  async fire(id: string): Promise<'ran' | 'held' | 'off'> {
    const { store, turns, usage } = this.deps;
    const d = store.get('duty', id);
    if (!d || !d.enabled) return 'off';
    const why = usage ? await usage.hold().catch(() => null) : null;
    // Refresh the next run time once this firing has been accounted for.
    setTimeout(() => this.sync(), 1500).unref();
    if (why) {
      store.update('duty', id, (x) => { x.held = { at: Date.now(), why }; });
      return 'held';
    }
    if (d.held) store.update('duty', id, (x) => { x.held = null; });
    void turns.enqueue(d.staffId, { kind: 'duty', dutyId: d.id, title: d.title, prompt: d.prompt });
    return 'ran';
  }

  private sync() {
    const { store } = this.deps;
    const tz = store.get('settings', 'settings')?.timezone ?? 'UTC';
    const seen = new Set<string>();

    for (const duty of store.list('duty')) {
      const wanted = duty.enabled && duty.cron && Scheduler.valid(duty.cron) && !store.get('staff', duty.staffId)?.retired;
      const existing = this.jobs.get(duty.id);
      if (!wanted) {
        if (duty.nextDueAt !== null) store.update('duty', duty.id, (d) => { d.nextDueAt = null; });
        continue;
      }
      seen.add(duty.id);
      if (!existing || existing.pattern !== duty.cron || existing.tz !== tz) {
        existing?.cron.stop();
        const id = duty.id;
        const cron = new Cron(duty.cron!, { timezone: tz }, () => { void this.fire(id); });
        this.jobs.set(id, { cron, pattern: duty.cron!, tz });
      }
      const next = this.jobs.get(duty.id)!.cron.nextRun()?.getTime() ?? null;
      if (next !== duty.nextDueAt) store.update('duty', duty.id, (d) => { d.nextDueAt = next; });
    }

    for (const [id, job] of this.jobs) {
      if (!seen.has(id)) { job.cron.stop(); this.jobs.delete(id); }
    }
  }
}
