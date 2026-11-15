import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { COMPACT_AT_DEFAULT, compactAt, usageGuard, USAGE_GUARD_DEFAULT } from '../../../shared/contract.ts';
import { createApp, type App } from '../src/app.ts';
import { DemoEngine } from '../src/engine/demo.ts';
import { createHttp } from '../src/http.ts';

let app: App;
let home: string;
let engine: DemoEngine;
const HOUR = 3_600_000;

const set = (week: number | null, weekResets = Date.now() + 50 * HOUR) => {
  engine.demoUsage = { week: week === null ? null : { used: week, resetsAt: weekResets } };
};
const duty = () => app.store.get('duty', 'duty_test')!;
/** How many times the duty has been started in Tally's thread. */
const runs = () => app.store.thread('tally', null, 500).rows.filter((r: any) => r.body.type === 'message' && r.body.via?.kind === 'duty').length;
const settle = () => new Promise((r) => setTimeout(r, 80));
const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-usage-'));
  process.env.BUREAU_OWNER = 'Robin Hale';
  engine = new DemoEngine({ speed: 0, usage: { week: null } });
  app = createApp({ home, engine });
  app.store.put('duty', { id: 'duty_test', staffId: 'tally', title: 'Reconcile the week', cadence: 'Every Friday', cron: null, prompt: 'Reconcile.', enabled: true, lastDoneAt: null, nextDueAt: null, note: null, attention: false } as any);
});

after(async () => {
  // Let the duty turns started here finish before the office closes.
  await until(() => app.turns.allLive().every((l) => !l.running && l.queued === 0));
  await settle();
  app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('the limits have defaults, and anything out of range is brought back into it', () => {
  assert.deepEqual(usageGuard(null), USAGE_GUARD_DEFAULT);
  assert.deepEqual(usageGuard({}), USAGE_GUARD_DEFAULT);
  assert.deepEqual(usageGuard({ usageGuard: { on: false, week: 250 } }), { on: false, week: 100 });
  assert.deepEqual(usageGuard({ usageGuard: { on: true, week: -4 } }), { on: true, week: 1 });
  assert.deepEqual(usageGuard({ usageGuard: { on: true, week: Number.NaN } }), { on: true, week: USAGE_GUARD_DEFAULT.week });
  // An office saved while there was a five-hour limit still reads cleanly.
  assert.deepEqual(usageGuard({ usageGuard: { on: true, week: 70, fiveHour: 90 } as any }), { on: true, week: 70 });
});

test('under the limit a scheduled duty runs', async () => {
  set(40);
  await app.usage.refresh();
  assert.equal(app.usage.status().holding, null);
  const before = runs();
  assert.equal(await app.scheduler.fire('duty_test'), 'ran');
  await until(() => runs() === before + 1);
  assert.equal(runs(), before + 1);
  assert.ok(!duty().held);
});

test('at the week\'s limit a scheduled duty is held, says why, and a notice goes on the Desk once', async () => {
  set(80);
  await app.usage.refresh();
  assert.deepEqual(app.usage.status().holding, { used: 80, limit: 80 });
  const before = runs();
  assert.equal(await app.scheduler.fire('duty_test'), 'held');
  await settle();
  assert.equal(runs(), before);
  assert.match(duty().held!.why, /80% of the week’s Claude usage is spent; duties hold at 80%/);

  const notice = app.store.get('due', 'due_usage')!;
  assert.match(notice.title, /Scheduled duties are on hold: 80% of the week/);
  assert.match(notice.note!, /Anything Robin asks for still runs/);
  assert.equal(notice.attention, true);

  // The owner clears the notice; a second held duty does not put it back.
  app.store.del('due', 'due_usage');
  assert.equal(await app.scheduler.fire('duty_test'), 'held');
  assert.equal(app.store.get('due', 'due_usage'), undefined);
});

test('what the owner asks for runs whatever the usage, and Run now clears the hold', async () => {
  const http = createHttp(app, { webDist: home });
  const cookie = app.auth.cookie(app.auth.pairLocal(), false).split(';')[0]!;
  assert.ok(duty().held);
  const before = runs();
  const res = await http.request('/api/duties/duty_test/run', { method: 'POST', headers: { cookie } });
  assert.equal(res.status, 200);
  await until(() => runs() === before + 1);
  assert.equal(runs(), before + 1);
  assert.ok(!duty().held);

  const plan = await (await http.request('/api/usage/plan', { headers: { cookie } })).json() as any;
  assert.equal(plan.available, true);
  assert.equal(plan.week.used, 80);
  assert.equal(plan.holding.limit, 80);
  assert.equal('fiveHour' in plan, false);

  // Limits sent from Settings are kept within 1 to 100, and a part that is left out keeps its value.
  const put = await http.request('/api/settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ usageGuard: { week: 400 } }) });
  assert.equal(put.status, 200);
  assert.deepEqual(app.store.get('settings', 'settings')!.usageGuard, { on: true, week: 100 });
  app.store.update('settings', 'settings', (s) => { s.usageGuard = { ...USAGE_GUARD_DEFAULT }; });
});

test('raising the limit in Settings lifts the hold at once, and switching the hold off does too', async () => {
  // A new hold, after a spell under the limit, puts the notice up again.
  set(40);
  await app.usage.refresh();
  set(80);
  await app.usage.refresh();
  assert.equal(await app.scheduler.fire('duty_test'), 'held');
  assert.ok(app.store.get('due', 'due_usage'));

  app.usage.start();
  await app.usage.refresh();
  app.store.update('settings', 'settings', (s) => { s.usageGuard = { on: true, week: 95 }; });
  assert.equal(app.usage.status().holding, null);
  assert.equal(app.store.get('due', 'due_usage'), undefined);
  assert.equal(await app.scheduler.fire('duty_test'), 'ran');
  assert.ok(!duty().held);

  app.store.update('settings', 'settings', (s) => { s.usageGuard = { on: true, week: 50 }; });
  assert.equal(app.usage.status().holding?.limit, 50);
  app.store.update('settings', 'settings', (s) => { s.usageGuard = { on: false, week: 50 }; });
  assert.equal(app.usage.status().holding, null);
  assert.equal(await app.scheduler.fire('duty_test'), 'ran');
  app.store.update('settings', 'settings', (s) => { s.usageGuard = { ...USAGE_GUARD_DEFAULT }; });
});

test('a week that has passed its reset counts as empty', async () => {
  // The week was last read at 99%, but its reset time has gone by.
  set(99, Date.now() - 1000);
  await app.usage.refresh();
  const s = app.usage.status();
  assert.deepEqual(s.week, { used: 0, resetsAt: null });
  assert.equal(s.holding, null);
  assert.equal(app.store.get('due', 'due_usage'), undefined);
});

test('when the figures cannot be read, duties run and the last figures are kept', async () => {
  set(30);
  await app.usage.refresh();
  const real = engine.usage;
  engine.usage = async () => { throw new Error('Claude Code did not answer.'); };
  try {
    const s = await app.usage.refresh();
    assert.equal(s.error, 'Claude Code did not answer.');
    assert.equal(s.week?.used, 30);
    assert.equal(await app.scheduler.fire('duty_test'), 'ran');
  } finally {
    engine.usage = real;
  }
  assert.equal((await app.usage.refresh()).error, undefined);
});

test('each turn reports how full the conversation is, and a new conversation clears it', async () => {
  const before = app.store.get('staff', 'atlas')!.context;
  assert.equal(before ?? null, null);
  await app.turns.enqueue('atlas', { kind: 'owner', text: 'Hello' });
  const c = app.store.get('staff', 'atlas')!.context!;
  assert.deepEqual([c.window, c.compactsAt], [COMPACT_AT_DEFAULT, COMPACT_AT_DEFAULT - 33_000]);
  assert.ok(c.used > 0 && c.used < c.compactsAt);
  await app.turns.enqueue('atlas', { kind: 'owner', text: 'Hello again' });
  assert.ok(app.store.get('staff', 'atlas')!.context!.used > c.used);

  app.turns.newConversation('atlas');
  assert.equal(app.store.get('staff', 'atlas')!.context, null);
});

test('the compaction window is passed to the engine, kept within bounds, and changing it measures everyone again', async () => {
  assert.equal(compactAt(null), 400_000);
  assert.equal(compactAt({ compactAt: 5 }), 100_000);
  assert.equal(compactAt({ compactAt: 9_000_000 }), 1_000_000);
  assert.equal(compactAt({ compactAt: Number.NaN }), 400_000);

  // On start, people whose figure is not known are measured without a turn.
  assert.equal(app.store.get('staff', 'piper')!.context ?? null, null);
  await app.turns.readContexts();
  const piper = app.store.get('staff', 'piper')!.context!;
  assert.deepEqual([piper.used, piper.window, piper.compactsAt], [318_000, 400_000, 367_000]);

  const seen: (number | null | undefined)[] = [];
  const run = engine.run.bind(engine);
  engine.run = (o) => { seen.push(o.compactWindow); return run(o); };
  try {
    const http = createHttp(app, { webDist: home });
    const cookie = app.auth.cookie(app.auth.pairLocal(), false).split(';')[0]!;
    const put = await http.request('/api/settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ compactAt: 250_000 }) });
    assert.equal(put.status, 200);
    assert.equal(app.store.get('settings', 'settings')!.compactAt, 250_000);
    await until(() => app.store.get('staff', 'piper')!.context?.window === 250_000);
    assert.equal(app.store.get('staff', 'piper')!.context!.compactsAt, 217_000);

    await app.turns.enqueue('hearth', { kind: 'owner', text: 'Hello' });
    // Duty turns queued by the tests above may also have started; the one just asked for is the last.
    assert.equal(seen.at(-1), 250_000);
    assert.equal(app.store.get('staff', 'hearth')!.context!.window, 250_000);
  } finally {
    engine.run = run;
    app.store.update('settings', 'settings', (s) => { delete s.compactAt; });
  }
});

test('a duty that is switched off does not fire', async () => {
  app.store.update('duty', 'duty_test', (d) => { d.enabled = false; });
  assert.equal(await app.scheduler.fire('duty_test'), 'off');
});
