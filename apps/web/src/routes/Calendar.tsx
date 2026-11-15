import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { DueItem, Duty, DutyRun, Staff } from '@shared/contract.ts';
import { Bubble } from '../components/bits.tsx';
import { clock, dayHeading, daysAway, isoDay, parseDay, plural, timeOfDay, when } from '../lib/format.ts';
import { Link } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { useNow, useStaffList, useStore } from '../sync/store.ts';

/**
 * The calendar: what is coming due, and when scheduled duties run.
 *
 * The list at the top always answers "what do I have to deal with": this week by default, the
 * month, everything, or one day when a day is chosen in the grid below.
 *
 * Two kinds of thing are on it. Due dates are the office's own and stay until they are done.
 * Appointments are copied from the owner's Google Calendar by a member of staff; they have a
 * time, belong to Google Calendar, and simply pass.
 */

type View = 'week' | 'month' | 'all' | 'schedule';
const VIEWS: [View, string][] = [['week', 'Week'], ['month', 'Month'], ['all', 'Everything'], ['schedule', 'On a schedule']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const addDays = (day: string, n: number) => { const d = parseDay(day); d.setDate(d.getDate() + n); return isoDay(d.getTime()); };
const addMonths = (day: string, n: number) => { const d = parseDay(day); d.setDate(1); d.setMonth(d.getMonth() + n); return isoDay(d.getTime()); };
const weekStart = (day: string) => addDays(day, -parseDay(day).getDay());
const monthStart = (day: string) => `${day.slice(0, 8)}01`;
const monthName = (day: string) => `${MONTHS[parseDay(day).getMonth()]} ${parseDay(day).getFullYear()}`;

/** "15 to 21 November 2026", or "29 November to 5 December 2026" across a month end. */
function rangeLabel(from: string, to: string): string {
  const a = parseDay(from);
  const b = parseDay(to);
  const tail = `${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} to ${tail}`;
  return `${a.getDate()} ${MONTHS[a.getMonth()]}${a.getFullYear() === b.getFullYear() ? '' : ` ${a.getFullYear()}`} to ${tail}`;
}

interface DayRun extends DutyRun { duty: Duty }

const byDate = (a: DueItem, b: DueItem) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title);

export function Calendar() {
  const t = useNow(60_000);
  const today = isoDay(t);
  const dueMap = useStore((s) => s.due);
  const dutyMap = useStore((s) => s.duties);
  const staffMap = useStore((s) => s.staff);
  const staff = useStaffList();

  const [view, setView] = useState<View>('week');
  /** Any day inside the week or month being shown. */
  const [anchor, setAnchor] = useState(today);
  const [chosen, setChosen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [form, setForm] = useState({ date: today, title: '', note: '', staffId: '', attention: false });
  const [runs, setRuns] = useState<DutyRun[]>([]);

  const grid = view === 'week' || view === 'month';
  const range = useMemo(() => {
    if (view === 'week') {
      const from = weekStart(anchor);
      return { from, to: addDays(from, 6), gridFrom: from, weeks: 1 };
    }
    const from = monthStart(anchor);
    const to = addDays(addMonths(from, 1), -1);
    const gridFrom = weekStart(from);
    const span = Math.round((parseDay(to).getTime() - parseDay(gridFrom).getTime()) / 86_400_000) + 1;
    return { from, to, gridFrom, weeks: Math.ceil(span / 7) };
  }, [view, anchor]);
  const cells = useMemo(() => Array.from({ length: range.weeks * 7 }, (_, i) => addDays(range.gridFrom, i)), [range]);
  const hasToday = today >= range.from && today <= range.to;
  const day = grid ? chosen : null;

  // When scheduled duties run in the days on screen. The office works this out, in its own time zone.
  const scheduleKey = Object.values(dutyMap).map((d) => `${d.id}:${d.enabled ? d.cron : ''}`).sort().join('|');
  const first = cells[0];
  const last = cells[cells.length - 1];
  useEffect(() => {
    if (!grid || !first || !last) return;
    let live = true;
    api.dutyRuns(first, last).then((r) => { if (live) setRuns(r.runs); }).catch(() => { if (live) setRuns([]); });
    return () => { live = false; };
  }, [grid, first, last, scheduleKey]);

  const open = useMemo(() => Object.values(dueMap).filter((d) => !d.done).sort(byDate), [dueMap]);
  /** A due date that has gone by is late. An appointment that has gone by is only over. */
  const isLate = (it: DueItem) => !it.source && it.date < today;
  const isOver = (it: DueItem) => !!it.source && it.date < today;
  const finished = useMemo(() => Object.values(dueMap).filter((d) => d.done).sort((a, b) => b.date.localeCompare(a.date)), [dueMap]);
  const byDay = useMemo(() => {
    const m = new Map<string, DueItem[]>();
    for (const it of open) m.set(it.date, [...(m.get(it.date) ?? []), it]);
    return m;
  }, [open]);
  const runsByDay = useMemo(() => {
    const m = new Map<string, DayRun[]>();
    for (const r of runs) {
      const duty = dutyMap[r.dutyId];
      if (duty) m.set(r.day, [...(m.get(r.day) ?? []), { ...r, duty }]);
    }
    return m;
  }, [runs, dutyMap]);

  /** What the list at the top shows. */
  const listed = useMemo(() => {
    if (day) return open.filter((d) => d.date === day);
    const current = open.filter((d) => !(d.source && d.date < today));
    if (view === 'all') return showDone ? [...current, ...finished] : current;
    return (hasToday ? current : open).filter((d) => d.date >= range.from && d.date <= range.to);
  }, [day, view, open, finished, showDone, range, hasToday, today]);
  // Anything already past its date belongs in front of the owner whenever they look at the present.
  const late = useMemo(() => (grid && !day && hasToday ? open.filter((d) => !d.source && d.date < today && d.date < range.from) : []), [grid, day, hasToday, open, today, range]);
  const groups = useMemo(() => {
    const out: { date: string; items: DueItem[] }[] = [];
    for (const it of listed) {
      const prev = out[out.length - 1];
      if (prev && prev.date === it.date) prev.items.push(it);
      else out.push({ date: it.date, items: [it] });
    }
    return out;
  }, [listed]);
  const next = open.find((d) => d.date > range.to);

  // Choosing a view always shows the whole of it, around the day that was being looked at.
  const show = (v: View) => { setView(v); if (v === 'week' || v === 'month') setAnchor(chosen ?? anchor); setChosen(null); };
  useEffect(() => {
    if (!chosen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) setChosen(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chosen]);
  const move = (n: number) => { setChosen(null); setAnchor(view === 'week' ? addDays(anchor, 7 * n) : addMonths(anchor, n)); };
  const goToday = () => { setChosen(null); setAnchor(today); };
  const startAdding = (date?: string) => { setForm((f) => ({ ...f, date: date ?? day ?? today })); setAdding(true); };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    await api.addDue({ date: form.date, title: form.title.trim(), note: form.note.trim() || null, staffId: form.staffId || null, attention: form.attention });
    setForm({ ...form, title: '', note: '', attention: false });
    setAdding(false);
  };

  const scheduled = useMemo(() => Object.values(dutyMap).filter((d) => d.cron).sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextDueAt ?? Infinity) - (b.nextDueAt ?? Infinity) || a.title.localeCompare(b.title)), [dutyMap]);
  const paused = scheduled.filter((d) => !d.enabled).length;

  const heading = day
    ? dayHeading(day)
    : view === 'week' ? (hasToday ? 'This week' : `Week of ${rangeLabel(range.from, range.to)}`)
    : view === 'month' ? (hasToday ? 'This month' : monthName(range.from))
    : view === 'all' ? 'Everything open' : 'On a schedule';
  const dayRuns = day ? runsByDay.get(day) ?? [] : [];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="cal-headline">
            <h1 className="page-title">Coming due</h1>
            <div className="views" role="tablist" aria-label="View">
              {VIEWS.map(([v, label]) => (
                <button key={v} role="tab" aria-selected={view === v} className={`view-tab${view === v ? ' on' : ''}`} onClick={() => show(v)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="page-lede">Renewals, filings, invoices and appointments that staff are tracking for you, with the duties that run on a schedule.</p>
        </div>
        <button className="btn btn-ink" onClick={() => (adding ? setAdding(false) : startAdding())}>
          {adding ? 'Close' : 'Add something'}
        </button>
      </header>

      {adding && (
        <form className="panel" onSubmit={add}>
          <div className="grid2">
            <label className="field">
              <span>What</span>
              <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Passport renewal" autoFocus />
            </label>
            <label className="field">
              <span>When</span>
              <input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </label>
            <label className="field">
              <span>Note</span>
              <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional" />
            </label>
            <label className="field">
              <span>Who looks after it</span>
              <select className="input select" value={form.staffId} onChange={(e) => setForm({ ...form, staffId: e.target.value })}>
                <option value="">Nobody yet</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.attention} onChange={(e) => setForm({ ...form, attention: e.target.checked })} />
            I have to decide something for this one
          </label>
          <div className="row">
            <button className="btn btn-blue" type="submit" disabled={!form.title.trim() || !form.date}>
              Add to the calendar
            </button>
          </div>
        </form>
      )}

      <section className="cal-top" aria-live="polite">
        <div className="cal-top-head">
          <div className="row">
            <h2 className="panel-title">
              {heading}
              {day && <small>{daysAway(day, t)}</small>}
              {!day && grid && hasToday && <small>{view === 'week' ? rangeLabel(range.from, range.to) : monthName(range.from)}</small>}
            </h2>
            {day && (
              <button className="btn btn-ink btn-sm" onClick={() => setChosen(null)}>
                Back to the whole {view}
              </button>
            )}
          </div>
          {day && (
            <button className="btn btn-soft btn-sm" onClick={() => startAdding(day)}>
              Add something on this day
            </button>
          )}
        </div>

        {view === 'schedule' ? (
          <div>
            {scheduled.length === 0 && <p className="empty">No duties run on a schedule yet. Add one to a person in Settings.</p>}
            {scheduled.map((d) => (
              <div key={d.id} className={`lane-row${d.enabled ? '' : ' cal-paused'}`}>
                <span className="lane-date" style={{ width: 130 }}>
                  {!d.enabled ? 'Paused' : d.nextDueAt ? when(d.nextDueAt, t) : 'Not set'}
                  {d.enabled && d.nextDueAt && isoDay(d.nextDueAt) !== today && <span className="lane-note" style={{ display: 'block', fontWeight: 400 }}>{clock(d.nextDueAt)}</span>}
                </span>
                <span className="lane-text" style={{ fontSize: 15, lineHeight: '22px' }}>
                  {d.title}
                  <span className="lane-note" style={{ display: 'block' }}>{d.cadence}</span>
                </span>
                {staffMap[d.staffId] && <Bubble staff={staffMap[d.staffId]} size={22} working={false} />}
              </div>
            ))}
            {paused > 0 && (
              <p className="cal-foot">
                {plural(paused, 'duty', 'duties')} {paused === 1 ? 'is' : 'are'} paused and will not run. <Link to="/settings" className="link">Switch duties on in Settings</Link>, under each person.
              </p>
            )}
          </div>
        ) : (
          <>
            {late.length > 0 && (
              <div className="cal-day">
                <div className="cal-date red">
                  Overdue
                  <small>{plural(late.length, 'thing')}</small>
                </div>
                <div className="cal-items">
                  {late.map((it) => <ItemRow key={it.id} it={it} staffMap={staffMap} now={t} dated />)}
                </div>
              </div>
            )}
            {groups.map((g) => (
              <div key={g.date} className="cal-day">
                <div className={`cal-date${g.items.some(isLate) ? ' red' : ''}`}>
                  {day ? 'On this day' : dayHeading(g.date)}
                  <small>{day ? (g.items.some(isLate) ? 'Overdue' : plural(g.items.length, 'thing')) : daysAway(g.date, t)}</small>
                </div>
                <div className="cal-items">
                  {g.items.map((it) => <ItemRow key={it.id} it={it} staffMap={staffMap} now={t} />)}
                </div>
              </div>
            ))}
            {dayRuns.length > 0 && (
              <div className="cal-day">
                <div className="cal-date soft">
                  Staff duties
                  <small>Run by themselves</small>
                </div>
                <div className="cal-items">
                  {dayRuns.map((r) => (
                    <div key={r.dutyId} className="cal-item">
                      <span className="cal-run-time">{clock(r.first)}</span>
                      <span className="lane-text" style={{ fontSize: 15, lineHeight: '22px' }}>
                        {r.duty.title}
                        <span className="lane-note" style={{ display: 'block' }}>{r.count > 1 ? `${r.count} times this day. ` : ''}{r.duty.cadence}</span>
                      </span>
                      {staffMap[r.duty.staffId] && <Bubble staff={staffMap[r.duty.staffId]} size={22} working={false} />}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {groups.length === 0 && late.length === 0 && dayRuns.length === 0 && (
              <p className="empty">
                <b>{day ? 'Nothing is due on this day.' : view === 'all' ? 'Nothing is coming due.' : `Nothing is due ${hasToday ? `this ${view}` : `in this ${view}`}.`}</b>{' '}
                {view === 'all'
                  ? 'Staff add dates here as they find them in your mail and records, and you can add your own.'
                  : next && !day ? <>The next thing after it is <button className="link" onClick={() => { setChosen(next.date); setAnchor(next.date); setView(view === 'week' ? 'week' : 'month'); }}>{next.title}</button>, on {dayHeading(next.date)}.</> : null}
              </p>
            )}
            {view === 'all' && finished.length > 0 && (
              <button className="btn btn-quiet" style={{ paddingLeft: 0, marginTop: 8 }} onClick={() => setShowDone(!showDone)}>
                {showDone ? 'Hide finished items' : `Show ${finished.length} finished`}
              </button>
            )}
          </>
        )}
      </section>

      {grid && (
        <section className="cal-board">
          <div className="cal-nav">
            <h2 className="panel-title">{view === 'week' ? rangeLabel(range.from, range.to) : monthName(range.from)}</h2>
            <div className="row">
              <button className="btn btn-soft btn-sm" onClick={() => move(-1)}>Earlier</button>
              <button className="btn btn-soft btn-sm" onClick={goToday} disabled={hasToday && !chosen}>Today</button>
              <button className="btn btn-soft btn-sm" onClick={() => move(1)}>Later</button>
            </div>
          </div>
          <div className={`cal-grid ${view}`}>
            {view === 'month' && WEEKDAYS.map((w) => <div key={w} className="cal-wd-head">{w}</div>)}
            {cells.map((d) => {
              const items = byDay.get(d) ?? [];
              const dr = runsByDay.get(d) ?? [];
              // A week has room for each duty and its time. A month keeps to what is due and counts the duties.
              const shownItems = items.slice(0, view === 'week' ? 9 : 3);
              const shownRuns = view === 'week' ? dr.slice(0, Math.max(0, 9 - shownItems.length)) : [];
              const more = items.length - shownItems.length + (view === 'week' ? dr.length - shownRuns.length : 0);
              const date = parseDay(d);
              const out = view === 'month' && (d < range.from || d > range.to);
              return (
                <button
                  key={d}
                  className={`cal-cell${d === chosen ? ' on' : ''}${d === today ? ' today' : ''}${out ? ' out' : ''}${d < today ? ' past' : ''}`}
                  aria-pressed={d === chosen}
                  aria-label={`${dayHeading(d)}: ${items.length ? `${plural(items.length, 'thing')} due` : 'nothing due'}${dr.length ? `, ${plural(dr.length, 'duty', 'duties')}` : ''}`}
                  onClick={() => setChosen(d === chosen ? null : d)}
                >
                  <span className="cal-cell-head">
                    {view === 'week' && <span className="cal-wd">{WEEKDAYS[date.getDay()]}</span>}
                    <span className="cal-num">{date.getDate()}</span>
                  </span>
                  <span className="cal-chips">
                    {shownItems.map((it) => (
                      <span key={it.id} className={`cal-chip${it.attention || isLate(it) ? ' red' : ''}${it.source ? ' appt' : ''}${isOver(it) ? ' over' : ''}`}>
                        <span className="cal-chip-text">{it.time && <span className="cal-chip-time">{timeOfDay(it.time)} </span>}{it.title}</span>
                        {view === 'week' && it.staffId && staffMap[it.staffId] && <Bubble staff={staffMap[it.staffId]} size={20} working={false} />}
                      </span>
                    ))}
                    {shownRuns.map((r) => (
                      <span key={r.dutyId} className="cal-chip run">
                        <span className="cal-chip-text">
                          <span className="cal-chip-time">{clock(r.first)}</span> {r.duty.title}
                        </span>
                      </span>
                    ))}
                    {more > 0 && <span className="cal-more">and {more} more</span>}
                    {view === 'month' && dr.length > 0 && <span className="cal-duties">{plural(dr.length, 'duty', 'duties')}</span>}
                  </span>
                  <span className="cal-marks" aria-hidden="true">
                    {items.slice(0, 4).map((it) => <i key={it.id} className={it.attention || isLate(it) ? 'red' : it.source ? 'blue' : ''} />)}
                    {dr.length > 0 && <i className="run" />}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="cal-foot">
            Choose a day to see it above, and choose it again to go back. Entries with a black edge are due dates and red ones need you. A blue edge is an appointment copied from your Google Calendar. Lighter entries are duties staff run by themselves.
          </p>
        </section>
      )}
    </div>
  );
}

function ItemRow({ it, staffMap, now, dated }: { it: DueItem; staffMap: Record<string, Staff>; now: number; dated?: boolean }) {
  const [moving, setMoving] = useState(false);
  return (
    <div className={`cal-item${it.done ? ' done' : ''}`}>
      {it.source ? <span className="cal-appt-mark" aria-hidden="true" /> : <input type="checkbox" checked={it.done} onChange={(e) => void api.saveDue(it.id, { done: e.target.checked })} aria-label={`Mark ${it.title} as done`} />}
      <span className="lane-text" style={{ fontSize: 15, lineHeight: '22px' }}>
        {it.time && <span className="cal-chip-time">{timeOfDay(it.time)} </span>}
        {it.title}
        {it.source && <span className="lane-note" style={{ display: 'block' }}>{it.time ? 'From your Google Calendar' : 'All day, from your Google Calendar'}</span>}
        {dated && <span className="lane-note red" style={{ display: 'block' }}>Was due {dayHeading(it.date)}, {daysAway(it.date, now).toLowerCase()}</span>}
        {it.note && <span className={`lane-note${it.attention && !it.done ? ' red' : ''}`} style={{ display: 'block' }}>{it.note}</span>}
        {moving && (
          <span className="cal-move">
            <input className="input" type="date" defaultValue={it.date} aria-label={`New date for ${it.title}`} autoFocus onChange={(e) => { if (e.target.value) { void api.saveDue(it.id, { date: e.target.value }); setMoving(false); } }} />
          </span>
        )}
      </span>
      {it.staffId && staffMap[it.staffId] && <Bubble staff={staffMap[it.staffId]} size={22} working={false} />}
      {!it.done && !it.source && (
        <button className="btn btn-quiet btn-sm" onClick={() => setMoving(!moving)}>
          {moving ? 'Keep the date' : 'Change date'}
        </button>
      )}
      <button className="btn btn-quiet btn-sm" onClick={() => void api.removeDue(it.id)} aria-label={`Remove ${it.title}`}>
        Remove
      </button>
    </div>
  );
}
