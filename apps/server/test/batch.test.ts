import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { DemoEngine } from '../src/engine/demo.ts';
import type { EngineEvent, EngineTurn, RunOptions } from '../src/engine/types.ts';
import { createHttp } from '../src/http.ts';
import { canonical } from '../src/turns.ts';

const TOOL = 'mcp__claude_ai_Google_Calendar__create_event';
const game = (d: string) => ({ summary: `Pottery class ${d}`, start: { dateTime: `${d}T11:00:00` }, end: { dateTime: `${d}T12:00:00` } });
const GAMES = ['2027-01-09', '2027-01-16', '2027-01-23'];

/** What each call in the scripted turn came to: the batch's answer, then each calendar call. */
const outcomes: { batch?: string; calls: { input: unknown; ran: boolean }[] } = { calls: [] };

/** Puts three games to the owner as a batch, then makes the calls it was given, and one it was not. */
class BatchEngine extends DemoEngine {
  override run(o: RunOptions): EngineTurn {
    if (!o.prompt.includes('BATCH')) return super.run(o);
    const abort = new AbortController();
    async function* events(): AsyncGenerator<EngineEvent> {
      yield { type: 'session', sessionId: 'batch-test' };
      const t = o.tools.find((x) => x.name === 'request_batch')!;
      yield { type: 'tool-start', id: 'b1', name: 'mcp__bureau__request_batch', input: {} };
      // Keys in another order, as a model may write them: still the same call.
      outcomes.batch = await t.run({
        title: 'Add the winter pottery course to your calendar, 3 classes',
        items: GAMES.map((d) => ({ label: `Sat ${d}, 11:00`, tool: TOOL, input: game(d) })),
      });
      yield { type: 'tool-end', id: 'b1', ok: true };
      const calls = [...GAMES.map(game), { end: game(GAMES[0]!).end, start: game(GAMES[0]!).start, summary: game(GAMES[0]!).summary }, game('2027-02-13')];
      for (const [i, input] of calls.entries()) {
        const id = `c${i}`;
        yield { type: 'tool-start', id, name: TOOL, input };
        let ran = o.gate.check(TOOL, input, id).outcome === 'allow';
        if (!ran) {
          // Not part of what was signed: it waits for a signature of its own, which the test declines.
          const w = o.gate.wait(TOOL, input, abort.signal, id);
          ran = (await w).allow;
        }
        outcomes.calls.push({ input, ran });
        yield { type: 'tool-end', id, ok: ran };
      }
      yield { type: 'text', add: 'Done.' };
      yield { type: 'result', ok: true };
    }
    return { events: events(), interrupt: () => abort.abort() };
  }
}

let app: App;
let home: string;
let http: ReturnType<typeof createHttp>;
let cookie: string;
const post = (p: string, body: unknown) => http.request(`/api${p}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const until = async (ok: () => boolean) => { for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-batch-'));
  process.env.BUREAU_OWNER = 'Robin Hale';
  app = createApp({ home, engine: new BatchEngine({ speed: 0 }) });
  app.store.update('settings', 'settings', (s) => { s.undoSeconds = 0; s.checkSlips = false; });
  app.store.update('staff', 'hearth', (s) => { s.authority['calendar.write'] = 3; });
  http = createHttp(app, { webDist: home });
  cookie = app.auth.cookie(app.auth.pairLocal(), false).split(';')[0]!;
});

after(() => {
  app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('the same call written with its keys in another order compares equal', () => {
  assert.equal(canonical({ b: 1, a: { d: ' x ', c: [2, 1] } }), canonical({ a: { c: [2, 1], d: 'x' }, b: 1, e: undefined }));
  assert.notEqual(canonical({ a: [1, 2] }), canonical({ a: [2, 1] }));
});

test('one signature for a set: unticked items and anything else still need their own', async () => {
  const turn = app.turns.enqueue('hearth', { kind: 'owner', text: 'BATCH the games' });

  // One slip, every item in full, and the person shown as waiting on the owner.
  await until(() => app.store.list('slip').some((s) => s.batch && s.status === 'pending'));
  const slip = app.store.list('slip').find((s) => s.batch)!;
  assert.equal(slip.batch!.items.length, 3);
  assert.equal(slip.batch!.classId, 'calendar.write');
  assert.match(slip.batch!.items[0]!.title, /Put on your calendar: Pottery class 2027-01-09/);
  assert.equal(app.turns.allLive().find((l) => l.staffId === 'hearth')?.waitingSlipId, slip.id);

  // Nothing ticked is not a signature.
  assert.equal((await post(`/slips/${slip.id}/sign`, { items: [] })).status, 409);
  // The owner unticks the second game.
  assert.equal((await post(`/slips/${slip.id}/sign`, { items: [0, 2] })).status, 200);

  // The unticked game, a second use of a signed one, and a game never listed each come back as
  // slips of their own; decline all three.
  for (let n = 0; n < 3; n++) {
    await until(() => app.store.list('slip').some((s) => !s.batch && s.status === 'pending'));
    const single = app.store.list('slip').find((s) => !s.batch && s.status === 'pending')!;
    await post(`/slips/${single.id}/decline`, {});
  }
  await turn;

  assert.match(outcomes.batch ?? '', /Signed 2 of 3/);
  assert.match(outcomes.batch ?? '', /unticked 2 \(Sat 2027-01-16/);
  assert.deepEqual(outcomes.calls.map((c) => c.ran), [true, false, true, false, false]);
  const signed = app.store.get('slip', slip.id)!;
  assert.deepEqual(signed.batch!.approved, [0, 2]);
  assert.equal(signed.edited, true);
});

test('a batch holds one kind of action, and only actions that need a signature', async () => {
  const r = { staffId: 'hearth', origin: 'test', outside: new Set<string>(), grants: [], abort: new AbortController() } as any;
  const tool = ((app.turns as any).deps.buildTools(r) as { name: string; run: (a: unknown) => Promise<string> }[]).find((t) => t.name === 'request_batch')!;
  const mixed = await tool.run({ title: 'Two kinds at once', items: [{ label: 'a game', tool: TOOL, input: game('2027-01-09') }, { label: 'a mail', tool: 'mcp__claude_ai_Gmail__send_email', input: { to: 'x@example.com' } }] });
  assert.match(mixed, /One batch holds one kind of action/);
  const free = await tool.run({ title: 'Read two files', items: [{ label: 'a', tool: 'Read', input: { file_path: 'notes/a.md' } }, { label: 'b', tool: 'Read', input: { file_path: 'notes/b.md' } }] });
  assert.match(free, /needs no signature/);
  app.store.update('staff', 'hearth', (s) => { s.authority['calendar.write'] = 4; });
  const already = await tool.run({ title: 'Two games', items: GAMES.slice(0, 2).map((d) => ({ label: d, tool: TOOL, input: game(d) })) });
  assert.match(already, /already do this kind of thing without a signature/);
  app.store.update('staff', 'hearth', (s) => { s.authority['calendar.write'] = 3; });
});
