import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { kindOf, nextVersionPath, versionOf } from '../src/artifacts.ts';
import { DemoEngine } from '../src/engine/demo.ts';
import { createHttp } from '../src/http.ts';

let app: App;
let home: string;
let driveDir: string;
let http: ReturnType<typeof createHttp>;
let cookie: string;
let who: string;
const lib = (...p: string[]) => path.join(app.staffRoot, who, 'library', ...p);
const write = (rel: string, text: string, mtime?: number) => {
  fs.mkdirSync(path.dirname(lib(rel)), { recursive: true });
  fs.writeFileSync(lib(rel), text);
  if (mtime) fs.utimesSync(lib(rel), mtime / 1000, mtime / 1000);
};
const post = (p: string, body: unknown) => http.request(`/api${p}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (p: string) => http.request(`/api${p}`, { headers: { cookie } });

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-artifacts-'));
  driveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-artifacts-drive-'));
  process.env.BUREAU_OWNER = 'Robin Hale';
  app = createApp({ home, engine: new DemoEngine({ speed: 0 }) });
  app.drive.choose(driveDir);
  http = createHttp(app, { webDist: home });
  cookie = app.auth.cookie(app.auth.pairLocal(), false).split(';')[0]!;
  who = app.store.list('staff').find((s) => !s.isChief)!.id;
});

after(() => {
  app.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(driveDir, { recursive: true, force: true });
});

test('a version mark makes files one piece of work', () => {
  assert.deepEqual(versionOf('Pilot - Cold Open v3 - 2026-11-16.fountain'), { key: 'Pilot - Cold Open - 2026-11-16.fountain', title: 'Pilot - Cold Open', n: 3 });
  assert.equal(versionOf('Pilot - Cold Open - 2026-11-16.fountain').key, 'Pilot - Cold Open - 2026-11-16.fountain');
  assert.equal(versionOf('pilot/budget_v2.csv').key, path.join('pilot', 'budget.csv'));
  assert.equal(versionOf('notes (v4).md').key, 'notes.md');
  assert.equal(versionOf('Form W-9 review.md').n, 1);
  assert.equal(versionOf('dev2 plan.md').n, 1);
  assert.equal(kindOf('a.fountain'), 'script');
  assert.equal(kindOf('a.HTML'), 'page');
  assert.equal(kindOf('a.docx'), 'file');
});

test('the library is listed as pieces with their versions, newest first', async () => {
  const t = Date.now() - 3_600_000;
  write('pilot/Cold Open - 2026-11-16.fountain', 'INT. ROOM - DAY', t);
  write('pilot/Cold Open v2 - 2026-11-16.fountain', 'INT. ROOM - NIGHT', t + 1000);
  write('pilot/Cold Open v3 - 2026-11-16.fountain', 'EXT. ROOF - NIGHT', t + 2000);
  write('Spend by month.html', '<p>chart</p>', t + 5000);
  write('.DS_Store', 'x');
  const res = await get(`/artifacts?staff=${who}`);
  const { artifacts } = (await res.json()) as { artifacts: any[] };
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].title, 'Spend by month');
  assert.equal(artifacts[0].kind, 'page');
  const script = artifacts[1];
  assert.equal(script.title, 'Cold Open');
  assert.equal(script.folder, 'pilot');
  assert.deepEqual(script.versions.map((v: any) => v.label), ['Version 3', 'Version 2', 'Version 1']);
  assert.equal(script.versions[0].path, path.join('pilot', 'Cold Open v3 - 2026-11-16.fountain'));
});

test('a file is served only from inside the library', async () => {
  const ok = await get(`/artifacts/file?staff=${who}&path=${encodeURIComponent('Spend by month.html')}`);
  assert.equal(ok.status, 200);
  // A page comes back as text, never as a page that could run here.
  assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/);
  assert.match(ok.headers.get('content-security-policy') ?? '', /sandbox/);
  fs.writeFileSync(path.join(app.staffRoot, who, 'notes', 'memory.md'), 'private');
  assert.equal((await get(`/artifacts/file?staff=${who}&path=${encodeURIComponent('../notes/memory.md')}`)).status, 404);
  fs.symlinkSync(path.join(app.staffRoot, who, 'notes'), lib('linked'));
  assert.equal((await get(`/artifacts/file?staff=${who}&path=${encodeURIComponent('linked/memory.md')}`)).status, 404);
  fs.unlinkSync(lib('linked'));
});

test('retiring takes a piece off the list and keeps the files', async () => {
  const id = 'Spend by month.html';
  const r = await post('/artifacts/retire', { staff: who, id });
  assert.equal(r.status, 200);
  const a = app.artifacts.get(who, id)!;
  assert.ok(a.retiredAt);
  assert.ok(fs.existsSync(lib(id)));
  await post('/artifacts/retire', { staff: who, id, retired: false });
  assert.equal(app.artifacts.get(who, id)!.retiredAt, null);
});

test('saving to Drive copies the newest version once, under From staff and the person', async () => {
  const id = path.join('pilot', 'Cold Open - 2026-11-16.fountain');
  const name = app.store.get('staff', who)!.name;
  const first = (await (await post('/artifacts/drive', { staff: who, id })).json()) as { to: string; already: boolean };
  assert.equal(first.to, path.join('From staff', name, 'Cold Open v3 - 2026-11-16.fountain'));
  assert.equal(first.already, false);
  assert.equal(fs.readFileSync(path.join(driveDir, first.to), 'utf8'), 'EXT. ROOF - NIGHT');
  const again = (await (await post('/artifacts/drive', { staff: who, id })).json()) as { to: string; already: boolean };
  assert.equal(again.already, true);
  // An older version, and a name already taken in Drive, get a name of their own.
  fs.writeFileSync(path.join(driveDir, 'From staff', name, 'Cold Open v2 - 2026-11-16.fountain'), 'the owner’s own copy');
  const older = (await (await post('/artifacts/drive', { staff: who, id, version: path.join('pilot', 'Cold Open v2 - 2026-11-16.fountain') })).json()) as { to: string };
  assert.equal(older.to, path.join('From staff', name, 'Cold Open v2 - 2026-11-16 (2).fountain'));
  assert.equal(app.artifacts.get(who, id)!.drive.length, 2);
});

test('the next version keeps the name and the mark where they were', () => {
  assert.equal(nextVersionPath('Cold Open v3 - 2026-11-16.fountain', 4), 'Cold Open v4 - 2026-11-16.fountain');
  assert.equal(nextVersionPath(path.join('pilot', 'Cold Open - 2026-11-16.fountain'), 2), path.join('pilot', 'Cold Open v2 - 2026-11-16.fountain'));
  assert.equal(nextVersionPath('budget_v2.csv', 3), 'budget_v3.csv');
  assert.equal(nextVersionPath('notes (v4).md', 5), 'notes (v5).md');
  assert.equal(nextVersionPath('Treatment.md', 2), 'Treatment v2.md');
  for (const name of ['Cold Open v3 - 2026-11-16.fountain', 'budget_v2.csv', 'notes (v4).md', 'Treatment.md']) {
    assert.equal(versionOf(nextVersionPath(name, 7)).key, versionOf(name).key);
  }
});

test('notes on passages go to the writer as one message; the owner’s edit is the next version', async () => {
  const id = path.join('pilot', 'Cold Open - 2026-11-16.fountain');
  const v3 = path.join('pilot', 'Cold Open v3 - 2026-11-16.fountain');
  const add = (body: object) => post('/artifacts/notes', { staff: who, id, path: v3, before: '', ...body });
  assert.equal((await add({ quote: 'EXT. ROOF - NIGHT', text: 'Start inside; the roof comes later.' })).status, 200);
  assert.equal((await add({ quote: '', text: 'Shorter overall.' })).status, 200);
  assert.equal((await add({ quote: 'x', text: '   ' })).status, 400);
  assert.equal((await post('/artifacts/notes', { staff: who, id: 'Spend by month.html', path: 'Spend by month.html', quote: 'a', before: '', text: 'b' })).status, 400);

  // The owner changes a line themselves: a new file, the next version, marked as theirs.
  const edit = (await (await post('/artifacts/edit', { staff: who, id, base: v3, text: 'INT. STAIRWELL - NIGHT' })).json()) as { path: string };
  assert.equal(edit.path, path.join('pilot', 'Cold Open v4 - 2026-11-16.fountain'));
  assert.equal(fs.readFileSync(lib(v3), 'utf8'), 'EXT. ROOF - NIGHT');
  const a = app.artifacts.get(who, id)!;
  assert.equal(a.versions[0]!.path, edit.path);
  assert.equal(a.versions[0]!.byOwner, true);
  assert.equal((await post('/artifacts/edit', { staff: who, id, base: edit.path, text: 'INT. STAIRWELL - NIGHT' })).status, 400);

  const sent = await post('/artifacts/notes/send', { staff: who, id });
  assert.equal(sent.status, 200);
  const rows = app.store.thread(who, null, 50).rows.map((r) => r.body as { type: string; from?: string; text?: string });
  const msg = rows.filter((r) => r.type === 'message' && r.from === 'owner').pop()!.text!;
  assert.match(msg, /Notes on “Cold Open”, 2 notes\./);
  assert.match(msg, /1\. On “EXT\. ROOF - NIGHT” \(in version 3, library\/pilot\/Cold Open v3 - 2026-11-16\.fountain\): Start inside/);
  assert.match(msg, /2\. On the whole piece .*: Shorter overall\./);
  assert.match(msg, /I made changes myself in version 4 \(library\/pilot\/Cold Open v4 - 2026-11-16\.fountain\)/);
  assert.match(msg, /save the result as the next version/);
  const notes = (await (await get(`/artifacts/notes?staff=${who}&id=${encodeURIComponent(id)}`)).json()) as { notes: { id: string; sentAt: number | null }[] };
  assert.ok(notes.notes.every((n) => n.sentAt));
  // Nothing new: nothing to send.
  assert.equal((await post('/artifacts/notes/send', { staff: who, id })).status, 400);
  // A sent note can be put away but not removed or rewritten.
  const first = notes.notes[0]!.id;
  assert.equal((await http.request(`/api/artifacts/notes/${first}`, { method: 'DELETE', headers: { cookie } })).status, 400);
  assert.equal((await http.request(`/api/artifacts/notes/${first}/change`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
});

test('deleting removes every version and the folder it leaves empty', async () => {
  const id = path.join('pilot', 'Cold Open - 2026-11-16.fountain');
  const r = (await (await post('/artifacts/delete', { staff: who, id })).json()) as { files: number };
  assert.equal(r.files, 4);
  assert.equal(app.artifacts.notes(who, id).length, 0);
  assert.equal(fs.existsSync(lib('pilot')), false);
  assert.ok(fs.existsSync(lib()));
  assert.equal(app.artifacts.get(who, id), undefined);
  assert.equal((await post('/artifacts/delete', { staff: who, id })).status, 400);
  // The copies in Drive are the owner's and stay.
  assert.ok(fs.existsSync(path.join(driveDir, 'From staff')));
});

test('new work stands out until the owner opens it; work from before counts as seen', async () => {
  const old = Date.now() - 86_400_000;
  write('Old memo.md', '# Old', old);
  // The first listing sets where "new" starts, so an office's existing work is not all new.
  assert.equal(app.artifacts.get(who, 'Old memo.md')!.fresh, false);
  await new Promise((res) => setTimeout(res, 5));
  write('Fresh memo.md', '# Fresh');
  assert.equal(app.artifacts.get(who, 'Fresh memo.md')!.fresh, true);
  await new Promise((res) => setTimeout(res, 5));
  const r = await post('/artifacts/seen', { staff: who, id: 'Fresh memo.md' });
  assert.equal(r.status, 200);
  assert.equal(app.artifacts.get(who, 'Fresh memo.md')!.fresh, false);
  // A new version from staff makes it new again; one the owner saved does not.
  write('Fresh memo v2.md', '# Fresh again', Date.now() + 5000);
  assert.equal(app.artifacts.get(who, 'Fresh memo.md')!.fresh, true);
});

test('staff mark pieces for the owner by path or title; the mark clears when opened', async () => {
  write('Budget 2027 v2 - 2026-11-19.csv', 'a,b\n1,2\n', Date.now() - 60_000);
  const chief = app.store.list('staff').find((s) => s.isChief)!;
  const r = { staffId: who, outside: new Set<string>(), origin: 'test', depth: 0 };
  const mine = (app.turns as any).deps.buildTools(r) as { name: string; shape: Record<string, unknown>; run: (a: any) => Promise<string> }[];
  const mark = mine.find((t) => t.name === 'mark_artifacts')!;
  assert.equal('staff' in mark.shape, false, 'only the chief of staff marks in other libraries');
  const out = await mark.run({ pieces: ['library/Budget 2027 v2 - 2026-11-19.csv', { piece: 'Old memo', why: 'for your rewrite' }, 'No such thing'], why: 'the budget you asked about' });
  assert.match(out, /Marked for .*“Budget 2027”, “Old memo”/);
  assert.match(out, /Not found in your library: No such thing\. What is there:/);
  const a = app.artifacts.get(who, 'Budget 2027 - 2026-11-19.csv')!;
  assert.deepEqual({ by: a.marked?.by, why: a.marked?.why }, { by: who, why: 'the budget you asked about' });
  assert.equal(app.artifacts.get(who, 'Old memo.md')!.marked?.why, 'for your rewrite', 'a piece can carry its own words');

  const chiefTools = (app.turns as any).deps.buildTools({ ...r, staffId: chief.id }) as typeof mine;
  const name = app.store.get('staff', who)!.name;
  assert.match(await chiefTools.find((t) => t.name === 'mark_artifacts')!.run({ pieces: ['Fresh memo'], staff: name }), /Marked for/);
  assert.equal(app.artifacts.get(who, 'Fresh memo.md')!.marked?.by, chief.id);

  await post('/artifacts/seen', { staff: who, id: a.id });
  assert.equal(app.artifacts.get(who, a.id)!.marked, null);
});
