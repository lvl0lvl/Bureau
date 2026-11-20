import fs from 'node:fs';
import path from 'node:path';
import type { Artifact, ArtifactKind, ArtifactNote, ArtifactVersion } from '../../../shared/contract.ts';
import { newId } from './store.ts';
import { FROM_STAFF, type OfficeDrive } from './drive.ts';
import type { Store } from './store.ts';

/**
 * Artifacts: the finished work staff keep for the owner, read from the `library/` folder in each
 * person's own folder. The files are the record. A file named "Cold open v3.fountain" is version
 * 3 of "Cold open.fountain", so the versions of one piece are shown together.
 *
 * What the owner has done with each one (retired it, saved a copy to Drive) is kept in a private
 * doc beside it, so staff can go on writing the folder as they like.
 */

const KIND: Record<string, ArtifactKind> = {
  '.fountain': 'script', '.spmd': 'script',
  '.md': 'document', '.markdown': 'document',
  '.csv': 'table', '.tsv': 'table',
  '.xlsx': 'sheet', '.xls': 'sheet', '.numbers': 'sheet', '.ods': 'sheet',
  '.html': 'page', '.htm': 'page',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image', '.heic': 'image',
  '.pdf': 'pdf',
  '.txt': 'text', '.json': 'text', '.py': 'text', '.js': 'text', '.ts': 'text', '.sh': 'text', '.yaml': 'text', '.yml': 'text', '.xml': 'text', '.log': 'text',
};

export const kindOf = (file: string): ArtifactKind => KIND[path.extname(file).toLowerCase()] ?? 'file';

/** A version mark in a file name: "Cold open v3", "budget_v2", "notes (v4)". */
const VERSION = /(^|[\s_\-.(])v(\d{1,3})\)?(?=$|[\s_\-.)])/i;

/** The piece a file belongs to and which version of it the file is. A file with no mark is version 1. */
export function versionOf(file: string): { key: string; title: string; n: number } {
  const ext = path.extname(file);
  const dir = path.dirname(file);
  let base = path.basename(file, ext);
  let n = 1;
  const m = VERSION.exec(base);
  if (m) {
    n = Number(m[2]);
    base = (base.slice(0, m.index) + base.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').replace(/\s+-\s*-\s+/g, ' - ').replace(/[\s_\-]+$/, '').trim();
  }
  const key = path.join(dir === '.' ? '' : dir, `${base}${ext.toLowerCase()}`);
  // The date a draft carries is shown beside it, so the title can leave it out.
  const title = base.replace(/\s*[-–,]?\s*\d{4}-\d{2}-\d{2}$/, '').replace(/[_]+/g, ' ').trim() || base;
  return { key, title, n };
}

interface Meta {
  id: string;
  retiredAt?: number | null;
  drive?: { path: string; to: string; at: number }[];
  /** Versions the owner wrote by editing in the app. */
  ownerEdits?: string[];
  /** When the owner last opened it. */
  seenAt?: number;
  /** A member of staff marked it for the owner. */
  marked?: { at: number; by: string; why: string | null } | null;
}

/** Kinds the owner can leave notes on and edit as text. */
export const EDITABLE = new Set<ArtifactKind>(['script', 'document', 'text', 'table']);
const MAX_EDIT = 1024 * 1024;
const NOTE = '_artifactNote';

/** The file name for the version after `newest`, numbered `n`: "Cold open v4 - 2026-11-16.fountain". */
export function nextVersionPath(newest: string, n: number): string {
  const ext = path.extname(newest);
  const dir = path.dirname(newest);
  const base = path.basename(newest, ext);
  const m = VERSION.exec(base);
  let next: string;
  if (m) {
    // Keep the mark where it is, in the same style: "v3" becomes "v4", "(v3)" becomes "(v4)".
    const mark = m[0].replace(/\d+/, String(n));
    next = base.slice(0, m.index) + mark + base.slice(m.index + m[0].length);
  } else {
    // Before a trailing date if there is one, as staff are asked to name drafts.
    const date = /(\s*[-–,]?\s*\d{4}-\d{2}-\d{2})$/.exec(base);
    next = date ? `${base.slice(0, date.index)} v${n}${date[1]}` : `${base} v${n}`;
  }
  return path.join(dir === '.' ? '' : dir, `${next}${ext}`);
}

export class Artifacts {
  private deps: { store: Store; staffRoot: string; drive: OfficeDrive };
  constructor(deps: { store: Store; staffRoot: string; drive: OfficeDrive }) {
    this.deps = deps;
  }

  private root(staffId: string) {
    return path.join(this.deps.staffRoot, staffId, 'library');
  }

  private meta(staffId: string, key: string): Meta | undefined {
    return this.deps.store.getPrivate<Meta>('_artifact', `${staffId}:${key}`);
  }

  private saveMeta(staffId: string, key: string, fn: (m: Meta) => void) {
    const id = `${staffId}:${key}`;
    const m: Meta = structuredClone(this.deps.store.getPrivate<Meta>('_artifact', id) ?? { id });
    fn(m);
    if (!m.retiredAt && !m.drive?.length && !m.ownerEdits?.length && !m.seenAt && !m.marked) this.deps.store.delPrivate('_artifact', id);
    else this.deps.store.putPrivate('_artifact', m);
  }

  /**
   * Work older than this counts as seen, so an office that had artifacts before "new" was kept
   * does not show every one of them as new. Set the first time it is asked for.
   */
  private since(): number {
    const b = this.deps.store.getPrivate<{ id: string; at: number }>('_artifactSince', 'since');
    if (b) return b.at;
    return this.deps.store.putPrivate('_artifactSince', { id: 'since', at: Date.now() }).at;
  }

  /** Every artifact of one person, or of everyone, newest first. */
  list(staffId?: string): Artifact[] {
    const since = this.since();
    const people = this.deps.store.list('staff').filter((s) => !s.retired && (!staffId || s.id === staffId));
    const out: Artifact[] = [];
    for (const s of people) {
      const root = this.root(s.id);
      const groups = new Map<string, { title: string; versions: (ArtifactVersion & { n: number })[] }>();
      const walk = (dir: string, depth: number) => {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          // Links are left out: an artifact is a file in the person's own folder.
          if (e.isDirectory()) { if (depth < 4) walk(full, depth + 1); continue; }
          if (!e.isFile()) continue;
          const st = fs.statSync(full, { throwIfNoEntry: false });
          if (!st) continue;
          const rel = path.relative(root, full);
          const v = versionOf(rel);
          const g = groups.get(v.key) ?? { title: v.title, versions: [] };
          g.versions.push({ path: rel, size: st.size, modifiedAt: st.mtimeMs, n: v.n, label: '' });
          groups.set(v.key, g);
        }
      };
      walk(root, 0);
      for (const [key, g] of groups) {
        const versions = g.versions.sort((a, b) => b.n - a.n || b.modifiedAt - a.modifiedAt);
        const total = versions.length;
        const meta = this.meta(s.id, key);
        const edits = meta?.ownerEdits ?? [];
        const fromStaff = Math.max(0, ...versions.filter((v) => !edits.includes(v.path)).map((v) => v.modifiedAt));
        const retiredAt = meta?.retiredAt ?? null;
        out.push({
          id: key,
          staffId: s.id,
          title: g.title,
          folder: path.dirname(key) === '.' ? '' : path.dirname(key),
          kind: kindOf(key),
          ext: path.extname(key).slice(1).toLowerCase(),
          versions: versions.map(({ n: _n, ...v }, i) => ({ ...v, label: total > 1 ? `Version ${total - i}` : 'Only version', ...(meta?.ownerEdits?.includes(v.path) ? { byOwner: true } : {}) })),
          modifiedAt: Math.max(...versions.map((v) => v.modifiedAt)),
          retiredAt,
          drive: meta?.drive ?? [],
          fresh: !retiredAt && fromStaff > (meta?.seenAt ?? since),
          marked: retiredAt ? null : meta?.marked ?? null,
        });
      }
    }
    return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  get(staffId: string, id: string): Artifact | undefined {
    return this.list(staffId).find((a) => a.id === id);
  }

  /** The file on disk for one version, or null when it is not a file in that person's library. */
  file(staffId: string, rel: string): string | null {
    if (!this.deps.store.get('staff', staffId)) return null;
    const root = this.root(staffId);
    const full = path.resolve(root, rel);
    let real: string;
    let realRoot: string;
    try { real = fs.realpathSync(full); realRoot = fs.realpathSync(root); } catch { return null; }
    const r = path.relative(realRoot, real);
    if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  }

  /** The owner opened it: it is no longer new, and a mark staff put on it has done its job. */
  seen(staffId: string, id: string): Artifact {
    const a = this.need(staffId, id);
    if (a.fresh || a.marked || !this.meta(staffId, a.id)?.seenAt) {
      this.saveMeta(staffId, a.id, (m) => {
        m.seenAt = Date.now();
        m.marked = null;
      });
    }
    return this.get(staffId, id)!;
  }

  /**
   * Mark pieces so they stand out for the owner, each with its own few words. Each name is
   * matched against the piece's path in the library, any of its versions' paths, or its title,
   * ignoring case. Returns what was marked and the names that matched nothing.
   */
  mark(staffId: string, pieces: { name: string; why: string | null }[], by: string): { marked: Artifact[]; unknown: string[] } {
    const list = this.list(staffId).filter((a) => !a.retiredAt);
    const norm = (s: string) => s.trim().replace(/^library\//, '').toLowerCase();
    const marked: Artifact[] = [];
    const unknown: string[] = [];
    for (const { name, why } of pieces) {
      const n = norm(name);
      const a = list.find((x) => x.id.toLowerCase() === n || x.versions.some((v) => v.path.toLowerCase() === n)) ?? list.find((x) => x.title.toLowerCase() === n);
      if (!a) {
        unknown.push(name);
        continue;
      }
      if (marked.includes(a)) continue;
      this.saveMeta(staffId, a.id, (m) => {
        m.marked = { at: Date.now(), by, why };
      });
      marked.push(a);
    }
    return { marked, unknown };
  }

  retire(staffId: string, id: string, retired: boolean): Artifact {
    const a = this.need(staffId, id);
    this.saveMeta(staffId, a.id, (m) => { m.retiredAt = retired ? Date.now() : null; });
    return this.get(staffId, id)!;
  }

  /** Remove every version of a piece from the person's folder. */
  remove(staffId: string, id: string): { files: number } {
    const a = this.need(staffId, id);
    const root = this.root(staffId);
    let files = 0;
    for (const v of a.versions) {
      const f = this.file(staffId, v.path);
      if (!f) continue;
      fs.rmSync(f);
      files += 1;
      // Leave no empty folders behind, up to the library itself.
      let dir = path.dirname(path.resolve(root, v.path));
      while (dir.startsWith(root + path.sep)) {
        try { if (fs.readdirSync(dir).filter((n) => n !== '.DS_Store').length) break; fs.rmSync(dir, { recursive: true }); } catch { break; }
        dir = path.dirname(dir);
      }
    }
    this.deps.store.delPrivate('_artifact', `${staffId}:${a.id}`);
    for (const n of this.notes(staffId, a.id)) this.deps.store.delPrivate(NOTE, n.id);
    return { files };
  }

  /** Copy one version into "From staff/<name>/" in the office Drive folder. */
  toDrive(staffId: string, id: string, version?: string): { to: string; already: boolean } {
    const a = this.need(staffId, id);
    const v = (version ? a.versions.find((x) => x.path === version) : a.versions[0]);
    if (!v) throw new Error('That version is no longer there.');
    const done = a.drive.find((d) => d.path === v.path);
    if (done) return { to: done.to, already: true };
    const source = this.file(staffId, v.path);
    if (!source) throw new Error('That file is no longer there.');
    const drive = this.deps.drive;
    if (!drive.folder) throw new Error('The office has no Drive folder yet. Choose one under Drive folder in Settings.');
    if (!drive.found) throw new Error('The office Drive folder cannot be seen on this Mac right now. Check that Google Drive is running on the Mac, then try again.');
    const name = this.deps.store.get('staff', staffId)!.name.replace(/[/\\:]/g, ' ').trim() || 'Staff';
    const ext = path.extname(v.path);
    const base = path.basename(v.path, ext);
    let to = '';
    for (let i = 1; ; i++) {
      const tryTo = path.join(FROM_STAFF, name, `${base}${i > 1 ? ` (${i})` : ''}${ext}`);
      try { to = drive.put(source, tryTo).to; break; } catch (e) {
        if (i < 20 && /already exists/.test((e as Error).message)) continue;
        throw e;
      }
    }
    this.saveMeta(staffId, a.id, (m) => { m.drive = [...(m.drive ?? []), { path: v.path, to, at: Date.now() }]; });
    return { to, already: false };
  }

  // ------------------------------------------------------------ notes

  notes(staffId: string, id: string): ArtifactNote[] {
    return this.deps.store.listPrivate<ArtifactNote>(NOTE).filter((n) => n.staffId === staffId && n.artifactId === id).sort((a, b) => a.at - b.at);
  }

  addNote(staffId: string, id: string, input: { path: string; quote: string; before: string; text: string }): ArtifactNote {
    const a = this.need(staffId, id);
    if (!EDITABLE.has(a.kind)) throw new Error('Notes can be left on scripts, documents, tables and text.');
    if (!a.versions.some((v) => v.path === input.path)) throw new Error('That version is no longer there.');
    const text = input.text.trim();
    if (!text) throw new Error('Write the note first.');
    if (text.length > 4000) throw new Error('That note is too long.');
    const note: ArtifactNote = {
      id: newId('note'), staffId, artifactId: a.id, path: input.path, quote: input.quote.trim().slice(0, 1200), before: input.before.slice(-80),
      text, at: Date.now(), sentAt: null, doneAt: null,
    };
    return this.deps.store.putPrivate(NOTE, note);
  }

  /** Change an open note's text, or put a note away (`done`), or take it back out. */
  updateNote(noteId: string, patch: { text?: string; done?: boolean }): ArtifactNote {
    const note = this.deps.store.getPrivate<ArtifactNote>(NOTE, noteId);
    if (!note) throw new Error('That note is no longer there.');
    const next = { ...note };
    if (patch.text !== undefined) {
      if (note.sentAt) throw new Error('That note has been sent. Leave a new one instead.');
      const t = patch.text.trim();
      if (!t) throw new Error('Write the note first.');
      next.text = t.slice(0, 4000);
    }
    if (patch.done !== undefined) next.doneAt = patch.done ? Date.now() : null;
    return this.deps.store.putPrivate(NOTE, next);
  }

  removeNote(noteId: string): void {
    const note = this.deps.store.getPrivate<ArtifactNote>(NOTE, noteId);
    if (!note) throw new Error('That note is no longer there.');
    if (note.sentAt) throw new Error('That note has been sent. Put it away instead.');
    this.deps.store.delPrivate(NOTE, noteId);
  }

  /**
   * The owner's notes, and any edits they made since the last time, as one message for the person
   * who wrote it. Marks the notes sent. Returns the message, or throws when there is nothing to send.
   */
  composeNotes(staffId: string, id: string): { text: string; hint: string; notes: number } {
    const a = this.need(staffId, id);
    const open = this.notes(staffId, id).filter((n) => !n.sentAt && !n.doneAt);
    const lastSent = Math.max(0, ...this.notes(staffId, id).map((n) => n.sentAt ?? 0));
    const edits = a.versions.filter((v) => v.byOwner && v.modifiedAt > lastSent);
    if (!open.length && !edits.length) throw new Error('There are no notes to send.');
    const lib = (p: string) => `library/${p.split(path.sep).join('/')}`;
    const label = (p: string) => a.versions.find((v) => v.path === p)?.label.toLowerCase() ?? 'an older version';
    const newest = a.versions[0]!;
    const lines: string[] = [`Notes on “${a.title}”${open.length ? `, ${open.length === 1 ? 'one note' : `${open.length} notes`}` : ''}.`];
    if (open.length) {
      lines.push('');
      for (const [i, n] of open.entries()) {
        const where = n.path === newest.path ? '' : ` (in ${label(n.path)}, ${lib(n.path)})`;
        lines.push(n.quote ? `${i + 1}. On “${n.quote.replace(/\s+/g, ' ').slice(0, 400)}”${where}: ${n.text}` : `${i + 1}. On the whole piece${where}: ${n.text}`);
      }
    }
    if (edits.length) {
      lines.push('', `I made changes myself in ${edits.map((v) => `${v.label.toLowerCase()} (${lib(v.path)})`).join(' and ')}. Work from ${edits[0]!.path === newest.path ? 'that one' : 'the newest version'}, and keep my changes unless a note says otherwise.`);
    }
    lines.push('', `Revise it with these in mind and save the result as the next version, a new file beside the others in ${lib(path.dirname(newest.path) === '.' ? '' : path.dirname(newest.path)).replace(/\/$/, '')}/, then tell me in a few lines what you changed and anything you did not take up, and why.`);
    const at = Date.now();
    for (const n of open) this.deps.store.putPrivate(NOTE, { ...n, sentAt: at });
    return {
      text: lines.join('\n'),
      hint: `Sent from the artifact viewer: notes on ${lib(newest.path)}, the newest version of “${a.title}”.`,
      notes: open.length,
    };
  }

  /** Save the owner's edit of one version as the next version. Nothing already there is changed. */
  saveEdit(staffId: string, id: string, base: string, text: string): { path: string } {
    const a = this.need(staffId, id);
    if (!EDITABLE.has(a.kind)) throw new Error('Only scripts, documents, tables and text can be edited here.');
    if (!a.versions.some((v) => v.path === base)) throw new Error('That version is no longer there.');
    if (Buffer.byteLength(text) > MAX_EDIT) throw new Error('That is too long to save from here.');
    const original = this.file(staffId, base);
    if (original && fs.readFileSync(original, 'utf8') === text) throw new Error('Nothing has changed.');
    const root = this.root(staffId);
    let n = a.versions.length + 1;
    let rel = nextVersionPath(a.versions[0]!.path, n);
    while (fs.existsSync(path.join(root, rel)) && n < 999) rel = nextVersionPath(a.versions[0]!.path, (n += 1));
    const full = path.resolve(root, rel);
    if (path.relative(root, full).startsWith('..')) throw new Error('That version cannot be saved there.');
    fs.writeFileSync(full, text, { flag: 'wx' });
    this.saveMeta(staffId, a.id, (m) => { m.ownerEdits = [...(m.ownerEdits ?? []), rel]; });
    return { path: rel };
  }

  private need(staffId: string, id: string): Artifact {
    const a = this.get(staffId, id);
    if (!a) throw new Error('That artifact is no longer there.');
    return a;
  }
}
