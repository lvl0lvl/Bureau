import fs from 'node:fs';
import path from 'node:path';
import type { OfficeDrive } from './drive.ts';
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

const SEEN = '_drop';
const BASELINE = '#baseline';
/** How many files go to the chief of staff in one go. */
const BATCH = 20;

export class DropWatch {
  private deps: { store: Store; drive: OfficeDrive; hand: (staffId: string, files: string[]) => void; everyMs?: number };
  /** Files seen once and not yet handed over. A file is handed over when it looks the same twice running, so a copy still in progress is left alone. */
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: { store: Store; drive: OfficeDrive; hand: (staffId: string, files: string[]) => void; everyMs?: number }) {
    this.deps = deps;
  }

  /** Look once. Returns the files handed over this time, as paths inside the office Drive folder. */
  scan(): string[] {
    const { store, drive } = this.deps;
    const settings = store.get('settings', 'settings');
    if (!settings || settings.watchDrop === false || !drive.found) return [];
    const chief = store.list('staff').find((s) => s.isChief && !s.retired);
    if (!chief) return [];

    const now = drive.dropped();
    const key = (f: { rel: string; size: number; mtimeMs: number }) => `${f.rel}|${f.size}|${Math.round(f.mtimeMs)}`;
    const seen = new Set(store.listPrivate<{ id: string }>(SEEN).map((d) => d.id));

    // The first look ever: what is already there was left before the office started watching.
    if (!seen.has(BASELINE)) {
      store.putPrivate(SEEN, { id: BASELINE, at: Date.now() });
      for (const f of now) store.putPrivate(SEEN, { id: key(f), at: Date.now() });
      return [];
    }

    const current = new Set(now.map(key));
    // Forget files that have gone (filed, or taken back), so the list stays short.
    for (const id of seen) if (id !== BASELINE && !current.has(id)) store.delPrivate(SEEN, id);

    const ready: string[] = [];
    const waiting = new Set<string>();
    for (const f of now) {
      const k = key(f);
      if (seen.has(k)) continue;
      if (this.pending.has(k) && ready.length < BATCH) {
        ready.push(f.rel);
        store.putPrivate(SEEN, { id: k, at: Date.now() });
      } else waiting.add(k);
    }
    this.pending = waiting;
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
