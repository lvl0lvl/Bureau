import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Artifact, Staff } from '@shared/contract.ts';
import { parseFountain, spans } from '../lib/fountain.ts';
import { plural, when } from '../lib/format.ts';
import { navigate, useSearch } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { toast, useIsPhone, useNow, useStaffList, useStore } from '../sync/store.ts';
import { BackIcon, Bubble, Check, Chevron, SearchIcon } from './bits.tsx';
import { Markdown } from './Markdown.tsx';
import { EditView, findPassage, NoteComposer, NotesPanel, useNoteHighlights, useNotes, useSelectedPassage } from './ArtifactNotes.tsx';

/**
 * Artifacts: finished work staff keep for the owner. The newest few sit in a person's details,
 * the newest one drawn small, and any of them opens into a viewer big enough to read it, with the
 * rest of the list beside it. The way it is drawn depends on what it is: a script is laid out as
 * a script, a table as a table, a page or chart runs in a sealed frame.
 */

// ------------------------------------------------------------------- loading

let bump = 0;
const bumpers = new Set<() => void>();
const changed = () => {
  bump += 1;
  bumpers.forEach((f) => f());
};

/** The artifacts of one person, or of everyone. Loaded again when that person finishes a turn. */
export function useArtifacts(staffId?: string): { list: Artifact[] | null; error: string | null } {
  const [list, setList] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(bump);
  const running = useStore((s) => (staffId ? !!s.live[staffId]?.running : Object.values(s.live).some((l) => l.running)));
  useEffect(() => {
    const f = () => setN(bump);
    bumpers.add(f);
    const focus = () => document.visibilityState === 'visible' && setN((x) => x + 0.001);
    document.addEventListener('visibilitychange', focus);
    return () => {
      bumpers.delete(f);
      document.removeEventListener('visibilitychange', focus);
    };
  }, []);
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    // While someone is working the list waits for them to finish. It still loads the first time,
    // and again after anything the owner did here.
    const key = `${staffId ?? ''}:${n}`;
    if (running && loaded.current === key) return;
    let live = true;
    api
      .artifacts(staffId)
      .then((l) => {
        if (!live) return;
        loaded.current = key;
        setList(l);
        setError(null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the artifacts.'));
    return () => {
      live = false;
    };
  }, [staffId, running, n]);
  return { list, error };
}

// ------------------------------------------------------------------- opening

let pushed = false;

/** Open the viewer on one artifact, or on the whole list when `id` is empty. */
export function openArtifact(staffId: string, id: string, office = false): void {
  const q = new URLSearchParams(location.search);
  q.set('artifact', id);
  if (office) q.set('staff', staffId);
  pushed = true;
  navigate(`${location.pathname}?${q}`);
}

function selectArtifact(staffId: string, id: string, office: boolean) {
  const q = new URLSearchParams(location.search);
  q.set('artifact', id);
  if (office) q.set('staff', staffId);
  navigate(`${location.pathname}?${q}`, { replace: true });
}

function closeArtifact() {
  if (pushed) {
    pushed = false;
    history.back();
    return;
  }
  const q = new URLSearchParams(location.search);
  q.delete('artifact');
  q.delete('staff');
  navigate(`${location.pathname}${q.size ? `?${q}` : ''}`, { replace: true });
}

/** The artifact named in the address, if the viewer is open. */
export function useArtifactParam(): { id: string; staffId: string | null } | null {
  const search = useSearch();
  return useMemo(() => {
    const q = new URLSearchParams(search);
    const id = q.get('artifact');
    return id === null ? null : { id, staffId: q.get('staff') };
  }, [search]);
}

// --------------------------------------------------------------------- words

const KIND_LABEL: Record<Artifact['kind'], string> = { script: 'Script', document: 'Document', table: 'Table', sheet: 'Spreadsheet', page: 'Page', image: 'Image', pdf: 'PDF', text: 'Text', file: 'File' };

export const kindLabel = (a: Artifact) => KIND_LABEL[a.kind];

function meta(a: Artifact, t: number): string {
  return `${kindLabel(a)}, ${a.versions.length > 1 ? `${a.versions.length} versions, ` : ''}${when(a.modifiedAt, t)}`;
}

/** A small page with what the file is written on it. */
export function ArtifactGlyph({ a }: { a: Artifact }) {
  const mark = a.kind === 'script' ? 'Script' : a.kind === 'document' ? 'Doc' : a.ext.slice(0, 5) || 'File';
  return (
    <span className={`artifact-glyph k-${a.kind}`} aria-hidden="true">
      <i>{mark}</i>
    </span>
  );
}

// ----------------------------------------------------------------- the aside

const SHOWN = 4;

/** In a person's details, under their open work. */
export function ArtifactsBlock({ staff }: { staff: Staff }) {
  const t = useNow(60_000);
  const { list, error } = useArtifacts(staff.id);
  const current = (list ?? []).filter((a) => !a.retiredAt);
  const retired = (list ?? []).length - current.length;
  const [first, ...rest] = current;

  return (
    <section className="aside-block">
      <div className="aside-head">
        <h2 className="aside-title">Artifacts</h2>
        {(current.length > SHOWN || (current.length > 0 && retired > 0)) && (
          <button className="link" onClick={() => openArtifact(staff.id, '')}>
            {current.length > SHOWN ? `Show all ${current.length}` : 'Show all'}
          </button>
        )}
      </div>
      {error && <p className="empty" style={{ fontSize: 14 }}>{error}</p>}
      {list && current.length === 0 && (
        <p className="empty" style={{ fontSize: 14 }}>
          {retired > 0 ? (
            <>
              Nothing on the list.{' '}
              <button className="link" onClick={() => openArtifact(staff.id, '')}>
                {plural(retired, 'retired artifact')}
              </button>
            </>
          ) : (
            <>Finished work {staff.name} keeps for you shows here: a script, a document, a spreadsheet, a chart.</>
          )}
        </p>
      )}
      {first && (
        <button className="artifact-card" onClick={() => openArtifact(staff.id, first.id)} aria-label={`Open ${first.title}`}>
          <span className="artifact-thumb">
            <span className="artifact-thumb-inner">
              <ArtifactBody a={first} path={first.versions[0]!.path} thumb />
            </span>
          </span>
          <span className="artifact-card-text">
            <span className="duty-title">{first.title}</span>
            <span className="duty-cadence">{meta(first, t)}</span>
          </span>
        </button>
      )}
      {rest.slice(0, SHOWN - 1).map((a) => (
        <button key={a.id} className="artifact-row" onClick={() => openArtifact(staff.id, a.id)}>
          <ArtifactGlyph a={a} />
          <span className="grow">
            <span className="duty-title">{a.title}</span>
            <span className="duty-cadence">{meta(a, t)}</span>
          </span>
        </button>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- the viewer

/**
 * The big view. With a person, it lists their artifacts; without one (the Artifacts page), it
 * lists everyone's, by person. On a phone the list and the document take the screen in turn.
 */
export function ArtifactViewer({ staffId, id, office = false }: { staffId: string | null; id: string; office?: boolean }) {
  const phone = useIsPhone();
  const t = useNow(60_000);
  const staffMap = useStore((s) => s.staff);
  const people = useStaffList();
  const { list, error } = useArtifacts(office ? undefined : staffId ?? undefined);
  const [query, setQuery] = useState('');
  const [showRetired, setShowRetired] = useState(id === '');
  const [version, setVersion] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [onList, setOnList] = useState(id === '');
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** The notes column (on a phone, a sheet over the page), editing, and a note being written. */
  const [notesOpen, setNotesOpen] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [composing, setComposing] = useState<{ quote: string; before: string } | null>(null);
  const [activeNote, setActiveNote] = useState<string | null>(null);

  const all = list ?? [];
  const chosen = all.find((a) => a.id === id && (!office || !staffId || a.staffId === staffId)) ?? null;
  const q = query.trim().toLowerCase();
  const matches = (a: Artifact) => !q || `${a.title} ${a.folder} ${a.ext} ${staffMap[a.staffId]?.name ?? ''}`.toLowerCase().includes(q);
  const current = all.filter((a) => !a.retiredAt && matches(a));
  const retired = all.filter((a) => a.retiredAt && matches(a));
  const flat = [...current, ...(showRetired || chosen?.retiredAt ? retired : [])];

  // Opened on the whole list: on a computer, show the newest one beside it.
  useEffect(() => {
    if (!list || chosen || phone) return;
    const pick = (list.find((a) => !a.retiredAt) ?? list[0]);
    if (pick) selectArtifact(pick.staffId, pick.id, office);
  }, [list, chosen, phone, office]);
  useEffect(() => {
    setVersion(null);
    setMenu(false);
    setConfirm(false);
    setEditing(false);
    setComposing(null);
    setActiveNote(null);
    bodyRef.current?.scrollTo(0, 0);
  }, [chosen?.id, chosen?.staffId]);
  useEffect(() => {
    if (chosen?.retiredAt) setShowRetired(true);
  }, [chosen?.retiredAt]);

  const pickIn = (a: Artifact) => {
    selectArtifact(a.staffId, a.id, office);
    setOnList(false);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Before anything underneath, such as the details sheet, closes too.
        e.preventDefault();
        e.stopImmediatePropagation();
        if (confirm) setConfirm(false);
        else if (menu) setMenu(false);
        else if (composing) setComposing(null);
        else if (editing) return;
        else if (phone && notesOpen) setNotesOpen(false);
        else closeArtifact();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || confirm) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = flat.findIndex((a) => a === chosen);
        const next = flat[Math.max(0, Math.min(flat.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (next && next !== chosen) {
          e.preventDefault();
          pickIn(next);
          listRef.current?.querySelector(`[data-key="${CSS.escape(`${next.staffId}:${next.id}`)}"]`)?.scrollIntoView({ block: 'nearest' });
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  // The page behind does not scroll while this is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const v = chosen ? chosen.versions.find((x) => x.path === version) ?? chosen.versions[0]! : null;
  const savedHere = chosen && v ? chosen.drive.find((d) => d.path === v.path) : undefined;
  const owner = chosen ? staffMap[chosen.staffId] : undefined;

  // Notes and edits, on the kinds that are read as text.
  const notable = !!chosen && NOTABLE.has(chosen.kind);
  const { notes, reload: reloadNotes } = useNotes(notable ? chosen : null);
  const liveNotes = notes.filter((n) => !n.doneAt);
  const unsent = liveNotes.filter((n) => !n.sentAt).length;
  // The column shows by itself on a computer once there are notes; on a phone only when asked.
  const showNotes = notable && !editing && (notesOpen ?? (!phone && liveNotes.length > 0));
  const [picked, holdPick, donePick] = useSelectedPassage(bodyRef, notable && !editing && !composing);
  const [bodyReady, setBodyReady] = useState(0);
  useEffect(() => {
    // The page is drawn after its text arrives; look for the passages again once it is there.
    const el = bodyRef.current;
    if (!el) return;
    const mo = new MutationObserver(() => setBodyReady((x) => x + 1));
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [chosen?.id, v?.path, editing]);
  useNoteHighlights(bodyRef, notable && !editing ? notes : [], activeNote, bodyReady);
  const saveNote = async (text: string) => {
    if (!chosen || !v || !composing) return false;
    const r = await api.addArtifactNote(chosen, { path: v.path, quote: composing.quote, before: composing.before, text });
    if (!r) return false;
    setComposing(null);
    setActiveNote(r.note.id);
    if (!phone) setNotesOpen(true);
    reloadNotes();
    return true;
  };
  const pickNote = (n: (typeof notes)[number]) => {
    setActiveNote(n.id);
    if (n.path !== v?.path && chosen?.versions.some((x) => x.path === n.path) && !findInBody(n.quote, n.before)) setVersion(n.path);
    const r = findInBody(n.quote, n.before);
    (r?.startContainer.parentElement ?? null)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (phone) setNotesOpen(false);
  };
  const findInBody = (quote: string, before: string) => {
    const page = bodyRef.current?.querySelector('.artifact-page, .artifact-table-wrap');
    return page && quote ? findPassage(page, quote, before) : null;
  };
  const scopeName = !office && staffId ? staffMap[staffId]?.name : null;

  const toDrive = async () => {
    if (!chosen || !v) return;
    setBusy(true);
    const r = await api.artifactToDrive(chosen, v.path);
    setBusy(false);
    if (!r) return;
    toast(r.already ? `Already in Drive, at ${r.to}.` : `Saved to Drive, at ${r.to}.`);
    changed();
  };
  const retire = async (on: boolean) => {
    if (!chosen) return;
    setMenu(false);
    const r = await api.retireArtifact(chosen, on);
    if (!r) return;
    toast(on ? 'Retired. It stays in the folder and is listed under Retired.' : 'Back on the list.');
    if (on) setShowRetired(true);
    changed();
  };
  const remove = async () => {
    if (!chosen) return;
    setBusy(true);
    const i = flat.indexOf(chosen);
    const r = await api.deleteArtifact(chosen);
    setBusy(false);
    setConfirm(false);
    if (!r) return;
    toast(`Deleted “${chosen.title}”.`);
    const next = flat[i + 1] ?? flat[i - 1];
    if (next) selectArtifact(next.staffId, next.id, office);
    else closeArtifact();
    changed();
  };
  const download = () => {
    setMenu(false);
    if (!chosen || !v) return;
    const url = api.artifactUrl(chosen.staffId, v.path, true);
    if (!url) return toast('The sample office has no files to download.');
    const a = document.createElement('a');
    a.href = url;
    a.download = v.path.split('/').pop() ?? 'file';
    a.click();
  };

  const row = (a: Artifact) => {
    const on = a === chosen;
    return (
      <button key={`${a.staffId}:${a.id}`} data-key={`${a.staffId}:${a.id}`} className={`viewer-item${on ? ' on' : ''}${a.retiredAt ? ' retired' : ''}`} onClick={() => pickIn(a)} aria-current={on ? 'true' : undefined}>
        <ArtifactGlyph a={a} />
        <span className="grow">
          <span className="viewer-item-title">{a.title}</span>
          <span className="viewer-item-meta">
            {a.folder ? `${a.folder}, ` : ''}
            {meta(a, t)}
          </span>
        </span>
      </button>
    );
  };

  const groups = office ? people.map((p) => ({ p, items: current.filter((a) => a.staffId === p.id) })).filter((g) => g.items.length) : [{ p: null, items: current }];

  const sidebar = (
    <div className="viewer-list" ref={listRef}>
      <div className="viewer-list-head">
        <h2>{scopeName ? `${scopeName}’s artifacts` : 'Artifacts'}</h2>
        {phone && (
          <button className="btn btn-soft" onClick={closeArtifact}>
            Close
          </button>
        )}
      </div>
      {all.length > 6 && (
        <label className="viewer-search">
          <SearchIcon />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search the artifacts" />
        </label>
      )}
      {error && <p className="empty" style={{ fontSize: 14 }}>{error}</p>}
      {list && all.length === 0 && <p className="empty" style={{ fontSize: 14 }}>Nothing here yet. Finished work staff keep for you shows here.</p>}
      {list && all.length > 0 && current.length === 0 && retired.length === 0 && <p className="empty" style={{ fontSize: 14 }}>Nothing matches “{query}”.</p>}
      {groups.map((g) => (
        <Fragment key={g.p?.id ?? 'one'}>
          {g.p && (
            <div className="viewer-group">
              <Bubble staff={g.p} size={20} working={false} />
              {g.p.name}
            </div>
          )}
          {g.items.map(row)}
        </Fragment>
      ))}
      {retired.length > 0 && (
        <>
          <button className="viewer-retired-toggle" onClick={() => setShowRetired((x) => !x)} aria-expanded={showRetired}>
            <span className={`disclose${showRetired ? ' open' : ''}`}>
              <Chevron />
            </span>
            Retired <span className="muted">{retired.length}</span>
          </button>
          {showRetired && retired.map(row)}
        </>
      )}
    </div>
  );

  const main = chosen && v ? (
    <div className="viewer-main">
      <div className="viewer-bar">
        {phone && (
          <button className="btn viewer-back" onClick={() => setOnList(true)} aria-label="All artifacts">
            <BackIcon />
            <span>All</span>
          </button>
        )}
        <div className="grow viewer-title">
          <h2>{chosen.title}</h2>
          <p>
            {owner?.name ?? 'Staff'}, {kindLabel(chosen).toLowerCase()}, {chosen.versions.length > 1 ? `${v.label.toLowerCase()} of ${chosen.versions.length}, ` : ''}
            {v.byOwner ? 'your edit, ' : ''}saved {when(v.modifiedAt, t)}
            {chosen.retiredAt ? '. Retired' : ''}
            {savedHere ? (
              <>
                . <span className="viewer-indrive">In Drive</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="viewer-acts">
          {chosen.versions.length > 1 && (
            <select className="select viewer-version" value={v.path} onChange={(e) => setVersion(e.target.value)} aria-label="Version">
              {chosen.versions.map((x, i) => (
                <option key={x.path} value={x.path}>
                  {x.label}
                  {x.byOwner ? ', yours' : ''}
                  {i === 0 && !phone && !x.byOwner ? ', newest' : ''}
                </option>
              ))}
            </select>
          )}
          {notable && !editing && (
            <button className={`btn ${showNotes ? 'btn-ink' : 'btn-soft'} viewer-notes-btn`} onClick={() => setNotesOpen(!showNotes)} aria-pressed={showNotes} title="Notes on passages, to send to the writer">
              Notes{liveNotes.length ? <span className="viewer-notes-count">{unsent || liveNotes.length}</span> : null}
            </button>
          )}
          {notable && !editing && !phone && (
            <button className="btn btn-soft" onClick={() => setEditing(true)} title="Change the text and save it as a new version">
              Edit
            </button>
          )}
          <button className="btn btn-line" disabled={busy} onClick={() => void toDrive()} title={savedHere ? `In Drive at ${savedHere.to}` : 'Copy this version to From staff in the office Drive folder'}>
            {savedHere ? (
              <>
                <Check /> In Drive
              </>
            ) : phone ? (
              'To Drive'
            ) : (
              'Save to Drive'
            )}
          </button>
          <span className="viewer-more">
            <button className="btn btn-soft" onClick={() => setMenu((x) => !x)} aria-haspopup="menu" aria-expanded={menu} aria-label="More">
              <Dots />
            </button>
            {menu && (
              <div className="pop viewer-menu" role="menu">
                {notable && phone && (
                  <button
                    className="pop-item"
                    role="menuitem"
                    onClick={() => {
                      setMenu(false);
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                )}
                <button className="pop-item" role="menuitem" onClick={download}>
                  Download
                </button>
                <button className="pop-item" role="menuitem" onClick={() => void retire(!chosen.retiredAt)}>
                  {chosen.retiredAt ? 'Put back on the list' : 'Retire'}
                </button>
                <button
                  className="pop-item red"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    setConfirm(true);
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </span>
          {!phone && (
            <button className="btn btn-soft" onClick={closeArtifact}>
              Close
            </button>
          )}
        </div>
      </div>
      {editing ? (
        <EditView
          a={chosen}
          path={v.path}
          onDone={(saved) => {
            setEditing(false);
            if (saved) {
              setVersion(null);
              changed();
              reloadNotes();
            }
          }}
        />
      ) : (
        <div className={`viewer-split${showNotes && !phone ? ' with-notes' : ''}`}>
          <div className={`viewer-body k-${chosen.kind}`} ref={bodyRef} onClick={() => setMenu(false)}>
            <ArtifactBody key={`${chosen.staffId}:${v.path}:${v.modifiedAt}`} a={chosen} path={v.path} />
          </div>
          {showNotes && (
            <NotesPanel
              a={chosen}
              writer={owner}
              notes={notes}
              active={activeNote}
              shownPath={v.path}
              phone={phone}
              onPick={pickNote}
              onWhole={() => setComposing({ quote: '', before: '' })}
              reload={reloadNotes}
              onClose={() => setNotesOpen(false)}
            />
          )}
        </div>
      )}
      {picked && !composing && (
        <button
          className={`note-add${phone ? ' bottom' : ''}`}
          style={phone ? undefined : { top: Math.max(8, picked.rect.top - 44), left: picked.rect.left + picked.rect.width / 2 }}
          onPointerDown={(e) => {
            e.preventDefault();
            holdPick();
          }}
          onClick={() => {
            setComposing({ quote: picked.quote, before: picked.before });
            donePick();
          }}
        >
          Add note
        </button>
      )}
      {composing && (
        <div className={`note-composer-wrap${phone ? ' is-sheet' : ''}`} onClick={() => setComposing(null)}>
          <NoteComposer quote={composing.quote} phone={phone} onSave={saveNote} onCancel={() => setComposing(null)} />
        </div>
      )}
      {confirm && (
        <div className="viewer-confirm-scrim" onClick={() => setConfirm(false)}>
          <div className="viewer-confirm" role="alertdialog" aria-modal="true" aria-labelledby="del-title" onClick={(e) => e.stopPropagation()}>
            <h3 id="del-title">Delete “{chosen.title}”?</h3>
            <p>
              {chosen.versions.length > 1 ? `All ${chosen.versions.length} versions are` : 'It is'} removed from {owner?.name ?? 'their'}’s folder. {chosen.drive.length ? 'The copy you saved to Drive stays there. ' : ''}Backups made before today still have it.
            </p>
            <div className="row">
              <button className="btn btn-soft" autoFocus onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button className="btn btn-red" disabled={busy} onClick={() => void remove()}>
                {busy ? 'Deleting' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  ) : (
    <div className="viewer-main viewer-none">
      {!phone && (
        <div className="viewer-bar">
          <div className="grow" />
          <button className="btn btn-soft" onClick={closeArtifact}>
            Close
          </button>
        </div>
      )}
      <p className="empty">{list === null ? 'Opening' : id && !chosen ? 'That artifact is no longer here. It may have been renamed or deleted.' : 'Choose one from the list.'}</p>
    </div>
  );

  const showList = !phone || onList || !chosen;
  return (
    <div className="viewer-scrim" onClick={closeArtifact}>
      <div className={`viewer${phone ? (showList ? ' show-list' : ' show-doc') : ''}`} role="dialog" aria-modal="true" aria-label={chosen ? chosen.title : 'Artifacts'} onClick={(e) => e.stopPropagation()}>
        {showList && sidebar}
        {(!phone || !showList) && main}
      </div>
    </div>
  );
}

const Dots = () => (
  <svg width="16" height="4" viewBox="0 0 16 4" aria-hidden="true">
    <circle cx="2" cy="2" r="1.6" fill="currentColor" />
    <circle cx="8" cy="2" r="1.6" fill="currentColor" />
    <circle cx="14" cy="2" r="1.6" fill="currentColor" />
  </svg>
);

// ---------------------------------------------------------------- the body

const TEXT_KINDS = new Set<Artifact['kind']>(['script', 'document', 'table', 'page', 'text']);
/** Kinds the owner can leave notes on and edit. The office allows the same. */
const NOTABLE = new Set<Artifact['kind']>(['script', 'document', 'table', 'text']);

/** One version, drawn the way its kind is read. `thumb` draws it small and still, for the details. */
export function ArtifactBody({ a, path, thumb = false }: { a: Artifact; path: string; thumb?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const size = a.versions.find((x) => x.path === path)?.size ?? 0;
  const tooBig = size > 8 * 1024 * 1024;
  useEffect(() => {
    if (!TEXT_KINDS.has(a.kind) || tooBig) return;
    let live = true;
    setText(null);
    setFailed(null);
    api
      .artifactText(a.staffId, path)
      .then((x) => live && setText(x))
      .catch((e) => live && setFailed(e instanceof Error ? e.message : 'This file could not be opened.'));
    return () => {
      live = false;
    };
  }, [a.staffId, path, a.kind, tooBig]);
  const url = api.artifactUrl(a.staffId, path);

  if (failed) return <Paper thumb={thumb}><p className="empty">{failed}</p></Paper>;
  if (tooBig && TEXT_KINDS.has(a.kind)) return <CannotShow a={a} thumb={thumb} why="This file is too large to show here." />;

  switch (a.kind) {
    case 'image':
      return url ? <img className="artifact-image" src={url} alt={thumb ? '' : a.title} loading="lazy" /> : <CannotShow a={a} thumb={thumb} why="The sample office has no images." />;
    case 'pdf':
      if (!url) return <CannotShow a={a} thumb={thumb} why="The sample office has no PDFs." />;
      return thumb ? <CannotShow a={a} thumb why="" /> : <PdfView url={url} />;
    case 'sheet':
    case 'file':
      return <CannotShow a={a} thumb={thumb} why={a.kind === 'sheet' ? 'A spreadsheet in this format cannot be shown here. Save it to Drive to open it in Google Sheets, or download it.' : 'This kind of file cannot be shown here. Save it to Drive or download it to open it.'} />;
  }
  if (text === null) return <Paper thumb={thumb}><p className="muted">{thumb ? '' : 'Opening'}</p></Paper>;
  switch (a.kind) {
    case 'script':
      return <Paper thumb={thumb} script><Screenplay text={text} /></Paper>;
    case 'document':
      return (
        <Paper thumb={thumb}>
          <div className="doc msg artifact-doc">
            <Markdown text={text} />
          </div>
        </Paper>
      );
    case 'table':
      return <TableView text={text} tab={a.ext === 'tsv'} thumb={thumb} />;
    case 'page':
      return <PageFrame html={text} title={a.title} thumb={thumb} />;
    default:
      return (
        <Paper thumb={thumb}>
          <pre className="doc mono artifact-text">{text}</pre>
        </Paper>
      );
  }
}

function Paper({ children, thumb, script }: { children: ReactNode; thumb?: boolean; script?: boolean }) {
  return <div className={`artifact-page${script ? ' script' : ''}${thumb ? ' thumb' : ''}`}>{children}</div>;
}

function CannotShow({ a, why, thumb }: { a: Artifact; why: string; thumb?: boolean }) {
  return (
    <div className={`artifact-cannot${thumb ? ' thumb' : ''}`}>
      <span className="artifact-glyph big" aria-hidden="true">
        <i>{a.ext.slice(0, 5) || 'File'}</i>
      </span>
      {!thumb && <p>{why}</p>}
    </div>
  );
}

function PdfView({ url }: { url: string }) {
  const phone = useIsPhone();
  // A phone's browser shows only the first page of a PDF inside a page, so it opens on its own.
  if (phone)
    return (
      <div className="artifact-cannot">
        <span className="artifact-glyph big" aria-hidden="true">
          <i>pdf</i>
        </span>
        <a className="btn btn-line" href={url} target="_blank" rel="noopener">
          Open the PDF
        </a>
      </div>
    );
  return <iframe className="artifact-frame" src={url} title="PDF" />;
}

// ---------------------------------------------------------------- a script

function Emph({ text }: { text: string }) {
  return (
    <>
      {spans(text).map((s, i) => {
        let n: ReactNode = s.text;
        if (s.u) n = <u>{n}</u>;
        if (s.i) n = <em>{n}</em>;
        if (s.b) n = <strong>{n}</strong>;
        return <Fragment key={i}>{n}</Fragment>;
      })}
    </>
  );
}

export function Screenplay({ text }: { text: string }) {
  const els = useMemo(() => parseFountain(text), [text]);
  return (
    <div className="screenplay">
      {els.map((e, i) => {
        switch (e.t) {
          case 'title': {
            const title = e.fields.find((f) => /^title$/i.test(f.key));
            const rest = e.fields.filter((f) => f !== title && !/^notes$/i.test(f.key));
            const notes = e.fields.find((f) => /^notes$/i.test(f.key));
            return (
              <div key={i} className="sp-title">
                {title && <h1><Emph text={title.value} /></h1>}
                {rest.map((f) => (
                  <p key={f.key}>
                    {/^(author|authors)$/i.test(f.key) ? <span className="muted">by </span> : /^draft date$/i.test(f.key) ? <span className="muted">Draft of </span> : null}
                    <Emph text={f.value} />
                  </p>
                ))}
                {notes && <p className="sp-notes">{notes.value}</p>}
              </div>
            );
          }
          case 'scene':
            return (
              <h2 key={i} className="sp-scene">
                <Emph text={e.text} />
                {e.number && <span className="sp-num">{e.number}</span>}
              </h2>
            );
          case 'action':
            return (
              <p key={i} className="sp-action">
                <Emph text={e.text} />
              </p>
            );
          case 'centered':
            return (
              <p key={i} className="sp-centered">
                <Emph text={e.text} />
              </p>
            );
          case 'transition':
            return (
              <p key={i} className="sp-transition">
                {e.text}
              </p>
            );
          case 'break':
            return <hr key={i} className="sp-break" />;
          case 'dialogue':
            return (
              <div key={i} className="sp-dialogue">
                <p className="sp-character">{e.character}</p>
                {e.lines.map((l, j) => (
                  <p key={j} className={l.t === 'paren' ? 'sp-paren' : l.t === 'lyric' ? 'sp-line sp-lyric' : 'sp-line'}>
                    <Emph text={l.text} />
                  </p>
                ))}
              </div>
            );
        }
      })}
    </div>
  );
}

// ----------------------------------------------------------------- a table

export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const NUMBER = /^[-+(]?[$€£]?\s?[\d,]+(\.\d+)?%?\)?$/;

function TableView({ text, tab, thumb }: { text: string; tab: boolean; thumb?: boolean }) {
  const rows = useMemo(() => parseDelimited(text, tab ? '\t' : ','), [text, tab]);
  const LIMIT = thumb ? 14 : 2000;
  const [head, ...body] = rows;
  if (!head) return <Paper thumb={thumb}><p className="empty">This table is empty.</p></Paper>;
  const numeric = head.map((_, c) => body.slice(0, 50).every((r) => !r[c]?.trim() || NUMBER.test(r[c]!.trim())));
  return (
    <div className={`artifact-table-wrap${thumb ? ' thumb' : ''}`}>
      <table className="artifact-table">
        <thead>
          <tr>
            {head.map((h, c) => (
              <th key={c} className={numeric[c] ? 'num' : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, LIMIT).map((r, i) => (
            <tr key={i}>
              {head.map((_, c) => (
                <td key={c} className={numeric[c] ? 'num' : undefined}>
                  {r[c] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!thumb && body.length > LIMIT && <p className="muted" style={{ padding: '10px 0', fontSize: 13 }}>The first {LIMIT} of {body.length} rows. Download it for the rest.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ a page

/**
 * A page or chart a member of staff made, run in a frame sealed off from the office: no access to
 * the app or its sign-in, no network except the usual script libraries, no forms, no popups.
 */
const SEAL = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.plot.ly; style-src 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; font-src https://fonts.gstatic.com data:; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>:root{color-scheme:light}html{background:Canvas}</style>`;

export function sealPage(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + SEAL + html.slice(head.index + head[0].length);
  const doc = /<html[^>]*>/i.exec(html);
  if (doc) return html.slice(0, doc.index + doc[0].length) + `<head>${SEAL}</head>` + html.slice(doc.index + doc[0].length);
  return `<!doctype html><html><head>${SEAL}</head><body>${html}</body></html>`;
}

function PageFrame({ html, title, thumb }: { html: string; title: string; thumb?: boolean }) {
  const doc = useMemo(() => sealPage(html), [html]);
  return <iframe className={`artifact-frame${thumb ? ' thumb' : ''}`} sandbox="allow-scripts" srcDoc={doc} title={title} tabIndex={thumb ? -1 : undefined} loading="lazy" />;
}

// ------------------------------------------------------------------ the page

/** Everyone's artifacts, by person: the office-wide list, at /artifacts. */
export function ArtifactsPage() {
  const t = useNow(60_000);
  const people = useStaffList();
  const { list, error } = useArtifacts();
  const sel = useArtifactParam();
  const current = (list ?? []).filter((a) => !a.retiredAt);
  const retired = (list ?? []).length - current.length;

  return (
    <div className="page">
      <header>
        <h1 className="page-title">Artifacts</h1>
        <p className="page-lede">Finished work staff have kept for you: scripts, documents, spreadsheets, charts. The files live in each person’s library folder on your Mac. Open one to read it, save it to Drive, retire it or delete it.</p>
      </header>
      {error && <p className="empty">{error}</p>}
      {list && current.length === 0 && (
        <p className="empty">
          <b>Nothing kept yet.</b> When someone finishes a script, a report or a chart, it shows here and beside their conversation.
        </p>
      )}
      <div className="artifact-people">
        {people
          .map((p) => ({ p, items: current.filter((a) => a.staffId === p.id) }))
          .filter((g) => g.items.length)
          .map(({ p, items }) => (
            <section key={p.id} className="aside-block">
              <div className="aside-head" style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
                <Bubble staff={p} size={24} working={false} />
                <h2 className="aside-title">{p.name}</h2>
                <span className="aside-meta">{plural(items.length, 'artifact')}</span>
              </div>
              {items.map((a) => (
                <button key={a.id} className="artifact-row" onClick={() => openArtifact(p.id, a.id, true)}>
                  <ArtifactGlyph a={a} />
                  <span className="grow">
                    <span className="duty-title">{a.title}</span>
                    <span className="duty-cadence">
                      {a.folder ? `${a.folder}, ` : ''}
                      {meta(a, t)}
                    </span>
                  </span>
                </button>
              ))}
            </section>
          ))}
      </div>
      {retired > 0 && (
        <p className="muted" style={{ fontSize: 14 }}>
          {plural(retired, 'artifact')} retired.{' '}
          <button className="link" onClick={() => openArtifact(people[0]?.id ?? '', '', true)}>
            Show them
          </button>
        </p>
      )}
      {sel && <ArtifactViewer staffId={sel.staffId} id={sel.id} office />}
    </div>
  );
}
