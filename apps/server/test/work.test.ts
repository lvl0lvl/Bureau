import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { DemoEngine } from '../src/engine/demo.ts';
import { systemAppend } from '../src/prompt.ts';
import { findBd } from '../src/work.ts';

// These run against the real bd program. Without it the work list is simply off.
const bd = findBd();
const opts = { skip: bd ? false : 'beads (bd) is not installed', timeout: 120_000 };

let app: App;
let home: string;

const until = async <T>(what: string, fn: () => T | undefined | false | null, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const bodies = (id: string) => app.store.thread(id, null, 200).rows.map((r: any) => r.body);
const idle = (id: string) => until(`${id} to finish`, () => !app.turns.isBusy(id));

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-work-'));
  process.env.BUREAU_OWNER = 'Robin Hale';
  app = createApp({ home, engine: new DemoEngine({ speed: 0 }) });
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('without beads the work list is off and staff are not told about it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-nowork-'));
  const plain = createApp({ home: dir, engine: new DemoEngine({ speed: 0 }), work: false });
  try {
    assert.equal(plain.work.available, false);
    assert.match(plain.work.problem!, /not installed/);
    const told = systemAppend(plain.store.get('staff', 'wren')!, plain.store.list('staff'), plain.store.get('settings', 'settings')!, { home: dir, books: plain.books.dir, work: plain.work.available });
    assert.doesNotMatch(told, /add_work/);
    assert.equal(fs.existsSync(path.join(dir, 'work')), false);
  } finally {
    plain.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('work the owner gives someone starts them, and closes with a result', opts, async () => {
  assert.equal(await app.work.ready(), true);
  assert.ok(fs.existsSync(path.join(home, 'work', '.beads')));
  // Beads sets up its own folder and nothing else in the office.
  assert.equal(fs.existsSync(path.join(home, '.beads')), false);

  const item = await app.work.add('owner', { title: 'File the October receipts', detail: 'They are in the inbox.', staffId: 'tally' });
  assert.match(item.id, /^job-/);
  assert.equal(item.createdBy, 'owner');
  assert.equal(item.staffId, 'tally');
  assert.equal(item.ready, true);

  const closed = await until('Tally to close it', () => { const w = app.work.get(item.id); return w?.status === 'closed' ? w : undefined; });
  assert.match(closed.result!, /File the October receipts/);
  assert.ok(closed.closedAt);
  await idle('tally');

  const rows = bodies('tally');
  const brief = rows.find((b) => b.type === 'message' && b.via?.kind === 'work');
  assert.equal(brief.via.name, 'Robin');
  assert.match(brief.text, /File the October receipts/);
  assert.ok(app.store.list('done').some((d) => d.staffId === 'tally' && /Finished: File the October receipts/.test(d.text)));
});

test('closing one piece releases the next, and the opener hears the result', opts, async () => {
  app.store.appendRow('wren', { type: 'message', from: 'owner', text: 'Put the Halvorsen invoice on the work list.' });
  await app.turns.enqueue('wren', { kind: 'owner', text: 'Put the Halvorsen invoice on the work list.' });

  const items = app.work.list();
  const invoice = items.find((w) => /Prepare invoice 0043/.test(w.title))!;
  const followUp = items.find((w) => /Tell the owner/.test(w.title))!;
  assert.equal(invoice.staffId, 'tally');
  assert.equal(invoice.createdBy, 'wren');
  assert.equal(followUp.staffId, 'wren');
  assert.deepEqual(followUp.after, [invoice.id]);

  // Tally was started without Wren waiting; when Tally closes, Wren's follow-up starts by itself.
  await until('both pieces to close', () => app.work.get(invoice.id)?.status === 'closed' && app.work.get(followUp.id)?.status === 'closed');
  await idle('wren');
  await idle('tally');

  const wren = bodies('wren');
  assert.ok(wren.some((b) => b.type === 'note' && new RegExp(`Tally finished “Prepare invoice 0043 for Halvorsen” \\(${invoice.id}\\)`).test(b.text)));
  assert.ok(wren.some((b) => b.type === 'message' && b.via?.kind === 'work' && /Tell the owner invoice 0043 is ready/.test(b.text)));
  assert.ok(bodies('tally').some((b) => b.type === 'message' && b.via?.kind === 'work' && b.via.name === 'Wren'));
});

test('only one person can hold a piece of work, and waiting work cannot be taken early', opts, async () => {
  const open = await app.work.add('owner', { title: 'Look into a second monitor' });
  assert.equal(open.staffId, null);
  const taken = await app.work.claim('atlas', open.id);
  assert.equal(taken.staffId, 'atlas');
  assert.equal(taken.status, 'in_progress');
  await assert.rejects(app.work.claim('forge', open.id), /belongs to Atlas/);

  const later = await app.work.add('owner', { title: 'Order the monitor', staffId: 'forge', after: [open.id] });
  assert.equal(later.ready, false);
  await assert.rejects(app.work.claim('forge', later.id), new RegExp(`waiting on ${open.id}`));
  assert.match(app.work.summaryFor('forge'), new RegExp(`${later.id} “Order the monitor” \\(waiting on ${open.id}\\)`));
  assert.match(app.work.summaryFor('atlas'), /in progress/);
  assert.equal(app.work.summaryFor('piper'), '');

  const noted = await app.work.note('atlas', open.id, 'Two candidates under $400.');
  assert.match(noted.notes, /Atlas: Two candidates under \$400\./);
});

test('a change made with bd in a terminal is picked up and releases what was waiting', opts, async () => {
  const open = app.work.list().find((w) => w.title === 'Look into a second monitor')!;
  const later = app.work.list().find((w) => w.title === 'Order the monitor')!;
  execFileSync(bd!, ['--actor', 'owner', 'close', open.id, '--reason', 'Chose the 27 inch.', '--force'], { cwd: path.join(home, 'work'), env: { ...process.env, BD_NON_INTERACTIVE: '1' } });
  assert.equal(app.work.get(open.id)!.status, 'in_progress', 'not seen until the office looks');

  await app.work.refresh();
  assert.equal(app.work.get(open.id)!.status, 'closed');
  assert.equal(app.work.get(open.id)!.result, 'Chose the 27 inch.');
  // Forge is started on the released piece and is shown what came before it.
  const done = await until('Forge to finish', () => { const w = app.work.get(later.id); return w?.status === 'closed' ? w : undefined; });
  assert.match(done.result!, /Order the monitor/);
  await idle('forge');
});

test('work carries what its opener had read from outside, and deep chains are not started', opts, async () => {
  const tainted = await app.work.add('piper', { title: 'Reply to the supplier', staffId: 'piper', read: ['Mail in your inbox'], depth: 1 });
  assert.deepEqual(tainted.read, ['Mail in your inbox']);
  assert.equal(app.store.getPrivate<{ depth: number }>('_workx', tainted.id)!.depth, 1);
  // Opened for oneself: nothing is started.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.turns.isBusy('piper'), false);
  assert.equal(app.work.get(tainted.id)!.status, 'open');

  const deep = await app.work.add('piper', { title: 'Hand this on again', staffId: 'hearth', depth: 4 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.work.get(deep.id)!.status, 'open');
  assert.ok(bodies('hearth').some((b) => b.type === 'note' && b.tone === 'warn' && /handed on 4 times/.test(b.text)));
});

test('the briefing explains the work list only when it exists', opts, () => {
  const told = systemAppend(app.store.get('staff', 'wren')!, app.store.list('staff'), app.store.get('settings', 'settings')!, { home, books: app.books.dir, work: app.work.available });
  assert.match(told, /add_work/);
});
