import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { DemoEngine } from '../src/engine/demo.ts';
import { weekReport } from '../src/week.ts';

let app: App;
let home: string;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 13, 20, 0, 0);
const ago = (days: number) => NOW - days * DAY;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-week-'));
  app = createApp({ home, engine: new DemoEngine({ speed: 0 }), work: false });
  const { store } = app;
  const slip = (id: string, staffId: string, status: string, decidedAt: number, extra: Record<string, unknown> = {}) =>
    store.put('slip', { id, kind: 'action', staffId, title: id, detail: '', origin: { trigger: 'test', read: [] }, status, createdAt: decidedAt - 1000, decidedAt, ...extra } as any);

  // This week: Piper ran three times (one a duty), Tally once. One of Piper's failed.
  store.putPrivate('_usage', { id: 't1', staffId: 'piper', at: ago(1), ok: true, kind: 'duty', durationMs: 4 * 60_000, costUsd: 0.41 });
  store.putPrivate('_usage', { id: 't2', staffId: 'piper', at: ago(2), ok: true, kind: 'owner', durationMs: 90_000, costUsd: 0.2 });
  store.putPrivate('_usage', { id: 't3', staffId: 'piper', at: ago(6.9), ok: false, kind: 'owner', durationMs: 30_000, costUsd: 0.05 });
  store.putPrivate('_usage', { id: 't4', staffId: 'tally', at: ago(3), ok: true, kind: 'work', durationMs: 10 * 60_000, costUsd: 1.1 });
  // The week before, and long ago.
  store.putPrivate('_usage', { id: 't5', staffId: 'tally', at: ago(8), ok: true, kind: 'duty', durationMs: 60_000, costUsd: 0.3 });
  store.putPrivate('_usage', { id: 't6', staffId: 'tally', at: ago(30), ok: true, durationMs: 60_000, costUsd: 9 });

  store.put('done', { id: 'd1', at: ago(1), staffId: 'piper', text: 'Cleared the inbox' });
  store.put('done', { id: 'd2', at: ago(2), staffId: 'tally', text: 'Closed October' });
  store.put('done', { id: 'd3', at: ago(9), staffId: 'tally', text: 'Filed receipts' });

  slip('s1', 'piper', 'signed', ago(1));
  slip('s2', 'piper', 'signed', ago(1.5), { edited: true });
  slip('s3', 'piper', 'declined', ago(2));
  slip('s4', 'tally', 'signed', ago(10));
  slip('s5', 'piper', 'pending', 0, { decidedAt: undefined });
  slip('s6', 'wren', 'signed', ago(1), { kind: 'promotion' });
  slip('s7', 'piper', 'signed', ago(1), { kind: 'lesson', lesson: { staffId: 'piper', from: 'edit', about: 's2' } });
  slip('s8', 'piper', 'expired', ago(1));

  store.put('due', { id: 'due1', date: '2026-11-29', title: 'Car insurance renews', note: 'Premium up 11%.', attention: true, staffId: 'hearth', done: false, at: ago(2) });
  store.put('due', { id: 'due2', date: '2026-12-01', title: 'No time recorded', note: null, attention: true, staffId: 'hearth', done: false });
  store.put('due', { id: 'due3', date: '2026-12-02', title: 'Robin wrote this one', note: null, attention: true, staffId: null, done: false, at: ago(1) } as any);
  store.put('due', { id: 'due4', date: '2026-12-03', title: 'Not flagged', note: null, attention: false, staffId: 'hearth', done: false, at: ago(1) });
});

after(() => {
  app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('the week is counted from the office\'s own records, this week and the one before', () => {
  const w = weekReport(app.store, NOW);
  assert.equal(w.to, NOW);
  assert.equal(w.from, NOW - 7 * DAY);
  assert.deepEqual(w.totals, { turns: 4, minutes: 16, costUsd: 1.76, done: 2, signed: 2, asWritten: 1, edited: 1, declined: 1, rules: 1, dutyRuns: 1, workClosed: 0, flagged: 1 });
  assert.deepEqual(w.previous, { turns: 1, minutes: 1, costUsd: 0.3, done: 1, signed: 1, asWritten: 1, edited: 0, declined: 0, rules: 0, dutyRuns: 1, workClosed: 0, flagged: 0 });
  assert.equal(w.waiting, 1);
  assert.equal(w.since, ago(30));
});

test('each person has their own line, in roster order, and people with nothing still appear', () => {
  const w = weekReport(app.store, NOW);
  const piper = w.staff.find((s) => s.staffId === 'piper')!;
  assert.deepEqual([piper.turns, piper.minutes, piper.done, piper.signed, piper.asWritten, piper.edited, piper.declined, piper.rules, piper.dutyRuns], [3, 6, 1, 2, 1, 1, 1, 1, 1]);
  const tally = w.staff.find((s) => s.staffId === 'tally')!;
  assert.deepEqual([tally.turns, tally.minutes, tally.done, tally.signed], [1, 10, 1, 0]);
  assert.equal(w.staff.find((s) => s.staffId === 'hearth')!.flagged, 1);
  assert.equal(w.staff.find((s) => s.staffId === 'atlas')!.turns, 0);
  assert.deepEqual(w.staff.map((s) => s.staffId).slice(0, 3), ['wren', 'tally', 'piper']);
  // The per-person lines add up to the totals.
  for (const k of ['turns', 'done', 'signed', 'declined', 'rules'] as const) assert.equal(w.staff.reduce((n, s) => n + s[k], 0), w.totals[k]);
});

test('what was done and what was flagged are listed, newest first, this week only', () => {
  const w = weekReport(app.store, NOW);
  assert.deepEqual(w.done.map((d) => d.text), ['Cleared the inbox', 'Closed October']);
  assert.deepEqual(w.flagged.map((d) => d.title), ['Car insurance renews']);
});

test('a date a member of staff puts on the Desk records when, so it can be counted', async () => {
  const r = { staffId: 'hearth', outside: new Set<string>(), origin: 'test', depth: 0 };
  const tools = (app.turns as any).deps.buildTools(r) as { name: string; run: (a: any) => Promise<string> }[];
  await tools.find((t) => t.name === 'add_due')!.run({ date: '2099-01-05', title: 'Passport expires', needs_decision: true });
  const item = app.store.list('due').find((d) => d.title === 'Passport expires')!;
  assert.ok(item.at && Date.now() - item.at < 5000);
  assert.equal(weekReport(app.store).flagged[0]!.title, 'Passport expires');
});
