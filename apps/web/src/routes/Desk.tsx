import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Bubble, SearchIcon, Wordmark } from '../components/bits.tsx';
import { SlipCard } from '../components/Slip.tsx';
import { clock, dueLane, dur, greeting, isoDay, longDate, plural, shortDate, timeOfDay } from '../lib/format.ts';
import { Link, navigate, useSearch } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { useChief, useHireDrafts, useIsPhone, useNow, useSlipList, useStaffByAttention, useStaffList, useStore } from '../sync/store.ts';

const NUMBER = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/**
 * On a phone, the people along the top of the Desk: a red ring is waiting on the owner, yellow is
 * working now. When they do not all fit, the last place counts the rest and opens the Staff page.
 */
function StaffStrip() {
  const { staff, waiting } = useStaffByAttention();
  const live = useStore((s) => s.live);
  const [places, setPlaces] = useState(() => stripPlaces());
  useEffect(() => {
    const on = () => setPlaces(stripPlaces());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  if (staff.length === 0) return null;
  const shown = staff.length <= places ? staff : staff.slice(0, places - 1);
  const rest = staff.slice(shown.length);
  return (
    <nav className="strip" aria-label="Staff" style={{ gridTemplateColumns: `repeat(${places}, 1fr)` }}>
      {shown.map((s) => {
        const state = waiting.has(s.id) ? 'waiting on you' : live[s.id]?.running ? 'working now' : '';
        return (
          <Link key={s.id} to={`/t/${s.id}`} className="strip-item" aria-label={state ? `${s.name}, ${state}` : s.name}>
            <Bubble staff={s} size={40} needs={waiting.has(s.id)} />
            <span className="strip-name">{s.name}</span>
          </Link>
        );
      })}
      {rest.length > 0 && (
        <Link to="/staff" className="strip-item" aria-label={`${rest.length} more, see everyone`}>
          <span className={`bubble s40 strip-more${rest.some((s) => waiting.has(s.id)) ? ' needs' : ''}`} aria-hidden="true">
            +{rest.length}
          </span>
          <span className="strip-name">Everyone</span>
        </Link>
      )}
    </nav>
  );
}

/** How many 40px bubbles with a name beneath fit across the phone's Desk (20px margins). */
function stripPlaces(): number {
  return Math.max(4, Math.min(8, Math.floor((window.innerWidth - 40) / 56)));
}

export function Desk() {
  const t = useNow(15_000);
  const settings = useStore((s) => s.settings);
  const staffMap = useStore((s) => s.staff);
  const brief = useStore((s) => s.brief);
  const liveMap = useStore((s) => s.live);
  const dueMap = useStore((s) => s.due);
  const doneMap = useStore((s) => s.done);
  const staff = useStaffList();
  const slips = useSlipList();
  const chief = useChief();
  const hireDrafts = useHireDrafts();
  const [ask, setAsk] = useState('');
  const askRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        askRef.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const open = slips.filter((s) => s.status === 'pending' || s.status === 'signing');
  const pending = open.filter((s) => s.status === 'pending');
  const settled = useMemo(
    () =>
      slips
        .filter((s) => (s.status === 'signed' || s.status === 'declined') && s.decidedAt && t - s.decidedAt < 18 * 3_600_000)
        .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
        .slice(0, 3),
    [slips, t],
  );
  // On a wide screen the first slip waiting is open, ready to read. On a phone the list stays short.
  const phone = useIsPhone();
  // A slip being signed keeps its place until it goes ahead, so nothing below it jumps.
  const firstPending = phone || open[0]?.status === 'signing' ? undefined : pending[0]?.id;

  // A notification opens the Desk at one slip: /?slip=<id>.
  const focusSlip = new URLSearchParams(useSearch()).get('slip');

  const working = staff.filter((s) => liveMap[s.id]?.running);
  // Due dates, and today's appointments. The rest of the appointments are on the calendar.
  const today = isoDay(t);
  const due = useMemo(() => Object.values(dueMap).filter((d) => !d.done && (!d.source || d.date === today)).sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '')), [dueMap, today]);
  const done = useMemo(() => {
    const since = new Date(t);
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 1);
    return Object.values(doneMap).filter((d) => d.at >= since.getTime()).sort((a, b) => b.at - a.at);
  }, [doneMap, t]);

  const owner = settings?.ownerName ?? '';
  const freshBrief = brief && isoDay(brief.at) === isoDay(t) ? brief : null;
  const briefAuthor = freshBrief ? staffMap[freshBrief.staffId] : undefined;
  const n = pending.length;
  const fallback = `${greeting(t)}${owner ? `, ${owner}` : ''}. ${n === 0 ? 'Nothing needs your signature.' : `${NUMBER[n] ?? n} thing${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} your signature.`}`;

  const submitAsk = (e: FormEvent) => {
    e.preventDefault();
    if (!chief || !ask.trim()) return;
    void api.sendMessage(chief.id, ask);
    setAsk('');
    navigate(`/t/${chief.id}`);
  };

  return (
    <div className="desk">
      <div className="desk-main">
        <div className="topbar desk-only">
          <span className="topbar-date">{longDate(t)}</span>
          <div className="topbar-actions">
            <form className="ask" onSubmit={submitAsk} role="search">
              <SearchIcon />
              <input ref={askRef} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={`Ask ${chief?.name ?? 'your chief of staff'} for anything`} aria-label={`Ask ${chief?.name ?? 'your chief of staff'}`} />
              <kbd>⌘K</kbd>
            </form>
            {chief && (
              <Link to={`/t/${chief.id}`} className="btn btn-ink">
                New request
              </Link>
            )}
          </div>
        </div>
        <div className="phone-head phone-only flex">
          <Wordmark />
          <span className="topbar-date">{shortDate(t)}</span>
        </div>
        {phone && <StaffStrip />}

        <header className="brief">
          <h1 className="brief-text">{freshBrief ? freshBrief.text : fallback}</h1>
          {freshBrief && briefAuthor && (
            <div className="brief-by">
              <Bubble staff={briefAuthor} size={24} working={false} />
              <span className="desk-only">
                Written by {briefAuthor.name}
                {briefAuthor.isChief ? ', your chief of staff,' : ''} at {clock(freshBrief.at)}
              </span>
              <span className="phone-only">
                {briefAuthor.name}, {clock(freshBrief.at)}
              </span>
              <Link to={`/t/${briefAuthor.id}`} className="link">
                <span className="desk-only">Read the full brief</span>
                <span className="phone-only">Full brief</span>
              </Link>
              <Link to="/week" className="link phone-only">
                The week
              </Link>
            </div>
          )}
        </header>

        {hireDrafts.length > 0 && (
          <Link to="/hire" className="desk-pointer">
            <span className="grow">
              <b>{hireDrafts.length === 1 ? 'A hire is in draft' : `${hireDrafts.length} hires are in draft`}:</b>{' '}
              {hireDrafts.map((h) => `${h.name}, ${h.role.charAt(0).toLowerCase()}${h.role.slice(1)}`).join('; ')}. Nothing exists until you sign.
            </span>
            <span className="link">Open the hiring desk</span>
          </Link>
        )}

        <section className="section" aria-label="To sign">
          <div className="section-head desk-only">
            <h2 className="section-title">To sign</h2>
            {n > 0 && <span className="section-count">{n}</span>}
          </div>
          {open.length === 0 && settled.length === 0 ? (
            <p className="empty">
              <b>Nothing is waiting for you.</b> When someone needs your signature or a decision, the slip appears here and on your phone.
            </p>
          ) : (
            <div className="slips">
              {open.length === 0 && <p className="empty">Nothing is waiting for you. Here is what you signed most recently.</p>}
              {open.map((s) => (
                <SlipCard key={s.id} slip={s} autoOpen={focusSlip ? s.id === focusSlip : s.id === firstPending} focus={s.id === focusSlip} />
              ))}
              {settled.map((s) => (
                <SlipCard key={s.id} slip={s} />
              ))}
            </div>
          )}
        </section>
      </div>

      <aside className="desk-aside">
        <section className="aside-block" aria-label="Working now">
          <div className="aside-head" style={{ paddingTop: 8 }}>
            <h2 className="aside-title">Working now</h2>
            <span className="aside-meta">
              {working.length} of {staff.length} staff
            </span>
          </div>
          {working.length === 0 ? (
            <p className="empty" style={{ fontSize: 14 }}>
              Nobody is working at the moment. Give someone a job from their thread.
            </p>
          ) : (
            <div className="work-rows">
              {working.map((s) => {
                const l = liveMap[s.id]!;
                return (
                  <Link key={s.id} to={`/t/${s.id}`} className="work-row">
                    <Bubble staff={s} working />
                    <span className="grow">
                      <span className="work-name" style={{ display: 'block' }}>
                        {s.name}
                      </span>
                      <span className="work-what" style={{ display: 'block' }}>
                        {l.waitingSlipId ? <span className="red" style={{ fontWeight: 600 }}>{l.activity ?? 'Waiting for you'}</span> : (l.activity ?? 'Working')}
                      </span>
                    </span>
                    <span className="work-time">{l.since ? dur(t - l.since) : ''}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <section className="aside-block" aria-label="Coming due">
          <div className="aside-head">
            <h2 className="aside-title">Coming due</h2>
            <Link to="/calendar" className="link">
              Calendar
            </Link>
          </div>
          {due.length === 0 ? (
            <p className="empty" style={{ fontSize: 14 }}>
              Nothing is coming due. Staff add renewals, filings and appointments here as they find them.
            </p>
          ) : (
            due.slice(0, 6).map((d) => (
              <Link key={d.id} to="/calendar" className="lane-row">
                <span className="lane-date">{dueLane(d.date, t)}</span>
                <span className="lane-text">
                  {d.time ? `${timeOfDay(d.time)} ` : ''}{d.title}
                  {d.note && <span className={`lane-note${d.attention ? ' red' : ''}`} style={{ display: 'block' }}>{d.note}</span>}
                </span>
                {d.staffId && staffMap[d.staffId] && <Bubble staff={staffMap[d.staffId]} size={20} working={false} />}
              </Link>
            ))
          )}
        </section>

        <section className="aside-block" aria-label="Done since yesterday">
          <div className="aside-head">
            <h2 className="aside-title">Done since yesterday</h2>
            <Link to="/week" className="link" style={{ fontSize: 13 }}>
              The week
            </Link>
          </div>
          {done.length === 0 ? (
            <p className="empty" style={{ fontSize: 14 }}>
              Nothing yet. Finished work is listed here with who did it and when.
            </p>
          ) : (
            done.slice(0, 5).map((d) => (
              <div key={d.id} className="lane-row" style={{ padding: '8px 0' }}>
                <span className="lane-date soft">{isoDay(d.at) === isoDay(t) ? clock(d.at) : 'Yesterday'}</span>
                <span className="lane-text">{d.text}</span>
                {staffMap[d.staffId] && <Bubble staff={staffMap[d.staffId]} size={20} working={false} />}
              </div>
            ))
          )}
        </section>
      </aside>
    </div>
  );
}
