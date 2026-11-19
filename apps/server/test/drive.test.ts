import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { OfficeDrive } from '../src/drive.ts';
import type { Store } from '../src/store.ts';

let scratch: string;
let root: string;
let outside: string;
let drive: OfficeDrive;
const drop = (...p: string[]) => path.join(root, 'Drop here', ...p);

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-drive-'));
  root = path.join(scratch, 'Office');
  outside = path.join(scratch, 'Elsewhere');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not for staff');
  const settings: Record<string, unknown> = { driveFolder: null };
  const store = { get: () => settings, update: (_k: string, _id: string, fn: (s: any) => void) => fn(settings) } as unknown as Store;
  drive = new OfficeDrive(store);
  fs.mkdirSync(root);
  drive.choose(root);

  fs.mkdirSync(drop('writers_room'));
  fs.writeFileSync(drop('writers_room', 'pilot.txt'), 'cold open');
  fs.mkdirSync(drop('empty'));
  fs.symlinkSync(outside, drop('shortcut out'));
  fs.symlinkSync(path.join(scratch, 'nowhere'), drop('dangling'));
  fs.symlinkSync(path.join(root, 'Filed'), drop('to filed'));
  fs.mkdirSync(drop('locked'));
  fs.writeFileSync(drop('locked', 'inside.txt'), 'x');
  fs.chmodSync(drop('locked'), 0o000);
});

after(() => {
  try { fs.chmodSync(drop('locked'), 0o755); } catch { /* gone */ }
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('a folder and what is in it are both listed', () => {
  const out = drive.list('Drop here');
  assert.match(out, /^Drop here\/writers_room\/ \| folder \|/m);
  assert.match(out, /^Drop here\/writers_room\/pilot\.txt \| 9 B \|/m);
  assert.match(out, /^Drop here\/empty\/ \| folder, empty \|/m);
  assert.match(drive.list('Drop here/writers_room'), /pilot\.txt/);
});

test('links and folders that cannot be opened are listed with the reason, not left out', () => {
  const out = drive.list('Drop here');
  assert.match(out, /^Drop here\/shortcut out \| link or shortcut to somewhere outside the office Drive folder, cannot be opened/m);
  assert.match(out, /^Drop here\/dangling \| link or shortcut, cannot be opened: where it leads is not on this Mac/m);
  assert.match(out, /^Drop here\/to filed \| link to the folder "Filed\/"/m);
  if (process.getuid?.() !== 0) assert.match(out, /^Drop here\/locked\/ \| folder, cannot be opened: this Mac does not let the office read it/m);
  assert.doesNotMatch(out, /secret\.txt/);
});

test('a link cannot carry staff outside the folder', () => {
  assert.throws(() => drive.list('Drop here/shortcut out'), /outside the office Drive folder by way of a link/);
  assert.throws(() => drive.put(path.join(outside, 'secret.txt'), 'Drop here/shortcut out/copied.txt'), /outside the office Drive folder by way of a link/);
  assert.equal(fs.existsSync(path.join(outside, 'copied.txt')), false);
  assert.throws(() => drive.move('Drop here/writers_room/pilot.txt', 'Drop here/shortcut out/pilot.txt'), /outside the office Drive folder by way of a link/);
  assert.equal(fs.existsSync(drop('writers_room', 'pilot.txt')), true);
});

test('a link itself can still be moved out of Drop here', () => {
  const moved = drive.move('Drop here/dangling', 'Filed/dangling');
  assert.equal(moved.to, 'Filed/dangling');
  assert.ok(fs.lstatSync(path.join(root, 'Filed', 'dangling')).isSymbolicLink());
});

test('an empty folder and a missing one are told apart', () => {
  assert.equal(drive.list('Drop here/empty'), 'Nothing in Drop here/empty.');
  assert.throws(() => drive.list('Drop here/not here'), /There is no folder/);
});
