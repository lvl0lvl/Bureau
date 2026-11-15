import { type ContextUse, type PlanUsage, type Staff } from '@shared/contract.ts';
import { resetIn, tokens } from '../lib/format.ts';
import { Link } from '../lib/router.tsx';
import { useNow, useStaffList, useStore } from '../sync/store.ts';
import { usePlanUsage } from '../sync/usage.ts';

/**
 * Always in view: how much of the week's Claude allowance is used and when it starts again, and
 * how far a staff conversation is from being compacted. The mark on the week's bar is where
 * scheduled duties are held.
 */

export function weekReading(usage: PlanUsage, now: number) {
  const w = usage.week;
  const used = w ? Math.round(w.used) : 0;
  const limit = usage.guard.on ? usage.guard.week : null;
  const over = limit !== null && !!w && w.used >= limit;
  const reset = w?.resetsAt ? `Resets in ${resetIn(w.resetsAt, now)}` : w && w.used > 0 ? 'Reset time not given' : 'Not started';
  return { used, limit, over, reset };
}

/** How full a conversation is, measured against the point where compaction starts. */
export function contextReading(c: ContextUse | null | undefined) {
  if (!c || c.compactsAt <= 0) return null;
  const left = Math.max(0, c.compactsAt - c.used);
  return { pct: Math.min(100, Math.round((c.used / c.compactsAt) * 100)), left, used: c.used, window: c.window, compactsAt: c.compactsAt };
}

/**
 * Whose conversation the readout shows: the person whose thread is open, otherwise whoever is
 * nearest to compaction.
 */
function useContextInView(staffId: string | null): { staff: Staff; reading: ReturnType<typeof contextReading> } | null {
  const staff = useStaffList();
  if (staffId) {
    const s = staff.find((x) => x.id === staffId);
    return s ? { staff: s, reading: contextReading(s.context) } : null;
  }
  let best: { staff: Staff; reading: NonNullable<ReturnType<typeof contextReading>> } | null = null;
  for (const s of staff) {
    const r = contextReading(s.context);
    if (r && (!best || r.pct > best.reading.pct)) best = { staff: s, reading: r };
  }
  return best;
}

export function Bar({ used, limit = null, over = false }: { used: number; limit?: number | null; over?: boolean }) {
  return (
    <span className={`usage-bar${over ? ' over' : ''}`} aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, used))}%` }} />
      {limit !== null && limit < 100 && <b style={{ left: `${limit}%` }} />}
    </span>
  );
}

const contextTitle = (name: string, r: NonNullable<ReturnType<typeof contextReading>>) =>
  `${name}’s conversation holds ${tokens(r.used)} tokens. Claude Code summarizes the earlier part when it reaches ${tokens(r.compactsAt)}.`;

/** The sidebar readout. `staffId` is the person whose thread is open, if any. */
export function UsageMeter({ staffId }: { staffId: string | null }) {
  const usage = usePlanUsage();
  const now = useNow(30_000);
  const demo = useStore((s) => s.settings?.engine === 'demo');
  const ctx = useContextInView(staffId);
  const week = usage?.available && usage.week ? weekReading(usage, now) : null;
  if (!week && !ctx) return null;
  return (
    <Link to="/settings#usage" className="usage" aria-label="Claude usage and conversation size. Open them in Settings.">
      <span className="usage-title">{demo ? 'Claude usage, demo' : 'Claude usage'}</span>
      {week && (
        <span className={`usage-row${week.over ? ' over' : ''}`}>
          <span className="usage-line">
            <span className="usage-label">Week</span>
            <span className="usage-pct">{week.used}%</span>
            <span className="usage-note">{week.reset.replace(/^R/, 'r')}</span>
          </span>
          <Bar used={week.used} limit={week.limit} over={week.over} />
        </span>
      )}
      {usage?.holding && <span className="usage-hold">Scheduled duties on hold</span>}
      {ctx && (
        <span className="usage-row" title={ctx.reading ? contextTitle(ctx.staff.name, ctx.reading) : undefined}>
          <span className="usage-line">
            <span className="usage-label">Context</span>
            <span className="usage-pct">{ctx.reading ? `${ctx.reading.pct}%` : '0%'}</span>
            <span className="usage-note">{ctx.reading ? `${ctx.staff.name}, ${tokens(ctx.reading.left)} left` : `${ctx.staff.name}, not started`}</span>
          </span>
          <Bar used={ctx.reading?.pct ?? 0} />
        </span>
      )}
    </Link>
  );
}

/** One line for the phone, above the message box. */
export function UsageStrip() {
  const usage = usePlanUsage();
  const now = useNow(30_000);
  const ctx = useContextInView(null);
  const week = usage?.available && usage.week ? weekReading(usage, now) : null;
  if (!week && !ctx?.reading) return null;
  return (
    <Link to="/settings#usage" className="usage-strip" aria-label="Claude usage and conversation size. Open them in Settings.">
      {week && (
        <span className={`usage-strip-part${week.over ? ' over' : ''}`}>
          <span className="usage-label">Week</span>
          <span className="usage-pct">{week.used}%</span>
          {usage?.holding ? <span className="usage-hold">duties on hold</span> : <span className="usage-note">{week.reset.replace(/^R/, 'r')}</span>}
        </span>
      )}
      {ctx?.reading && (
        <span className="usage-strip-part">
          <span className="usage-label">Context</span>
          <span className="usage-pct">{ctx.reading.pct}%</span>
          <span className="usage-note">{ctx.staff.name}, {tokens(ctx.reading.left)} left</span>
        </span>
      )}
    </Link>
  );
}

/** One line for a thread on the phone, where the sidebar and the bar above the message box are not shown. */
export function ContextLine({ staff }: { staff: Staff }) {
  const r = contextReading(staff.context);
  if (!r) return null;
  return (
    <span className="thread-context" title={contextTitle(staff.name, r)}>
      Context {r.pct}%, {tokens(r.left)} until compaction
    </span>
  );
}
