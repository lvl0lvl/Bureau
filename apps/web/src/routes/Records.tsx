import { useEffect, useMemo, useState } from 'react';
import type { BooksCommit, BooksEntry, LibraryFile } from '@shared/contract.ts';
import { Bubble, useLoad } from '../components/bits.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { bytes, when } from '../lib/format.ts';
import { api } from '../sync/client.ts';
import { toast, useNow, useStaffList } from '../sync/store.ts';

// --------------------------------------------------------------------- books

export function Books() {
  const t = useNow(60_000);
  const tree = useLoad<BooksEntry[]>(() => api.booksTree(), []);
  const history = useLoad<BooksCommit[]>(() => api.booksHistory(), []);
  const [path, setPath] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const files = useMemo(() => (tree.data ?? []).filter((e) => !e.dir).sort((a, b) => a.path.localeCompare(b.path)), [tree.data]);
  useEffect(() => {
    if (!path && files.length) setPath(files[0]!.path);
  }, [files, path]);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setText(null);
    api
      .booksFile(path)
      .then((x) => live && setText(x))
      .catch(() => live && setText('This file could not be opened.'));
    return () => {
      live = false;
    };
  }, [path, history.data]);

  const revert = async (c: BooksCommit) => {
    setBusy(c.sha);
    const ok = await api.booksRevert(c.sha);
    setBusy(null);
    if (ok !== undefined) {
      toast('Undone. The earlier version is back.');
      tree.reload();
      history.reload();
    }
  };

  let lastDir = '';
  return (
    <div className="page fixed">
      <header>
        <h1 className="page-title">The Books</h1>
        <p className="page-lede">The shared records everyone works from, kept as plain files on your Mac. Every change is recorded with who made it, and any change can be undone.</p>
      </header>
      <div className="cols">
        <nav className="col-list" aria-label="Files">
          <div className="list-head">Files</div>
          {tree.error && <p className="empty">{tree.error}</p>}
          {tree.data && files.length === 0 && <p className="empty" style={{ fontSize: 14 }}>The Books are empty. Ask someone to start a record, such as your contacts or this month’s accounts.</p>}
          {files.map((f) => {
            const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
            const head = dir !== lastDir ? dir : null;
            lastDir = dir;
            return (
              <div key={f.path}>
                {head && <div className="list-head file-dir">{head}</div>}
                <button className={`file-row${f.path === path ? ' on' : ''}`} onClick={() => setPath(f.path)}>
                  <span className="file-name">{f.path.slice(dir ? dir.length + 1 : 0)}</span>
                  <span className="narrow">{when(f.modifiedAt, t)}</span>
                </button>
              </div>
            );
          })}
        </nav>
        <article className="col-main" aria-label="File">
          {path && <h2 className="doc-title">{path}</h2>}
          {path && text === null && <p className="muted">Opening</p>}
          {text !== null && (path?.endsWith('.md') ? <div className="doc msg" style={{ whiteSpace: 'normal' }}><Markdown text={text} /></div> : <pre className="doc mono" style={{ margin: 0 }}>{text}</pre>)}
        </article>
        <aside className="col-side" aria-label="History">
          <div className="list-head">Changes</div>
          {history.error && <p className="empty">{history.error}</p>}
          {history.data && history.data.length === 0 && <p className="empty" style={{ fontSize: 14 }}>No changes recorded yet.</p>}
          {(history.data ?? []).map((c) => (
            <div key={c.sha} className="commit">
              <div className="commit-top">{c.subject}</div>
              <div className="commit-meta">
                {c.author}, {when(c.at, t)}
                {c.files.length > 0 && `. ${c.files.join(', ')}`}
              </div>
              <button className="btn btn-soft btn-sm" disabled={busy === c.sha} onClick={() => void revert(c)}>
                {busy === c.sha ? 'Undoing' : 'Undo this change'}
              </button>
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- library

export function Library() {
  const t = useNow(60_000);
  const staff = useStaffList();
  const files = useLoad<LibraryFile[]>(() => api.library(), []);
  const byStaff = useMemo(() => {
    const m = new Map<string, LibraryFile[]>();
    for (const f of files.data ?? []) m.set(f.staffId, [...(m.get(f.staffId) ?? []), f]);
    for (const list of m.values()) list.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return m;
  }, [files.data]);
  const any = (files.data ?? []).length > 0;

  return (
    <div className="page">
      <header>
        <h1 className="page-title">Library</h1>
        <p className="page-lede">Finished work that staff have saved for you: reports, drafts, spreadsheets, scripts. The files live in each person’s folder on your Mac.</p>
      </header>
      {files.error && <p className="empty">{files.error}</p>}
      {files.data && !any && (
        <p className="empty">
          <b>Nothing saved yet.</b> When someone finishes a report or a document, it is kept here so you can open it later.
        </p>
      )}
      {staff
        .filter((s) => byStaff.has(s.id))
        .map((s) => (
          <section key={s.id} className="aside-block" style={{ maxWidth: 760 }}>
            <div className="aside-head" style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
              <Bubble staff={s} size={24} working={false} />
              <h2 className="aside-title">{s.name}</h2>
            </div>
            {byStaff.get(s.id)!.map((f) => (
              <button key={f.path} className="file-row" onClick={() => void api.openLibraryFile(f)}>
                <span className="file-name">{f.path}</span>
                <span className="narrow">
                  {bytes(f.size)}, {when(f.modifiedAt, t)}
                </span>
              </button>
            ))}
          </section>
        ))}
    </div>
  );
}
