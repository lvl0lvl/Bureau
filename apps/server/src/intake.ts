import fs from 'node:fs';
import path from 'node:path';
import type { DropFolder } from '../../../shared/contract.ts';
import { DROP, type OfficeDrive } from './drive.ts';
import { newId, type Store } from './store.ts';

/**
 * Ways for documents to reach the office without typing them in.
 *
 * Uploads: files the owner attaches to a message, from a phone or a computer. They are held
 * briefly, then moved into the folder of the person the message goes to.
 *
 * DropWatch: files the owner leaves in "Drop here" in the office Drive folder are noticed and
 * handed to the chief of staff.
 *
 * leaveInDrop: a photo taken in the app is put in "Drop here" for the owner, so it is in Drive and
 * reaches the chief of staff the same way as anything else left there.
 *
 * Either way the contents came from outside the office. The turn that receives them is marked as
 * having read outside material from its first moment, so nothing they say can send or pay unsigned.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 10;
const DAY = 86_400_000;

export interface HeldFile { id: string; name: string; bytes: number }
export interface TakenFile { name: string; rel: string; bytes: number }

/** A file name that is safe to create: no folders, no hidden files, nothing odd. */
export function safeName(raw: string): string {
  const base = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = base.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 12);
    name = `${name.slice(0, 120 - ext.length)}${ext}`;
  }
  return name || 'file';
}

/** `name` if it is free in `dir`, otherwise "name 2.ext", "name 3.ext" and so on. */
function free(dir: string, name: string): string {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; n < 1000; n++) {
    const next = `${stem} ${n}${ext}`;
    if (!fs.existsSync(path.join(dir, next))) return next;
  }
  return `${stem} ${Date.now()}${ext}`;
}

export function sizeWords(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export class Uploads {
  private dir: string;

  constructor(home: string) {
    this.dir = path.join(home, 'uploads');
  }

  /** Hold a file until the message it belongs to is sent. */
  save(name: string, data: Uint8Array): HeldFile {
    if (data.byteLength === 0) throw new Error('That file is empty.');
    if (data.byteLength > MAX_UPLOAD_BYTES) throw new Error(`That file is larger than ${sizeWords(MAX_UPLOAD_BYTES)}. Put it in Drop here in the office Drive folder instead.`);
    const id = newId('up');
    const dir = path.join(this.dir, id);
    fs.mkdirSync(dir, { recursive: true });
    const safe = safeName(name);
    fs.writeFileSync(path.join(dir, safe), data);
    return { id, name: safe, bytes: data.byteLength };
  }

  private held(id: string): { file: string; name: string; bytes: number } | null {
    if (!/^up_[A-Za-z0-9_-]+$/.test(id)) return null;
    const dir = path.join(this.dir, id);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    const name = names[0];
    if (!name) return null;
    const file = path.join(dir, name);
    return { file, name, bytes: fs.statSync(file).size };
  }

  /** Move held files into a member of staff's folder, under inbox/<date>/. Unknown ids are skipped. */
  take(ids: string[], staffHome: string, day: string): TakenFile[] {
    const out: TakenFile[] = [];
    const dir = path.join(staffHome, 'inbox', day);
    for (const id of [...new Set(ids)].slice(0, MAX_FILES_PER_MESSAGE)) {
      const h = this.held(id);
      if (!h) continue;
      fs.mkdirSync(dir, { recursive: true });
      const name = free(dir, h.name);
      fs.renameSync(h.file, path.join(dir, name));
      fs.rmSync(path.dirname(h.file), { recursive: true, force: true });
      out.push({ name, rel: path.join('inbox', day, name), bytes: h.bytes });
    }
    return out;
  }

  /** Throw away files that were uploaded but never sent. */
  sweep(olderThan = DAY) {
    let ids: string[] = [];
    try { ids = fs.readdirSync(this.dir); } catch { return; }
    for (const id of ids) {
      const dir = path.join(this.dir, id);
      try { if (Date.now() - fs.statSync(dir).mtimeMs > olderThan) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    }
  }
}

/** The office Drive folder is not set, or cannot be seen on this Mac right now. */
export class NoDriveFolder extends Error {}

/**
 * Put a file from the owner's own device in "Drop here", as if the owner had left it there. The
 * watch below hands it to the chief of staff once it has looked the same twice, like any other
 * dropped file. A name already in use gets a number, so nothing is overwritten.
 */
export function leaveInDrop(drive: OfficeDrive, name: string, data: Uint8Array): { name: string; rel: string; bytes: number } {
  if (data.byteLength === 0) throw new Error('That file is empty.');
  if (data.byteLength > MAX_UPLOAD_BYTES) throw new Error(`That file is larger than ${sizeWords(MAX_UPLOAD_BYTES)}.`);
  const root = drive.folder;
  if (!root || !drive.found) throw new NoDriveFolder('The office Drive folder cannot be seen on this Mac right now.');
  const dir = path.join(root, DROP);
  fs.mkdirSync(dir, { recursive: true });
  const safe = free(dir, safeName(name));
  fs.writeFileSync(path.join(dir, safe), data, { flag: 'wx' });
  return { name: safe, rel: path.join(DROP, safe), bytes: data.byteLength };
}

const SEEN = '_drop';
const PARKED = '_dropPark';
const BASELINE = '#baseline';
/**
 * Looks in a row with nothing new or changed in a folder before its files are handed over. A file
 * left on its own needs one (it looked the same twice); a folder that Google Drive is still
 * filling needs three, so it reaches the chief of staff as one notice instead of several.
 */
const FOLDER_QUIET = 3;
const key = (f: { rel: string; size: number; mtimeMs: number }) => `${f.rel}|${f.size}|${Math.round(f.mtimeMs)}`;

/** The top folder in Drop here that a file is in, or the file itself when it is left loose. */
function groupOf(rel: string): string {
  const parts = rel.split(path.sep);
  return parts.length > 2 ? parts.slice(0, 2).join(path.sep) : rel;
}

export interface ParkedFolder { id: string; at: number; by: string }

/** A folder in Drop here the owner has said to leave alone, as a path inside the office Drive folder. */
export function normaliseDropFolder(folder: string): string | null {
  const clean = folder.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.').join('/');
  if (!clean || clean.split('/').includes('..')) return null;
  if (clean === DROP) return null;
  const rel = clean.startsWith(`${DROP}/`) ? clean : `${DROP}/${clean}`;
  return rel.split('/').join(path.sep);
}

export class DropWatch {
  private deps: { store: Store; drive: OfficeDrive; hand: (staffId: string, files: string[]) => void; everyMs?: number };
  /** Files seen once and not yet handed over. A file is handed over when it looks the same twice running, so a copy still in progress is left alone. */
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: { store: Store; drive: OfficeDrive; hand: (staffId: string, files: string[]) => void; everyMs?: number }) {
    this.deps = deps;
  }

  /** The chief of staff who is handed what is dropped, or null while the folder is not being watched. */
  private watcher() {
    const { store, drive } = this.deps;
    const settings = store.get('settings', 'settings');
    if (!settings || settings.watchDrop === false || !drive.found) return null;
    return store.list('staff').find((s) => s.isChief && !s.retired) ?? null;
  }

  /**
   * The first look ever: what is already there was left before the office started watching, and
   * is left alone. Does nothing after that, or while the folder is not watched. The office calls
   * this before it puts a file in Drop here itself, so that file is not taken for an old one.
   * True when this was the first look.
   */
  settle(): boolean {
    const { store, drive } = this.deps;
    if (!this.watcher() || store.listPrivate<{ id: string }>(SEEN).some((d) => d.id === BASELINE)) return false;
    store.putPrivate(SEEN, { id: BASELINE, at: Date.now() });
    for (const f of drive.dropped()) store.putPrivate(SEEN, { id: key(f), at: Date.now() });
    return true;
  }

  /** Folders in Drop here that are left alone: nothing in them is handed over. */
  parked(): ParkedFolder[] {
    return this.deps.store.listPrivate<ParkedFolder>(PARKED).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Leave a folder in Drop here alone, or stop leaving it alone. `folder` may leave out "Drop here/". */
  park(folder: string, on: boolean, by: string): string {
    const rel = normaliseDropFolder(folder);
    if (!rel) throw new Error('Name a folder inside Drop here, for example "writers_room".');
    if (on) this.deps.store.putPrivate<ParkedFolder>(PARKED, { id: rel, at: Date.now(), by });
    else this.deps.store.delPrivate(PARKED, rel);
    return rel;
  }

  /** The folders in Drop here now, with those left alone (even once they are gone). */
  folders(): DropFolder[] {
    const parked = this.parked();
    const out = new Map<string, DropFolder>();
    for (const f of this.deps.drive.dropped()) {
      const g = groupOf(f.rel);
      if (g === f.rel) continue;
      const e = out.get(g) ?? { name: path.relative(DROP, g), files: 0, parked: null };
      e.files += 1;
      out.set(g, e);
    }
    for (const p of parked) {
      const e = out.get(p.id) ?? { name: path.relative(DROP, p.id), files: 0, parked: null };
      e.parked = { at: p.at, by: p.by };
      out.set(p.id, e);
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private isParked(rel: string, parked: ParkedFolder[]): boolean {
    return parked.some((p) => rel === p.id || rel.startsWith(p.id + path.sep));
  }

  /** How many looks in a row each folder has gone unchanged. */
  private quiet = new Map<string, number>();

  /** Look once. Returns the files handed over this time, as paths inside the office Drive folder. */
  scan(): string[] {
    const { store, drive } = this.deps;
    const chief = this.watcher();
    if (!chief || this.settle()) return [];

    const all = drive.dropped();
    const seen = new Set(store.listPrivate<{ id: string }>(SEEN).map((d) => d.id));

    const current = new Set(all.map(key));
    // Forget files that have gone (filed, or taken back), so the list stays short.
    for (const id of seen) if (id !== BASELINE && !current.has(id)) store.delPrivate(SEEN, id);

    const parked = this.parked();
    // New files by the folder they arrived in. A folder that changed this time waits again.
    const groups = new Map<string, { files: string[]; keys: string[]; changed: boolean; folder: boolean }>();
    for (const f of all) {
      const k = key(f);
      if (seen.has(k) || this.isParked(f.rel, parked)) continue;
      const g = groupOf(f.rel);
      const e = groups.get(g) ?? { files: [], keys: [], changed: false, folder: g !== f.rel };
      e.files.push(f.rel);
      e.keys.push(k);
      if (!this.pending.has(k)) e.changed = true;
      groups.set(g, e);
    }

    const ready: string[] = [];
    const waiting = new Set<string>();
    const quiet = new Map<string, number>();
    for (const [g, e] of groups) {
      const q = e.changed ? 0 : (this.quiet.get(g) ?? 0) + 1;
      if (q >= (e.folder ? FOLDER_QUIET : 1)) {
        ready.push(...e.files);
        for (const k of e.keys) store.putPrivate(SEEN, { id: k, at: Date.now() });
      } else {
        for (const k of e.keys) waiting.add(k);
        quiet.set(g, q);
      }
    }
    this.pending = waiting;
    this.quiet = quiet;
    if (ready.length) this.deps.hand(chief.id, ready);
    return ready;
  }

  start() {
    const every = this.deps.everyMs ?? 60_000;
    this.timer = setInterval(() => { try { this.scan(); } catch (e) { console.error('[drop] could not look in Drop here:', (e as Error).message); } }, every);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
