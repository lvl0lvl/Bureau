import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import type { Brief, Change, DoneItem, DueItem, Duty, Hire, Live, Row, SessionInfo, Settings, Slip, Snapshot, Staff, WorkItem } from '@shared/contract.ts';

export interface ThreadState {
  rows: Row[];
  hasMore: boolean;
  loaded: boolean;
  loadingOlder: boolean;
  /** When the thread was last closed; kept for a few minutes so going back is instant. */
  leftAt: number | null;
}

export interface State {
  phase: 'boot' | 'unpaired' | 'ready';
  conn: 'connecting' | 'live' | 'offline';
  fixtures: boolean;
  session: SessionInfo | null;
  rev: number;
  /** serverTime minus this device's clock. */
  skew: number;
  settings: Settings | null;
  staff: Record<string, Staff>;
  slips: Record<string, Slip>;
  duties: Record<string, Duty>;
  due: Record<string, DueItem>;
  done: Record<string, DoneItem>;
  /** Hiring drafts, open and recently decided. */
  hires: Record<string, Hire>;
  /** The work list: open pieces, and ones closed in the last week. */
  work: Record<string, WorkItem>;
  /** False when the office has no work list (beads is not installed). */
  workOn: boolean;
  brief: Brief | null;
  live: Record<string, Live>;
  threads: Record<string, ThreadState>;
  openThread: string | null;
  toast: string | null;
}

export const useStore = create<State>(() => ({
  phase: 'boot',
  conn: 'connecting',
  fixtures: false,
  session: null,
  rev: 0,
  skew: 0,
  settings: null,
  staff: {},
  slips: {},
  duties: {},
  due: {},
  done: {},
  hires: {},
  work: {},
  workOn: false,
  brief: null,
  live: {},
  threads: {},
  openThread: null,
  toast: null,
}));

const set = useStore.setState;
const get = useStore.getState;

export function now(): number {
  return Date.now() + get().skew;
}

function index<T extends { id: string }>(list: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of list) out[item.id] = item;
  return out;
}

// ------------------------------------------------------------------ snapshot

export function applySnapshot(s: Snapshot, opts: { cached?: boolean } = {}): void {
  const live: Record<string, Live> = {};
  if (!opts.cached) for (const l of s.live) live[l.staffId] = l;
  set((st) => ({
    phase: st.phase === 'unpaired' ? st.phase : 'ready',
    rev: s.rev,
    skew: opts.cached ? st.skew : s.serverTime - Date.now(),
    settings: s.settings,
    staff: index(s.staff),
    slips: index(s.slips),
    duties: index(s.duties),
    due: index(s.due),
    done: index(s.done),
    hires: index(s.hires ?? []),
    work: index(s.work ?? []),
    workOn: s.work !== undefined,
    brief: s.brief,
    live: opts.cached ? st.live : live,
  }));
  if (!opts.cached) scheduleCacheWrite();
}

// -------------------------------------------------------------------- deltas

function sortRows(rows: Row[]): Row[] {
  return rows.sort((a, b) => a.seq - b.seq);
}

/** A server copy of a streaming row can be behind the text we already appended locally. */
function mergeRow(prev: Row | undefined, next: Row): Row {
  if (!prev) return next;
  if (prev.body.type === 'message' && next.body.type === 'message' && next.body.streaming && prev.body.text.length > next.body.text.length && prev.body.text.startsWith(next.body.text)) {
    return { ...next, body: { ...next.body, text: prev.body.text } };
  }
  return next;
}

function upsertRow(thread: ThreadState, row: Row): ThreadState {
  let rows = thread.rows;
  const at = rows.findIndex((r) => r.id === row.id);
  if (at >= 0) {
    rows = rows.slice();
    rows[at] = mergeRow(rows[at], row);
    return { ...thread, rows };
  }
  rows = rows.slice();
  // Our own optimistic copy of a message is replaced by the server's.
  if (row.body.type === 'message' && row.body.from === 'owner') {
    const text = row.body.text;
    const tmp = rows.findIndex((r) => r.id.startsWith('tmp:') && r.body.type === 'message' && r.body.text === text);
    if (tmp >= 0) rows.splice(tmp, 1);
  }
  rows.push(row);
  return { ...thread, rows: sortRows(rows) };
}

export function applyChanges(rev: number, changes: Change[]): void {
  set((st) => {
    const next: Partial<State> = { rev: Math.max(st.rev, rev) };
    const copy = <K extends 'staff' | 'slips' | 'duties' | 'due' | 'done' | 'hires' | 'work' | 'threads'>(key: K): State[K] => {
      if (!next[key]) next[key] = { ...st[key] } as State[K];
      return next[key] as State[K];
    };
    for (const c of changes) {
      switch (c.k) {
        case 'staff': copy('staff')[c.v.id] = c.v; break;
        case 'slip': copy('slips')[c.v.id] = c.v; break;
        case 'duty': copy('duties')[c.v.id] = c.v; break;
        case 'due': copy('due')[c.v.id] = c.v; break;
        case 'done': copy('done')[c.v.id] = c.v; break;
        case 'hire': copy('hires')[c.v.id] = c.v; break;
        case 'work': copy('work')[c.v.id] = c.v; break;
        case 'brief': next.brief = c.v; break;
        case 'settings': next.settings = c.v; break;
        case 'row': {
          const threads = copy('threads');
          const t = threads[c.v.staffId];
          if (t && t.loaded) threads[c.v.staffId] = upsertRow(t, c.v);
          break;
        }
        case 'del': {
          if (c.kind === 'row') {
            const threads = copy('threads');
            for (const id of Object.keys(threads)) {
              const t = threads[id]!;
              if (t.rows.some((r) => r.id === c.id)) threads[id] = { ...t, rows: t.rows.filter((r) => r.id !== c.id) };
            }
          } else {
            const key = ({ staff: 'staff', slip: 'slips', duty: 'duties', due: 'due', done: 'done', hire: 'hires', work: 'work' } as const)[c.kind];
            const map = copy(key) as Record<string, unknown>;
            delete map[c.id];
          }
          break;
        }
      }
    }
    return next;
  });
  scheduleCacheWrite();
}

export function applyThread(staffId: string, rows: Row[], hasMore: boolean, opts: { older?: boolean } = {}): void {
  set((st) => {
    const prev = st.threads[staffId];
    const byId = new Map<string, Row>();
    if (prev) for (const r of prev.rows) byId.set(r.id, r);
    for (const r of rows) byId.set(r.id, mergeRow(byId.get(r.id), r));
    // Optimistic rows the server now has are dropped.
    const texts = new Set(rows.filter((r) => r.body.type === 'message' && r.body.from === 'owner').map((r) => (r.body as { text: string }).text));
    for (const [id, r] of byId) if (id.startsWith('tmp:') && r.body.type === 'message' && texts.has(r.body.text)) byId.delete(id);
    const merged = sortRows([...byId.values()]);
    // A fresh window only says whether there is more above *it*; keep what we knew if we already hold older rows.
    const minIncoming = rows.length ? Math.min(...rows.map((r) => r.seq)) : Infinity;
    const heldOlder = !!prev && prev.loaded && prev.rows.some((r) => r.seq < minIncoming);
    const more = opts.older || !heldOlder ? hasMore : prev!.hasMore;
    return {
      threads: { ...st.threads, [staffId]: { rows: merged, hasMore: more, loaded: true, loadingOlder: false, leftAt: prev?.leftAt ?? null } },
    };
  });
}

// Streaming text is batched to one store write per frame.
const streamBuffer = new Map<string, { staffId: string; add: string }>();
let streamFrame = 0;

export function applyStream(rowId: string, staffId: string, add: string): void {
  const held = streamBuffer.get(rowId);
  if (held) held.add += add;
  else streamBuffer.set(rowId, { staffId, add });
  if (!streamFrame) streamFrame = requestAnimationFrame(flushStream);
}

function flushStream(): void {
  streamFrame = 0;
  if (!streamBuffer.size) return;
  const batch = [...streamBuffer.entries()];
  streamBuffer.clear();
  set((st) => {
    let threads = st.threads;
    for (const [rowId, { staffId, add }] of batch) {
      const t = threads[staffId];
      if (!t) continue;
      const at = t.rows.findIndex((r) => r.id === rowId);
      if (at < 0) continue;
      const row = t.rows[at]!;
      if (row.body.type !== 'message') continue;
      const rows = t.rows.slice();
      rows[at] = { ...row, body: { ...row.body, text: row.body.text + add } };
      if (threads === st.threads) threads = { ...threads };
      threads[staffId] = { ...t, rows };
    }
    return threads === st.threads ? {} : { threads };
  });
}

export function applyLive(v: Live): void {
  set((st) => ({ live: { ...st.live, [v.staffId]: v } }));
}

export function patchThread(staffId: string, patch: Partial<ThreadState>): void {
  set((st) => {
    const t = st.threads[staffId] ?? { rows: [], hasMore: false, loaded: false, loadingOlder: false, leftAt: null };
    return { threads: { ...st.threads, [staffId]: { ...t, ...patch } } };
  });
}

export function dropThread(staffId: string): void {
  set((st) => {
    if (!st.threads[staffId] || st.openThread === staffId) return {};
    const threads = { ...st.threads };
    delete threads[staffId];
    return { threads };
  });
}

let toastTimer = 0;
export function toast(text: string): void {
  set({ toast: text });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => set({ toast: null }), 3600);
}

// --------------------------------------------------------------------- cache

const CACHE_KEY = 'bureau.cache.v1';
let cacheTimer = 0;

function scheduleCacheWrite(): void {
  if (get().fixtures || cacheTimer) return;
  cacheTimer = window.setTimeout(() => {
    cacheTimer = 0;
    const st = get();
    if (!st.settings) return;
    const snap: Snapshot = {
      protocol: 0,
      rev: st.rev,
      serverTime: now(),
      settings: st.settings,
      staff: Object.values(st.staff),
      slips: Object.values(st.slips),
      duties: Object.values(st.duties),
      due: Object.values(st.due),
      done: Object.values(st.done).sort((a, b) => b.at - a.at).slice(0, 60),
      brief: st.brief,
      live: [],
      hires: Object.values(st.hires),
      work: st.workOn ? Object.values(st.work) : undefined,
    };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(snap));
    } catch {
      /* storage full or unavailable: the cache is only a convenience */
    }
  }, 800);
}

export function readCache(): Snapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Snapshot) : null;
  } catch {
    return null;
  }
}

export function clearCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to clear */
  }
}

// ----------------------------------------------------------------- selectors

export function useStaffList(): Staff[] {
  const staff = useStore((s) => s.staff);
  return useMemo(() => Object.values(staff).filter((s) => !s.retired).sort((a, b) => a.order - b.order), [staff]);
}

/** The chief of staff first, then whoever was active most recently. The sidebar's order. */
export function useStaffByActivity(): Staff[] {
  const list = useStaffList();
  return useMemo(() => [...list].sort((a, b) => Number(b.isChief) - Number(a.isChief) || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.order - b.order), [list]);
}

/**
 * Staff in the order the owner most likely wants them: the chief of staff, then whoever is
 * waiting on the owner, then whoever is working, then the most recently active.
 */
export function useStaffByAttention(): { staff: Staff[]; waiting: Set<string> } {
  const list = useStaffList();
  const slips = useStore((s) => s.slips);
  const live = useStore((s) => s.live);
  return useMemo(() => {
    const waiting = new Set<string>();
    for (const id in slips) if (slips[id]!.status === 'pending') waiting.add(slips[id]!.staffId);
    const rank = (s: Staff) => (s.isChief ? 0 : waiting.has(s.id) ? 1 : live[s.id]?.running ? 2 : 3);
    const staff = [...list].sort((a, b) => rank(a) - rank(b) || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) || a.order - b.order);
    return { staff, waiting };
  }, [list, slips, live]);
}

export function useChief(): Staff | undefined {
  const list = useStaffList();
  return list.find((s) => s.isChief) ?? list[0];
}

export function useSlipList(): Slip[] {
  const slips = useStore((s) => s.slips);
  return useMemo(() => Object.values(slips).sort((a, b) => a.createdAt - b.createdAt), [slips]);
}

/** Hiring drafts still open, most recently changed first. */
export function useHireDrafts(): Hire[] {
  const hires = useStore((s) => s.hires);
  return useMemo(() => Object.values(hires).filter((h) => h.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt), [hires]);
}

/** The work list, oldest first. */
export function useWorkList(): WorkItem[] {
  const work = useStore((s) => s.work);
  return useMemo(() => Object.values(work).sort((a, b) => a.createdAt - b.createdAt), [work]);
}

export function useOpenWorkCount(): number {
  return useStore((s) => {
    let n = 0;
    for (const id in s.work) if (s.work[id]!.status !== 'closed') n++;
    return n;
  });
}

export function usePendingCount(): number {
  return useStore((s) => {
    let n = 0;
    for (const id in s.slips) if (s.slips[id]!.status === 'pending') n++;
    return n;
  });
}

/** A clock that ticks, corrected for the server's time. */
export function useNow(everyMs = 1000): number {
  const [t, setT] = useState(now);
  useEffect(() => {
    const id = window.setInterval(() => setT(now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return t;
}

export function useIsPhone(): boolean {
  const query = '(max-width: 859px)';
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}
