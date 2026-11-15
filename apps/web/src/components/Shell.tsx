import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, navigate, type Route } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { useChief, useOpenWorkCount, usePendingCount, useStaffList, useStore } from '../sync/store.ts';
import { UsageMeter, UsageStrip } from './Usage.tsx';
import { Bubble, Me, MicIcon, PlusIcon, SendIcon, Wordmark } from './bits.tsx';

const NAV: { to: string; name: Route['name']; label: string }[] = [
  { to: '/', name: 'desk', label: 'Desk' },
  { to: '/work', name: 'work', label: 'Work' },
  { to: '/staff', name: 'staff', label: 'Staff' },
  { to: '/books', name: 'books', label: 'Books' },
  { to: '/calendar', name: 'calendar', label: 'Calendar' },
  { to: '/library', name: 'library', label: 'Library' },
  { to: '/week', name: 'week', label: 'The week' },
];

function Sidebar({ route }: { route: Route }) {
  const staff = useStaffList();
  const pending = usePendingCount();
  const openWork = useOpenWorkCount();
  const slips = useStore((s) => s.slips);
  const settings = useStore((s) => s.settings);
  const conn = useStore((s) => s.conn);
  const waiting = new Set<string>();
  for (const id in slips) if (slips[id]!.status === 'pending') waiting.add(slips[id]!.staffId);

  return (
    <aside className="sidebar">
      <Link to="/" aria-label="Bureau, go to the Desk">
        <Wordmark />
      </Link>
      <nav className="nav" aria-label="Sections">
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className={`nav-item${route.name === n.name ? ' on' : ''}`} aria-current={route.name === n.name ? 'page' : undefined}>
            {n.label}
            {n.name === 'desk' && pending > 0 && (
              <span className="nav-count" aria-label={`${pending} to sign`}>
                {pending}
              </span>
            )}
            {n.name === 'work' && openWork > 0 && (
              <span className="nav-count quiet" aria-label={`${openWork} open`}>
                {openWork}
              </span>
            )}
          </Link>
        ))}
      </nav>
      <nav className="roster" aria-label="Staff">
        <div className="roster-title">Staff</div>
        {staff.map((s) => (
          <Link key={s.id} to={`/t/${s.id}`} className={`roster-row${route.name === 'thread' && route.staffId === s.id ? ' on' : ''}`}>
            <Bubble staff={s} needs={waiting.has(s.id)} />
            <span className="grow">
              <span className="roster-name">{s.name}</span>
              <span className="roster-role" style={{ display: 'block' }}>
                {s.role}
              </span>
            </span>
            {waiting.has(s.id) && <span className="hidden-label">Waiting on you</span>}
          </Link>
        ))}
        <Link to="/hire" className={`roster-row roster-add${route.name === 'hire' ? ' on' : ''}`}>
          <span className="bubble">
            <PlusIcon />
          </span>
          Hire someone
        </Link>
      </nav>
      <UsageMeter staffId={route.name === 'thread' ? route.staffId ?? null : null} />
      <Link to="/settings" className="host" aria-label="Settings">
        <Me size={30} />
        <span className="grow">
          <span className="host-name" style={{ display: 'block' }}>
            {settings?.ownerName ?? 'You'}
          </span>
          <span className={`host-state${conn === 'live' ? '' : ' off'}`}>
            <i />
            {conn === 'live' ? `${settings?.hostName ?? 'This Mac'}, online` : conn === 'connecting' ? 'Connecting' : 'Reconnecting'}
          </span>
        </span>
      </Link>
    </aside>
  );
}

type Recognition = { start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; interimResults: boolean; lang: string };

function PhoneBar({ route }: { route: Route }) {
  const chief = useChief();
  const pending = usePendingCount();
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const Speech = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!chief || !text.trim()) return;
    void api.sendMessage(chief.id, text);
    setText('');
    navigate(`/t/${chief.id}`);
  };
  const dictate = () => {
    if (listening) {
      rec.current?.stop();
      return;
    }
    const r: Recognition = new Speech();
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    r.onresult = (e: any) => setText(Array.from(e.results as ArrayLike<any>, (x: any) => x[0].transcript).join(''));
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };
  const canDictate = !!Speech && !text.trim();

  return (
    <div className="phonebar">
      <UsageStrip />
      <form className="phonebar-ask" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? 'Listening' : `Tell ${chief?.name ?? 'your chief of staff'} what you need`} aria-label={`Message ${chief?.name ?? 'your chief of staff'}`} enterKeyHint="send" />
        {canDictate ? (
          <button type="button" className="phonebar-go" onClick={dictate} aria-label={listening ? 'Stop dictating' : 'Dictate'} style={listening ? { background: 'var(--red)' } : undefined}>
            <MicIcon />
          </button>
        ) : (
          <button type="submit" className="phonebar-go" aria-label="Send" disabled={!text.trim()}>
            <SendIcon />
          </button>
        )}
      </form>
      <nav className="tabs" aria-label="Sections">
        {NAV.slice(0, 5).map((n) => (
          <Link key={n.to} to={n.to} className={`tab${route.name === n.name ? ' on' : ''}`} aria-current={route.name === n.name ? 'page' : undefined}>
            {n.label}
            {n.name === 'desk' && pending > 0 && <span className="nav-count">{pending}</span>}
          </Link>
        ))}
        {/* The owner's square leads to Settings, as it does at the foot of the sidebar. */}
        <Link to="/settings" className={`tab tab-me${route.name === 'settings' ? ' on' : ''}`} aria-label="Settings" aria-current={route.name === 'settings' ? 'page' : undefined}>
          <Me />
        </Link>
      </nav>
    </div>
  );
}

/** Says new slips aloud for screen readers. */
function Announcer() {
  const slips = useStore((s) => s.slips);
  const seen = useRef<Set<string> | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const pending = Object.values(slips).filter((s) => s.status === 'pending');
    if (seen.current) {
      const fresh = pending.filter((s) => !seen.current!.has(s.id));
      if (fresh.length) setMessage(fresh.length === 1 ? `New slip to sign: ${fresh[0]!.title}` : `${fresh.length} new slips to sign`);
    }
    seen.current = new Set(pending.map((s) => s.id));
  }, [slips]);
  return (
    <div className="sr" aria-live="polite">
      {message}
    </div>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const toast = useStore((s) => s.toast);
  const pending = usePendingCount();
  useEffect(() => {
    document.title = pending > 0 ? `(${pending}) Bureau` : 'Bureau';
  }, [pending]);
  return (
    <div className="app">
      <Sidebar route={route} />
      <main className="view">{children}</main>
      {route.name !== 'thread' && route.name !== 'hire' && <PhoneBar route={route} />}
      <Announcer />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
