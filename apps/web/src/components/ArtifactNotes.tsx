import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Artifact, ArtifactNote, Staff } from '@shared/contract.ts';
import { when } from '../lib/format.ts';
import { api } from '../sync/client.ts';
import { toast } from '../sync/store.ts';

/**
 * Notes on an artifact: select a passage, leave a note, send the notes to the person who wrote it
 * as one message. The passages stay marked on the page with the browser's own highlights, so the
 * document itself is never rewritten to show them.
 */

export function useNotes(a: Artifact | null): { notes: ArtifactNote[]; reload: () => void } {
  const [notes, setNotes] = useState<ArtifactNote[]>([]);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!a) return setNotes([]);
    let live = true;
    api.artifactNotes(a).then((x) => live && setNotes(x)).catch(() => live && setNotes([]));
    return () => {
      live = false;
    };
  }, [a?.staffId, a?.id, n]);
  return { notes, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** Where a sent note stands: answered by a newer version from the writer, or still waiting. */
export function noteState(n: ArtifactNote, a: Artifact): { kind: 'open' | 'waiting' | 'answered' | 'done'; label: string } {
  if (n.doneAt) return { kind: 'done', label: 'Put away' };
  if (!n.sentAt) return { kind: 'open', label: 'Not sent yet' };
  const answer = [...a.versions].reverse().find((v) => !v.byOwner && v.path !== n.path && v.modifiedAt > n.sentAt!);
  return answer ? { kind: 'answered', label: `Answered in ${answer.label.toLowerCase()}` } : { kind: 'waiting', label: `Sent ${when(n.sentAt, Date.now())}, waiting for the next version` };
}

// ----------------------------------------------------------- finding passages

/** Text under `root`, without its spaces and line breaks, with where each character sits. */
function indexText(root: Node): { flat: string; at: { node: Text; offset: number }[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let flat = '';
  const at: { node: Text; offset: number }[] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const t = n.data;
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i]!)) continue;
      flat += t[i]!.toLowerCase();
      at.push({ node: n, offset: i });
    }
  }
  return { flat, at };
}

const squeeze = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** The passage a note was left on, found again on the page. Spacing and case are ignored. */
export function findPassage(root: Node, quote: string, before: string): Range | null {
  const q = squeeze(quote);
  if (!q) return null;
  const { flat, at } = indexText(root);
  const ctx = squeeze(before).slice(-24);
  let best = -1;
  for (let i = flat.indexOf(q); i >= 0; i = flat.indexOf(q, i + 1)) {
    if (best < 0) best = i;
    if (ctx && flat.slice(Math.max(0, i - ctx.length), i) === ctx) {
      best = i;
      break;
    }
  }
  if (best < 0) return null;
  const start = at[best]!;
  const end = at[best + q.length - 1]!;
  const r = document.createRange();
  r.setStart(start.node, start.offset);
  r.setEnd(end.node, end.offset + 1);
  return r;
}

type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void };
const registry = (): HighlightRegistry | null => (globalThis.CSS as unknown as { highlights?: HighlightRegistry })?.highlights ?? null;
const makeHighlight = (ranges: Range[]): unknown => {
  const H = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  return H ? new H(...ranges) : null;
};

/** Mark the passages of these notes on the page; `active` is drawn stronger. */
export function useNoteHighlights(root: RefObject<HTMLElement | null>, notes: ArtifactNote[], active: string | null, ready: unknown) {
  useEffect(() => {
    const reg = registry();
    const el = root.current?.querySelector('.artifact-page, .artifact-table-wrap') ?? null;
    if (!reg || !el) return;
    const all: Range[] = [];
    const strong: Range[] = [];
    for (const n of notes) {
      if (n.doneAt || !n.quote) continue;
      const r = findPassage(el, n.quote, n.before);
      if (!r) continue;
      (n.id === active ? strong : all).push(r);
    }
    const a = makeHighlight(all);
    const b = makeHighlight(strong);
    if (a) reg.set('bureau-note', a);
    if (b) reg.set('bureau-note-active', b);
    return () => {
      reg.delete('bureau-note');
      reg.delete('bureau-note-active');
    };
  }, [root, notes, active, ready]);
}

// ------------------------------------------------------------ the selection

export interface Picked {
  quote: string;
  before: string;
  /** Where the passage is on screen, to put the button beside it. */
  rect: { top: number; left: number; bottom: number; width: number };
}

/** The passage selected inside the document, if any. Held a moment after it clears, so a tap can use it. */
export function useSelectedPassage(root: RefObject<HTMLElement | null>, enabled: boolean): [Picked | null, () => void, () => void] {
  const [picked, setPicked] = useState<Picked | null>(null);
  const holding = useRef(false);
  const clearTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return setPicked(null);
    const look = () => {
      const sel = document.getSelection();
      const page = root.current?.querySelector('.artifact-page, .artifact-table-wrap');
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      if (sel && sel.rangeCount && !sel.isCollapsed && page && page.contains(sel.getRangeAt(0).commonAncestorContainer)) {
        const r = sel.getRangeAt(0);
        const quote = sel.toString().trim();
        if (!quote) return;
        const pre = document.createRange();
        pre.setStart(page, 0);
        pre.setEnd(r.startContainer, r.startOffset);
        const box = r.getBoundingClientRect();
        setPicked({ quote, before: pre.toString().slice(-80), rect: { top: box.top, left: box.left, bottom: box.bottom, width: box.width } });
        return;
      }
      if (holding.current) return;
      clearTimer.current = window.setTimeout(() => setPicked(null), 350);
    };
    document.addEventListener('selectionchange', look);
    return () => {
      document.removeEventListener('selectionchange', look);
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
    };
  }, [root, enabled]);
  const hold = useCallback(() => {
    holding.current = true;
  }, []);
  const done = useCallback(() => {
    holding.current = false;
    setPicked(null);
    document.getSelection()?.removeAllRanges();
  }, []);
  return [picked, hold, done];
}

// ------------------------------------------------------------ the composer

export function NoteComposer({ quote, phone, onSave, onCancel }: { quote: string; phone: boolean; onSave: (text: string) => Promise<boolean>; onCancel: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    ref.current?.focus();
  }, []);
  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onSave(text.trim());
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <div className={`note-composer${phone ? ' is-sheet' : ''}`} role="dialog" aria-label="New note" onClick={(e) => e.stopPropagation()}>
      {quote ? <blockquote className="note-quote">{clip(quote, 280)}</blockquote> : <p className="note-whole">A note on the whole piece</p>}
      <textarea
        ref={ref}
        className="input note-text"
        value={text}
        rows={3}
        placeholder="Your note"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div className="row note-composer-acts">
        <button className="btn btn-soft btn-sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-blue btn-sm" disabled={!text.trim() || busy} onClick={() => void save()}>
          {busy ? 'Saving' : 'Add note'}
        </button>
      </div>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// -------------------------------------------------------------- the panel

export function NotesPanel({
  a,
  writer,
  notes,
  active,
  shownPath,
  phone,
  onPick,
  onWhole,
  reload,
  onClose,
}: {
  a: Artifact;
  writer: Staff | undefined;
  notes: ArtifactNote[];
  active: string | null;
  shownPath: string;
  phone: boolean;
  onPick: (n: ArtifactNote) => void;
  onWhole: () => void;
  reload: () => void;
  onClose: () => void;
}) {
  const [sending, setSending] = useState(false);
  const shown = notes.filter((n) => !n.doneAt);
  const open = shown.filter((n) => !n.sentAt);
  const lastSent = Math.max(0, ...notes.map((n) => n.sentAt ?? 0));
  const edits = a.versions.filter((v) => v.byOwner && v.modifiedAt > lastSent);
  const name = writer?.name ?? 'them';
  const send = async () => {
    setSending(true);
    const r = await api.sendArtifactNotes(a);
    setSending(false);
    if (!r) return;
    toast(`Sent to ${name}. The reply comes in their conversation, and the next version shows here.`);
    reload();
  };
  const label = (path: string) => a.versions.find((v) => v.path === path)?.label ?? 'An older version';
  return (
    <aside className={`viewer-notes${phone ? ' is-sheet' : ''}`} aria-label="Notes" onClick={(e) => e.stopPropagation()}>
      <div className="viewer-notes-head">
        <h3>Notes</h3>
        <button className="btn btn-quiet btn-sm" onClick={onWhole}>
          Add a note
        </button>
        {phone && (
          <button className="btn btn-soft btn-sm" onClick={onClose}>
            Done
          </button>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="viewer-notes-empty">{phone ? 'Select words in the document, then tap Add note.' : 'Select words in the document to leave a note on them.'} Notes go to {name} together when you send them.</p>
      ) : (
        <ol className="viewer-notes-list">
          {shown.map((n) => {
            const st = noteState(n, a);
            return (
              <li key={n.id} className={`note-card is-${st.kind}${n.id === active ? ' on' : ''}`}>
                <button className="note-card-main" onClick={() => onPick(n)}>
                  {n.quote ? <span className="note-quote">{clip(n.quote, 160)}</span> : <span className="note-whole">The whole piece</span>}
                  <span className="note-body">{n.text}</span>
                  <span className="note-meta">
                    {n.path !== shownPath ? `${label(n.path)}. ` : ''}
                    {st.label}
                  </span>
                </button>
                {st.kind === 'open' ? (
                  <button className="note-x" aria-label="Remove this note" title="Remove" onClick={() => void api.removeArtifactNote(n.id).then(reload)}>
                    ×
                  </button>
                ) : (
                  <button className="note-x" aria-label="Put this note away" title="Put away" onClick={() => void api.updateArtifactNote(n.id, { done: true }).then(reload)}>
                    ×
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {(open.length > 0 || edits.length > 0) && (
        <div className="viewer-notes-send">
          <button className="btn btn-blue" disabled={sending} onClick={() => void send()}>
            {sending ? 'Sending' : open.length ? `Send ${open.length === 1 ? 'the note' : `${open.length} notes`} to ${name}` : `Tell ${name} about your edit`}
          </button>
          <p>
            {open.length ? `One message, each passage quoted${edits.length ? ', with your edit' : ''}.` : 'One message, so they work from your version.'} {name} revises and saves the next version.
          </p>
        </div>
      )}
    </aside>
  );
}

// -------------------------------------------------------------- editing

/** The text of one version, to change and save as the next version. */
export function EditView({ a, path, onDone }: { a: Artifact; path: string; onDone: (saved: string | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [original, setOriginal] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .artifactText(a.staffId, path)
      .then((x) => {
        if (!live) return;
        setText(x);
        setOriginal(x);
      })
      .catch(() => live && toast('This version could not be opened to edit.'));
    return () => {
      live = false;
    };
  }, [a.staffId, path]);
  const changed = text !== null && text !== original;
  const save = async () => {
    if (!changed || busy) return;
    setBusy(true);
    const r = await api.saveArtifactEdit(a, path, text!);
    setBusy(false);
    if (!r) return;
    toast('Saved as a new version, marked as yours. The one you started from is unchanged.');
    onDone(r.path);
  };
  return (
    <div className="artifact-edit">
      <div className="artifact-edit-bar">
        <span>
          Editing {a.versions.find((v) => v.path === path)?.label.toLowerCase() ?? 'this version'}. Saving makes a new version; the one you started from stays as it was.
        </span>
        <button className="btn btn-soft btn-sm" onClick={() => (!changed || window.confirm('Leave without saving your changes?')) && onDone(null)}>
          Cancel
        </button>
        <button className="btn btn-blue btn-sm" disabled={!changed || busy} onClick={() => void save()}>
          {busy ? 'Saving' : 'Save as new version'}
        </button>
      </div>
      {text === null ? (
        <p className="muted" style={{ padding: 24 }}>
          Opening
        </p>
      ) : (
        <textarea
          className={`artifact-edit-text${a.kind === 'script' || a.kind === 'table' ? ' mono' : ''}`}
          value={text}
          spellCheck={a.kind !== 'table'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void save();
            }
          }}
          aria-label="The text of this version"
        />
      )}
    </div>
  );
}
