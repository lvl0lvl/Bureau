import fs from 'node:fs';
import path from 'node:path';
import type { Live, Slip } from '../../../shared/contract.ts';
import { Auth } from './auth.ts';
import { Backup, type AgePaths } from './backup.ts';
import { Books } from './books.ts';
import { Catalog } from './catalog.ts';
import { OfficeDrive } from './drive.ts';
import { Hires } from './hires.ts';
import { Skills } from './skills.ts';
import type { Engine } from './engine/types.ts';
import { checkPrompt, lessonPrompt } from './prompt.ts';
import { Push } from './push.ts';
import { Scheduler } from './scheduler.ts';
import { UsageWatch } from './usage.ts';
import { DropWatch, Uploads } from './intake.ts';
import { ensureStaffHome, seed, seedDemo } from './seed.ts';
import { Slips } from './slips.ts';
import { Store } from './store.ts';
import { buildTools } from './tools.ts';
import { Turns } from './turns.ts';
import { MAX_WORK_DEPTH, Work } from './work.ts';
import { newId } from './store.ts';

/** Everything the server is made of, wired together. Tests build one of these on a temp folder. */
export interface App {
  home: string;
  staffRoot: string;
  store: Store;
  books: Books;
  slips: Slips;
  turns: Turns;
  scheduler: Scheduler;
  usage: UsageWatch;
  uploads: Uploads;
  drop: DropWatch;
  auth: Auth;
  push: Push;
  catalog: Catalog;
  skills: Skills;
  hires: Hires;
  work: Work;
  drive: OfficeDrive;
  backup: Backup;
  engine: Engine;
  onLive(fn: (live: Live) => void): () => void;
  onNeedsOwner(fn: (slip: Slip) => void): () => void;
  close(): void;
}

export function createApp(opts: { home: string; engine: Engine; demo?: boolean; /** False leaves the work list off (no beads). */ work?: boolean; /** Null leaves backups unable to run (no age). */ age?: AgePaths | null }): App {
  const home = opts.home;
  const staffRoot = path.join(home, 'staff');
  fs.mkdirSync(staffRoot, { recursive: true });

  const store = new Store(path.join(home, 'bureau.db'));
  const books = new Books(path.join(home, 'books'));
  books.init();

  const liveListeners = new Set<(l: Live) => void>();
  const slipListeners = new Set<(s: Slip) => void>();

  const slips = new Slips({
    store,
    onNeedsOwner: (slip) => { for (const fn of slipListeners) fn(slip); },
    learn: async (c, staff) => {
      const owner = store.get('settings', 'settings')!.ownerName;
      const p = lessonPrompt({ owner, name: staff.name, role: staff.role, profile: staff.instructions, title: c.slip.title, before: c.before, after: c.after, reason: c.reason });
      return opts.engine.ask({ ...p, configDir: staff.configDir });
    },
    check: async (slip, chief) => {
      const preparedBy = store.get('staff', slip.staffId);
      const p = checkPrompt({
        preparedBy: preparedBy?.name ?? 'A colleague', role: preparedBy?.role ?? 'staff', title: slip.title, detail: slip.detail,
        trigger: slip.origin.trigger, read: slip.origin.read,
        meta: (slip.draft?.meta ?? []).map((m) => `${m.label}: ${m.value}`).join('; '), text: slip.draft?.text ?? '',
      });
      const answer = await opts.engine.ask({ ...p, configDir: chief.configDir });
      const line = answer.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
      const concern = /^concern\b[:\s-]*/i.exec(line);
      if (concern) return { ok: false, note: line.slice(concern[0].length).trim().slice(0, 240) };
      return { ok: true, note: line.replace(/^ok\b[.,:\s-]*/i, '').trim().slice(0, 120) };
    },
  });

  const catalog = new Catalog(store, path.join(home, 'catalog'));
  // Skills written for this office ship with Bureau. Everything else is fetched when the owner asks.
  const house = path.resolve(import.meta.dirname, '..', 'house-skills');
  if (fs.existsSync(house)) catalog.addLocal('house', 'House skills', house);
  const skills = new Skills({ store, catalog, staffRoot, heldRoot: path.join(home, 'held') });
  const hires = new Hires({ store, catalog, skills, ensureHome: (s) => ensureStaffHome(staffRoot, s) });

  const work = new Work({ store, dir: path.join(home, 'work'), bdPath: opts.work === false ? null : undefined });

  const drive = new OfficeDrive(store);

  let turns!: Turns;
  turns = new Turns({
    store, slips, engine: opts.engine, books, staffRoot, skills, work, drive,
    buildTools: (running) => buildTools({ store, slips, catalog, hires, work, drive, staffRoot, books: books.dir, turns: () => turns }, running),
    onLive: (live) => { for (const fn of liveListeners) fn(live); },
  });

  seed(store, { engine: opts.engine.name, staffRoot });
  if (opts.demo) seedDemo(store, staffRoot, books.dir, catalog);
  books.commit('Bureau', 'Set up the office');
  slips.recover();

  // Work that becomes ready starts its holder; work that closes is reported to whoever opened it.
  work.on((e) => {
    const name = (id: string) => (id === 'owner' ? store.get('settings', 'settings')!.ownerName : store.get('staff', id)?.name ?? id);
    if (e.type === 'ready') {
      const staff = e.item.staffId ? store.get('staff', e.item.staffId) : undefined;
      if (!staff || staff.retired) return;
      if (e.depth > MAX_WORK_DEPTH) {
        store.appendRow(staff.id, { type: 'note', tone: 'warn', text: `“${e.item.title}” (${e.item.id}) is ready for ${staff.name} but was not started, because it has been handed on ${e.depth} times. Tell ${staff.name} to go ahead if it should be done.` });
        return;
      }
      void turns.enqueue(staff.id, { kind: 'work', workId: e.item.id, why: e.why });
    } else {
      const closer = store.get('staff', e.by);
      if (closer) store.put('done', { id: newId('done'), at: Date.now(), staffId: closer.id, text: `Finished: ${e.item.title}` });
      const opener = store.get('staff', e.item.createdBy);
      if (opener && !opener.retired && opener.id !== e.by) {
        store.appendRow(opener.id, { type: 'note', tone: 'info', text: `${name(e.by)} finished “${e.item.title}” (${e.item.id})${e.item.result ? `: ${e.item.result}` : '.'}` });
      }
    }
  });

  drive.ensure();
  const backup = new Backup({ store, home, drive, work, age: opts.age, busy: () => turns.allLive().some((l) => l.running) });

  const uploads = new Uploads(home);
  uploads.sweep();
  // Whatever the owner leaves in "Drop here" goes to the chief of staff.
  const drop = new DropWatch({ store, drive, hand: (staffId, files) => { void turns.enqueue(staffId, { kind: 'drop', files }); } });

  const usage = new UsageWatch({ store, engine: opts.engine });
  // Each finished turn moves the figures.
  liveListeners.add((l) => { if (!l.running) usage.touched(); });
  const scheduler = new Scheduler({ store, turns, usage });
  scheduler.start();
  const auth = new Auth(store);
  const push = new Push(store, home);
  slipListeners.add((slip) => {
    const who = store.get('staff', slip.staffId)?.name ?? 'Your staff';
    const title = slip.kind === 'question' ? `${who} has a question` : slip.kind === 'promotion' ? 'A promotion to consider' : `${who} needs your signature`;
    // A slip can be signed straight from the notification only when it is a plain action that does
    // not trace back to anything read from outside. Everything else has to be opened and read.
    const signable = slip.kind === 'action' && slip.origin.read.length === 0;
    void push.notify({ title, body: slip.title, url: `/?slip=${slip.id}`, tag: slip.id, slipId: slip.id, signable });
  });

  return {
    home, staffRoot, store, books, slips, turns, scheduler, usage, uploads, drop, auth, push, catalog, skills, hires, work, drive, backup, engine: opts.engine,
    onLive: (fn) => { liveListeners.add(fn); return () => liveListeners.delete(fn); },
    onNeedsOwner: (fn) => { slipListeners.add(fn); return () => slipListeners.delete(fn); },
    close: () => { scheduler.stop(); backup.stop(); usage.stop(); drop.stop(); store.close(); },
  };
}
