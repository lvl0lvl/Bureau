import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Row, Slip } from '../../../shared/contract.ts';
import { createApp, type App } from '../src/app.ts';
import { Auth } from '../src/auth.ts';
import { DemoEngine } from '../src/engine/demo.ts';
import { PROMOTION_STREAK } from '../src/slips.ts';
import { decide } from '../src/authority.ts';
import { systemAppend } from '../src/prompt.ts';
import { newId } from '../src/store.ts';

let app: App;
let home: string;

const until = async (what: string, fn: () => unknown, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const pending = () => app.store.list('slip').filter((s) => s.status === 'pending');
const thread = (id: string) => app.store.thread(id, null, 100).rows;
const say = (staffId: string, text: string) => {
  app.store.appendRow(staffId, { type: 'message', from: 'owner', text });
  return app.turns.enqueue(staffId, { kind: 'owner', text });
};

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-test-'));
  process.env.BUREAU_OWNER = 'Robin Hale';
  app = createApp({ home, engine: new DemoEngine({ speed: 0 }) });
  app.store.update('settings', 'settings', (s) => { s.undoSeconds = 0; s.checkSlips = false; });
});

after(() => {
  app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a new office has its staff, their folders, the Books, and duties switched off', () => {
  const staff = app.store.list('staff');
  assert.deepEqual(staff.map((s) => s.id).sort(), ['atlas', 'forge', 'hearth', 'piper', 'tally', 'wren']);
  assert.equal(staff.filter((s) => s.isChief).length, 1);
  assert.ok(staff.every((s) => s.authority['money.move'] === 0));
  assert.ok(fs.existsSync(path.join(home, 'staff', 'tally', 'notes', 'memory.md')));
  assert.ok(fs.existsSync(path.join(home, 'books', '.git')));
  assert.ok(app.store.list('duty').length > 0);
  assert.ok(app.store.list('duty').every((d) => !d.enabled && d.nextDueAt === null));
  const s = app.store.get('settings', 'settings')!;
  assert.equal(s.ownerName, 'Robin');
  assert.equal(s.ownerInitials, 'RH');
  assert.equal(s.signatureText, 'R. Hale');
});

test('a turn becomes a work log and an answer, and narration is folded into the log', async () => {
  const res = await say('atlas', 'hello there');
  assert.equal(res.ok, true);
  const rows = thread('atlas');
  assert.deepEqual(rows.map((r) => r.body.type), ['message', 'work', 'message']);
  const work = rows[1]!.body;
  assert.ok(work.type === 'work' && work.status === 'done' && work.steps.length === 1);
  assert.ok(work.type === 'work' && work.steps[0]!.said?.startsWith('Checking my notes'));
  const answer = rows[2]!.body;
  assert.ok(answer.type === 'message' && answer.from === 'staff' && !answer.streaming && answer.text.includes('demo engine'));
  assert.equal(app.turns.live('atlas').running, false);
  assert.equal(app.store.get('staff', 'atlas')!.unread, 1);
});

test('writing to someone new is refused at "Drafts": no slip, nothing sent', async () => {
  const res = await say('tally', 'send the invoice to Halvorsen');
  assert.equal(res.ok, true);
  assert.equal(pending().length, 0);
  assert.match(res.text, /Nothing was sent/);
  assert.ok(fs.existsSync(path.join(home, 'staff', 'tally', 'library', 'invoice-0042.md')));
});

test('writing to a known contact waits for a signature, then goes ahead and is logged', async () => {
  fs.appendFileSync(path.join(home, 'books', 'contacts.md'), '- Accounts desk, Halvorsen Construction, accounts@halvorsen.example\n');
  const turn = say('tally', 'send the invoice to Halvorsen');
  const slip = (await until('a slip', () => pending()[0])) as Slip;
  assert.equal(slip.kind, 'action');
  assert.equal(slip.actionClass, 'mail.send');
  assert.equal(slip.staffId, 'tally');
  assert.match(slip.title, /Send mail to accounts@halvorsen\.example/);
  assert.ok(slip.draft?.editable && slip.draft.text.includes('invoice 0042'));
  assert.match(slip.origin.trigger, /^You asked at /);
  assert.equal(slip.detail.includes('Sending invoice 0042'), true);
  const live = app.turns.live('tally');
  assert.equal(live.waitingSlipId, slip.id);
  assert.ok(thread('tally').some((r) => r.body.type === 'slip' && r.body.slipId === slip.id));

  const signed = app.slips.sign(slip.id, slip.draft!.text.replace('Hello', 'Hello there'));
  assert.ok(!('error' in signed) && signed.status === 'signing' && signed.edited === true);
  const res = await turn;
  assert.match(res.text, /has gone to Halvorsen/);
  assert.equal(app.store.get('slip', slip.id)!.status, 'signed');
  const done = app.store.list('done').map((d) => d.text);
  assert.ok(done.some((t) => /Send mail to accounts@halvorsen/.test(t)), 'the gate logs what was sent');
  assert.ok(done.some((t) => /Sent invoice 0042/.test(t)), 'the staff member logs the outcome');
  assert.ok(app.store.list('due').some((d) => /Halvorsen pays invoice 0042/.test(d.title)));
  assert.deepEqual(app.store.get('staff', 'tally')!.record, { asWritten: 0, edited: 1, declined: 0 });
});

test('declining stops the action and the staff member carries on', async () => {
  const turn = say('tally', 'send the invoice again');
  const slip = (await until('a slip', () => pending()[0])) as Slip;
  app.slips.decline(slip.id, 'Not yet');
  const res = await turn;
  assert.match(res.text, /Nothing was sent/);
  assert.equal(app.store.get('slip', slip.id)!.status, 'declined');
  const work = thread('tally').filter((r) => r.body.type === 'work').pop()!.body;
  assert.ok(work.type === 'work' && work.steps.some((s) => s.status === 'declined'));
});

test('signing can be undone until it goes ahead', async () => {
  app.store.update('settings', 'settings', (s) => { s.undoSeconds = 30; });
  const turn = say('tally', 'send the invoice once more');
  const slip = (await until('a slip', () => pending()[0])) as Slip;
  const signing = app.slips.sign(slip.id);
  assert.ok(!('error' in signing) && signing.status === 'signing' && signing.commitAt! > Date.now());
  const undone = app.slips.undo(slip.id);
  assert.ok(!('error' in undone) && undone.status === 'pending');
  assert.equal(app.turns.live('tally').running, true, 'still waiting');
  app.store.update('settings', 'settings', (s) => { s.undoSeconds = 0; });
  app.slips.sign(slip.id);
  assert.match((await turn).text, /has gone to Halvorsen/);
});

test('stopping a turn expires the slip it was waiting on', async () => {
  const turn = say('tally', 'send the invoice, last time');
  const slip = (await until('a slip', () => pending()[0])) as Slip;
  app.turns.stop('tally');
  const res = await turn;
  assert.equal(res.ok, false);
  assert.equal(app.store.get('slip', slip.id)!.status, 'expired');
  assert.ok(thread('tally').some((r) => r.body.type === 'note' && r.body.text === 'Stopped.'));
});

test('money never moves: the transfer is refused and comes back as something to sign', async () => {
  const turn = say('tally', 'pay the Q4 estimate');
  const slip = (await until('a review slip', () => pending().find((s) => s.kind === 'review'))) as Slip;
  assert.match(slip.title, /Pay Q4 estimated tax/);
  app.slips.sign(slip.id);
  const res = await turn;
  assert.match(res.text, /yours to pay/);
  const work = thread('tally').filter((r) => r.body.type === 'work').pop()!.body;
  assert.ok(work.type === 'work' && work.steps[0]!.status === 'error' && work.steps[0]!.detail === 'Outside authority');
});

test('a question comes back with the answer', async () => {
  const turn = say('hearth', 'which insurance should we choose?');
  const slip = (await until('a question', () => pending().find((s) => s.kind === 'question'))) as Slip;
  assert.equal(slip.options?.length, 3);
  assert.ok(slip.origin.read.some((r) => r.startsWith('Web search')));
  assert.ok('error' in app.slips.sign(slip.id), 'questions are answered, not signed');
  app.slips.answer(slip.id, slip.options![1]!);
  assert.match((await turn).text, /You chose: Calder Mutual/);
});

test('reading outside material first turns "acts" into "asks"', async () => {
  app.store.update('staff', 'forge', (s) => { s.authority = { ...s.authority, 'scripts.run': 4 }; });
  const clean = await say('forge', 'run the backup script');
  assert.match(clean.text, /finished cleanly/);
  assert.ok(app.store.list('done').some((d) => d.staffId === 'forge' && /backup/i.test(d.text)));

  // Same authority, but this time the turn reads the web before it tries to act.
  const gate = (app.turns as any).gate({ staffId: 'forge', outside: new Set(['Web page at example.org']), receipts: new Map(), early: new Map(), steps: [], msgText: '', lastSaid: '', origin: 'test', abort: new AbortController() });
  assert.equal(gate.check('Bash', { command: 'python3 library/backup.py' }, 'x').outcome, 'ask');
});

test('after reading mail, opening a web page becomes a slip that shows the address; after the web alone it does not', async () => {
  const running = (outside: string[]) => ({ staffId: 'atlas', outside: new Set(outside), receipts: new Map(), early: new Map(), steps: [], msgText: '', lastSaid: '', origin: 'test', abort: new AbortController() });
  const web = running(['Web search for “Northbeam Ventures”']);
  assert.equal((app.turns as any).gate(web).check('WebFetch', { url: 'https://northbeam.example/about' }, 'a').outcome, 'allow');
  assert.ok(web.outside.has('Web page at northbeam.example'));

  const mail = running(['Mail in your inbox']);
  const gate = (app.turns as any).gate(mail);
  const url = 'https://collect.example/pixel?note=owner-account-4417';
  assert.equal(gate.check('WebFetch', { url }, 'b').outcome, 'ask');
  const before = pending().length;
  const waiting = gate.wait('WebFetch', { url }, mail.abort.signal, 'b');
  await until('a slip for the web page', () => pending().length === before + 1);
  const slip = pending().find((s) => s.staffId === 'atlas' && /collect\.example/.test(s.title))!;
  assert.equal(slip.draft?.text, url);
  assert.deepEqual(slip.origin.read, ['Mail in your inbox']);
  app.slips.decline(slip.id, 'No');
  assert.equal((await waiting).allow, false);
  assert.equal(mail.outside.has('Web page at collect.example'), false);
});

test('the chief of staff can hand work on and gets the answer back', async () => {
  const res = await say('wren', 'ask Atlas what they found');
  assert.match(res.text, /Atlas replied:/);
  const rows = thread('atlas');
  const handed = rows.find((r) => r.body.type === 'message' && r.body.via?.kind === 'staff');
  assert.ok(handed && handed.body.type === 'message' && handed.body.via?.name === 'Wren');
});

test('a hand-off carries what the sender had read from outside, and the answer brings back what the receiver read', async () => {
  const seen: [string, any][] = [];
  const turns = app.turns as any;
  const enqueue = turns.enqueue.bind(turns);
  turns.enqueue = (id: string, t: unknown) => { seen.push([id, t]); return enqueue(id, t); };
  try {
    // Wren is asked by Piper, who had read mail, and hands it on to Atlas.
    const res = await app.turns.enqueue('wren', { kind: 'staff', fromId: 'piper', text: 'ask Atlas what they found', depth: 0, read: ['Mail in your inbox'] });
    assert.match(res.text, /Atlas replied:/);
    const handed = seen.find(([id, t]) => id === 'atlas' && t.kind === 'staff');
    assert.deepEqual(handed?.[1].read, ['Mail in your inbox'], 'Atlas starts with what Wren had inherited');
    assert.ok(res.read?.includes('Mail in your inbox'), 'and the answer says what it rests on');
  } finally {
    turns.enqueue = enqueue;
  }
  // A turn that begins from a hand-off with outside material is treated as having read it.
  const gate = (app.turns as any).gate({ staffId: 'forge', outside: new Set(['Mail in your inbox']), receipts: new Map(), early: new Map(), steps: [], msgText: '', lastSaid: '', origin: 'test', abort: new AbortController() });
  app.store.update('staff', 'forge', (s) => { s.authority['scripts.run'] = 4; });
  assert.equal(gate.check('Bash', { command: 'python3 library/backup.py' }, 'y').outcome, 'ask');
});

test('the chief of staff checks a slip when checking is on', async () => {
  app.store.update('settings', 'settings', (s) => { s.checkSlips = true; });
  const turn = say('tally', 'send the invoice with a check');
  const slip = (await until('a slip', () => pending()[0])) as Slip;
  assert.equal(slip.check?.by, 'wren');
  assert.ok(slip.check?.state === 'checking' || slip.check?.state === 'ok');
  await until('the check', () => app.store.get('slip', slip.id)!.check?.state === 'ok');
  app.slips.sign(slip.id);
  await turn;
  app.store.update('settings', 'settings', (s) => { s.checkSlips = false; });
});

test('a run of slips signed as written proposes a promotion; signing it raises authority', async () => {
  assert.equal(app.store.get('staff', 'tally')!.authority['mail.send'], 3);
  for (let i = 0; i < PROMOTION_STREAK; i += 1) {
    const s = app.slips.create({ kind: 'action', staffId: 'tally', title: `Send mail ${i}`, detail: '', origin: { trigger: 'test', read: [] }, actionClass: 'mail.send' }, { needsWaiter: false, addRow: false });
    app.slips.sign(s.id);
    await until('signed', () => app.store.get('slip', s.id)!.status === 'signed');
  }
  const promo = (await until('a promotion', () => pending().find((s) => s.kind === 'promotion'))) as Slip;
  assert.deepEqual(promo.promotion, { staffId: 'tally', classId: 'mail.send', from: 3, to: 4, record: `${PROMOTION_STREAK} of ${PROMOTION_STREAK}` });
  assert.equal(promo.staffId, 'wren');
  app.slips.sign(promo.id);
  await until('promoted', () => app.store.get('staff', 'tally')!.authority['mail.send'] === 4);
  assert.equal(pending().filter((s) => s.kind === 'promotion').length, 0);
});

test('clients catch up from a cursor: only what changed, and only the thread they have open', async () => {
  const cursor = app.store.rev;
  await say('piper', 'hello');
  app.store.put('due', { id: newId('due'), date: '2027-01-15', title: 'Test item', note: null, attention: false, staffId: null, done: false });
  const none = app.store.changesSince(cursor, null)!;
  assert.ok(none.every((c) => c.k !== 'row'));
  assert.ok(none.some((c) => c.k === 'due'));
  assert.ok(none.some((c) => c.k === 'staff' && c.v.id === 'piper'));
  const withThread = app.store.changesSince(cursor, 'piper')!;
  const rows = withThread.filter((c): c is { k: 'row'; v: Row } => c.k === 'row');
  assert.deepEqual(rows.map((c) => c.v.body.type), ['message', 'work', 'message']);
  assert.equal(app.store.changesSince(app.store.rev, 'piper')!.length, 0);
  assert.equal(app.store.changesSince(app.store.rev + 1000, null), null, 'a cursor from another database gets a snapshot');
});

test('the Books record who changed what, and a change can be undone', () => {
  fs.appendFileSync(path.join(home, 'books', 'accounts.md'), '- Chequing, ends 4471\n');
  assert.deepEqual(app.books.commit('Tally', 'Tally: add the chequing account'), ['accounts.md']);
  const [latest] = app.books.history(1);
  assert.equal(latest!.author, 'Tally');
  assert.deepEqual(latest!.files, ['accounts.md']);
  assert.equal(app.books.revert(latest!.sha).ok, true);
  assert.ok(!app.books.file('accounts.md').text.includes('4471'));
  assert.throws(() => app.books.file('../bureau.db'));
  assert.throws(() => app.books.file('.git/config'));
});

test('duties run on a schedule only when switched on', () => {
  const duty = app.store.list('duty').find((d) => d.cron)!;
  app.store.update('duty', duty.id, (d) => { d.enabled = true; });
  assert.ok((app.store.get('duty', duty.id)!.nextDueAt ?? 0) > Date.now());
  app.store.update('duty', duty.id, (d) => { d.enabled = false; });
  assert.equal(app.store.get('duty', duty.id)!.nextDueAt, null);
});

test('the calendar is told when scheduled duties run: once a day each, in the office time zone, only when switched on', () => {
  const tz = app.store.get('settings', 'settings')!.timezone;
  app.store.update('settings', 'settings', (s) => { s.timezone = 'America/Los_Angeles'; });
  const daily = app.store.list('duty').find((d) => d.cron === '0 7 * * *')!;
  const weekdays = app.store.list('duty').find((d) => d.cron === '0 8,14 * * 1-5')!;
  assert.deepEqual(app.scheduler.runsBetween('2026-11-08', '2026-11-14'), []);
  for (const d of [daily, weekdays]) app.store.update('duty', d.id, (x) => { x.enabled = true; });

  const runs = app.scheduler.runsBetween('2026-11-08', '2026-11-14');
  const mine = (id: string) => runs.filter((r) => r.dutyId === id);
  assert.deepEqual(mine(daily.id).map((r) => r.day), ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
  // 7:00 am in Los Angeles on Sunday 8 November 2026 is 15:00 UTC.
  assert.equal(new Date(mine(daily.id)[0]!.first).toISOString(), '2026-11-08T15:00:00.000Z');
  assert.deepEqual(mine(weekdays.id).map((r) => `${r.day} x${r.count}`), ['2026-11-09 x2', '2026-11-10 x2', '2026-11-11 x2', '2026-11-12 x2', '2026-11-13 x2']);
  assert.deepEqual(app.scheduler.runsBetween('2026-11-14', '2026-11-08'), []);

  for (const d of [daily, weekdays]) app.store.update('duty', d.id, (x) => { x.enabled = false; });
  app.store.update('settings', 'settings', (s) => { s.timezone = tz; });
});

test('sessions this Mac was given and never used again are cleared; phones and used ones stay', () => {
  const old = Date.now() - 60 * 60_000;
  const age = (cookieValue: string, createdAt: number, lastSeenAt: number) => {
    const id = cookieValue.split('.')[0]!;
    const d = app.store.listPrivate<any>('_device').find((x) => x.id === id)!;
    app.store.putPrivate('_device', { ...d, createdAt, lastSeenAt });
    return id;
  };
  const oneShot = age(app.auth.pairLocal(), old, old);
  const kept = age(app.auth.pairLocal(), old, old);
  const used = age(app.auth.pairLocal(), old, old + 5 * 60_000);
  const fresh = app.auth.pairLocal().split('.')[0]!;
  const phone = age(app.auth.pair(app.auth.createCode().code, 'iPhone')!, old, old);

  assert.equal(app.auth.pruneLocal((id) => id === kept), 1);
  const left = new Set(app.auth.devices().map((d) => d.id));
  assert.equal(left.has(oneShot), false, 'one request an hour ago, never back');
  for (const id of [kept, used, fresh, phone]) assert.equal(left.has(id), true);
  for (const id of [kept, used, fresh, phone]) app.auth.revoke(id);
});

test('pairing: a code works once, sessions verify, and local means truly local', () => {
  const { code } = app.auth.createCode();
  const cookieValue = app.auth.pair(code.toLowerCase(), 'Phone')!;
  assert.ok(cookieValue);
  assert.equal(app.auth.pair(code, 'Again'), null);
  const header = app.auth.cookie(cookieValue, true);
  assert.match(header, /HttpOnly; SameSite=Lax; .*Secure/);
  const device = app.auth.verify(header.split(';')[0]);
  assert.equal(device?.label, 'Phone');
  assert.equal(app.auth.verify('bureau_session=nope.nope'), null);
  app.auth.revoke(device!.id);
  assert.equal(app.auth.verify(header.split(';')[0]), null);

  assert.equal(Auth.isLocal('127.0.0.1', { host: 'localhost:8787' }), true);
  assert.equal(Auth.isLocal('127.0.0.1', { host: 'localhost:8787', forwardedFor: '100.64.0.2' }), false, 'through Tailscale Serve');
  assert.equal(Auth.isLocal('127.0.0.1', { host: 'evil.example' }), false, 'DNS rebinding');
  assert.equal(Auth.isLocal('192.168.1.20', { host: 'localhost:8787' }), false);
});

test('after a restart, slips that were waiting on a running turn are closed', () => {
  const s = app.slips.create({ kind: 'action', staffId: 'piper', title: 'Orphan', detail: '', origin: { trigger: 'test', read: [] } }, { needsWaiter: true, addRow: false });
  const keep = app.slips.create({ kind: 'promotion', staffId: 'wren', title: 'Keeps', detail: '', origin: { trigger: 'test', read: [] } }, { needsWaiter: false, addRow: false });
  app.slips.recover();
  assert.equal(app.store.get('slip', s.id)!.status, 'expired');
  assert.equal(app.store.get('slip', keep.id)!.status, 'pending');
  app.slips.decline(keep.id);
});

test('staff are told about the owner in the owner’s words, and refusals use the owner’s name', async () => {
  const told = () => systemAppend(app.store.get('staff', 'tally')!, app.store.list('staff'), app.store.get('settings', 'settings')!, { home: path.join(home, 'staff', 'tally'), books: app.books.dir });
  assert.match(told(), /Robin relies on this office for business and personal affairs\./);
  app.store.update('settings', 'settings', (s) => { s.ownerAbout = 'Robin runs a bakery and keeps everything in Google Drive.'; });
  assert.match(told(), /\nRobin runs a bakery and keeps everything in Google Drive\.\n/);
  assert.doesNotMatch(told(), /relies on this office/);
  app.store.update('settings', 'settings', (s) => { s.ownerAbout = ''; });

  const pay = decide(0, { classId: 'money.move', mode: 'execute' } as any, { tainted: false, owner: 'Robin' });
  assert.match((pay as any).message, /Robin makes the payment/);
  const look = decide(1, { classId: 'mail.send', mode: 'execute' } as any, { tainted: false });
  assert.match((look as any).message, /Tell the owner what you found/);
});
