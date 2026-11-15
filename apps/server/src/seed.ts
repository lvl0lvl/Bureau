import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Level, Settings, Slip, Staff, Step } from '../../../shared/contract.ts';
import { ACTION_CLASSES } from '../../../shared/contract.ts';
import { newId, type Store } from './store.ts';

/** First-run contents: the starting staff, their authority and duties. */

type Levels = Record<string, Level>;

const base = (over: Levels): Levels => {
  const out: Levels = {};
  for (const c of ACTION_CLASSES) out[c.id] = 0;
  return { ...out, ...over };
};

interface StarterStaff {
  id: string; name: string; role: string; about: string; isChief?: boolean; authority: Levels;
  duties: { title: string; cadence: string; cron: string | null; prompt: string }[];
}

export const STARTERS: StarterStaff[] = [
  {
    id: 'wren', name: 'Wren', role: 'Chief of staff', isChief: true,
    about: 'Runs the office: writes the morning brief, routes work to the right person and checks what others prepare. Reads no outside mail, so nothing from outside can steer a check.',
    authority: base({ 'books.change': 3, 'calendar.write': 3, 'drive.change': 3, 'mac.files': 1, 'scripts.run': 1, 'apps.other': 1, 'team.assign': 4, 'team.check': 4 }),
    duties: [
      { title: 'Write the morning brief', cadence: 'Every morning at 7:00', cron: '0 7 * * *', prompt: 'Read the desk with read_desk, then publish this morning\'s brief with write_brief.' },
    ],
  },
  {
    id: 'tally', name: 'Tally', role: 'Books and finance',
    about: 'Keeps the ledger, files receipts, prepares invoices and watches tax dates. Prepares payments; never makes them.',
    authority: base({ 'mail.read': 1, 'mail.send': 3, 'mail.send_new': 2, 'books.change': 3, 'drive.change': 4, 'mac.files': 1, 'scripts.run': 1, 'apps.other': 1, 'web.read': 1, 'team.assign': 3 }),
    duties: [
      { title: 'Reconcile the accounts', cadence: 'Every Friday', cron: '0 16 * * 5', prompt: 'Bring this month\'s ledger in the Books up to date from the latest statements and receipts. Flag anything you cannot place with ask_owner. Log the result.' },
      { title: 'File every receipt', cadence: 'Daily, from Gmail to Drive', cron: '0 6 * * *', prompt: 'Find receipts and invoices that arrived in Gmail since yesterday, file them in Drive under Receipts by month, and note each in the ledger.' },
      { title: 'Send and chase invoices', cadence: 'As work is delivered', cron: null, prompt: 'Prepare invoices for delivered work and chase any that are overdue.' },
      { title: 'Watch tax dates', cadence: 'First of each month', cron: '0 9 1 * *', prompt: 'Check the obligations list for tax estimates and filings due in the next 60 days. Make sure each is on the desk with add_due, with the amount if it can be worked out.' },
    ],
  },
  {
    id: 'piper', name: 'Piper', role: 'Inbox and letters',
    about: 'Reads the inbox, drafts replies, keeps the calendar straight and keeps the contact list current.',
    authority: base({ 'mail.read': 1, 'mail.send': 3, 'mail.send_new': 2, 'books.change': 3, 'calendar.write': 3, 'drive.change': 3, 'scripts.run': 1, 'apps.other': 1, 'web.read': 1, 'team.assign': 3 }),
    duties: [
      { title: 'Clear the inbox', cadence: 'Weekdays at 8:00 and 2:00', cron: '0 8,14 * * 1-5', prompt: 'Go through mail that arrived since the last pass. Reply to what needs a reply, hand finance mail to Tally and personal admin to Hearth, and add new correspondents to contacts in the Books. Ignore sales mail.' },
    ],
  },
  {
    id: 'atlas', name: 'Atlas', role: 'Research',
    about: 'Finds things out and writes them up: investors, markets, clients, regulations. Puts finished notes in the Library.',
    authority: base({ 'mail.send_new': 2, 'books.change': 3, 'drive.change': 4, 'scripts.run': 1, 'apps.other': 1, 'web.read': 1, 'team.assign': 3 }),
    duties: [],
  },
  {
    id: 'hearth', name: 'Hearth', role: 'Personal and home',
    about: 'Looks after personal administration: insurance, renewals, appointments, travel and the household.',
    authority: base({ 'mail.read': 1, 'mail.send': 3, 'mail.send_new': 2, 'books.change': 3, 'calendar.write': 3, 'drive.change': 3, 'scripts.run': 1, 'apps.other': 1, 'web.read': 1, 'team.assign': 3 }),
    duties: [
      { title: 'Check renewals and appointments', cadence: 'Every Monday', cron: '0 8 * * 1', prompt: 'Review the obligations list and the calendar for renewals, appointments and personal deadlines in the next 30 days. Put anything missing on the desk and prepare what can be prepared.' },
    ],
  },
  {
    id: 'forge', name: 'Forge', role: 'Projects and scripts',
    about: 'Handles chores for the software projects and writes and runs small scripts for the rest of the office.',
    authority: base({ 'books.change': 3, 'drive.change': 4, 'mac.files': 3, 'scripts.run': 3, 'apps.other': 1, 'web.read': 1, 'team.assign': 3 }),
    duties: [],
  },
];

function ownerFullName(): string {
  if (process.env.BUREAU_OWNER) return process.env.BUREAU_OWNER;
  // A full name from git is usually the person's real name; the macOS account name is the fallback.
  try {
    const n = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (/\S+\s+\S+/.test(n)) return n;
  } catch { /* no git identity */ }
  try {
    const n = execFileSync('id', ['-F'], { encoding: 'utf8' }).trim();
    if (n) return n;
  } catch { /* not macOS */ }
  return os.userInfo().username;
}

function hostName(): string {
  try {
    const n = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (n) return n;
  } catch { /* not macOS */ }
  return os.hostname().replace(/\.local$/, '');
}

export function defaultSettings(engine: string): Omit<Settings, 'rev'> {
  const full = ownerFullName();
  const parts = full.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? 'You';
  const last = parts.length > 1 ? parts[parts.length - 1]! : '';
  return {
    id: 'settings',
    ownerName: first,
    ownerInitials: `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase() || 'ME',
    signature: null,
    signatureText: last ? `${first[0]}. ${last}` : first,
    undoSeconds: 8,
    checkSlips: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    engine,
    hostName: hostName(),
  };
}

export function ensureStaffHome(staffRoot: string, staff: Pick<Staff, 'id' | 'name'>) {
  const home = path.join(staffRoot, staff.id);
  fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(home, 'library'), { recursive: true });
  const claudeMd = path.join(home, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(claudeMd, `# ${staff.name}'s folder\n\nWhat you have written down for yourself is loaded below at the start of every conversation.\n\n@notes/memory.md\n`);
  }
  const memory = path.join(home, 'notes', 'memory.md');
  if (!fs.existsSync(memory)) fs.writeFileSync(memory, '# Memory\n\nStanding facts and preferences worth keeping. One line each.\n\n');
}

export function seed(store: Store, opts: { engine: string; staffRoot: string }) {
  if (!store.get('settings', 'settings')) store.put('settings', defaultSettings(opts.engine));
  else if (store.get('settings', 'settings')!.engine !== opts.engine) store.update('settings', 'settings', (s) => { s.engine = opts.engine; });

  if (store.list('staff').length === 0) {
    store.transact(() => {
      STARTERS.forEach((s, i) => {
        store.put('staff', {
          id: s.id, name: s.name, letter: s.name[0]!.toUpperCase(), role: s.role, about: s.about, instructions: '', skills: [],
          isChief: !!s.isChief, model: null, configDir: null, authority: s.authority,
          record: { asWritten: 0, edited: 0, declined: 0 }, order: i, hiredAt: Date.now(), retired: false, unread: 0, lastLine: null,
        });
        for (const d of s.duties) {
          // Duties start switched off so a new office does not spend usage until the owner says so.
          store.put('duty', { id: newId('duty'), staffId: s.id, title: d.title, cadence: d.cadence, cron: d.cron, prompt: d.prompt, enabled: false, lastDoneAt: null, nextDueAt: null, note: null, attention: false });
        }
      });
    });
  }
  for (const s of store.list('staff')) ensureStaffHome(opts.staffRoot, s);
}

// ------------------------------------------------------------------- demo

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

/** Sample content so the app can be seen working without Claude. Only used with BUREAU_DEMO=1. */
export function seedDemo(store: Store, staffRoot: string, booksDir: string, _catalog?: unknown) {
  if (store.list('slip').length > 0 || store.get('brief', 'brief')) return;
  const now = Date.now();
  const owner = store.get('settings', 'settings')!.ownerName;

  fs.writeFileSync(path.join(booksDir, 'contacts.md'), `# Contacts\n\nOne line per person: name, organisation, email, a few words of context.\n\n- Priya Raman, Northbeam Ventures, priya@northbeam.example, partner; intro call in November\n- Accounts desk, Halvorsen Construction, accounts@halvorsen.example, pays training invoices\n- Dr. Okafor, Harbourside Dental, frontdesk@harboursidedental.example\n`);
  fs.writeFileSync(path.join(booksDir, 'obligations.md'), `# Obligations\n\nRenewals, filings and bills. Each line: date, what, amount if known, who looks after it.\n\n- ${day(15)} Car insurance renews, premium up 11%, Hearth\n- ${day(18)} Apple Developer Program renews, $99, Forge\n- ${day(63)} Q4 estimated tax, about $2,140, Tally prepares and ${owner} pays\n`);
  fs.mkdirSync(path.join(booksDir, 'ledger'), { recursive: true });
  fs.writeFileSync(path.join(booksDir, 'ledger', '2026-11.md'), `# November 2026\n\n| Date | Item | In | Out | Category |\n|---|---|---|---|---|\n| 6 Nov | Halvorsen Construction, confined space entry training | 2,400.00 | | Consulting (to invoice) |\n| 3 Nov | Cloud hosting | | 84.10 | Software |\n| 2 Nov | Domain renewal | | 18.00 | Software |\n`);
  fs.mkdirSync(path.join(staffRoot, 'tally', 'library'), { recursive: true });
  fs.writeFileSync(path.join(staffRoot, 'tally', 'library', 'october-summary.md'), `# October summary\n\nIn: $6,150.00\nOut: $2,318.00\nNet: $3,832.00\n\n47 entries, all matched to receipts.\n`);
  fs.mkdirSync(path.join(staffRoot, 'hearth', 'library'), { recursive: true });
  fs.writeFileSync(path.join(staffRoot, 'hearth', 'library', 'car-insurance-quotes.md'), `# Car insurance: two quotes\n\n| Insurer | Yearly | Excess |\n|---|---|---|\n| Northline | $1,180 | $750 |\n| Calder Mutual | $1,240 | $500 |\n| Current | $1,310 | $500 |\n`);

  const mk = (s: Partial<Slip> & Pick<Slip, 'kind' | 'staffId' | 'title' | 'detail'>, row = true): Slip => {
    const slip = store.put('slip', { id: newId('slip'), origin: { trigger: 'Bureau', read: [] }, status: 'pending', createdAt: now, ...s } as Omit<Slip, 'rev'>);
    store.putPrivate('_slipx', { id: slip.id, needsWaiter: false });
    if (row) store.appendRow(slip.staffId, { type: 'slip', slipId: slip.id }, slip.createdAt);
    return slip;
  };

  store.transact(() => {
    const briefHour = new Date(now - 2 * HOUR).getHours();
    const hello = briefHour < 12 ? 'Good morning' : briefHour < 18 ? 'Good afternoon' : 'Good evening';
    store.put('brief', { id: 'brief', staffId: 'wren', at: now - 2 * HOUR, text: `${hello}, ${owner}. Three things need your signature, October’s books are closed, and Northbeam replied overnight.` });

    // Past slips, so each person has a record.
    const history: [string, string, number, number][] = [['wren', 'calendar.write', 14, 1], ['tally', 'books.change', 22, 1], ['piper', 'mail.send', 31, 5], ['atlas', 'drive.change', 6, 0], ['hearth', 'calendar.write', 9, 1], ['forge', 'scripts.run', 5, 1]];
    for (const [staffId, classId, asWritten, edited] of history) {
      for (let i = 0; i < asWritten + edited; i += 1) {
        const at = now - (i + 1.3) * (26 * DAY / (asWritten + edited + 1));
        store.put('slip', { id: newId('slip'), kind: 'action', staffId, title: 'Earlier work', detail: '', origin: { trigger: 'Earlier', read: [] }, actionClass: classId, status: 'signed', createdAt: at - HOUR, decidedAt: at, edited: i >= asWritten ? true : undefined });
      }
    }
    // Tally's last eight were signed as written, which is what the promotion below rests on.

    // The Tally thread from the design.
    const t0 = now - 70 * MIN;
    const step = (label: string, ms: number, at: number, extra: Partial<Step> = {}): Step => ({ id: newId('st'), label, status: 'done', startedAt: at, endedAt: at + ms, ...extra });
    store.appendRow('tally', { type: 'message', from: 'owner', text: 'Close out October and tell me where I stand. Flag anything odd.' }, t0);
    store.appendRow('tally', {
      type: 'work', turnId: newId('turn'), status: 'done', startedAt: t0 + 2000, endedAt: t0 + 6 * MIN,
      steps: [
        step('Read october-statement.csv', 8000, t0 + 2000, { said: 'Pulling 47 transactions from the bank export.' }),
        step('Search files in Drive', 3 * MIN, t0 + 12_000, { said: 'Matching them to receipts in Drive.', detail: 'Receipts/2026-10' }),
        step('Edited 2026-10.md', 40_000, t0 + 200_000, { said: 'Categorizing 45 by your rules.' }),
        step('Edited 2026-10.md', MIN, t0 + 245_000, { said: 'Two charges I cannot place.', status: 'error', detail: '2 unplaced' }),
        step('Wrote october-summary.md', 12_000, t0 + 310_000, { said: 'Writing the October summary to the Books.' }),
      ],
    }, t0 + 2000);
    store.appendRow('tally', { type: 'message', from: 'staff', text: 'October is closed. You took in **$6,150** and spent **$2,318**, so you are up **$3,832** for the month.\n\nTwo charges need your call:\n\n- 22 Oct, Adobe Creative Cloud, $59.99. First charge from this company.\n- 27 Oct, Harbour Café, $184.20. Six times your usual meal.' }, t0 + 6 * MIN);
    store.appendRow('tally', { type: 'message', from: 'owner', text: 'Adobe is business. The café was lunch for the Halvorsen crew, so bill it to them.' }, t0 + 9 * MIN);
    store.appendRow('tally', { type: 'message', from: 'staff', text: 'Done. Adobe is filed under Software, and the lunch is on invoice 0042 as a billable expense. The invoice needs your signature before it goes out.' }, t0 + 10 * MIN);

    mk({
      kind: 'action', staffId: 'piper', title: 'Reply to Priya Raman at Northbeam', detail: 'Confirms Thursday at 2:00 pm and attaches the deck.',
      origin: { trigger: 'Duty: Clear the inbox', read: ['Mail from priya@northbeam.example'] }, actionClass: 'mail.send',
      draft: { meta: [{ label: 'To', value: 'priya@northbeam.example' }, { label: 'Subject', value: 'Re: Intro and next steps' }, { label: 'Attached', value: 'Deck v3.pdf' }], text: 'Hi Priya,\n\nThursday at 2:00 pm works well. I’ve attached the current deck, which now includes the pilot numbers you asked about. Would a 30-minute video call suit you?\n\n' + owner, editable: true },
      check: { by: 'wren', state: 'ok', note: 'Matches what was asked.', at: now - 95 * MIN }, createdAt: now - 98 * MIN,
    });
    mk({
      kind: 'action', staffId: 'tally', title: 'Send invoice 0042 to Halvorsen Construction', detail: 'Confined space entry training on 6 November, plus the crew lunch. $2,584.20, net 30.',
      origin: { trigger: 'You asked at 8:21 am', read: [] }, actionClass: 'mail.send',
      draft: { meta: [{ label: 'To', value: 'accounts@halvorsen.example' }, { label: 'Subject', value: 'Invoice 0042: confined space entry training' }, { label: 'Total', value: '$2,584.20' }], text: 'Hello,\n\nPlease find invoice 0042 for the confined space entry training delivered on 6 November.\n\nTraining, one day: $2,400.00\nCrew lunch, 27 October: $184.20\nTotal: $2,584.20, payable within 30 days.\n\nThank you,\n' + owner, editable: true },
      check: { by: 'wren', state: 'ok', at: now - 58 * MIN }, createdAt: t0 + 10 * MIN + 1000,
    });
    mk({
      kind: 'promotion', staffId: 'wren', title: 'Promote Tally: keep the Books without asking',
      detail: 'You signed Tally’s last 8 as written. This moves Tally from “Asks first” to “Acts” for this one kind of work. You can take it back on the Staff page.',
      origin: { trigger: 'From the record', read: [] }, actionClass: 'books.change',
      promotion: { staffId: 'tally', classId: 'books.change', from: 3, to: 4, record: '8 of 8' }, createdAt: now - 50 * MIN,
    }, false);
    mk({
      kind: 'action', staffId: 'hearth', title: 'Put on your calendar: Dental cleaning', detail: 'Tuesday week at 9:30 am with Dr. Okafor. Booked by phone last Friday; this adds it to Google Calendar.',
      origin: { trigger: 'Duty: Check renewals and appointments', read: [] }, actionClass: 'calendar.write',
      draft: { meta: [{ label: 'When', value: `${day(11)}, 9:30 am` }, { label: 'Where', value: 'Harbourside Dental' }], text: '', editable: false },
      check: { by: 'wren', state: 'ok', at: now - 3 * HOUR }, status: 'signed', createdAt: now - 3 * HOUR - 5 * MIN, decidedAt: now - 80 * MIN,
    });

    const due: [number, string, string | null, boolean, string][] = [
      [3, 'Halvorsen invoice goes out', null, false, 'tally'],
      [6, 'Prepare for the call with Priya Raman', 'The deck is in the Library.', false, 'piper'],
      [11, 'Confirm the dental cleaning', null, false, 'hearth'],
      [15, 'Car insurance renews', 'Premium up 11%. Pick a quote.', true, 'hearth'],
      [18, 'Apple Developer Program renews, $99', null, false, 'forge'],
      [63, 'Q4 estimated tax, $2,140', `Tally prepares it. ${owner} pays it.`, false, 'tally'],
    ];
    for (const [d, title, note, attention, staffId] of due) store.put('due', { id: newId('due'), date: day(d), title, note, attention, staffId, done: false });

    const done: [number, string, string][] = [
      [140, 'tally', 'Closed October’s books, 47 entries'],
      [168, 'piper', 'Filed 12 receipts from Gmail to Drive'],
      [185, 'hearth', 'Got two car insurance quotes'],
      [420, 'forge', 'Ran the nightly backup script'],
      [80, 'hearth', 'Put on your calendar: Dental cleaning'],
    ];
    for (const [mins, staffId, text] of done) store.put('done', { id: newId('done'), at: now - mins * MIN, staffId, text });

    for (const d of store.list('duty')) {
      const notes: Record<string, [number, string | null, boolean]> = {
        'Reconcile the accounts': [140, null, false], 'File every receipt': [168, null, false], 'Send and chase invoices': [60, '1 waiting on you', true],
        'Write the morning brief': [120, null, false], 'Clear the inbox': [100, '1 waiting on you', true], 'Check renewals and appointments': [185, null, false],
      };
      const n = notes[d.title];
      if (n) store.update('duty', d.id, (x) => { x.lastDoneAt = now - n[0] * MIN; x.note = n[1]; x.attention = n[2]; });
    }

    const lines: Record<string, string> = { wren: 'The brief is on your desk.', tally: 'To sign: Send invoice 0042 to Halvorsen Construction', piper: 'To sign: Reply to Priya Raman at Northbeam', hearth: 'Two quotes are in my library.', atlas: 'Northbeam notes are in the Library.', forge: 'The backup ran cleanly.' };
    for (const s of store.list('staff')) {
      const recs: Record<string, [number, number]> = { wren: [14, 1], tally: [22, 1], piper: [31, 5], atlas: [6, 0], hearth: [10, 1], forge: [5, 1] };
      const r = recs[s.id] ?? [0, 0];
      store.update('staff', s.id, (x) => { x.lastLine = lines[s.id] ?? null; x.record = { asWritten: r[0], edited: r[1], declined: 0 }; });
    }
  });
}
