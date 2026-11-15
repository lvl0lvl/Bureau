import type { DueItem } from '../../../shared/contract.ts';
import { newId, type Store } from './store.ts';

/**
 * Copying the owner's Google Calendar onto the office calendar.
 *
 * The office holds no Google credential. A member of staff reads the calendar through the
 * connector on the Claude account and hands the events here. This module decides what is added,
 * changed and taken off, so that running it again never makes duplicates. Nothing here writes to
 * Google Calendar.
 *
 * Event titles are written by whoever sent the invitation, so every copied item is marked as
 * outside material, and reading it later carries that mark into the reader's turn.
 */

export const GOOGLE = 'google-calendar';
export const CALENDAR_OUTSIDE = 'Events on your calendar';
export const MAX_WINDOW_DAYS = 100;
export const MAX_EVENTS = 400;
const SKIP = '_calendar_skip';
const DAY = 86_400_000;

export interface CalendarEvent { event_id: string; start: string; title: string; note?: string }
export interface CopyResult { added: number; changed: number; removed: number; same: number; skipped: number; problems: string[] }

export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
const tidy = (s: unknown, max: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The date and time of day an event starts, in the office's time zone. A bare date is an all-day
 * event. A time without an offset is taken to be office time already.
 */
export function localStart(start: string, tz: string): { date: string; time: string | null } | null {
  const s = String(start ?? '').trim();
  if (isDate(s)) return { date: s, time: null };
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (!m || !isDate(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59) return null;
  if (!m[4]) return { date: m[1]!, time: `${m[2]}:${m[3]}` };
  const offset = /^z$/i.test(m[4]) ? 'Z' : m[4].length === 5 ? `${m[4].slice(0, 3)}:${m[4].slice(3)}` : m[4];
  const at = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00${offset}`);
  if (!Number.isFinite(at)) return null;
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** One event on one day. A repeating event has one of these for each day it falls on. */
const keyOf = (eventId: string, date: string) => `${eventId}@${date}`;

/**
 * Make the office calendar match the given events between two dates (inclusive). Items copied
 * earlier that fall in the window and are not in the list are taken off: they were cancelled or
 * moved. Items the owner removed from the office calendar are not put back.
 */
export function copyEvents(store: Store, o: { staffId: string; from: string; to: string; events: CalendarEvent[]; read?: string[] }): CopyResult {
  const res: CopyResult = { added: 0, changed: 0, removed: 0, same: 0, skipped: 0, problems: [] };
  if (!isDate(o.from) || !isDate(o.to)) { res.problems.push('from and to must be dates as YYYY-MM-DD.'); return res; }
  if (o.to < o.from) { res.problems.push('to is before from.'); return res; }
  if ((Date.parse(o.to) - Date.parse(o.from)) / DAY > MAX_WINDOW_DAYS) { res.problems.push(`The window is longer than ${MAX_WINDOW_DAYS} days. Copy a shorter stretch.`); return res; }
  if (o.events.length > MAX_EVENTS) { res.problems.push(`More than ${MAX_EVENTS} events. Copy a shorter stretch.`); return res; }

  const tz = store.get('settings', 'settings')?.timezone ?? 'UTC';
  const read = [...new Set([CALENDAR_OUTSIDE, ...(o.read ?? [])])];
  const skip = new Set(store.listPrivate<{ id: string }>(SKIP).map((s) => s.id));
  const have = new Map<string, DueItem>();
  for (const d of store.list('due')) if (d.source?.kind === GOOGLE) have.set(d.source.key, d);

  const seen = new Set<string>();
  for (const ev of o.events) {
    const eventId = tidy(ev.event_id, 200);
    const title = tidy(ev.title, 120);
    const at = localStart(ev.start, tz);
    if (!eventId || !title || !at) { res.problems.push(`“${title || eventId || 'an event'}”: ${!at ? 'the start could not be read' : 'it needs an id and a title'}.`); continue; }
    if (at.date < o.from || at.date > o.to) { res.problems.push(`“${title}” starts on ${at.date}, outside ${o.from} to ${o.to}.`); continue; }
    const key = keyOf(eventId, at.date);
    if (seen.has(key)) continue;
    seen.add(key);
    if (skip.has(key)) { res.skipped += 1; continue; }
    const note = tidy(ev.note, 160) || null;
    const cur = have.get(key);
    if (!cur) {
      store.put('due', { id: newId('due'), date: at.date, time: at.time, title, note, attention: false, staffId: o.staffId, done: false, source: { kind: GOOGLE, key }, read });
      res.added += 1;
    } else if (cur.title !== title || (cur.time ?? null) !== at.time || (cur.note ?? null) !== note) {
      store.update('due', cur.id, (d) => { d.title = title; d.time = at.time; d.note = note; d.read = read; });
      res.changed += 1;
    } else res.same += 1;
  }

  for (const [key, d] of have) {
    if (d.date < o.from || d.date > o.to || seen.has(key)) continue;
    store.del('due', d.id);
    res.removed += 1;
  }

  // Forget removals once their day is well past, so the list does not grow for ever.
  const old = new Date(Date.now() - 45 * DAY).toISOString().slice(0, 10);
  for (const id of skip) if ((id.split('@').pop() ?? '') < old) store.delPrivate(SKIP, id);
  return res;
}

/** The owner removed a copied item from the office calendar: do not copy that event again. */
export function ownerRemoved(store: Store, item: DueItem | undefined) {
  if (item?.source?.kind === GOOGLE) store.putPrivate(SKIP, { id: item.source.key, at: Date.now() });
}

/** "14:00" as "2:00 pm". */
export function timeOfDay(time: string | null | undefined): string {
  const m = /^(\d{2}):(\d{2})$/.exec(time ?? '');
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}
