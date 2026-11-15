import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BackupStatus } from '../../../shared/contract.ts';
import type { OfficeDrive } from './drive.ts';
import type { Store } from './store.ts';
import type { Work } from './work.ts';

/**
 * Backups of the whole office.
 *
 * Once a day the office packs itself into one file, encrypts it, and puts it in the Backups
 * folder of its Drive folder, where Google Drive for desktop carries it off the Mac.
 *
 * Encryption is done with age, to a key pair. The office keeps only the public half, which can
 * lock an archive and cannot open one. The private half, the recovery key, is shown to the owner
 * once when backups are switched on and is never stored here. So nothing on this Mac or in Drive
 * can read a backup, and making one needs no secret.
 */

const NAME = /^bureau-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\.tar\.gz\.age$/;
/** Left out of an archive: the live database (a consistent copy goes in instead) and catalog clones, which can be fetched again. */
const SKIP = new Set(['catalog', 'bureau.db', 'bureau.db-shm', 'bureau.db-wal', '.DS_Store']);
const HOUR = 3_600_000;
/** The backup day starts at three in the morning, office time. */
const DAY_STARTS = 3 * HOUR;
const DUE_ID = 'due_backup';

export interface AgePaths { age: string; keygen: string }

export function findAge(): AgePaths | null {
  const given = process.env.BUREAU_AGE_PATH;
  const dirs = given ? [path.dirname(given)] : [...(process.env.PATH ?? '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const age = path.join(d, 'age');
    const keygen = path.join(d, 'age-keygen');
    try { fs.accessSync(age, fs.constants.X_OK); fs.accessSync(keygen, fs.constants.X_OK); return { age, keygen }; } catch { /* keep looking */ }
  }
  return null;
}

/** Which archives to keep: the newest of each of the last `days` days that have one, and of each of the last `months` months. */
export function keep(names: string[], opts: { days?: number; months?: number } = {}): Set<string> {
  const days = opts.days ?? 14;
  const months = opts.months ?? 12;
  const ours = names.filter((n) => NAME.test(n)).sort().reverse();
  const kept = new Set<string>();
  const seenDays = new Set<string>();
  const seenMonths = new Set<string>();
  for (const n of ours) {
    const m = NAME.exec(n)!;
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    const month = `${m[1]}-${m[2]}`;
    if (!seenDays.has(day) && seenDays.size < days) { seenDays.add(day); kept.add(n); }
    if (!seenMonths.has(month) && seenMonths.size < months) { seenMonths.add(month); kept.add(n); }
  }
  return kept;
}

function parts(at: number, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))) out[p.type] = p.value;
  return out;
}

export function archiveName(at: number, timeZone: string): string {
  const p = parts(at, timeZone);
  return `bureau-${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}.tar.gz.age`;
}

const dateOf = (at: number, timeZone: string) => { const p = parts(at, timeZone); return `${p.year}-${p.month}-${p.day}`; };

function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** The line of a program's complaints that says what went wrong. */
function said(err: string): string | undefined {
  const lines = err.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /error/i.test(l)) ?? lines.pop();
}

function finished(child: ReturnType<typeof spawn>, what: string): Promise<void> {
  let err = '';
  child.stderr?.on('data', (d) => { err += String(d); });
  return new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`${what} could not be started: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${what} failed: ${said(err) ?? `exit ${code}`}`))));
  });
}

interface State {
  id: 'state';
  /** The public half of the recovery key. */
  recipient: string | null;
  keyCreatedAt: number | null;
  last: BackupStatus['last'];
  lastError: BackupStatus['lastError'];
  /** When today's backup first came due and found the office busy. */
  dueSince: number | null;
}

export class Backup {
  private store: Store;
  private home: string;
  private drive: OfficeDrive;
  private work: Work | undefined;
  private busy: () => boolean;
  private age: AgePaths | null;
  private running: Promise<NonNullable<BackupStatus['last']>> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: { store: Store; home: string; drive: OfficeDrive; work?: Work; busy?: () => boolean; age?: AgePaths | null }) {
    this.store = deps.store;
    this.home = deps.home;
    this.drive = deps.drive;
    this.work = deps.work;
    this.busy = deps.busy ?? (() => false);
    this.age = deps.age === undefined ? findAge() : deps.age;
  }

  private get state(): State {
    return this.store.getPrivate<State>('_backup', 'state') ?? { id: 'state', recipient: null, keyCreatedAt: null, last: null, lastError: null, dueSince: null };
  }

  private save(patch: Partial<State>) {
    this.store.putPrivate('_backup', { ...this.state, ...patch });
  }

  private get timeZone(): string {
    return this.store.get('settings', 'settings')?.timezone ?? 'UTC';
  }

  /** Why a backup cannot be made right now. Null when it can. */
  problem(): string | null {
    if (!this.age) return 'The age program is not installed on this Mac. Install it with “brew install age”, then restart Bureau.';
    if (!this.drive.folder) return 'Choose the office’s Drive folder first.';
    if (!this.drive.found) return 'The office’s Drive folder cannot be seen. Google Drive may not be running on this Mac.';
    if (!this.state.recipient) return 'Create a recovery key to switch backups on.';
    return null;
  }

  private archives(): { name: string; at: number }[] {
    const dir = this.drive.backups;
    if (!dir) return [];
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => NAME.test(n)).sort().map((name) => {
      let at = 0;
      try { at = fs.statSync(path.join(dir, name)).mtimeMs; } catch { /* gone */ }
      return { name, at };
    });
  }

  status(): BackupStatus {
    const st = this.state;
    const kept = this.archives();
    return {
      available: !!this.age,
      problem: this.problem(),
      folder: this.drive.backups,
      folderFound: this.drive.found,
      hasKey: !!st.recipient,
      keyCreatedAt: st.keyCreatedAt,
      keyEnding: st.recipient ? st.recipient.slice(-6) : null,
      last: st.last,
      lastError: st.lastError,
      kept: kept.length,
      oldestAt: kept[0]?.at ?? null,
      running: !!this.running,
    };
  }

  /**
   * Make the key pair. Returns the recovery key, which is the only time it exists outside the
   * owner's keeping: it is not stored, logged or kept in memory here.
   */
  createKey(replace = false): string {
    if (!this.age) throw new Error(this.problem()!);
    if (this.state.recipient && !replace) throw new Error('There is already a recovery key. Replacing it means older backups still need the old key.');
    const out = execFileSync(this.age.keygen, [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const secret = /AGE-SECRET-KEY-1[A-Z0-9]+/.exec(out)?.[0];
    const recipient = /age1[a-z0-9]{50,}/.exec(out)?.[0];
    if (!secret || !recipient) throw new Error('The key could not be made.');
    this.save({ recipient, keyCreatedAt: Date.now() });
    return secret;
  }

  /** Make a backup now. Calls that arrive while one is being made get the same one. */
  run(): Promise<NonNullable<BackupStatus['last']>> {
    this.running ??= this.make()
      .then((last) => {
        this.save({ last, lastError: null, dueSince: null });
        if (this.store.get('due', DUE_ID)) this.store.del('due', DUE_ID);
        return last;
      }, (e) => {
        this.save({ lastError: { at: Date.now(), message: (e as Error).message } });
        throw e;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  private async make(): Promise<NonNullable<BackupStatus['last']>> {
    const problem = this.problem();
    if (problem) throw new Error(problem);
    this.drive.ensure();
    const dest = this.drive.backups!;
    fs.mkdirSync(dest, { recursive: true });
    const recipient = this.state.recipient!;
    const at = Date.now();
    const name = archiveName(at, this.timeZone);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-backup-'));
    try {
      // A consistent copy of the database, taken by SQLite itself while the office keeps running.
      this.store.flushStreams();
      this.store.db.exec(`VACUUM INTO '${path.join(tmp, 'bureau.db').replace(/'/g, "''")}'`);
      fs.writeFileSync(path.join(tmp, 'backup.json'), JSON.stringify({
        format: 1, madeAt: new Date(at).toISOString(), host: os.hostname(), office: this.home, revision: this.store.rev,
        staff: this.store.list('staff').filter((s) => !s.retired).map((s) => s.name),
      }, null, 2));
      const entries = fs.readdirSync(this.home).filter((n) => !SKIP.has(n)).map((n) => `./${n}`);
      const out = path.join(tmp, name);
      // The work list allows one writer; hold its lock so beads is not mid-change while it is read.
      const pack = () => this.pack(entries, tmp, out, recipient);
      await (this.work?.available ? this.work.quiet(pack) : pack());

      const head = Buffer.alloc(21);
      const fd = fs.openSync(out, 'r');
      try { fs.readSync(fd, head, 0, 21, 0); } finally { fs.closeSync(fd); }
      if (head.toString() !== 'age-encryption.org/v1') throw new Error('The archive was not encrypted, so it was not saved.');

      const final = path.join(dest, name);
      const partial = `${final}.partial`;
      fs.copyFileSync(out, partial);
      if (sha(partial) !== sha(out)) { fs.rmSync(partial, { force: true }); throw new Error('The copy in the Backups folder does not match what was made.'); }
      fs.rmSync(final, { force: true });
      fs.renameSync(partial, final);
      this.prune(dest);
      return { at, file: name, bytes: fs.statSync(final).size };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async pack(entries: string[], tmp: string, out: string, recipient: string): Promise<void> {
    const tar = spawn('/usr/bin/tar', ['-czf', '-', '-C', this.home, ...entries, '-C', tmp, 'bureau.db', 'backup.json'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const age = spawn(this.age!.age, ['-r', recipient, '-o', out], { stdio: ['pipe', 'ignore', 'pipe'] });
    tar.stdout!.pipe(age.stdin!);
    age.stdin!.on('error', () => undefined);
    await Promise.all([finished(tar, 'Packing the office'), finished(age, 'Encrypting the archive')]);
  }

  private prune(dir: string) {
    const names = fs.readdirSync(dir).filter((n) => NAME.test(n));
    const kept = keep(names);
    for (const n of names) if (!kept.has(n)) fs.rmSync(path.join(dir, n), { force: true });
    // A copy that was interrupted part-way.
    for (const n of fs.readdirSync(dir)) if (n.endsWith('.tar.gz.age.partial')) fs.rmSync(path.join(dir, n), { force: true });
  }

  /**
   * The daily check. Makes today's backup if it has not been made, waiting up to two hours for
   * staff to finish what they are doing. When backups are switched on but have not worked for a
   * day and a half, it says so on the Desk.
   */
  async tick(now = Date.now()): Promise<void> {
    const st = this.state;
    if (!st.recipient || this.running) return;
    const tz = this.timeZone;
    const day = (t: number) => dateOf(t - DAY_STARTS, tz);
    if (st.last && day(st.last.at) === day(now)) return;

    let failure = this.problem();
    if (!failure) {
      if (this.busy() && now - (st.dueSince ?? now) < 2 * HOUR) {
        if (!st.dueSince) this.save({ dueSince: now });
        return;
      }
      try { await this.run(); return; } catch (e) { failure = (e as Error).message; }
    } else {
      this.save({ lastError: { at: now, message: failure } });
    }
    console.error('[backup]', failure);
    const since = st.last?.at ?? st.keyCreatedAt ?? now;
    if (now - since > 36 * HOUR) {
      const note = failure.length > 158 ? `${failure.slice(0, 157)}…` : failure;
      const cur = this.store.get('due', DUE_ID);
      if (!cur || cur.done || cur.note !== note) {
        this.store.put('due', { id: DUE_ID, date: dateOf(now, tz), title: 'The office is not being backed up', note, attention: true, staffId: null, done: false });
      }
    }
  }

  start() {
    if (this.timer) return;
    const go = () => { void this.tick().catch((e) => console.error('[backup]', (e as Error).message)); };
    setTimeout(go, 60_000).unref();
    this.timer = setInterval(go, 10 * 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Rebuild an office folder from one archive and the recovery key. The destination must be new or
 * empty: restoring never writes over an office.
 */
export async function restore(opts: { archive: string; dest: string; key: string; age?: AgePaths | null }): Promise<{ dest: string; manifest: Record<string, unknown> | null }> {
  const age = opts.age === undefined ? findAge() : opts.age;
  if (!age) throw new Error('The age program is not installed on this Mac. Install it with “brew install age”.');
  const key = /AGE-SECRET-KEY-1[A-Z0-9]+/.exec(opts.key.toUpperCase())?.[0];
  if (!key) throw new Error('That is not a recovery key. It starts with AGE-SECRET-KEY-1.');
  if (!fs.existsSync(opts.archive)) throw new Error(`There is no archive at ${opts.archive}.`);
  const dest = path.resolve(opts.dest);
  const existed = fs.existsSync(dest);
  if (existed && fs.readdirSync(dest).length) throw new Error(`${dest} is not empty. Restore into a new folder; nothing was written.`);
  fs.mkdirSync(dest, { recursive: true });
  try {
    const open = spawn(age.age, ['-d', '-i', '-', opts.archive], { stdio: ['pipe', 'pipe', 'pipe'] });
    const tar = spawn('/usr/bin/tar', ['-xzf', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    open.stdout!.pipe(tar.stdin!);
    tar.stdin!.on('error', () => undefined);
    open.stdin!.on('error', () => undefined);
    open.stdin!.end(`${key}\n`);
    const opened = finished(open, 'Opening the archive').catch((e) => { tar.stdin!.destroy(); throw /no identity matched|incorrect|failed to decrypt/i.test((e as Error).message) ? new Error('That recovery key does not open this archive. It may have been made with an earlier key.') : e; });
    const results = await Promise.allSettled([opened, finished(tar, 'Unpacking the archive')]);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason;
  } catch (e) {
    if (existed) for (const n of fs.readdirSync(dest)) fs.rmSync(path.join(dest, n), { recursive: true, force: true });
    else fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  let manifest: Record<string, unknown> | null = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dest, 'backup.json'), 'utf8')); } catch { /* an archive without one */ }
  return { dest, manifest };
}
