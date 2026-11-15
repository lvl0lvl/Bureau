import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { classify, decide } from '../src/authority.ts';
import { archiveName, Backup, findAge, keep, restore } from '../src/backup.ts';
import { findBd } from '../src/work.ts';
import { DemoEngine } from '../src/engine/demo.ts';
import { systemAppend } from '../src/prompt.ts';

// Backups run against the real age program. Without it they cannot be made, and the office says so.
const age = findAge();
const needsAge = { skip: age ? false : 'age is not installed', timeout: 120_000 };

let app: App;
let home: string;
let drive: string;
let scratch: string;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-backup-test-'));
  home = path.join(scratch, 'office');
  drive = path.join(scratch, 'My Drive', 'Office');
  fs.mkdirSync(home);
  fs.mkdirSync(drive, { recursive: true });
  process.env.BUREAU_OWNER = 'Robin Hale';
  app = createApp({ home, engine: new DemoEngine({ speed: 0 }), work: false });
});

after(async () => {
  await new Promise((r) => setTimeout(r, 50));
  app.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const gate = () => ({ home: path.join(app.staffRoot, 'tally'), books: app.books.dir, staffRoot: app.staffRoot, knownEmails: new Set<string>(), drive: app.drive.folder });
const briefing = () => systemAppend(app.store.get('staff', 'tally')!, app.store.list('staff'), app.store.get('settings', 'settings')!, {
  home: path.join(app.staffRoot, 'tally'), books: app.books.dir, drive: app.drive.briefing('Robin'),
});

test('which archives are kept: the newest of each recent day and of each recent month', () => {
  const names: string[] = [];
  for (let d = 1; d <= 28; d += 1) names.push(`bureau-2026-11-${String(d).padStart(2, '0')}-0300.tar.gz.age`);
  names.push('bureau-2026-11-28-1415.tar.gz.age', 'bureau-2026-10-31-0300.tar.gz.age', 'bureau-2026-10-12-0300.tar.gz.age', 'bureau-2025-06-02-0300.tar.gz.age', 'holiday photos.zip');
  const kept = keep(names);
  // Fourteen days back from the newest, taking the later of two made on the same day.
  assert.ok(kept.has('bureau-2026-11-28-1415.tar.gz.age'));
  assert.ok(!kept.has('bureau-2026-11-28-0300.tar.gz.age'));
  assert.ok(kept.has('bureau-2026-11-15-0300.tar.gz.age'));
  assert.ok(!kept.has('bureau-2026-11-14-0300.tar.gz.age'));
  // One a month before that.
  assert.ok(kept.has('bureau-2026-10-31-0300.tar.gz.age'));
  assert.ok(!kept.has('bureau-2026-10-12-0300.tar.gz.age'));
  assert.ok(kept.has('bureau-2025-06-02-0300.tar.gz.age'));
  // Anything that is not one of ours is never considered.
  assert.ok(!kept.has('holiday photos.zip'));
  assert.equal(kept.size, 16);
  assert.equal(archiveName(Date.UTC(2026, 10, 14, 2, 5), 'America/New_York'), 'bureau-2026-11-13-2105.tar.gz.age');
});

test('with no Drive folder, staff are told nothing about one and backups say what is missing', () => {
  assert.equal(app.drive.folder, null);
  assert.doesNotMatch(briefing(), /drive_list/);
  assert.equal(app.backup.status().hasKey, false);
  if (age) assert.match(app.backup.status().problem!, /Choose the office’s Drive folder/);
});

test('choosing the folder lays it out, and a folder that cannot be seen is never created', () => {
  const missing = path.join(scratch, 'Not mounted', 'Office');
  app.drive.choose(missing);
  assert.equal(app.drive.found, false);
  assert.equal(fs.existsSync(missing), false, 'the office must not make a stray local copy of a Drive folder');
  assert.throws(() => app.drive.list(), /cannot be seen/);
  assert.throws(() => app.drive.choose(os.homedir()), /inside your Drive/);

  app.drive.choose(drive);
  assert.equal(app.store.get('settings', 'settings')!.driveFolder, drive);
  for (const f of ['Drop here', 'From staff', 'Filed', 'Backups']) {
    assert.ok(fs.statSync(path.join(drive, f)).isDirectory(), f);
    assert.ok(fs.existsSync(path.join(drive, f, 'About this folder.txt')), `${f} explains itself`);
  }
  assert.match(fs.readFileSync(path.join(drive, 'About this folder.txt'), 'utf8'), /Drop here/);
  // Something the owner keeps beside the office's folders is left alone.
  fs.mkdirSync(path.join(drive, 'My own things'));
  app.drive.ensure();
  assert.ok(fs.existsSync(path.join(drive, 'My own things')));
  assert.equal(app.drive.status().folders.find((f) => f.name === 'Drop here')!.files, 0);
  assert.match(briefing(), /drive_list/);
  assert.ok(briefing().includes(drive));
});

test('staff can file what the owner drops, but cannot reach Backups or leave the folder', () => {
  fs.writeFileSync(path.join(drive, 'Drop here', 'acme.pdf'), 'receipt');
  fs.writeFileSync(path.join(drive, 'Backups', 'bureau-2026-01-01-0300.tar.gz.age'), 'x');
  const listing = app.drive.list();
  assert.match(listing, /Drop here\/acme\.pdf \| 7 B/);
  assert.doesNotMatch(listing, /Backups|About this folder/);
  assert.equal(app.drive.status().folders.find((f) => f.name === 'Drop here')!.files, 1);

  const moved = app.drive.move('Drop here/acme.pdf', 'Filed/2026/Receipts/2026-11-06 Acme 42.10.pdf');
  assert.equal(moved.to, 'Filed/2026/Receipts/2026-11-06 Acme 42.10.pdf');
  assert.ok(fs.existsSync(path.join(drive, moved.to)));
  assert.equal(fs.existsSync(path.join(drive, 'Drop here', 'acme.pdf')), false);

  fs.writeFileSync(path.join(drive, 'Drop here', 'again.pdf'), 'second');
  assert.throws(() => app.drive.move('Drop here/again.pdf', moved.to), /already exists/);
  assert.throws(() => app.drive.move('Drop here/again.pdf', '../outside.pdf'), /outside the office Drive folder/);
  assert.throws(() => app.drive.move('Drop here/again.pdf', 'Backups/again.pdf'), /Backups folder is the office’s own/);
  assert.throws(() => app.drive.move('Backups/bureau-2026-01-01-0300.tar.gz.age', 'Filed/x.age'), /Backups folder is the office’s own/);
  assert.throws(() => app.drive.move('Filed', 'Old'), /part of the office’s layout/);
  assert.throws(() => app.drive.list('Backups'), /Backups folder is the office’s own/);

  const report = path.join(app.staffRoot, 'tally', 'library', 'october.md');
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, '# October');
  assert.equal(app.drive.put(report, 'From staff/October close.md').to, 'From staff/October close.md');
  assert.throws(() => app.drive.put(report, 'From staff/October close.md'), /already exists/);
  fs.rmSync(path.join(drive, 'Backups', 'bureau-2026-01-01-0300.tar.gz.age'));
});

test('the Drive folder counts as Drive at the gate, and what is read there is outside material', () => {
  const read = classify('Read', { file_path: path.join(drive, 'Drop here', 'again.pdf') }, gate());
  assert.equal(read.classId, 'drive.change');
  assert.equal(read.mode, 'read');
  assert.match(read.outside!, /again\.pdf” in the office Drive folder/);
  assert.equal(decide(0, read, { tainted: false }).outcome, 'deny');
  assert.equal(decide(1, read, { tainted: false }).outcome, 'allow');

  const write = classify('Write', { file_path: path.join(drive, 'From staff', 'note.md'), content: 'hello' }, gate());
  assert.equal(write.classId, 'drive.change');
  assert.equal(write.mode, 'execute');
  assert.equal(decide(2, write, { tainted: false }).outcome, 'deny');
  assert.equal(decide(3, write, { tainted: false }).outcome, 'ask');
  assert.equal(decide(4, write, { tainted: false }).outcome, 'allow');

  for (const tool of ['Read', 'Write']) {
    const c = classify(tool, { file_path: path.join(drive, 'Backups', 'bureau-2026-11-13-0300.tar.gz.age'), content: '' }, gate());
    assert.match(c.refuse!, /Backups folder/);
    assert.equal(decide(4, c, { tainted: false }).outcome, 'deny');
  }

  const move = classify('mcp__bureau__drive_move', { from: 'Drop here/a.pdf', to: 'Filed/2026/a.pdf' }, gate());
  assert.equal(move.classId, 'drive.change');
  assert.equal(move.mode, 'execute');
  assert.match(move.slip.title, /Move in Drive: Drop here\/a\.pdf to Filed\/2026\/a\.pdf/);
  assert.equal(classify('mcp__bureau__drive_put', { from: 'library/x.md', to: 'From staff/x.md' }, gate()).classId, 'drive.change');
  const list = classify('mcp__bureau__drive_list', {}, gate());
  assert.equal(list.mode, 'read');
  assert.ok(list.outside);
  assert.equal(classify('mcp__bureau__report_done', { text: 'x' }, gate()).classId, null);
  assert.equal(classify('Bash', { command: `cat "${drive}/Drop here/again.pdf"` }, gate()).outside, 'The office Drive folder');
  // A file elsewhere on the Mac is still a file on the Mac.
  assert.equal(classify('Read', { file_path: path.join(scratch, 'elsewhere.txt') }, gate()).classId, 'mac.files');
});

test('backups need a recovery key, which the office hands over once and does not keep', needsAge, () => {
  assert.match(app.backup.status().problem!, /Create a recovery key/);
  const key = app.backup.createKey();
  assert.match(key, /^AGE-SECRET-KEY-1[A-Z0-9]+$/);
  const st = app.backup.status();
  assert.equal(st.hasKey, true);
  assert.equal(st.problem, null);
  assert.equal(st.keyEnding!.length, 6);
  assert.throws(() => app.backup.createKey(), /already a recovery key/);
  // Nothing the office keeps contains the key.
  app.store.flushStreams();
  const db = new DatabaseSync(path.join(home, 'bureau.db'), { readOnly: true });
  const bodies = (db.prepare('SELECT body FROM docs').all() as { body: string }[]).map((r) => r.body).join('\n');
  db.close();
  assert.doesNotMatch(bodies, /AGE-SECRET-KEY/);
  assert.match(bodies, /age1[a-z0-9]{50,}/);
  (globalThis as any).__key = key;
});

test('a backup is one encrypted file, and restoring it with the key rebuilds the office', needsAge, async () => {
  const key: string = (globalThis as any).__key;
  app.store.update('staff', 'tally', (s) => { s.about = 'Keeps the books, as backed up.'; });
  fs.writeFileSync(path.join(app.books.dir, 'backup-check.md'), 'In the Books when the backup was made.\n');
  fs.mkdirSync(path.join(home, 'catalog', 'big-clone'), { recursive: true });
  fs.writeFileSync(path.join(home, 'catalog', 'big-clone', 'SKILL.md'), 'fetched, not backed up');

  const made = await app.backup.run();
  assert.match(made.file, /^bureau-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz\.age$/);
  const file = path.join(drive, 'Backups', made.file);
  assert.equal(fs.statSync(file).size, made.bytes);
  const raw = fs.readFileSync(file);
  assert.equal(raw.subarray(0, 21).toString(), 'age-encryption.org/v1');
  assert.equal(raw.includes('backed up'), false, 'nothing readable in the archive');
  assert.deepEqual(fs.readdirSync(path.join(drive, 'Backups')).filter((n) => n.endsWith('.partial')), []);
  assert.equal(app.backup.status().last!.file, made.file);
  assert.equal(app.backup.status().kept, 1);

  const dest = path.join(scratch, 'restored');
  const done = await restore({ archive: file, dest, key });
  assert.deepEqual((done.manifest as any).staff.includes('Tally'), true);
  const db = new DatabaseSync(path.join(dest, 'bureau.db'), { readOnly: true });
  const tally = JSON.parse((db.prepare("SELECT body FROM docs WHERE kind = 'staff' AND id = 'tally'").get() as { body: string }).body);
  db.close();
  assert.equal(tally.about, 'Keeps the books, as backed up.');
  assert.equal(fs.readFileSync(path.join(dest, 'books', 'backup-check.md'), 'utf8'), 'In the Books when the backup was made.\n');
  assert.ok(fs.existsSync(path.join(dest, 'books', '.git')), 'the history of the Books comes too');
  assert.ok(fs.existsSync(path.join(dest, 'staff', 'tally')));
  assert.equal(fs.existsSync(path.join(dest, 'catalog')), false);
  assert.deepEqual(fs.readdirSync(dest).filter((n) => /^bureau\.db-/.test(n)), []);

  // The restored folder runs as an office.
  const again = createApp({ home: dest, engine: new DemoEngine({ speed: 0 }), work: false });
  try {
    assert.equal(again.store.get('staff', 'tally')!.about, 'Keeps the books, as backed up.');
    assert.equal(again.backup.status().hasKey, true);
  } finally {
    again.close();
  }

  await assert.rejects(restore({ archive: file, dest, key }), /is not empty/);
  const other = execFileSync(age!.keygen, [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const wrong = path.join(scratch, 'wrong-key');
  await assert.rejects(restore({ archive: file, dest: wrong, key: other }), /does not open this archive/);
  assert.equal(fs.existsSync(wrong), false, 'a failed restore leaves nothing behind');
  await assert.rejects(restore({ archive: file, dest: wrong, key: 'hunter2' }), /not a recovery key/);
});

test('one backup a day: it waits for staff to finish, and says so on the Desk when it cannot run', needsAge, async () => {
  const day = 86_400_000;
  const first = app.backup.status().last!;
  // Later the same day: nothing to do.
  await app.backup.tick(first.at + 60_000);
  assert.equal(app.backup.status().last!.file, first.file);

  // The next day, with the Drive folder gone (Google Drive not running).
  const hidden = `${drive}-hidden`;
  fs.renameSync(drive, hidden);
  await app.backup.tick(first.at + day + 60_000);
  assert.match(app.backup.status().lastError!.message, /cannot be seen/);
  assert.equal(app.store.get('due', 'due_backup'), undefined, 'one missed night is not yet worth a notice');
  await app.backup.tick(first.at + 2 * day);
  const notice = app.store.get('due', 'due_backup')!;
  assert.equal(notice.title, 'The office is not being backed up');
  assert.match(notice.note!, /Google Drive may not be running/);
  assert.equal(notice.attention, true);
  assert.equal(fs.existsSync(drive), false);

  // Drive comes back: the next check makes the backup and takes the notice off the Desk.
  fs.renameSync(hidden, drive);
  await app.backup.tick(Date.now() + 2 * day);
  assert.equal(app.store.get('due', 'due_backup'), undefined);
  assert.equal(app.backup.status().lastError, null);
  assert.ok(app.backup.status().last!.at >= first.at);

  // While someone is working, the nightly backup holds off, but not for more than two hours.
  const before = app.backup.status().last!.at;
  const patient = new Backup({ store: app.store, home, drive: app.drive, busy: () => true });
  const night = Date.now() + 5 * day;
  await patient.tick(night);
  await patient.tick(night + 3_600_000);
  assert.equal(app.backup.status().last!.at, before);
  await patient.tick(night + 3 * 3_600_000);
  assert.ok(app.backup.status().last!.at > before);
});

test('the work list is backed up while nothing is writing to it', { skip: age && findBd() ? false : 'needs age and beads', timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-backup-work-'));
  const office = path.join(dir, 'office');
  const cloud = path.join(dir, 'drive');
  fs.mkdirSync(office);
  fs.mkdirSync(cloud);
  const full = createApp({ home: office, engine: new DemoEngine({ speed: 0 }) });
  try {
    assert.equal(await full.work.ready(), true);
    const item = await full.work.add('owner', { title: 'Something still open when the backup ran' });
    full.drive.choose(cloud);
    const key = full.backup.createKey();
    // A change to the work list made at the same moment waits its turn; both finish.
    const [made] = await Promise.all([full.backup.run(), full.work.note('owner', item.id, 'Noted during the backup.')]);
    const dest = path.join(dir, 'restored');
    await restore({ archive: path.join(cloud, 'Backups', made.file), dest, key });
    assert.ok(fs.existsSync(path.join(dest, 'work', '.beads')));
    const again = createApp({ home: dest, engine: new DemoEngine({ speed: 0 }) });
    try {
      assert.equal(await again.work.ready(), true);
      await again.work.refresh();
      assert.equal(again.work.get(item.id)!.title, 'Something still open when the backup ran');
    } finally {
      again.close();
    }
  } finally {
    await new Promise((r) => setTimeout(r, 50));
    full.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
