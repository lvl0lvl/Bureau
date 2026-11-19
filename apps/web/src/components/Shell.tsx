import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, navigate, type Route } from '../lib/router.tsx';
import { MAX_PHOTO, namedFiles, namedPhotos } from '../lib/photo.ts';
import { api } from '../sync/client.ts';
import { toast, useChief, useOpenWorkCount, usePendingCount, useStaffList, useStore } from '../sync/store.ts';
import { HttpError } from '../sync/transport.ts';
import { UsageMeter, UsageStrip } from './Usage.tsx';
import { Bubble, CameraIcon, Me, MicIcon, PlusIcon, SendIcon, Wordmark } from './bits.tsx';
import { bytes } from '../lib/format.ts';

const NAV: { to: string; name: Route['name']; label: string }[] = [
  { to: '/', name: 'desk', label: 'Desk' },
  { to: '/work', name: 'work', label: 'Work' },
  { to: '/staff', name: 'staff', label: 'Staff' },
  { to: '/books', name: 'books', label: 'Books' },
  { to: '/calendar', name: 'calendar', label: 'Calendar' },
  { to: '/artifacts', name: 'artifacts', label: 'Artifacts' },
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

type Recognition = { start(): void; stop(): void; abort(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null; interimResults: boolean; lang: string };

/**
 * Set once this browser has refused to dictate (an iPhone can, for a page opened from the Home
 * Screen). The microphone button then gives way to Send, as it does where there is no dictation
 * at all, until the app is next opened.
 */
let dictationRefused = false;

/** What to tell the owner when dictation stops by itself. Empty when there is nothing to say. */
function dictationProblem(code: string): string {
  if (code === 'aborted') return '';
  if (code === 'no-speech') return 'Nothing was heard. Tap the microphone to try again.';
  if (code === 'audio-capture') return 'No microphone was found.';
  if (code === 'not-allowed') return 'The microphone is not allowed for this page. Use the one on the keyboard.';
  if (code === 'service-not-allowed') return 'This browser does not dictate here. Use the microphone on the keyboard.';
  if (code === 'network') return 'Dictation could not be reached. Use the microphone on the keyboard.';
  return 'Dictation did not start. Use the microphone on the keyboard.';
}

function PhoneBar({ route }: { route: Route }) {
  const chief = useChief();
  const pending = usePendingCount();
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [refused, setRefused] = useState(dictationRefused);
  const [photoBusy, setPhotoBusy] = useState(false);
  /** Photos and files chosen from the phone, held on the Mac until the message goes. */
  const [files, setFiles] = useState<{ id: string; name: string; bytes: number }[]>([]);
  const [holding, setHolding] = useState(0);
  const rec = useRef<Recognition | null>(null);
  const shoot = useRef<HTMLInputElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const Speech = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

  /** Stop listening and take no more words from this recognizer. */
  const hangUp = () => {
    const r = rec.current;
    rec.current = null;
    if (r) {
      r.onresult = r.onend = r.onerror = null;
      try { r.abort(); } catch { /* already stopped */ }
    }
    setListening(false);
  };
  useEffect(() => hangUp, []);

  const ready = (!!text.trim() || files.length > 0) && holding === 0;
  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (!chief || !ready) return;
    hangUp();
    void api.sendMessage(chief.id, text, { files });
    setText('');
    setFiles([]);
    navigate(`/t/${chief.id}`);
  };

  /** A photo or file already on the phone, to go with the message to the chief of staff. */
  const attach = async (chosen: FileList | null) => {
    const list = namedFiles(chosen);
    if (pick.current) pick.current.value = '';
    for (const f of list) {
      if (f.size > MAX_PHOTO) { toast(`${f.name} is larger than 25 MB. Put it in Drop here in the office Drive folder instead.`); continue; }
      if (f.size === 0) { toast(`${f.name} is empty.`); continue; }
      setHolding((n) => n + 1);
      try {
        const held = await api.upload(f);
        setFiles((cur) => (cur.length >= 10 ? cur : [...cur, held]));
      } catch (err) {
        toast((err as Error).message || `${f.name} could not be sent.`);
      } finally {
        setHolding((n) => n - 1);
      }
    }
  };

  const refuse = (why: string) => {
    dictationRefused = true;
    setRefused(true);
    hangUp();
    toast(why);
  };
  const dictate = () => {
    if (listening) {
      // Ask it to finish, which delivers the last words. If it never answers, stop waiting.
      const r = rec.current;
      try { r?.stop(); } catch { /* already stopped */ }
      window.setTimeout(() => { if (rec.current === r) hangUp(); }, 1500);
      return;
    }
    let r: Recognition;
    try {
      r = new Speech();
      r.interimResults = true;
      r.lang = navigator.language || 'en-US';
    } catch {
      refuse(dictationProblem('service-not-allowed'));
      return;
    }
    r.onresult = (e: any) => setText(Array.from(e.results as ArrayLike<any>, (x: any) => x[0].transcript).join('').trimStart());
    r.onend = () => { if (rec.current === r) { rec.current = null; setListening(false); } };
    r.onerror = (e: any) => {
      if (rec.current !== r) return;
      const code = String(e?.error ?? '');
      const why = dictationProblem(code);
      // Refused outright: it will not work on the next tap either, so stop offering it.
      if (code === 'not-allowed' || code === 'service-not-allowed') refuse(why);
      else { hangUp(); if (why) toast(why); }
    };
    rec.current = r;
    setListening(true);
    try {
      r.start();
    } catch {
      refuse(dictationProblem(''));
    }
  };
  // The microphone shows while the box is empty and stays for as long as it is listening, so it can be stopped.
  const canDictate = !!Speech && !refused && (listening || (!text.trim() && files.length === 0 && holding === 0));

  /** A photo for the office: into Drop here, where the chief of staff picks it up. */
  const photo = async (chosen: FileList | null) => {
    const [file] = namedPhotos(chosen);
    if (shoot.current) shoot.current.value = '';
    if (!file || photoBusy) return;
    if (file.size > MAX_PHOTO) { toast('That photo is larger than 25 MB.'); return; }
    if (file.size === 0) { toast('That photo is empty.'); return; }
    setPhotoBusy(true);
    toast('Sending the photo to the office');
    try {
      const left = await api.drop(file);
      toast(left.watched ? `The photo is in Drop here. ${chief?.name ?? 'Your chief of staff'} picks it up within two minutes.` : 'The photo is in Drop here. The office is not watching that folder: see Drive in Settings.');
    } catch (e) {
      // No Drive folder to be seen (or an office not yet restarted): give it to the chief of staff directly.
      const status = e instanceof HttpError ? e.status : 0;
      if (chief && (status === 404 || status === 405 || status === 409)) {
        try {
          const held = await api.upload(file);
          void api.sendMessage(chief.id, '', { files: [held] });
          navigate(`/t/${chief.id}`);
        } catch (e2) {
          toast((e2 as Error).message || 'The photo could not be sent.');
        }
      } else toast((e as Error).message || 'The photo could not be sent.');
    } finally {
      setPhotoBusy(false);
    }
  };

  return (
    <div className="phonebar">
      <UsageStrip />
      {(files.length > 0 || holding > 0) && (
        <ul className="composer-files phonebar-files" aria-label="Attached">
          {files.map((f) => (
            <li key={f.id}>
              <span className="composer-file-name">{f.name}</span>
              <span className="composer-file-size">{bytes(f.bytes)}</span>
              <button className="link" onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`}>
                Remove
              </button>
            </li>
          ))}
          {holding > 0 && <li className="composer-file-size">Sending {holding === 1 ? 'a file' : `${holding} files`} to the office</li>}
        </ul>
      )}
      <form className="phonebar-ask" onSubmit={send}>
        <button type="button" className="phonebar-cam" onClick={() => shoot.current?.click()} disabled={photoBusy} aria-label="Take a photo for the office" title="Take a photo for the office">
          <CameraIcon />
        </button>
        <span className="phonebar-field">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={listening ? 'Listening' : files.length ? 'Say what it is for' : `Tell ${chief?.name ?? 'your chief of staff'} what you need`} aria-label={`Message ${chief?.name ?? 'your chief of staff'}`} enterKeyHint="send" />
          <button type="button" className="phonebar-attach" onClick={() => pick.current?.click()} aria-label="Attach a photo or file" title="Attach a photo or file">
            <PlusIcon color="currentColor" />
          </button>
        </span>
        {canDictate ? (
          <button type="button" className={`phonebar-go${listening ? ' listening' : ''}`} onClick={dictate} aria-label={listening ? 'Stop dictating' : 'Dictate'}>
            <MicIcon />
          </button>
        ) : (
          <button type="submit" className="phonebar-go" aria-label="Send" disabled={!ready}>
            <SendIcon />
          </button>
        )}
        <input ref={shoot} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void photo(e.target.files)} />
        <input ref={pick} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
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
