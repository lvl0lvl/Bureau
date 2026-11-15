import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkItem } from '../../../shared/contract.ts';
import type { Store } from './store.ts';

/**
 * Work that outlives one exchange, kept in beads (`bd`, https://github.com/gastownhall/beads).
 *
 * Beads holds the truth: the items, what waits on what, who has claimed what. It lives in its
 * own folder, `<office>/work`, so the owner can also run `bd ready` or `bd list` there from a
 * terminal. This class is the only part of the office that talks to it. Beads' default mode
 * allows one writer at a time, so every call goes through one queue.
 *
 * After each change the items are copied into the office's own store, which is what the
 * interface and the staff tools read. What beads does not know (how many hand-ons deep an item
 * is, and what outside material its opener had read) is kept beside that copy.
 */

export const MAX_WORK_DEPTH = 3;
const KEEP_CLOSED_MS = 14 * 86_400_000;

interface Bead {
  id: string;
  title: string;
  description?: string;
  notes?: string;
  status: string;
  assignee?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  dependencies?: { issue_id: string; depends_on_id: string; type: string }[];
}

interface Extra { id: string; depth: number; read: string[] }

export type WorkEvent =
  /** An open item that someone holds has nothing left to wait on. */
  | { type: 'ready'; item: WorkItem; depth: number; why: 'assigned' | 'released' }
  | { type: 'closed'; item: WorkItem; by: string };

export function findBd(): string | null {
  const given = process.env.BUREAU_BD_PATH;
  if (given) return fs.existsSync(given) ? given : null;
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const full = path.join(d, 'bd');
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* keep looking */ }
  }
  return null;
}

export class Work {
  private store: Store;
  readonly dir: string;
  private bdPath: string | null;
  private queue: Promise<unknown> = Promise.resolve();
  private started: Promise<boolean> | null = null;
  private listeners = new Set<(e: WorkEvent) => void>();
  /** Why work is unavailable, for the interface. */
  problem: string | null = null;

  constructor(deps: { store: Store; dir: string; bdPath?: string | null }) {
    this.store = deps.store;
    this.dir = deps.dir;
    this.bdPath = deps.bdPath === undefined ? findBd() : deps.bdPath;
    if (!this.bdPath) this.problem = 'Beads (the bd program) is not installed on this Mac.';
  }

  /** Whether beads is installed. Staff are only told about the work list when it is. */
  get available(): boolean { return !!this.bdPath && !this.failed; }
  private failed = false;

  on(fn: (e: WorkEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: WorkEvent) {
    for (const fn of this.listeners) {
      try { fn(e); } catch (err) { console.error('[work] listener failed', err); }
    }
  }

  // ------------------------------------------------------------- beads

  /** One bd call. Callers hold the lock (see `locked`). */
  private bd(actor: string, args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      execFile(this.bdPath!, ['--actor', actor, ...args, '--json'], {
        cwd: this.dir, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, BD_NON_INTERACTIVE: '1', NO_COLOR: '1' },
      }, (err, stdout, stderr) => {
        if (err) {
          let message = (stderr || err.message).trim().split('\n').filter(Boolean)[0] ?? 'bd failed';
          try { message = JSON.parse(stdout).failed?.[0]?.error ?? JSON.parse(stdout).error ?? message; } catch { /* keep the first line */ }
          return reject(new Error(String(message).replace(/^Error[^:]*:\s*/i, '')));
        }
        try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch { resolve(null); }
      });
    });
  }

  /**
   * One whole operation at a time: the change and the copy that follows it. Without this, one
   * person closing a piece of work could slip between another person creating an item and
   * saying what it waits on, and the release would be missed.
   */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Run something while nothing is writing to the work list, such as copying its folder. */
  quiet<T>(fn: () => Promise<T>): Promise<T> {
    return this.locked(fn);
  }

  /** Create the beads folder on first use. Resolves false when beads cannot be used. */
  ready(): Promise<boolean> {
    if (!this.bdPath) return Promise.resolve(false);
    this.started ??= (async () => {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        if (!fs.existsSync(path.join(this.dir, '.beads'))) {
          await new Promise<void>((resolve, reject) => {
            execFile(this.bdPath!, ['init', '--prefix', 'job', '--non-interactive', '--skip-agents', '--skip-hooks', '--init-if-missing'], {
              cwd: this.dir, timeout: 120_000, env: { ...process.env, BD_NON_INTERACTIVE: '1', NO_COLOR: '1' },
            }, (err, _out, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-1)[0])) : resolve()));
          });
        }
        await this.locked(() => this.copy());
        return true;
      } catch (e) {
        this.failed = true;
        this.problem = `Beads could not be started: ${(e as Error).message}`;
        console.error('[work]', this.problem);
        return false;
      }
    })();
    return this.started;
  }

  // -------------------------------------------------------------- copy

  private extra(id: string): Extra {
    return this.store.getPrivate<Extra>('_workx', id) ?? { id, depth: 0, read: [] };
  }

  private toItem(b: Bead, readyIds: Set<string>, prev: WorkItem | undefined): Omit<WorkItem, 'rev'> {
    const status: WorkItem['status'] = b.status === 'closed' ? 'closed' : b.status === 'in_progress' || b.status === 'hooked' ? 'in_progress' : 'open';
    const staff = b.assignee && this.store.get('staff', b.assignee) ? b.assignee : null;
    return {
      id: b.id, title: b.title, detail: b.description ?? '', notes: b.notes ?? '', status,
      ready: status === 'open' && readyIds.has(b.id),
      staffId: staff,
      createdBy: b.created_by && (b.created_by === 'owner' || this.store.get('staff', b.created_by)) ? b.created_by : prev?.createdBy ?? 'owner',
      after: (b.dependencies ?? []).filter((d) => d.type === 'blocks' && d.issue_id === b.id).map((d) => d.depends_on_id),
      result: status === 'closed' ? b.close_reason ?? '' : null,
      read: this.extra(b.id).read,
      createdAt: Date.parse(b.created_at) || prev?.createdAt || Date.now(),
      updatedAt: Date.parse(b.updated_at) || Date.now(),
      closedAt: b.closed_at ? Date.parse(b.closed_at) : null,
    };
  }

  /**
   * Copy beads into the office's store. Returns the items that became ready in this pass, which
   * is how closing one piece of work releases the next.
   */
  private async copy(): Promise<WorkItem[]> {
    if (!this.bdPath || this.failed) return [];
    const all = await this.bd('bureau', ['list', '--all', '--limit', '0', '--flat']);
    const ready = await this.bd('bureau', ['ready', '--limit', '0']);
    const beads: Bead[] = Array.isArray(all) ? all : all?.issues ?? [];
    const readyIds = new Set<string>((Array.isArray(ready) ? ready : ready?.issues ?? []).map((b: Bead) => b.id));
    const cutoff = Date.now() - KEEP_CLOSED_MS;
    const seen = new Set<string>();
    const released: WorkItem[] = [];
    this.store.transact(() => {
      for (const b of beads) {
        const prev = this.store.get('work', b.id);
        const next = this.toItem(b, readyIds, prev);
        if (next.status === 'closed' && (next.closedAt ?? 0) < cutoff) continue;
        seen.add(b.id);
        const { rev: _rev, ...before } = prev ?? ({} as WorkItem);
        if (prev && JSON.stringify(before) === JSON.stringify(next)) continue;
        const saved = this.store.put('work', next);
        if (saved.ready && prev && !prev.ready && prev.status === 'open') released.push(saved);
      }
      for (const w of this.store.list('work')) if (!seen.has(w.id)) this.store.del('work', w.id);
    });
    return released;
  }

  /** Pick up changes made outside the office (for example with bd in a terminal). */
  async refresh(): Promise<void> {
    if (!(await this.ready())) return;
    for (const item of await this.locked(() => this.copy())) if (item.staffId) this.emit({ type: 'ready', item, depth: this.extra(item.id).depth, why: 'released' });
  }

  list(): WorkItem[] {
    return this.store.list('work').sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): WorkItem | undefined {
    return this.store.get('work', id.trim());
  }

  /** A few lines for the top of someone's next piece of work. Empty when they have nothing open. */
  summaryFor(staffId: string): string {
    const mine = this.list().filter((w) => w.staffId === staffId && w.status !== 'closed');
    if (!mine.length) return '';
    const line = (w: WorkItem) => {
      const waits = w.after.filter((id) => this.get(id)?.status !== 'closed');
      const state = w.status === 'in_progress' ? 'in progress' : waits.length ? `waiting on ${waits.join(', ')}` : 'ready';
      return `${w.id} “${w.title}” (${state})`;
    };
    const shown = mine.slice(0, 6).map(line).join('; ');
    return `Your open work: ${shown}${mine.length > 6 ? `; and ${mine.length - 6} more (list_work)` : ''}.`;
  }

  // ----------------------------------------------------------- changes

  private async after<T>(fn: () => Promise<T>): Promise<T> {
    if (!(await this.ready())) throw new Error(this.problem ?? 'The work list is not available.');
    const { out, released } = await this.locked(async () => ({ out: await fn(), released: await this.copy() }));
    for (const item of released) if (item.staffId) this.emit({ type: 'ready', item, depth: this.extra(item.id).depth, why: 'released' });
    return out;
  }

  /** Open a piece of work. `by` is a staff id or "owner". */
  async add(by: string, input: { title: string; detail?: string; staffId?: string | null; after?: string[]; depth?: number; read?: string[]; start?: boolean }): Promise<WorkItem> {
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new Error('A piece of work needs a title.');
    const waits = [...new Set(input.after ?? [])];
    for (const id of waits) if (!this.get(id)) throw new Error(`There is no work item ${id}.`);
    let id = '';
    await this.after(async () => {
      const args = ['create', title];
      if (input.detail?.trim()) args.push('-d', input.detail.trim().slice(0, 6000));
      if (input.staffId) args.push('--assignee', input.staffId);
      const made = await this.bd(by, args);
      id = String(made?.id ?? '');
      if (!id) throw new Error('Beads did not return an id for the new item.');
      this.store.putPrivate<Extra>('_workx', { id, depth: input.depth ?? 0, read: input.read ?? [] });
      for (const dep of waits) await this.bd(by, ['dep', 'add', id, dep]);
    });
    const item = this.get(id)!;
    // Someone else's work that can start now is started. Work a person opens for themselves is
    // theirs to pick up; it shows at the top of their next piece of work.
    if (item.ready && item.staffId && item.staffId !== by && input.start !== false) {
      this.emit({ type: 'ready', item, depth: this.extra(id).depth, why: 'assigned' });
    }
    return item;
  }

  /** Take an item. Beads makes this atomic: a second claimant is refused. */
  async claim(by: string, id: string): Promise<WorkItem> {
    const item = this.get(id);
    if (!item) throw new Error(`There is no work item ${id}.`);
    if (item.status === 'closed') throw new Error('That work is already closed.');
    if (item.staffId && item.staffId !== by) throw new Error(`That work belongs to ${this.store.get('staff', item.staffId)?.name ?? item.staffId}.`);
    if (item.status === 'open' && !item.ready) throw new Error(`That work is waiting on ${item.after.filter((a) => this.get(a)?.status !== 'closed').join(', ')}.`);
    await this.after(() => this.bd(by, ['update', item.id, '--claim']));
    return this.get(item.id)!;
  }

  async note(by: string, id: string, text: string): Promise<WorkItem> {
    const item = this.get(id);
    if (!item) throw new Error(`There is no work item ${id}.`);
    const who = by === 'owner' ? this.store.get('settings', 'settings')!.ownerName : this.store.get('staff', by)?.name ?? by;
    await this.after(() => this.bd(by, ['update', item.id, '--append-notes', `${who}: ${text.trim().slice(0, 2000)}`]));
    return this.get(item.id)!;
  }

  async assign(by: string, id: string, staffId: string | null): Promise<WorkItem> {
    const item = this.get(id);
    if (!item) throw new Error(`There is no work item ${id}.`);
    if (item.status === 'closed') throw new Error('That work is already closed.');
    if (staffId && !this.store.get('staff', staffId)) throw new Error('No such member of staff.');
    await this.after(async () => {
      // Giving it to someone else takes it out of the first person's hands.
      if (item.status === 'in_progress') await this.bd(by, ['update', item.id, '--status', 'open']);
      await this.bd(by, ['update', item.id, '--assignee', staffId ?? '']);
    });
    const next = this.get(item.id)!;
    if (next.ready && next.staffId && next.staffId !== by) this.emit({ type: 'ready', item: next, depth: this.extra(next.id).depth, why: 'assigned' });
    return next;
  }

  async close(by: string, id: string, result: string): Promise<WorkItem> {
    const item = this.get(id);
    if (!item) throw new Error(`There is no work item ${id}.`);
    if (item.status === 'closed') throw new Error('That work is already closed.');
    // Beads lets only the holder close claimed work. The office has already decided who may
    // (the holder, the opener, the chief of staff or the owner), so the others close it by force.
    const args = ['close', item.id, '--reason', result.trim().slice(0, 2000) || 'Done'];
    if (item.staffId && item.staffId !== by) args.push('--force');
    await this.after(() => this.bd(by, args));
    const next = this.get(item.id)!;
    this.emit({ type: 'closed', item: next, by });
    return next;
  }

  async reopen(by: string, id: string): Promise<WorkItem> {
    const item = this.get(id);
    if (!item) throw new Error(`There is no work item ${id}.`);
    if (item.status !== 'closed') return item;
    await this.after(() => this.bd(by, ['reopen', item.id]));
    return this.get(item.id)!;
  }
}
