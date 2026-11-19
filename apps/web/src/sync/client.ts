import { PROTOCOL } from '@shared/contract.ts';
import type { Artifact, ArtifactNote, BackupStatus, BooksCommit, BooksEntry, CatalogPage, CatalogSkillDetail, CatalogSource, Device, DriveStatus, DueItem, DutyRun, EngineInfo, Duty, Hire, InstalledSkill, Level, PlanUsage, ReachInfo, Row, ServerMsg, SessionInfo, Settings, Slip, Snapshot, Staff, ThreadPage, UsageSummary, WeekReport, WorkItem } from '@shared/contract.ts';
import { applyChanges, applyLive, applySnapshot, applyStream, applyThread, clearCache, dropThread, now, patchThread, readCache, toast, useStore } from './store.ts';
export interface PushInfo {
  publicKey?: string;
  web: number;
  apns: number;
  apnsConfigured: boolean;
}

import { HttpError, httpTransport, type Socket, type Transport } from './transport.ts';

const FIXTURE_KEY = 'bureau.fixtures';
const THREAD_KEEP_MS = 5 * 60_000;

let transport: Transport = httpTransport;
let socket: Socket | null = null;
let socketOpen = false;
let attempt = 0;
let retryTimer = 0;
let stableTimer = 0;
let pingSeq = 0;
let awaitingPong = 0;
let pongTimer = 0;
let booted = false;

const set = useStore.setState;
const get = useStore.getState;

function fixtureQuery(): string | null {
  const q = new URLSearchParams(location.search);
  if (q.has('fixtures')) {
    sessionStorage.setItem(FIXTURE_KEY, location.search);
    return location.search;
  }
  if (q.has('live')) {
    sessionStorage.removeItem(FIXTURE_KEY);
    return null;
  }
  return sessionStorage.getItem(FIXTURE_KEY);
}

// ---------------------------------------------------------------------- boot

export async function boot(): Promise<void> {
  if (booted) return;
  booted = true;

  const fx = fixtureQuery();
  if (fx !== null) {
    const { createFixtures } = await import('./fixtures.ts');
    transport = createFixtures(new URLSearchParams(fx));
    set({ fixtures: true });
  } else {
    const cached = readCache();
    if (cached) applySnapshot(cached, { cached: true });
  }

  window.addEventListener('online', () => wake());
  window.addEventListener('pageshow', () => wake());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake();
  });

  await start();
}

async function start(): Promise<void> {
  let session: SessionInfo;
  try {
    session = await transport.http<SessionInfo>('GET', '/session');
  } catch {
    // The server cannot be reached. Whatever the cache painted stays on screen.
    set((st) => ({ conn: 'offline', phase: st.phase === 'boot' && !st.settings ? 'boot' : st.phase }));
    scheduleRetry(() => void start());
    return;
  }
  set({ session });
  if (!session.paired) {
    clearCache();
    set({ phase: 'unpaired', conn: 'offline' });
    return;
  }
  if (get().phase === 'unpaired') set({ phase: 'boot' });
  try {
    applySnapshot(await transport.http<Snapshot>('GET', '/snapshot'));
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      set({ phase: 'unpaired', conn: 'offline' });
      return;
    }
  }
  connect();
}

// -------------------------------------------------------------------- socket

function connect(): void {
  clearTimeout(retryTimer);
  retryTimer = 0;
  socket?.close();
  socketOpen = false;
  set({ conn: get().conn === 'live' ? 'connecting' : get().conn === 'offline' ? 'offline' : 'connecting' });

  const mine = transport.socket({
    onOpen() {
      if (socket !== mine) return;
      socketOpen = true;
      const st = get();
      mine.send({ t: 'hello', protocol: PROTOCOL, cursor: st.rev || null, thread: st.openThread });
      if (st.openThread) mine.send({ t: 'open', staffId: st.openThread });
      set({ conn: 'live' });
      // Only a connection that stays up resets the backoff.
      clearTimeout(stableTimer);
      stableTimer = window.setTimeout(() => (attempt = 0), 10_000);
    },
    onMessage(msg) {
      if (socket !== mine) return;
      receive(msg);
    },
    onClose() {
      if (socket !== mine) return;
      socketOpen = false;
      socket = null;
      clearTimeout(stableTimer);
      clearTimeout(pongTimer);
      awaitingPong = 0;
      set({ conn: 'offline' });
      scheduleRetry(connect);
    },
  });
  socket = mine;
}

function scheduleRetry(fn: () => void): void {
  if (retryTimer) return;
  const base = Math.min(30_000, 500 * 2 ** attempt);
  attempt = Math.min(attempt + 1, 8);
  const delay = base * (0.5 + Math.random());
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    if (!navigator.onLine && transport.kind === 'http') {
      scheduleRetry(fn);
      return;
    }
    fn();
  }, delay);
}

/** The tab came back, or the network did. Check the socket is really alive; replace it if not. */
function wake(): void {
  const st = get();
  if (st.phase === 'unpaired') return;
  if (st.phase === 'boot' || !st.session) {
    clearTimeout(retryTimer);
    retryTimer = 0;
    void start();
    return;
  }
  if (!socket || !socketOpen) {
    attempt = 0;
    connect();
    return;
  }
  if (awaitingPong) return;
  const n = ++pingSeq;
  awaitingPong = n;
  socket.send({ t: 'ping', n });
  clearTimeout(pongTimer);
  pongTimer = window.setTimeout(() => {
    if (awaitingPong !== n) return;
    awaitingPong = 0;
    attempt = 0;
    connect();
  }, 3000);
}

function receive(msg: ServerMsg): void {
  switch (msg.t) {
    case 'snapshot':
      applySnapshot(msg.snapshot);
      break;
    case 'delta':
      applyChanges(msg.rev, msg.changes);
      markSeenIfWatching(msg.changes.some((c) => c.k === 'row' && c.v.staffId === get().openThread));
      break;
    case 'thread':
      applyThread(msg.staffId, msg.rows, msg.hasMore);
      markSeenIfWatching(msg.staffId === get().openThread);
      break;
    case 'stream':
      applyStream(msg.rowId, msg.staffId, msg.add);
      break;
    case 'live':
      applyLive(msg.v);
      break;
    case 'pong':
      if (msg.n === awaitingPong) {
        awaitingPong = 0;
        clearTimeout(pongTimer);
      }
      set({ skew: msg.serverTime - Date.now() });
      break;
  }
}

function markSeenIfWatching(relevant: boolean): void {
  const id = get().openThread;
  if (relevant && id && document.visibilityState === 'visible') socket?.send({ t: 'seen', staffId: id });
}

// ------------------------------------------------------------------- threads

const evictions = new Map<string, number>();

export function openThread(staffId: string): void {
  const st = get();
  if (st.openThread === staffId) return;
  clearTimeout(evictions.get(staffId));
  evictions.delete(staffId);
  if (st.openThread) leaveThread(st.openThread);
  set({ openThread: staffId });
  if (!st.threads[staffId]) patchThread(staffId, {});
  else patchThread(staffId, { leftAt: null });
  if (socketOpen) {
    socket!.send({ t: 'open', staffId });
    socket!.send({ t: 'seen', staffId });
  } else {
    // No socket yet: fetch the window over HTTP so the thread still opens.
    transport
      .http<ThreadPage>('GET', `/threads/${encodeURIComponent(staffId)}?limit=60`)
      .then((page) => applyThread(staffId, page.rows, page.hasMore))
      .catch(() => undefined);
  }
}

function leaveThread(staffId: string): void {
  patchThread(staffId, { leftAt: Date.now() });
  clearTimeout(evictions.get(staffId));
  evictions.set(staffId, window.setTimeout(() => dropThread(staffId), THREAD_KEEP_MS));
}

export function closeThread(staffId: string): void {
  if (get().openThread !== staffId) return;
  set({ openThread: null });
  leaveThread(staffId);
  socket?.send({ t: 'close' });
}

export async function loadOlder(staffId: string): Promise<void> {
  const t = get().threads[staffId];
  if (!t || !t.hasMore || t.loadingOlder || !t.rows.length) return;
  patchThread(staffId, { loadingOlder: true });
  const before = t.rows.find((r) => !r.id.startsWith('tmp:'))?.seq ?? t.rows[0]!.seq;
  try {
    const page = await transport.http<ThreadPage>('GET', `/threads/${encodeURIComponent(staffId)}?before=${before}&limit=60`);
    applyThread(staffId, page.rows, page.hasMore, { older: true });
  } catch {
    patchThread(staffId, { loadingOlder: false });
    toast('Could not load earlier messages.');
  }
}

// ------------------------------------------------------------------ commands

async function command<T>(run: () => Promise<T>, undo?: () => void): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    undo?.();
    toast(err instanceof Error && err.message ? err.message : 'That did not go through. Try again.');
    return undefined;
  }
}

function patchSlip(id: string, patch: Partial<Slip>): () => void {
  const prev = get().slips[id];
  if (!prev) return () => undefined;
  set((st) => ({ slips: { ...st.slips, [id]: { ...prev, ...patch } } }));
  return () => set((st) => (st.slips[id] && st.slips[id]!.rev === prev.rev ? { slips: { ...st.slips, [id]: prev } } : {}));
}

function list<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

/** A reply to our own change may arrive before the socket's copy; never let an older one win. */
function applyHire(hire: Hire): void {
  set((st) => ((st.hires[hire.id]?.rev ?? -1) > hire.rev ? {} : { hires: { ...st.hires, [hire.id]: hire } }));
}

function applyWork(item: WorkItem): void {
  set((st) => ((st.work[item.id]?.rev ?? -1) > item.rev ? {} : { work: { ...st.work, [item.id]: item } }));
}

/** One change to the work list. The answer carries the item as it now stands. */
function workCommand(path: string, body?: unknown): Promise<WorkItem | undefined> {
  return command(async () => {
    const res = await transport.http<{ item?: WorkItem }>('POST', path, body ?? {});
    if (res?.item) applyWork(res.item);
    return res?.item;
  });
}

export interface WorkInput {
  title: string;
  detail?: string;
  staffId?: string | null;
  after?: string[];
  start?: boolean;
}

/** The work list as the server has it, with where it is kept and why it is off when it is. */
export interface WorkPageInfo {
  available: boolean;
  problem: string | null;
  folder: string | null;
  items: WorkItem[];
}

let tmpSeq = 0;

export const api = {
  async pair(code: string, label: string): Promise<string | null> {
    try {
      await transport.http('POST', '/pair', { code: code.trim().toUpperCase(), label });
    } catch (err) {
      return err instanceof Error ? err.message : 'That code did not work.';
    }
    set({ phase: 'boot' });
    await start();
    return null;
  },

  /** `hire` is passed only from the hiring desk: the open draft's id, or null when there is none yet. */
  /** Hold a file on the office's Mac until the message it goes with is sent. */
  async upload(file: File): Promise<{ id: string; name: string; bytes: number }> {
    if (transport.kind !== 'http') {
      const held = { id: `up_sample${++tmpSeq}`, name: file.name, bytes: file.size };
      (await import('./fixtures.ts')).sampleUploads.set(held.id, { name: held.name, bytes: held.bytes });
      return held;
    }
    const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
    const data = await res.json().catch(() => null) as { id?: string; name?: string; bytes?: number; error?: string } | null;
    if (!res.ok || !data?.id) throw new HttpError(res.status, data?.error || 'The file could not be sent.');
    return { id: data.id, name: data.name ?? file.name, bytes: data.bytes ?? file.size };
  },

  /**
   * Put a photo in "Drop here" in the office Drive folder, where the chief of staff picks it up.
   * `watched` is false when the office is not handing that folder to anyone. Fails with 409 when
   * the folder cannot be seen, and with 404 on an office that has not been restarted since this
   * was added; the caller then sends the photo as an attachment instead.
   */
  async drop(file: File): Promise<{ name: string; bytes: number; watched: boolean }> {
    if (transport.kind !== 'http') return { name: file.name, bytes: file.size, watched: true };
    const res = await fetch(`/api/drop?name=${encodeURIComponent(file.name)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: file });
    const data = await res.json().catch(() => null) as { name?: string; bytes?: number; watched?: boolean; error?: string } | null;
    // An answer that is not the office's own (an older office serving the page instead) counts as "not there".
    if (!res.ok || !data?.name) throw new HttpError(res.ok ? 404 : res.status, data?.error || 'The photo could not be sent.');
    return { name: data.name, bytes: data.bytes ?? file.size, watched: data.watched !== false };
  },

  sendMessage(staffId: string, text: string, opts: { hire?: string | null; files?: { id: string; name: string; bytes: number }[] } = {}): Promise<unknown> {
    const body = text.trim();
    const files = opts.files ?? [];
    if (!body && !files.length) return Promise.resolve();
    const st = get();
    const thread = st.threads[staffId];
    const id = `tmp:${++tmpSeq}`;
    if (thread?.loaded) {
      const last = thread.rows[thread.rows.length - 1];
      const row: Row = { id, staffId, seq: (last?.seq ?? 0) + 0.5, rev: 0, at: now(), body: { type: 'message', from: 'owner', text: body, ...(files.length ? { files: files.map((f) => ({ name: f.name, bytes: f.bytes })) } : {}) } };
      patchThread(staffId, { rows: [...thread.rows, row] });
    }
    return command(
      async () => {
        const res = await transport.http<{ row?: Row } | null>('POST', `/threads/${encodeURIComponent(staffId)}/messages`, { text: body, clientId: id, ...(opts.hire === undefined ? {} : { hire: opts.hire }), ...(files.length ? { files: files.map((f) => f.id) } : {}) });
        if (res && res.row) applyThread(staffId, [res.row], get().threads[staffId]?.hasMore ?? false);
      },
      () => {
        const t = get().threads[staffId];
        if (t) patchThread(staffId, { rows: t.rows.filter((r) => r.id !== id) });
      },
    );
  },

  stop: (staffId: string) => command(() => transport.http('POST', `/threads/${encodeURIComponent(staffId)}/stop`)),
  newConversation: (staffId: string) => command(() => transport.http('POST', `/threads/${encodeURIComponent(staffId)}/new`)),

  /** Sign a slip. `items` names the items of a batch that are signed. */
  sign(slipId: string, text?: string, items?: number[]) {
    const undoSeconds = get().settings?.undoSeconds ?? 0;
    const undo = patchSlip(slipId, { status: 'signing', commitAt: now() + undoSeconds * 1000, decidedAt: now() });
    return command(() => transport.http('POST', `/slips/${slipId}/sign`, { ...(text === undefined ? {} : { text }), ...(items ? { items } : {}) }), undo);
  },
  undo(slipId: string) {
    const undo = patchSlip(slipId, { status: 'pending', commitAt: undefined, decidedAt: undefined });
    return command(() => transport.http('POST', `/slips/${slipId}/undo`), undo);
  },
  decline(slipId: string, reason?: string) {
    const undo = patchSlip(slipId, { status: 'declined', decidedAt: now(), declineReason: reason || undefined });
    return command(() => transport.http('POST', `/slips/${slipId}/decline`, reason ? { reason } : {}), undo);
  },
  answer(slipId: string, answer: string) {
    const undo = patchSlip(slipId, { status: 'signed', decidedAt: now(), answer });
    return command(() => transport.http('POST', `/slips/${slipId}/answer`, { answer }), undo);
  },

  setAuthority(staffId: string, classId: string, level: Level) {
    const prev = get().staff[staffId];
    if (!prev) return Promise.resolve(undefined);
    set((st) => ({ staff: { ...st.staff, [staffId]: { ...prev, authority: { ...prev.authority, [classId]: level } } } }));
    return command(
      () => transport.http('PUT', `/staff/${staffId}/authority`, { classId, level }),
      () => set((st) => ({ staff: { ...st.staff, [staffId]: prev } })),
    );
  },

  saveStaff: (id: string, patch: Partial<Staff>) => command(() => transport.http('PUT', `/staff/${id}`, patch)),
  hire: (data: Partial<Staff>) => command(() => transport.http<{ id?: string; staff?: Staff } | null>('POST', '/staff', data)),
  retire: (id: string) => command(() => transport.http('DELETE', `/staff/${id}`)),

  // Skills belong to one person. The store hears about the change through the staff record.
  installSkill: (staffId: string, ref: string) => command(() => transport.http<{ skill: InstalledSkill; staff?: Staff }>('POST', `/staff/${staffId}/skills`, { ref })),
  removeSkill: (staffId: string, skillId: string) => command(() => transport.http('DELETE', `/staff/${staffId}/skills/${encodeURIComponent(skillId)}`)),
  briefing: (staffId: string) => transport.http<{ text: string; folder: string }>('GET', `/staff/${staffId}/briefing`),

  catalog(q = '', opts: { limit?: number; source?: string } = {}): Promise<CatalogPage> {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.source) params.set('source', opts.source);
    const qs = params.toString();
    return transport.http<CatalogPage>('GET', `/catalog${qs ? `?${qs}` : ''}`);
  },
  catalogSkill: (id: string) => transport.http<CatalogSkillDetail>('GET', `/catalog/skill?id=${encodeURIComponent(id)}`),
  /** Fetches from GitHub. Only ever called because a button was pressed. */
  catalogRefresh: (source?: string) => command(() => transport.http<{ sources: CatalogSource[] }>('POST', '/catalog/refresh', source ? { source } : {})),
  catalogAddSource: (repo: string) => command(() => transport.http<{ sources: CatalogSource[] }>('POST', '/catalog/sources', { repo })),
  catalogRemoveSource: (id: string) => command(() => transport.http<{ sources: CatalogSource[] }>('DELETE', `/catalog/sources/${encodeURIComponent(id)}`)),

  saveHire(id: string, patch: Record<string, unknown>) {
    return command(async () => {
      const res = await transport.http<{ hire?: Hire }>('PUT', `/hires/${id}`, patch);
      if (res?.hire) applyHire(res.hire);
      return res;
    });
  },
  signHire: (id: string, patch: Record<string, unknown> = {}) =>
    command(async () => {
      const res = await transport.http<{ hire: Hire; staff: Staff }>('POST', `/hires/${id}/sign`, patch);
      if (res?.hire) applyHire(res.hire);
      if (res?.staff) set((st) => ({ staff: { ...st.staff, [res.staff.id]: res.staff } }));
      return res;
    }),
  dropHire: (id: string) =>
    command(async () => {
      const res = await transport.http<{ hire?: Hire }>('DELETE', `/hires/${id}`);
      if (res?.hire) applyHire(res.hire);
      return res;
    }),

  // The work list (beads). The store hears about every change through the socket as well.
  async workPage(): Promise<WorkPageInfo> {
    const res = await transport.http<Partial<WorkPageInfo>>('GET', '/work');
    const page: WorkPageInfo = { available: !!res?.available, problem: res?.problem ?? null, folder: res?.folder ?? null, items: res?.items ?? [] };
    for (const item of page.items) applyWork(item);
    if (page.available !== get().workOn) set({ workOn: page.available });
    return page;
  },
  addWork: (input: WorkInput) => workCommand('/work', input),
  closeWork: (id: string, result: string) => workCommand(`/work/${encodeURIComponent(id)}/close`, { result }),
  reopenWork: (id: string) => workCommand(`/work/${encodeURIComponent(id)}/reopen`),
  noteWork: (id: string, text: string) => workCommand(`/work/${encodeURIComponent(id)}/note`, { text }),
  assignWork: (id: string, staffId: string | null) => workCommand(`/work/${encodeURIComponent(id)}/assign`, { staffId }),
  /** Looks at beads again, for changes made with bd in a terminal. */
  syncWork: () =>
    command(async () => {
      const res = await transport.http<{ available: boolean; items?: WorkItem[] }>('POST', '/work/sync', {});
      for (const item of res?.items ?? []) applyWork(item);
      return res;
    }),

  // The office's folder in Google Drive, and the nightly backups that go into it.
  driveStatus: () => transport.http<DriveStatus>('GET', '/drive'),
  parkDrop: (folder: string, on: boolean) => command(() => transport.http<{ drive: DriveStatus }>('POST', '/drop/park', { folder, on })),
  chooseDrive: (folder: string | null) => command(() => transport.http<{ drive: DriveStatus; backup: BackupStatus }>('PUT', '/drive', { folder })),
  backupStatus: () => transport.http<BackupStatus>('GET', '/backup'),
  /** The answer carries the recovery key, once. Callers keep it in a dialog's own state and nowhere else. */
  createBackupKey: (replace = false) => command(() => transport.http<{ recoveryKey: string; status: BackupStatus }>('POST', '/backup/key', replace ? { replace: true } : {})),
  runBackup: () => command(() => transport.http<{ status: BackupStatus }>('POST', '/backup/run', {})),

  addDuty: (data: Partial<Duty>) => command(() => transport.http('POST', '/duties', data)),
  saveDuty: (id: string, patch: Partial<Duty>) => command(() => transport.http('PUT', `/duties/${id}`, patch)),
  removeDuty: (id: string) => command(() => transport.http('DELETE', `/duties/${id}`)),
  runDuty: (id: string) => command(() => transport.http('POST', `/duties/${id}/run`)),
  /** When scheduled duties run between two days, in the office's time zone. */
  dutyRuns: (from: string, to: string) => transport.http<{ runs: DutyRun[] }>('GET', `/duties/runs?from=${from}&to=${to}`),

  addDue: (data: Partial<DueItem>) => command(() => transport.http('POST', '/due', data)),
  saveDue(id: string, patch: Partial<DueItem>) {
    const prev = get().due[id];
    if (prev) set((st) => ({ due: { ...st.due, [id]: { ...prev, ...patch } } }));
    return command(
      () => transport.http('PUT', `/due/${id}`, patch),
      () => prev && set((st) => ({ due: { ...st.due, [id]: prev } })),
    );
  },
  removeDue: (id: string) => command(() => transport.http('DELETE', `/due/${id}`)),

  saveSettings(patch: Partial<Settings>) {
    const prev = get().settings;
    if (prev) set({ settings: { ...prev, ...patch } });
    return command(
      () => transport.http('PUT', '/settings', patch),
      () => prev && set({ settings: prev }),
    );
  },

  async booksTree(): Promise<BooksEntry[]> {
    return list<BooksEntry>(await transport.http('GET', '/books/tree'), 'entries', 'tree', 'files');
  },
  async booksFile(path: string): Promise<string> {
    const data = await transport.http<unknown>('GET', `/books/file?path=${encodeURIComponent(path)}`);
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object') {
      const o = data as Record<string, unknown>;
      return String(o.text ?? o.content ?? o.body ?? '');
    }
    return '';
  },
  async booksHistory(): Promise<BooksCommit[]> {
    return list<BooksCommit>(await transport.http('GET', '/books/history'), 'commits', 'history');
  },
  booksRevert: (sha: string) => command(() => transport.http('POST', '/books/revert', { sha })),

  async artifacts(staffId?: string): Promise<Artifact[]> {
    return list<Artifact>(await transport.http('GET', `/artifacts${staffId ? `?staff=${encodeURIComponent(staffId)}` : ''}`), 'artifacts');
  },
  /** Where one version of an artifact can be loaded by the browser itself (an image, a PDF), or null with the sample office. */
  artifactUrl(staffId: string, path: string, download = false): string | null {
    if (transport.kind !== 'http') return null;
    return `/api/artifacts/file?staff=${encodeURIComponent(staffId)}&path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
  },
  /** One version as text, exactly as saved. */
  async artifactText(staffId: string, path: string): Promise<string> {
    const url = this.artifactUrl(staffId, path);
    if (!url) {
      const data = await transport.http<{ text?: string }>('GET', `/artifacts/file?staff=${encodeURIComponent(staffId)}&path=${encodeURIComponent(path)}`);
      return data?.text ?? '';
    }
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new HttpError(res.status, res.status === 404 ? 'This file is no longer there.' : 'This file could not be opened.');
    return await res.text();
  },
  retireArtifact: (a: Artifact, retired: boolean) => command(() => transport.http<{ artifact: Artifact }>('POST', '/artifacts/retire', { staff: a.staffId, id: a.id, retired })),
  artifactToDrive: (a: Artifact, version?: string) => command(() => transport.http<{ to: string; already: boolean }>('POST', '/artifacts/drive', { staff: a.staffId, id: a.id, version })),
  deleteArtifact: (a: Artifact) => command(() => transport.http<{ files: number }>('POST', '/artifacts/delete', { staff: a.staffId, id: a.id })),
  /** Notes the owner left on passages of one artifact, oldest first. */
  async artifactNotes(a: Artifact): Promise<ArtifactNote[]> {
    return list<ArtifactNote>(await transport.http('GET', `/artifacts/notes?staff=${encodeURIComponent(a.staffId)}&id=${encodeURIComponent(a.id)}`), 'notes');
  },
  addArtifactNote: (a: Artifact, note: { path: string; quote: string; before: string; text: string }) =>
    command(() => transport.http<{ note: ArtifactNote }>('POST', '/artifacts/notes', { staff: a.staffId, id: a.id, ...note })),
  updateArtifactNote: (id: string, patch: { text?: string; done?: boolean }) => command(() => transport.http<{ note: ArtifactNote }>('POST', `/artifacts/notes/${encodeURIComponent(id)}/change`, patch)),
  removeArtifactNote: (id: string) => command(() => transport.http('DELETE', `/artifacts/notes/${encodeURIComponent(id)}`)),
  /** Hand the open notes (and any edits since) to the person who wrote it, as one message. */
  sendArtifactNotes: (a: Artifact) => command(() => transport.http<{ notes: number }>('POST', '/artifacts/notes/send', { staff: a.staffId, id: a.id })),
  /** Save the owner's edit of one version as the next version. */
  saveArtifactEdit: (a: Artifact, base: string, text: string) => command(() => transport.http<{ path: string }>('POST', '/artifacts/edit', { staff: a.staffId, id: a.id, base, text })),

  async devices(): Promise<Device[]> {
    return list<Device>(await transport.http('GET', '/devices'), 'devices');
  },
  deviceCode: () => command(() => transport.http<{ code: string; url?: string; expiresAt?: number }>('POST', '/devices/code')),
  revokeDevice: (id: string) => command(() => transport.http('DELETE', `/devices/${id}`)),
  /** How other devices reach the office, and whether it can hand out the Mac app. */
  reach: (fresh = false) => transport.http<ReachInfo>('GET', `/reach${fresh ? '?fresh=1' : ''}`),

  /** The Claude account staff run on and the apps connected to it. */
  week: () => transport.http<WeekReport>('GET', '/week'),
  planUsage: (fresh = false) => transport.http<PlanUsage>('GET', `/usage/plan${fresh ? '?fresh=1' : ''}`),
  engineInfo: (fresh = false) => transport.http<EngineInfo>('GET', `/engine${fresh ? '?fresh=1' : ''}`),

  pushInfo: () => transport.http<PushInfo>('GET', '/push'),
  pushSubscribe: (subscription: PushSubscriptionJSON) => command(() => transport.http('POST', '/push/web', { subscription })),
  pushUnsubscribe: (endpoint: string) => command(() => transport.http('DELETE', '/push/web', { endpoint })),
  pushTest: () => command(() => transport.http<PushInfo>('POST', '/push/test')),

  async usage(): Promise<UsageSummary | null> {
    try {
      return await transport.http<UsageSummary>('GET', '/usage');
    } catch {
      return null;
    }
  },
};
