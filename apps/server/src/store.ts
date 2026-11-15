import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import type { Brief, Change, DoneItem, DueItem, Duty, Hire, Live, Row, RowBody, Settings, Slip, Snapshot, Staff, WorkItem } from '../../../shared/contract.ts';
import { PROTOCOL } from '../../../shared/contract.ts';

/**
 * Durable state and the change feed.
 *
 * Everything clients can see is a "doc" of a public kind, or a transcript row. Each write takes
 * the next global revision number and is announced to listeners, which is all the sync protocol
 * needs: a client that knows revision N asks for whatever is newer.
 *
 * Private kinds (names start with "_") hold server-only state such as device tokens and the tool
 * inputs behind a slip. They are never announced and never leave the server.
 */

export type PublicKind = 'staff' | 'slip' | 'duty' | 'due' | 'done' | 'brief' | 'settings' | 'hire' | 'work';
const PUBLIC: readonly PublicKind[] = ['staff', 'slip', 'duty', 'due', 'done', 'brief', 'settings', 'hire', 'work'];

type KindMap = { staff: Staff; slip: Slip; duty: Duty; due: DueItem; done: DoneItem; brief: Brief; settings: Settings; hire: Hire; work: WorkItem };

export type StoreEvent =
  | { type: 'changes'; rev: number; changes: Change[] }
  | { type: 'stream'; rowId: string; staffId: string; add: string };

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(7).toString('base64url')}`;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS docs (
  kind TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS docs_rev ON docs (rev);
CREATE TABLE IF NOT EXISTS rows (
  id TEXT PRIMARY KEY, staff_id TEXT NOT NULL, seq INTEGER NOT NULL, rev INTEGER NOT NULL,
  at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rows_thread ON rows (staff_id, seq);
CREATE INDEX IF NOT EXISTS rows_rev ON rows (rev);
`;

export class Store {
  readonly db: DatabaseSync;
  rev = 0;
  private docs = new Map<string, Map<string, any>>();
  private listeners = new Set<(e: StoreEvent) => void>();
  private batch: Change[] | null = null;
  /** Rows being streamed: kept in memory and saved a few times a second. */
  private streaming = new Map<string, { row: Row; dirty: boolean }>();
  private flushTimer: NodeJS.Timeout | null = null;
  private seqCache = new Map<string, number>();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'rev'").get() as { value: string } | undefined;
    this.rev = r ? Number(r.value) : 0;
    for (const row of this.db.prepare('SELECT kind, id, body FROM docs WHERE deleted = 0').all() as any[]) {
      this.kind(row.kind).set(row.id, JSON.parse(row.body));
    }
  }

  close() {
    this.flushStreams();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.db.close();
  }

  on(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: StoreEvent) {
    for (const fn of this.listeners) {
      try { fn(e); } catch (err) { console.error('[store] listener failed', err); }
    }
  }

  private kind(kind: string): Map<string, any> {
    let m = this.docs.get(kind);
    if (!m) this.docs.set(kind, (m = new Map()));
    return m;
  }

  private nextRev(): number {
    this.rev += 1;
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('rev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(this.rev));
    return this.rev;
  }

  private announce(change: Change) {
    if (this.batch) this.batch.push(change);
    else this.emit({ type: 'changes', rev: this.rev, changes: [change] });
  }

  /** Group several writes into one delta for clients. */
  transact<T>(fn: () => T): T {
    if (this.batch) return fn();
    this.batch = [];
    try {
      return fn();
    } finally {
      const changes = this.batch;
      this.batch = null;
      if (changes.length) this.emit({ type: 'changes', rev: this.rev, changes });
    }
  }

  // ------------------------------------------------------------------ docs

  get<K extends PublicKind>(kind: K, id: string): KindMap[K] | undefined {
    return this.kind(kind).get(id);
  }

  list<K extends PublicKind>(kind: K): KindMap[K][] {
    return [...this.kind(kind).values()];
  }

  put<K extends PublicKind>(kind: K, doc: Omit<KindMap[K], 'rev'> & { rev?: number }): KindMap[K] {
    const next = { ...doc, rev: this.nextRev() } as KindMap[K];
    this.kind(kind).set((next as any).id, next);
    this.db.prepare('INSERT INTO docs (kind, id, rev, deleted, body) VALUES (?, ?, ?, 0, ?) ON CONFLICT(kind, id) DO UPDATE SET rev = excluded.rev, deleted = 0, body = excluded.body')
      .run(kind, (next as any).id, next.rev, JSON.stringify(next));
    this.announce({ k: kind, v: next } as Change);
    return next;
  }

  /** Read, change and save one doc. Returns undefined when it does not exist. */
  update<K extends PublicKind>(kind: K, id: string, fn: (doc: KindMap[K]) => void): KindMap[K] | undefined {
    const cur = this.get(kind, id);
    if (!cur) return undefined;
    const copy = structuredClone(cur);
    fn(copy);
    return this.put(kind, copy);
  }

  del(kind: Exclude<PublicKind, 'brief' | 'settings'>, id: string) {
    if (!this.kind(kind).delete(id)) return;
    const rev = this.nextRev();
    this.db.prepare('UPDATE docs SET deleted = 1, rev = ? WHERE kind = ? AND id = ?').run(rev, kind, id);
    this.announce({ k: 'del', kind, id });
  }

  // ---------------------------------------------------------- private docs

  getPrivate<T = any>(kind: `_${string}`, id: string): T | undefined {
    return this.kind(kind).get(id);
  }

  listPrivate<T = any>(kind: `_${string}`): T[] {
    return [...this.kind(kind).values()];
  }

  putPrivate<T extends { id: string }>(kind: `_${string}`, doc: T): T {
    this.kind(kind).set(doc.id, doc);
    this.db.prepare('INSERT INTO docs (kind, id, rev, deleted, body) VALUES (?, ?, 0, 0, ?) ON CONFLICT(kind, id) DO UPDATE SET deleted = 0, body = excluded.body')
      .run(kind, doc.id, JSON.stringify(doc));
    return doc;
  }

  delPrivate(kind: `_${string}`, id: string) {
    this.kind(kind).delete(id);
    this.db.prepare('DELETE FROM docs WHERE kind = ? AND id = ?').run(kind, id);
  }

  // ------------------------------------------------------------------ rows

  private nextSeq(staffId: string): number {
    let seq = this.seqCache.get(staffId);
    if (seq === undefined) {
      const r = this.db.prepare('SELECT MAX(seq) AS m FROM rows WHERE staff_id = ?').get(staffId) as { m: number | null };
      seq = r.m ?? 0;
    }
    seq += 1;
    this.seqCache.set(staffId, seq);
    return seq;
  }

  appendRow(staffId: string, body: RowBody, at = Date.now()): Row {
    const row: Row = { id: newId('row'), staffId, seq: this.nextSeq(staffId), rev: this.nextRev(), at, body };
    this.db.prepare('INSERT INTO rows (id, staff_id, seq, rev, at, deleted, body) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run(row.id, staffId, row.seq, row.rev, at, JSON.stringify(body));
    this.announce({ k: 'row', v: row });
    return row;
  }

  getRow(id: string): Row | undefined {
    const s = this.streaming.get(id);
    if (s) return s.row;
    const r = this.db.prepare('SELECT * FROM rows WHERE id = ? AND deleted = 0').get(id) as any;
    return r ? toRow(r) : undefined;
  }

  updateRow(id: string, body: RowBody): Row | undefined {
    const cur = this.getRow(id);
    if (!cur) return undefined;
    const row: Row = { ...cur, body, rev: this.nextRev() };
    const s = this.streaming.get(id);
    if (s) { s.row = row; s.dirty = false; }
    this.db.prepare('UPDATE rows SET rev = ?, body = ? WHERE id = ?').run(row.rev, JSON.stringify(body), id);
    this.announce({ k: 'row', v: row });
    return row;
  }

  delRow(id: string) {
    const cur = this.getRow(id);
    if (!cur) return;
    this.streaming.delete(id);
    const rev = this.nextRev();
    this.db.prepare('UPDATE rows SET deleted = 1, rev = ? WHERE id = ?').run(rev, id);
    this.announce({ k: 'del', kind: 'row', id });
  }

  /** Start streaming text into a message row. */
  beginStream(row: Row) {
    this.streaming.set(row.id, { row, dirty: false });
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flushStreams(), 400);
      this.flushTimer.unref();
    }
  }

  /** Append text to a streaming message row. Clients get the addition at once; the row is saved on a timer. */
  streamAppend(rowId: string, add: string) {
    const s = this.streaming.get(rowId);
    if (!s || s.row.body.type !== 'message' || !add) return;
    s.row = { ...s.row, body: { ...s.row.body, text: s.row.body.text + add } };
    s.dirty = true;
    this.emit({ type: 'stream', rowId, staffId: s.row.staffId, add });
  }

  /** Save streamed text without announcing it (clients already have it). */
  flushStreams() {
    for (const s of this.streaming.values()) {
      if (!s.dirty) continue;
      s.dirty = false;
      this.db.prepare('UPDATE rows SET body = ? WHERE id = ?').run(JSON.stringify(s.row.body), s.row.id);
    }
  }

  endStream(rowId: string, body: RowBody): Row | undefined {
    const row = this.updateRow(rowId, body);
    this.streaming.delete(rowId);
    return row;
  }

  /** The newest rows of a thread, oldest first. */
  thread(staffId: string, before: number | null, limit: number): { rows: Row[]; hasMore: boolean } {
    this.flushStreams();
    const found = (before === null
      ? this.db.prepare('SELECT * FROM rows WHERE staff_id = ? AND deleted = 0 ORDER BY seq DESC LIMIT ?').all(staffId, limit + 1)
      : this.db.prepare('SELECT * FROM rows WHERE staff_id = ? AND deleted = 0 AND seq < ? ORDER BY seq DESC LIMIT ?').all(staffId, before, limit + 1)) as any[];
    const hasMore = found.length > limit;
    const rows = found.slice(0, limit).reverse().map((r) => this.streaming.get(r.id)?.row ?? toRow(r));
    return { rows, hasMore };
  }

  lastRow(staffId: string): Row | undefined {
    return this.thread(staffId, null, 1).rows[0];
  }

  // ------------------------------------------------------------------ sync

  /**
   * Everything that changed after `cursor`. Row changes are limited to the thread the client
   * has open. Returns null when the cursor is from another database and a snapshot is needed.
   */
  changesSince(cursor: number, openThread: string | null): Change[] | null {
    if (cursor > this.rev) return null;
    this.flushStreams();
    const changes: Change[] = [];
    for (const d of this.db.prepare("SELECT kind, id, deleted, body FROM docs WHERE rev > ? AND kind NOT LIKE '\\_%' ESCAPE '\\' ORDER BY rev").all(cursor) as any[]) {
      if (!PUBLIC.includes(d.kind)) continue;
      if (d.deleted) changes.push({ k: 'del', kind: d.kind, id: d.id });
      else changes.push({ k: d.kind, v: this.kind(d.kind).get(d.id) ?? JSON.parse(d.body) } as Change);
    }
    if (openThread) {
      for (const r of this.db.prepare('SELECT * FROM rows WHERE staff_id = ? AND rev > ? ORDER BY rev').all(openThread, cursor) as any[]) {
        if (r.deleted) changes.push({ k: 'del', kind: 'row', id: r.id });
        else changes.push({ k: 'row', v: this.streaming.get(r.id)?.row ?? toRow(r) });
      }
    }
    return changes;
  }

  snapshot(live: Live[]): Snapshot {
    const weekAgo = Date.now() - 7 * 86_400_000;
    const dayAgo = Date.now() - 36 * 3_600_000;
    return {
      protocol: PROTOCOL,
      rev: this.rev,
      serverTime: Date.now(),
      settings: this.get('settings', 'settings')!,
      staff: this.list('staff').sort((a, b) => a.order - b.order),
      slips: this.list('slip').filter((s) => s.status === 'pending' || s.status === 'signing' || (s.decidedAt ?? s.createdAt) > weekAgo),
      duties: this.list('duty'),
      due: this.list('due').filter((d) => !d.done),
      done: this.list('done').filter((d) => d.at > dayAgo).sort((a, b) => b.at - a.at).slice(0, 60),
      brief: this.get('brief', 'brief') ?? null,
      live,
      work: this.list('work').filter((w) => w.status !== 'closed' || (w.closedAt ?? 0) > weekAgo).sort((a, b) => a.createdAt - b.createdAt),
      hires: this.list('hire').filter((h) => h.status === 'draft' || (h.decidedAt ?? h.updatedAt) > weekAgo).sort((a, b) => a.createdAt - b.createdAt),
    };
  }
}

function toRow(r: any): Row {
  return { id: r.id, staffId: r.staff_id, seq: r.seq, rev: r.rev, at: r.at, body: JSON.parse(r.body) };
}
