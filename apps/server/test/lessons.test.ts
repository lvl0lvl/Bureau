import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Slip } from '../../../shared/contract.ts';
import { createApp, type App } from '../src/app.ts';
import { DemoEngine } from '../src/engine/demo.ts';
import { LESSONS_HEADING } from '../src/prompt.ts';

let app: App;
let home: string;
let engine: DemoEngine;
let asked: string[] = [];
let answer: string | ((prompt: string) => string) = 'NONE';

const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); };
const settle = () => new Promise((r) => setTimeout(r, 40));
const lessons = (status = 'pending') => app.store.list('slip').filter((s) => s.kind === 'lesson' && s.status === status);
const mail = (text: string, staffId = 'piper'): Slip => app.slips.create({
  kind: 'action', staffId, title: 'Reply to Priya Raman', detail: 'Confirms Thursday.', origin: { trigger: 'Duty: Clear the inbox', read: ['Mail from priya@northbeam.example'] },
  actionClass: 'mail.send', draft: { meta: [{ label: 'To', value: 'priya@northbeam.example' }], text, editable: true },
}, { needsWaiter: false });
const LONG = 'Hi Priya,\n\nThank you so much for your wonderfully detailed note. Thursday at 2:00 pm works well for me. I have attached the current deck, which now includes the pilot numbers.\n\nKind regards,\nRobin Hale';

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-lessons-'));
  process.env.BUREAU_OWNER = 'Robin Hale';
  engine = new DemoEngine({ speed: 0 });
  app = createApp({ home, engine });
  app.store.update('settings', 'settings', (s) => { s.undoSeconds = 0; s.checkSlips = false; });
  engine.ask = async (o) => { asked.push(o.prompt); return typeof answer === 'function' ? answer(o.prompt) : answer; };
});

after(() => {
  app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a draft signed as written teaches nothing and nobody is asked', async () => {
  asked = [];
  const slip = mail(LONG);
  app.slips.sign(slip.id, LONG);
  await until(() => app.store.get('slip', slip.id)!.status === 'signed');
  await settle();
  assert.equal(asked.length, 0);
  assert.equal(lessons().length, 0);
});

test('an edited draft proposes a rule; signing it puts the rule in that person\'s profile', async () => {
  asked = [];
  answer = '- "Keep replies short: two or three sentences unless more is asked for."';
  const profile = app.store.get('staff', 'piper')!.instructions;
  const slip = mail(LONG);
  app.slips.sign(slip.id, 'Hi Priya,\n\nThursday at 2:00 pm works. Deck attached.\n\nRobin');
  await until(() => lessons().length === 1);

  // The model was shown both versions and the profile, and nothing else decides.
  assert.match(asked[0]!, /as Piper wrote it ---\nHi Priya,\n\nThank you so much/);
  assert.match(asked[0]!, /as Robin signed it ---\nHi Priya,\n\nThursday at 2:00 pm works\. Deck attached\./);

  const lesson = lessons()[0]!;
  assert.equal(lesson.draft!.text, 'Keep replies short: two or three sentences unless more is asked for.');
  assert.equal(lesson.draft!.editable, true);
  assert.deepEqual(lesson.lesson, { staffId: 'piper', from: 'edit', about: 'Reply to Priya Raman' });
  assert.equal(lesson.origin.trigger, 'Your edit of “Reply to Priya Raman”');
  // It carries the outside material the corrected draft traced back to.
  assert.deepEqual(lesson.origin.read, ['Mail from priya@northbeam.example']);
  assert.equal(lesson.check, undefined);
  // Nothing is learned until it is signed.
  assert.equal(app.store.get('staff', 'piper')!.instructions, profile);

  // Robin tightens the wording before signing; their wording is what is kept.
  app.slips.sign(lesson.id, 'Keep replies to three sentences.');
  await until(() => app.store.get('slip', lesson.id)!.status === 'signed');
  const learned = app.store.get('staff', 'piper')!.instructions;
  assert.ok(learned.startsWith(profile.trimEnd()));
  assert.ok(learned.endsWith(`${LESSONS_HEADING}\n- Keep replies to three sentences.`));
  // Editing a rule is not itself a correction to learn from, and rules do not count toward the record.
  await settle();
  assert.equal(lessons().length, 0);
  assert.equal(app.store.get('staff', 'piper')!.record.edited, 1);
});

test('a second rule joins the first under the same heading; one the profile already has is not proposed again', async () => {
  answer = 'Sign off with the first name only.';
  const a = mail(LONG);
  app.slips.sign(a.id, LONG.replace('Robin Hale', 'Robin'));
  await until(() => lessons().length === 1);
  const rule = lessons()[0]!;
  app.slips.sign(rule.id);
  await until(() => app.store.get('slip', rule.id)!.status === 'signed');
  const learned = app.store.get('staff', 'piper')!.instructions;
  assert.ok(learned.endsWith(`${LESSONS_HEADING}\n- Keep replies to three sentences.\n- Sign off with the first name only.`));
  assert.equal(learned.split(LESSONS_HEADING).length, 2);

  const b = mail(LONG);
  app.slips.sign(b.id, LONG.replace('Robin Hale', 'Robin'));
  await until(() => app.store.get('slip', b.id)!.status === 'signed');
  await settle();
  assert.equal(lessons().length, 0);
});

test('NONE proposes nothing, and a declined rule is dropped', async () => {
  answer = 'NONE';
  const a = mail(LONG, 'tally');
  app.slips.sign(a.id, LONG.replace('2:00 pm', '3:00 pm'));
  await until(() => app.store.get('slip', a.id)!.status === 'signed');
  await settle();
  assert.equal(lessons().length, 0);

  answer = 'Put the amount in the first line of every invoice note.';
  const before = app.store.get('staff', 'tally')!.instructions;
  const b = mail(LONG, 'tally');
  app.slips.sign(b.id, `$2,584.20 due.\n\n${LONG}`);
  await until(() => lessons().length === 1);
  app.slips.decline(lessons()[0]!.id, 'Not a rule');
  await settle();
  assert.equal(app.store.get('staff', 'tally')!.instructions, before);
  // Declining a rule, even with a reason, does not ask for another.
  assert.equal(lessons().length, 0);
});

test('declining with a reason can teach; declining without one does not', async () => {
  asked = [];
  answer = 'Ask before drafting a reply to anyone new.';
  const a = mail(LONG, 'hearth');
  app.slips.decline(a.id);
  await settle();
  assert.equal(asked.length, 0);

  const b = mail(LONG, 'hearth');
  app.slips.decline(b.id, 'I do not know this person. Ask me first.');
  await until(() => lessons().length === 1);
  assert.match(asked[0]!, /declined it and gave this reason:\nI do not know this person\. Ask me first\./);
  assert.equal(lessons()[0]!.lesson!.from, 'decline');
  app.slips.decline(lessons()[0]!.id);
});

test('no more than three proposed rules wait for one person', async () => {
  let n = 0;
  answer = () => `Standing rule number ${++n} for this office.`;
  for (let i = 0; i < 5; i++) {
    const s = mail(LONG, 'atlas');
    app.slips.sign(s.id, `${LONG}\n${i}`);
    await until(() => app.store.get('slip', s.id)!.status === 'signed');
    await settle();
  }
  assert.equal(lessons().filter((s) => s.lesson!.staffId === 'atlas').length, 3);
});

test('the demo engine draws a lesson from a much shorter signed version', async () => {
  const real = new DemoEngine({ speed: 0 });
  const { lessonPrompt } = await import('../src/prompt.ts');
  const p = lessonPrompt({ owner: 'Robin', name: 'Piper', role: 'Inbox', profile: '', title: 'Reply', before: LONG, after: 'Thursday works. Deck attached.\n\nRobin' });
  assert.match(await real.ask({ ...p, configDir: null }), /^Keep replies short/);
  const same = lessonPrompt({ owner: 'Robin', name: 'Piper', role: 'Inbox', profile: '', title: 'Reply', before: LONG, after: LONG.replace('2:00', '3:00') });
  assert.equal(await real.ask({ ...same, configDir: null }), 'NONE');
});
