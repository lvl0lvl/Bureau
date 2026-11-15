import type { WeekReport, WeekTotals } from '../../../shared/contract.ts';
import type { Store } from './store.ts';

/**
 * What the office did over the last seven days, counted from its own records.
 *
 * Nothing here is written by a model. Every figure is a count of rows the office already keeps:
 * turns that ran, slips that were decided, things logged as done, work closed. That is the point
 * of it: it is the one account of the office that staff cannot shade.
 */

const DAY = 86_400_000;

interface UsageRow { id: string; staffId: string; at: number; ok: boolean; costUsd?: number; durationMs?: number; kind?: string }

const empty = (): WeekTotals => ({ turns: 0, minutes: 0, costUsd: 0, done: 0, signed: 0, asWritten: 0, edited: 0, declined: 0, rules: 0, dutyRuns: 0, workClosed: 0, flagged: 0 });

export function weekReport(store: Store, now = Date.now()): WeekReport {
  const to = now;
  const from = now - 7 * DAY;
  const before = from - 7 * DAY;

  const totals = empty();
  const previous = empty();
  const by = new Map<string, WeekTotals>();
  /** The right tally for a moment in time: this week, the week before, or neither. */
  const bucket = (at: number | null | undefined, staffId?: string | null): WeekTotals[] => {
    if (!at || at > to || at <= before) return [];
    if (at <= from) return [previous];
    if (!staffId) return [totals];
    if (!by.has(staffId)) by.set(staffId, empty());
    return [totals, by.get(staffId)!];
  };

  for (const u of store.listPrivate<UsageRow>('_usage')) {
    for (const t of bucket(u.at, u.staffId)) {
      t.turns += 1;
      t.minutes += (u.durationMs ?? 0) / 60_000;
      t.costUsd += u.costUsd ?? 0;
      if (u.kind === 'duty') t.dutyRuns += 1;
    }
  }

  const doneRows = store.list('done');
  for (const d of doneRows) for (const t of bucket(d.at, d.staffId)) t.done += 1;

  for (const s of store.list('slip')) {
    if (s.kind === 'lesson') {
      if (s.status === 'signed') for (const t of bucket(s.decidedAt, s.lesson?.staffId ?? s.staffId)) t.rules += 1;
      continue;
    }
    if (s.kind !== 'action' && s.kind !== 'review') continue;
    for (const t of bucket(s.decidedAt, s.staffId)) {
      if (s.status === 'declined') t.declined += 1;
      else if (s.status === 'signed') { t.signed += 1; t[s.edited ? 'edited' : 'asWritten'] += 1; }
    }
  }

  for (const w of store.list('work')) if (w.status === 'closed') for (const t of bucket(w.closedAt, w.staffId)) t.workClosed += 1;

  // Dates staff put on the Desk for a decision. Items written before this was recorded have no time and are left out.
  const flagged = store.list('due').filter((d) => d.attention && d.staffId && d.at && d.at > from && d.at <= to).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  for (const d of store.list('due')) if (d.attention && d.staffId) for (const t of bucket(d.at, d.staffId)) t.flagged += 1;

  const round = (t: WeekTotals) => { t.minutes = Math.round(t.minutes); t.costUsd = Math.round(t.costUsd * 100) / 100; return t; };
  const staff = store.list('staff').filter((s) => !s.retired || by.has(s.id)).sort((a, b) => a.order - b.order)
    .map((s) => ({ staffId: s.id, ...round(by.get(s.id) ?? empty()) }));

  return {
    from, to,
    totals: round(totals), previous: round(previous),
    staff,
    done: doneRows.filter((d) => d.at > from && d.at <= to).sort((a, b) => b.at - a.at).slice(0, 60).map((d) => ({ at: d.at, staffId: d.staffId, text: d.text })),
    flagged: flagged.slice(0, 20).map((d) => ({ date: d.date, title: d.title, note: d.note, staffId: d.staffId!, done: d.done })),
    waiting: store.list('slip').filter((s) => s.status === 'pending').length,
    held: store.list('duty').filter((d) => d.enabled && d.held).length,
    // The office started keeping these on the day this page was added; earlier weeks read low.
    since: Math.min(...store.listPrivate<UsageRow>('_usage').map((u) => u.at), now),
  };
}
