import type { WeekReport, WeekTotals } from '@shared/contract.ts';
import { Bubble, useLoad } from '../components/bits.tsx';
import { weekReading } from '../components/Usage.tsx';
import { clock, isoDay, plural, shortDate } from '../lib/format.ts';
import { Link } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { useNow, useStore } from '../sync/store.ts';
import { usePlanUsage } from '../sync/usage.ts';

/**
 * The last seven days, counted by the office from its own records. No member of staff writes
 * any of it, which is what makes it worth reading before changing what someone may do.
 */

const hours = (minutes: number) => {
  if (minutes < 60) return { fig: String(minutes), unit: minutes === 1 ? 'minute' : 'minutes' };
  const h = minutes / 60;
  return { fig: h >= 10 ? String(Math.round(h)) : h.toFixed(1).replace(/\.0$/, ''), unit: h === 1 ? 'hour' : 'hours' };
};

function Figure({ label, fig, unit, note, red = false }: { label: string; fig: string; unit?: string; note: string; red?: boolean }) {
  return (
    <div className="week-fig">
      <span className="week-fig-label">{label}</span>
      <span className={`week-fig-num${red ? ' red' : ''}`}>
        {fig}
        {unit && <small>{unit}</small>}
      </span>
      <span className="week-fig-note">{note}</span>
    </div>
  );
}

const before = (n: number, was: number, noun = '') => (was === 0 && n === 0 ? 'None the week before either' : `${was}${noun} the week before`);

export function Week() {
  const now = useNow(60_000);
  const week = useLoad<WeekReport>(() => api.week(), []);
  const staff = useStore((s) => s.staff);
  const usage = usePlanUsage();
  const w = week.data;

  if (!w) {
    return (
      <div className="page">
        <h1 className="page-title">The week</h1>
        <p className="empty">{week.error ? 'The week could not be counted just now.' : 'Counting.'}</p>
      </div>
    );
  }

  const t = w.totals;
  const p = w.previous;
  const time = hours(t.minutes);
  const plan = usage?.available && usage.week ? weekReading(usage, now) : null;
  const active = w.staff.filter((s) => s.turns || s.done || s.signed || s.declined || s.rules || s.flagged);
  const young = now - w.since < 14 * 86_400_000;
  const signedShare = (x: WeekTotals) => (x.signed + x.declined === 0 ? 'Nothing was put to you' : `${x.edited} edited, ${x.declined} declined`);

  let lastDay = '';
  return (
    <div className="page">
      <header>
        <h1 className="page-title">The week</h1>
        <p className="page-lede">
          {shortDate(w.from)} to {shortDate(w.to)}. Counted by the office from its own records; nothing on this page is written by staff.
        </p>
      </header>

      <section className="week-figs" aria-label="The week in figures">
        <Figure label="Finished" fig={String(t.done)} note={before(t.done, p.done)} />
        <Figure label="Signed as written" fig={String(t.asWritten)} unit={t.signed + t.declined ? `of ${t.signed + t.declined}` : undefined} note={signedShare(t)} />
        <Figure label="Time at work" fig={time.fig} unit={time.unit} note={`${plural(t.turns, 'piece')} of work, ${t.dutyRuns} on a schedule`} />
        {plan ? (
          <Figure label="Claude usage this week" fig={`${plan.used}%`} note={`${plan.reset}. Everything on your account, not only the office.`} red={plan.over} />
        ) : (
          <Figure label="Rules learned" fig={String(t.rules)} note="Signed into profiles after a correction" />
        )}
      </section>

      {(w.waiting > 0 || w.held > 0) && (
        <p className="week-now">
          {w.waiting > 0 && (
            <Link to="/" className="link">
              {plural(w.waiting, 'slip')} waiting for you now
            </Link>
          )}
          {w.waiting > 0 && w.held > 0 && ' '}
          {w.held > 0 && (
            <Link to="/settings#usage" className="link">
              {plural(w.held, 'duty', 'duties')} held by the usage limit
            </Link>
          )}
        </p>
      )}

      <section className="panel" style={{ maxWidth: 'none' }}>
        <h2 className="panel-title">By person</h2>
        {active.length === 0 ? (
          <p className="empty">Nobody has done any work in the last seven days.</p>
        ) : (
          <div className="week-table" role="table">
            <div className="week-row week-head" role="row">
              <span role="columnheader">Person</span>
              <span role="columnheader">Finished</span>
              <span role="columnheader">Pieces of work</span>
              <span role="columnheader">Time</span>
              <span role="columnheader">Signed as written</span>
              <span role="columnheader">Edited</span>
              <span role="columnheader">Declined</span>
              <span role="columnheader">Rules learned</span>
            </div>
            {active.map((s) => {
              const who = staff[s.staffId];
              const h = hours(s.minutes);
              return (
                <Link key={s.staffId} to={`/t/${s.staffId}`} className="week-row" role="row">
                  <span role="cell" className="week-who">
                    {who && <Bubble staff={who} size={24} working={false} />}
                    <b>{who?.name ?? 'Someone who has left'}</b>
                  </span>
                  <span role="cell" data-label="Finished">{s.done || ''}</span>
                  <span role="cell" data-label="Pieces of work">{s.turns || ''}</span>
                  <span role="cell" data-label="Time">{s.turns ? `${h.fig} ${h.unit.startsWith('minute') ? 'min' : 'h'}` : ''}</span>
                  <span role="cell" data-label="Signed as written">{s.signed + s.declined ? `${s.asWritten} of ${s.signed + s.declined}` : ''}</span>
                  <span role="cell" data-label="Edited">{s.edited || ''}</span>
                  <span role="cell" data-label="Declined" className={s.declined ? 'red' : ''}>{s.declined || ''}</span>
                  <span role="cell" data-label="Rules learned">{s.rules || ''}</span>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {w.flagged.length > 0 && (
        <section className="panel" style={{ maxWidth: 'none' }}>
          <h2 className="panel-title">Caught for you</h2>
          <p className="panel-lede">Dates staff put on the Desk this week because something needs your decision.</p>
          <div>
            {w.flagged.map((d, i) => (
              <div key={i} className="lane-row">
                <span className="lane-date">{shortDate(new Date(`${d.date}T12:00:00`).getTime())}</span>
                <span className="lane-text">
                  {d.title}
                  {d.note && <span className={`lane-note${d.done ? '' : ' red'}`} style={{ display: 'block' }}>{d.note}</span>}
                </span>
                {staff[d.staffId] && <Bubble staff={staff[d.staffId]!} size={20} working={false} />}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel" style={{ maxWidth: 'none' }}>
        <h2 className="panel-title">Finished</h2>
        {w.done.length === 0 ? (
          <p className="empty">Nothing was logged as finished in the last seven days.</p>
        ) : (
          <div>
            {w.done.map((d, i) => {
              const day = isoDay(d.at);
              const first = day !== lastDay;
              lastDay = day;
              return (
                <div key={i} className="lane-row">
                  <span className="lane-date soft" style={{ width: 96 }}>{first ? (day === isoDay(now) ? 'Today' : shortDate(d.at)) : ''}</span>
                  <span className="lane-date soft" style={{ width: 64, fontWeight: 400 }}>{clock(d.at)}</span>
                  <span className="lane-text">{d.text}</span>
                  {staff[d.staffId] && <Bubble staff={staff[d.staffId]!} size={20} working={false} />}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <p className="week-foot">
        The same work would have cost about ${t.costUsd.toFixed(2)} at API prices, as Claude Code reports it. That is a measure of how much was done, not a charge: the office runs on your plan.
        {young ? ` The office has been keeping these records since ${shortDate(w.since)}, so the week before may read low.` : ''}
      </p>
    </div>
  );
}
