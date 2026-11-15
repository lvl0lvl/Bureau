import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Staff, WorkItem } from '@shared/contract.ts';
import { Bubble, Chevron, useLoad } from '../components/bits.tsx';
import { Dialog } from '../components/Catalog.tsx';
import { when } from '../lib/format.ts';
import { Link, navigate, useHash } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { useNow, useStaffList, useStore, useWorkList } from '../sync/store.ts';

const WEEK = 7 * 24 * 60 * 60_000;

type StaffMap = Record<string, Staff>;
type WorkMap = Record<string, WorkItem>;

/** Which part of the list a piece of work belongs in. */
export function workState(item: WorkItem): 'doing' | 'ready' | 'waiting' | 'finished' {
  if (item.status === 'closed') return 'finished';
  if (item.status === 'in_progress') return 'doing';
  return item.ready ? 'ready' : 'waiting';
}

export const WORK_STATE_LABEL = { doing: 'In progress', ready: 'Ready', waiting: 'Waiting', finished: 'Finished' } as const;

const SECTIONS: { key: ReturnType<typeof workState>; title: string; hint: string }[] = [
  { key: 'doing', title: 'In progress', hint: 'Someone has it now.' },
  { key: 'ready', title: 'Ready', hint: 'Nothing is in its way.' },
  { key: 'waiting', title: 'Waiting', hint: 'Starts when what it waits on is finished.' },
  { key: 'finished', title: 'Finished this week', hint: '' },
];

function opener(item: WorkItem, staff: StaffMap): string {
  return item.createdBy === 'owner' ? 'you' : (staff[item.createdBy]?.name ?? item.createdBy);
}

/** The pieces this one still waits on, by title. */
function blockers(item: WorkItem, work: WorkMap): string[] {
  return item.after.filter((id) => work[id]?.status !== 'closed').map((id) => work[id]?.title ?? id);
}

// ----------------------------------------------------------------------- row

function Holder({ item, staff }: { item: WorkItem; staff: StaffMap }) {
  const holder = item.staffId ? staff[item.staffId] : undefined;
  if (!item.staffId) {
    return (
      <span className="work-holder none">
        <span className="bubble s22" aria-hidden="true" />
        {item.status === 'closed' ? 'Nobody' : 'Nobody yet'}
      </span>
    );
  }
  return (
    <span className="work-holder">
      <Bubble staff={holder} letter={holder ? undefined : '?'} size={22} />
      {holder?.name ?? item.staffId}
    </span>
  );
}

function WorkRow({ item, open, staff, work, t }: { item: WorkItem; open: boolean; staff: StaffMap; work: WorkMap; t: number }) {
  const state = workState(item);
  const waits = state === 'waiting' ? blockers(item, work) : [];
  return (
    <div className={`work-item${open ? ' open' : ''}`} id={`work-${item.id}`}>
      <button className="work-row" onClick={() => navigate(open ? '/work' : `/work#${item.id}`, { replace: true })} aria-expanded={open}>
        <span className="work-main">
          <span className="work-title">{item.title}</span>
          {waits.length > 0 && <span className="work-sub">Waiting on: {waits.join(', ')}</span>}
          {state === 'finished' && item.result && <span className="work-sub">{item.result}</span>}
        </span>
        <Holder item={item} staff={staff} />
        <span className="work-by">Opened by {opener(item, staff)}</span>
        <Chevron />
      </button>
      {open && <WorkDetail item={item} staff={staff} work={work} t={t} />}
    </div>
  );
}

// -------------------------------------------------------------------- detail

function Links({ label, ids, work }: { label: string; ids: string[]; work: WorkMap }) {
  if (!ids.length) return null;
  return (
    <div className="work-links">
      <span className="work-label">{label}</span>
      <ul>
        {ids.map((id) => {
          const w = work[id];
          return (
            <li key={id}>
              {w ? (
                <>
                  <Link to={`/work#${id}`} className="link">
                    {w.title}
                  </Link>
                  <span className="muted">, {WORK_STATE_LABEL[workState(w)].toLowerCase()}</span>
                </>
              ) : (
                <span className="muted">{id}, no longer on this list</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function WorkDetail({ item, staff, work, t }: { item: WorkItem; staff: StaffMap; work: WorkMap; t: number }) {
  const people = useStaffList();
  const [note, setNote] = useState('');
  const [result, setResult] = useState('');
  const [to, setTo] = useState(item.staffId ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setTo(item.staffId ?? ''), [item.staffId]);

  const closed = item.status === 'closed';
  const waitingOnIt = useMemo(() => Object.values(work).filter((w) => w.after.includes(item.id)).map((w) => w.id), [work, item.id]);
  const notes = item.notes.split('\n').map((l) => l.trim()).filter(Boolean);
  const run = async (fn: () => Promise<unknown>, then?: () => void) => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) then?.();
  };
  const addNote = (e: FormEvent) => {
    e.preventDefault();
    if (note.trim()) void run(() => api.noteWork(item.id, note.trim()), () => setNote(''));
  };
  const close = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.closeWork(item.id, result.trim()), () => setResult(''));
  };
  const give = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api.assignWork(item.id, to || null));
  };
  const toName = to ? (staff[to]?.name ?? 'They') : '';

  return (
    <div className="work-detail">
      {item.detail && <p className="work-text">{item.detail}</p>}
      {closed && item.result && (
        <div className="work-links">
          <span className="work-label">Result</span>
          <p className="work-text">{item.result}</p>
        </div>
      )}
      <Links label="Waits on" ids={item.after} work={work} />
      <Links label={closed ? 'Came next' : 'Waiting on this'} ids={waitingOnIt} work={work} />
      {notes.length > 0 && (
        <div className="work-links">
          <span className="work-label">Notes</span>
          <ul>
            {notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {item.read.length > 0 && <p className="work-meta">Opened after reading: {item.read.join(', ')}. Whoever takes it carries that with them.</p>}
      <p className="work-meta">
        Opened {when(item.createdAt, t)} by {opener(item, staff)}
        {closed && item.closedAt ? `, finished ${when(item.closedAt, t)}` : ''}. In beads this is <span className="narrow">{item.id}</span>.
      </p>

      <div className="work-acts">
        <form className="work-act" onSubmit={addNote}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for whoever works on it" aria-label="Note" />
          <button className="btn btn-soft" disabled={busy || !note.trim()}>
            Add note
          </button>
        </form>
        {closed ? (
          <div className="work-act">
            <button className="btn btn-line" disabled={busy} onClick={() => void run(() => api.reopenWork(item.id))}>
              Reopen
            </button>
            <span className="work-hint">Puts it back on the list. Nobody is started on it until you give it to someone.</span>
          </div>
        ) : (
          <>
            <form className="work-act" onSubmit={give}>
              <select className="select work-pick" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Give it to">
                <option value="">Nobody</option>
                {people.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}, {s.role.toLowerCase()}
                  </option>
                ))}
              </select>
              <button className="btn btn-soft" disabled={busy || to === (item.staffId ?? '')}>
                {to ? 'Give it to them' : 'Take it back'}
              </button>
              {to !== (item.staffId ?? '') && to && (
                <span className="work-hint">{item.ready || item.status === 'in_progress' ? `${toName} starts on it straight away.` : `${toName} starts when what it waits on is finished.`}</span>
              )}
            </form>
            <form className="work-act" onSubmit={close}>
              <input className="input" value={result} onChange={(e) => setResult(e.target.value)} placeholder="What came of it, in a sentence" aria-label="Result" />
              <button className="btn btn-ink" disabled={busy}>
                Close it
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------- add

function AddWork({ items, onClose }: { items: WorkItem[]; onClose: () => void }) {
  const people = useStaffList();
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [staffId, setStaffId] = useState('');
  const [after, setAfter] = useState<string[]>([]);
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const open = items.filter((w) => w.status !== 'closed');
  const person = people.find((s) => s.id === staffId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const item = await api.addWork({ title: title.trim(), detail: detail.trim(), staffId: staffId || null, after, start });
    setBusy(false);
    if (!item) return;
    onClose();
    navigate(`/work#${item.id}`, { replace: true });
  };

  return (
    <Dialog
      title="Add work"
      width={560}
      onClose={onClose}
      foot={
        <button className="btn btn-ink btn-lg" form="add-work" disabled={busy || !title.trim()} style={{ width: '100%' }}>
          Add to the list
        </button>
      }
    >
      <form id="add-work" className="stack" onSubmit={submit}>
        <label className="field">
          <span>What needs doing</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Reconcile October against the bank feed" autoFocus maxLength={200} />
        </label>
        <label className="field">
          <span>Detail</span>
          <textarea className="textarea" value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="What done looks like, where things are, what to leave alone." />
        </label>
        <label className="field">
          <span>Who it is for</span>
          <select className="select" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            <option value="">Nobody yet</option>
            {people.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}, {s.role.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        {open.length > 0 && (
          <div className="field">
            <span>After</span>
            <small>Pick anything that has to be finished first. Leave empty if it can start now.</small>
            <div className="work-after">
              {open.map((w) => (
                <label key={w.id} className="check">
                  <input type="checkbox" checked={after.includes(w.id)} onChange={(e) => setAfter(e.target.checked ? [...after, w.id] : after.filter((a) => a !== w.id))} />
                  <span>{w.title}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {person &&
          (after.length > 0 ? (
            <p className="work-hint">{person.name} is started on it when what it waits on is finished.</p>
          ) : (
            <label className="check">
              <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} />
              <span>Start {person.name} on it now</span>
            </label>
          ))}
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------- page

export function Work() {
  const items = useWorkList();
  const work = useStore((s) => s.work);
  const staff = useStore((s) => s.staff);
  const t = useNow(60_000);
  const openId = decodeURIComponent(useHash().slice(1)) || null;
  const { data: info, error } = useLoad(() => api.workPage(), []);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const groups = useMemo(() => {
    const out: Record<ReturnType<typeof workState>, WorkItem[]> = { doing: [], ready: [], waiting: [], finished: [] };
    for (const w of items) {
      const state = workState(w);
      if (state === 'finished' && (w.closedAt ?? w.updatedAt) < t - WEEK) continue;
      out[state].push(w);
    }
    out.finished.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    return out;
  }, [items, t]);
  const shown = groups.doing.length + groups.ready.length + groups.waiting.length + groups.finished.length;

  // A link to one piece of work brings it into view.
  const openKnown = !!openId && !!work[openId];
  useEffect(() => {
    if (openId && openKnown) document.getElementById(`work-${openId}`)?.scrollIntoView({ block: 'nearest' });
  }, [openId, openKnown]);

  const refresh = async () => {
    setRefreshing(true);
    await api.syncWork();
    setRefreshing(false);
  };
  const off = info ? !info.available : false;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Work</h1>
          <p className="page-lede">For work that takes more than one exchange, where finishing one piece starts the next.</p>
        </div>
        {info?.available && (
          <button className="btn btn-ink" onClick={() => setAdding(true)}>
            Add work
          </button>
        )}
      </header>

      {error && <p className="empty">The work list could not be loaded: {error}</p>}

      {off && (
        <section className="panel">
          <h2 className="panel-title">The work list is switched off</h2>
          <p className="skill-why red">{info?.problem ?? 'Beads is not available on this Mac.'}</p>
          <p className="panel-lede" style={{ marginTop: 0 }}>
            The list is kept by beads, a small program called <span className="narrow">bd</span>. Install it on this Mac from{' '}
            <a className="link" href="https://github.com/gastownhall/beads" target="_blank" rel="noreferrer">
              github.com/gastownhall/beads
            </a>
            , then restart Bureau. Everything else works without it.
          </p>
        </section>
      )}

      {!off && shown === 0 && info && (
        <p className="empty">
          <b>Nothing on the list.</b> Add a piece of work here, or ask your chief of staff to break a job down. Each piece shows who has it, what it waits on and what came of it.
        </p>
      )}

      {!off &&
        SECTIONS.map((sec) => {
          const list = groups[sec.key];
          if (!list.length) return null;
          return (
            <section key={sec.key} className="section work-section" aria-label={sec.title}>
              <div className="section-head">
                <h2 className="section-title">{sec.title}</h2>
                <span className="aside-meta">{list.length}</span>
                {sec.hint && <span className="work-section-hint">{sec.hint}</span>}
              </div>
              <div className="work-list">
                {list.map((w) => (
                  <WorkRow key={w.id} item={w} open={openId === w.id} staff={staff} work={work} t={t} />
                ))}
              </div>
            </section>
          );
        })}

      {info?.available && (
        <footer className="work-source">
          <p>
            Kept by beads in <span className="work-folder">{info.folder ?? 'the office folder'}</span>. Changes you make there with <span className="narrow">bd</span> show up here within a minute.
          </p>
          <button className="btn btn-soft btn-sm" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? 'Looking' : 'Refresh'}
          </button>
        </footer>
      )}

      {adding && <AddWork items={items} onClose={() => setAdding(false)} />}
    </div>
  );
}
