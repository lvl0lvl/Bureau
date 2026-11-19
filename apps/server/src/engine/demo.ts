import fs from 'node:fs';
import path from 'node:path';
import type { ContextReading, Engine, EngineEvent, EngineTurn, RunOptions } from './types.ts';
import { COMPACT_AT_DEFAULT, type EngineInfo, type UsageWindow } from '../../../../shared/contract.ts';

/** What Claude Code holds back below the window before it compacts. */
const RESERVE = 33_000;

/** The last line of a letter when it is a name and nothing else, so a changed sign-off can be told from a changed sentence. */
function signOff(text: string): string {
  const last = text.trim().split('\n').pop()!.trim();
  return /^[\p{L}.' -]{1,40}$/u.test(last) ? last : '';
}

/**
 * A scripted stand-in for Claude. It walks the same path a real turn takes (narration, tool
 * calls through the authority gate, the office's own tools, a final answer) so the whole app can
 * be exercised and tested without spending subscription usage. It does no real work.
 */
export class DemoEngine implements Engine {
  readonly name = 'demo';
  /** Multiplier on every pause. 0 makes it instant for tests. */
  private speed: number;
  /** How many messages into a hiring conversation each chief is, so the demo asks before it proposes. */
  private hiringRounds = new Map<string, number>();

  /** Made-up plan usage, so the readout and the hold can be seen without a Claude account. */
  demoUsage: { week: UsageWindow | null };
  /** Made-up conversation sizes in tokens, by member of staff. Each turn adds to them. */
  demoContext = new Map<string, number>(Object.entries({ wren: 148_000, tally: 212_000, piper: 318_000, atlas: 64_000, hearth: 38_000, forge: 21_000 }));

  constructor(opts: { speed?: number; usage?: { week: UsageWindow | null } } = {}) {
    this.speed = opts.speed ?? 1;
    // BUREAU_DEMO_USAGE="61,3240": percent of the week used, and minutes until it resets.
    const [used, mins] = (process.env.BUREAU_DEMO_USAGE ?? '61,3240').split(',').map(Number);
    this.demoUsage = opts.usage ?? { week: Number.isFinite(used) ? { used: used!, resetsAt: Number.isFinite(mins) ? Date.now() + mins! * 60_000 : null } : null };
  }

  async usage(): Promise<{ week: UsageWindow | null }> {
    return this.demoUsage;
  }

  private reading(staffId: string, window: number | null | undefined): ContextReading {
    const w = window ?? COMPACT_AT_DEFAULT;
    return { used: this.demoContext.get(staffId) ?? 15_000, window: w, compactsAt: w - RESERVE };
  }

  async context(o: { staffId: string; compactWindow: number | null }): Promise<ContextReading | null> {
    return this.reading(o.staffId, o.compactWindow);
  }

  /** A turn adds to the conversation; past the limit the earlier part is summarized, as Claude Code does. */
  private grow(staffId: string, window: number | null | undefined): ContextReading {
    let used = (this.demoContext.get(staffId) ?? 15_000) + 9_400;
    if (used >= (window ?? COMPACT_AT_DEFAULT) - RESERVE) used = 46_000;
    this.demoContext.set(staffId, used);
    return this.reading(staffId, window);
  }

  run(o: RunOptions): EngineTurn {
    const abort = new AbortController();
    const speed = this.speed;
    const engine = this;
    const sleep = (ms: number) => new Promise<void>((res) => {
      if (!speed || abort.signal.aborted) return res();
      const t = setTimeout(res, ms * speed);
      abort.signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });
    let n = 0;
    const started = Date.now();
    const text = o.prompt.replace(/^\[[^\]]*\]\s*/, '');
    const lower = text.toLowerCase();

    async function* say(words: string): AsyncGenerator<EngineEvent> {
      const parts = words.match(/\S+\s*/g) ?? [];
      for (let i = 0; i < parts.length; i += 2) {
        if (abort.signal.aborted) return;
        yield { type: 'text', add: parts.slice(i, i + 2).join('') };
        await sleep(45);
      }
    }

    /** A tool call that goes through the gate like a real one. Returns whether it went ahead. */
    async function* call(name: string, input: Record<string, unknown>, work = 700): AsyncGenerator<EngineEvent, boolean> {
      const id = `demo_${started}_${(n += 1)}`;
      yield { type: 'tool-start', id, name, input };
      const verdict = o.gate.check(name, input, id);
      if (verdict.outcome === 'deny') { yield { type: 'tool-end', id, ok: false }; return false; }
      if (verdict.outcome === 'ask') {
        const d = await o.gate.wait(name, input, abort.signal, id);
        if (!d.allow) { yield { type: 'tool-end', id, ok: false }; return false; }
      }
      await sleep(work);
      yield { type: 'tool-end', id, ok: !abort.signal.aborted };
      return !abort.signal.aborted;
    }

    /** One of the office's own tools. Returns its text result. */
    async function* own(name: string, args: Record<string, unknown>): AsyncGenerator<EngineEvent, string> {
      const id = `demo_${started}_${(n += 1)}`;
      yield { type: 'tool-start', id, name: `mcp__bureau__${name}`, input: args };
      const t = o.tools.find((x) => x.name === name);
      const out = t ? await t.run(args) : `No tool called ${name}.`;
      await sleep(150);
      yield { type: 'tool-end', id, ok: !!t };
      return out;
    }

    const books = o.extraDirs[0] ?? o.cwd;
    const rounds = this.hiringRounds;
    const canHire = o.tools.some((t) => t.name === 'propose_hire');
    const hiring = canHire && (/from the hiring desk/.test(lower) || /\bhir(e|ing)\b/.test(lower));

    async function* script(): AsyncGenerator<EngineEvent> {
      yield { type: 'session', sessionId: o.sessionId ?? `demo-${started}` };
      await sleep(350);

      const workItem = /^work item (job-[\w.-]+) is yours/i.exec(text)?.[1];
      if (workItem && o.tools.some((t) => t.name === 'close_work')) {
        const title = /can start now: “([^”]+)”/.exec(text)?.[1] ?? 'the work';
        yield* own('claim_work', { id: workItem });
        yield* say(`Working on “${title}”. `);
        yield* call('Read', { file_path: 'notes/memory.md' }, 400);
        yield* own('close_work', { id: workItem, result: `Done (demo engine): ${title}.` });
        yield* say(`That is finished and closed: ${title}.`);
      } else if (o.tools.some((t) => t.name === 'add_work') && /work list|\bplan\b|break (it|this) down/.test(lower)) {
        yield* say('Breaking that into pieces on the work list. ');
        const first = yield* own('add_work', { title: 'Prepare invoice 0043 for Halvorsen', detail: 'Training on 6 November, one day at $2,400. Draft it in your library; do not send it.', for: 'Tally' });
        const firstId = /(job-[\w.-]+)/.exec(first)?.[1];
        const second = firstId ? yield* own('add_work', { title: 'Tell the owner invoice 0043 is ready to send', after: [firstId] }) : 'No follow-up opened.';
        yield* say(firstId ? `Tally has the invoice (${firstId}). I have a follow-up waiting on it${/(job-[\w.-]+)/.exec(second)?.[1] ? ` (${/(job-[\w.-]+)/.exec(second)![1]})` : ''} and will tell you when it is ready. You can watch both on the Work page.` : first);
      } else if (hiring) {
        const draft = /open draft: (hire_[\w-]+)/i.exec(o.prompt)?.[1];
        const said = text.replace(/\(from the hiring desk[\s\S]*$/i, '').trim();
        const round = (rounds.get(o.staffId) ?? 0) + 1;
        rounds.set(o.staffId, round);
        const again = /\bset (\w+) up again/i.exec(said)?.[1];
        if (!draft && again) {
          rounds.delete(o.staffId);
          yield* say(`Starting from how ${again} is set up today. `);
          const res = yield* own('propose_hire', { staff: again, note: 'This draft starts from the current setup. Tell me what should change; this is the demo engine, so it will not rewrite the profile for you.' });
          yield* say(/^Saved/.test(res) ? `I have opened a draft from ${again}’s current setup. Tell me what is not working, or change it yourself and sign.` : res);
        } else if (draft) {
          yield* say('Reworking the draft with that in mind. ');
          yield* own('propose_hire', { hire_id: draft, note: `Revised after: “${said.slice(0, 140)}”. This is the demo engine, so the profile itself is unchanged.` });
          yield* say('I have revised the draft. Change anything you like in it, or tell me what is still off. Sign it when it reads right.');
        } else if (round === 1 && said.length < 220) {
          yield* say('Before I draft anything, two questions. What would this person handle in an ordinary week? And what should never happen without you seeing it first?');
        } else {
          rounds.delete(o.staffId);
          const finance = /financ|book|invoice|tax|account|receipt|money/.test(lower);
          yield* say('That is enough to draft from. Looking for skills that fit. ');
          const found = yield* own('search_skills', { query: finance ? 'invoice month close receipts tax' : said.slice(0, 120), limit: 6 });
          const ids = [...found.matchAll(/^(\S+:\S+) \|/gm)].map((m) => m[1]!);
          if (ids[0]) yield* own('read_skill', { id: ids[0] });
          yield* say('Writing up a proposal. ');
          yield* own('propose_hire', finance ? {
            name: 'Marlow', role: 'Finance lead',
            about: 'Keeps the money side in order: invoices out, receipts filed, months closed, and the tax packet ready ahead of each deadline.',
            profile: 'You look after the money side of a one-person business with consulting income and a few software projects.\n\nYou are responsible for sending invoices when work is done, filing receipts as they arrive, closing each month in the Books, and having the figures ready three weeks before each tax date.\n\nYou never move money, never tell anyone a payment has been made, and never guess a category: what you cannot place goes on the "to sort" list.\n\nGood work is a ledger where every line points to a document, and a summary that can be read in a minute.',
            authority: { 'mail.read': 1, 'mail.send': 3, 'books.change': 3, 'drive.change': 3, 'calendar.write': 2 },
            skills: ids.slice(0, 4).map((id, i) => ({ id, take: i < 3, why: i < 3 ? 'Matches work this person does every month.' : 'Useful later; not needed to start.' })),
            note: 'I assumed invoices go out by email and receipts live in Drive. Tell me if either is wrong.',
          } : {
            name: 'Quill', role: 'Assistant',
            about: `Looks after: ${said.slice(0, 160)}`,
            profile: `You were hired for this: ${said.slice(0, 400)}\n\nAsk before anything leaves the office. Write down what you learn about how the owner likes things done.`,
            skills: ids.slice(0, 2).map((id) => ({ id, take: true, why: 'Closest match in the catalog.' })),
            note: 'This is the demo engine, so the proposal is a template. With Claude connected it is written from the conversation.',
          });
          yield* say('The draft is on the hiring desk. I kept the starting authority low: reading and drafting, with a signature for anything that leaves the office. Tell me what to change, or edit it yourself and sign.');
        }
      } else if (/under drop here:|now in your folder:/.test(lower)) {
        // Files the owner left in Drop here or attached to a message.
        const files = [...text.matchAll(/^- (.+?)(?: \([^)]*\))?$/gm)].map((m) => m[1]!);
        yield* say(files.length === 1 ? 'Opening what you left. ' : `Opening the ${files.length} files you left. `);
        for (const f of files.slice(0, 3)) yield* call('Read', { file_path: f }, 300);
        yield* say(`${files.length === 1 ? `“${files[0]!.split('/').pop()}” is` : 'They are'} where you left ${files.length === 1 ? 'it' : 'them'}. This is the demo engine, so I can show the hand-over but not read a document. With Claude connected I say what each one is, deal with it or pass it to the colleague whose job it is, and file it.`);
      } else if (/\binvoice\b/.test(lower)) {
        yield* say('Pulling the Halvorsen job from the ledger. ');
        yield* call('Read', { file_path: path.join(books, 'ledger', '2026-11.md') });
        yield* say('Writing up invoice 0042. ');
        const body = '# Invoice 0042\n\nHalvorsen Construction\nConfined space entry training, 6 November 2026\n\nTraining, one day: $2,400.00\n\nTotal due: $2,400.00\nTerms: net 30\n';
        fs.mkdirSync(path.join(o.cwd, 'library'), { recursive: true });
        fs.writeFileSync(path.join(o.cwd, 'library', 'invoice-0042.md'), body);
        yield* call('Write', { file_path: 'library/invoice-0042.md', content: body });
        yield* say('Sending invoice 0042 to the accounts desk at Halvorsen. ');
        const sent = yield* call('mcp__claude_ai_Gmail__send_email', {
          to: ['accounts@halvorsen.example'],
          subject: 'Invoice 0042: confined space entry training',
          body: 'Hello,\n\nPlease find invoice 0042 for the confined space entry training delivered on 6 November. The total is $2,400.00, payable within 30 days.\n\nThank you',
        }, 900);
        if (sent) {
          yield* own('report_done', { text: 'Sent invoice 0042 to Halvorsen Construction, $2,400.00' });
          yield* own('add_due', { date: plusDays(30), title: 'Halvorsen pays invoice 0042', note: '$2,400.00, net 30' });
          yield* say('Invoice 0042 has gone to Halvorsen: $2,400.00, net 30. The payment date is on your desk and I will chase it if it slips.');
        } else {
          yield* say('Nothing was sent. Invoice 0042 is in my library as a draft, ready when you are.');
        }
      } else if (/calendar/.test(lower) && /copy|google|appointments|sync/.test(lower)) {
        yield* say('Reading your Google Calendar for the next six weeks. ');
        const from = plusDays(0);
        const to = plusDays(42);
        if (yield* call('mcp__claude_ai_Google_Calendar__list_events', { calendar_id: 'primary', time_min: from, time_max: to })) {
          const out = yield* own('copy_calendar', {
            from, to,
            events: [
              { event_id: 'demo-priya', start: `${plusDays(6)}T14:00:00`, title: 'Call with Priya Raman', note: 'Northbeam Ventures, video call' },
              { event_id: 'demo-dental', start: `${plusDays(11)}T09:30:00`, title: 'Dental cleaning', note: 'Harbourside Dental' },
              { event_id: 'demo-school', start: `${plusDays(4)}T18:30:00`, title: 'School concert' },
              { event_id: 'demo-trip', start: plusDays(20), title: 'Away: Portland', note: `Through ${plusDays(22)}` },
            ],
          });
          yield* say(`${out.split('\n')[0]} Nothing was changed in Google Calendar.`);
        } else {
          yield* say('I could not read your calendar, so the office calendar is as it was.');
        }
      } else if (/\bbrief\b/.test(lower)) {
        yield* say('Reading the desk and the obligations list. ');
        yield* call('Read', { file_path: path.join(books, 'obligations.md') });
        yield* own('write_brief', { text: 'Good morning. Nothing is waiting for your signature, the Books are up to date, and the next date on the desk is the car insurance renewal.' });
        yield* say('The brief is on your desk.');
      } else if (/insurance|which|choose|decide/.test(lower)) {
        yield* say('Comparing the two quotes against your current cover. ');
        yield* call('WebSearch', { query: 'car insurance renewal quotes comparable cover' });
        const answer = yield* own('ask_owner', {
          question: 'Which car insurance should I arrange?',
          options: ['Northline, $1,180 a year', 'Calder Mutual, $1,240 a year', 'Stay where you are, $1,310 a year'],
          context: 'All three match your current cover. Northline has a higher excess ($750 against $500).',
        });
        yield* say(`${answer.replace(/^.*answered:\s*/i, 'You chose: ')}. I will prepare the switch and bring it to you to sign before anything is committed.`);
      } else if (/research|look into|find out|who is/.test(lower)) {
        yield* say('Searching for recent coverage. ');
        yield* call('WebSearch', { query: text.slice(0, 80) });
        yield* say('Reading the two most relevant pages. ');
        yield* call('WebFetch', { url: 'https://example.org/profile' });
        fs.mkdirSync(path.join(o.cwd, 'library'), { recursive: true });
        fs.writeFileSync(path.join(o.cwd, 'library', 'research-note.md'), `# Research note\n\nQuestion: ${text}\n\nThis file was written by the demo engine. Connect Claude for real research.\n`);
        yield* call('Write', { file_path: 'library/research-note.md', content: '…' });
        yield* own('report_done', { text: 'Wrote a research note' });
        yield* say('I wrote a short note and put it in the Library. This is the demo engine, so the note is a placeholder: connect Claude to get real research.');
      } else if (/\bscript\b|\brun\b|backup/.test(lower)) {
        yield* say('Running the backup script. ');
        const ran = yield* call('Bash', { command: 'python3 library/backup.py --all', description: 'Run the nightly backup script' }, 1200);
        yield* say(ran ? 'The backup ran and finished cleanly.' : 'The script did not run.');
      } else if (/\bpay\b|transfer|wire/.test(lower)) {
        yield* say('Preparing the payment details. ');
        const paid = yield* call('mcp__bank__transfer_funds', { to: 'Tax authority', amount: 2140 });
        if (!paid) {
          const res = yield* own('request_signoff', { title: 'Pay Q4 estimated tax, $2,140', detail: 'Due 15 January. Staff do not move money, so this one is yours to pay.', draft: 'Payee: tax authority\nAmount: $2,140.00\nDue: 15 January\nReference: Q4 estimate' });
          yield* say(/^Signed/.test(res) ? 'Thank you. It is yours to pay; I have noted it as acknowledged.' : 'Understood. It stays on the desk until you pay it.');
        }
      } else if (/\bask (\w+)|hand .* to (\w+)/.test(lower)) {
        const who = /\bask (\w+)|hand .* to (\w+)/.exec(lower)!;
        const name = (who[1] ?? who[2] ?? '').replace(/^\w/, (c) => c.toUpperCase());
        yield* say(`Handing this to ${name}. `);
        const reply = yield* own('hand_to', { staff: name, message: text });
        yield* say(reply);
      } else {
        yield* say('Checking my notes and the Books first. ');
        yield* call('Read', { file_path: 'notes/memory.md' }, 400);
        yield* say('This is the demo engine, so I can show how work flows but I cannot do real work yet. Try asking me to send an invoice, research something, run a script, or pay a bill, and watch what the office lets me do.');
      }
      yield { type: 'context', ...engine.grow(o.staffId, o.compactWindow) };
      yield { type: 'result', ok: !abort.signal.aborted, costUsd: 0, durationMs: Date.now() - started };
    }

    return { events: script(), interrupt: () => abort.abort() };
  }

  async ask(o: { system: string; prompt: string; configDir: string | null }): Promise<string> {
    await new Promise((res) => setTimeout(res, 1200 * this.speed));
    // A correction to learn from: the demo reads the obvious things out of it.
    if (/lasting preference/.test(o.prompt)) {
      const before = /--- as .* wrote it ---\n([\s\S]*?)\n--- as /.exec(o.prompt)?.[1] ?? '';
      const after = /--- as .* signed it ---\n([\s\S]*?)\n--- end ---/.exec(o.prompt)?.[1] ?? '';
      const reason = /gave this reason:\n(.*)/.exec(o.prompt)?.[1] ?? '';
      if (reason) return /long|short|brief/i.test(reason) ? 'Keep drafts short: say it in three sentences unless more is needed.' : /ask|check with me|first/i.test(reason) ? 'Ask before preparing anything like this; do not draft it on your own.' : 'NONE';
      if (after && after.length < before.length * 0.75) return 'Keep replies short: two or three sentences unless more is asked for.';
      if (signOff(before) !== signOff(after) || /\b(Best|Regards|Thanks|Cheers),?\s*\n/i.test(after) !== /\b(Best|Regards|Thanks|Cheers),?\s*\n/i.test(before)) return 'Close letters the way the signed version does, and use the same sign-off every time.';
      return 'NONE';
    }
    if (/wire|gift card|urgent(ly)? transfer/i.test(o.prompt)) return 'CONCERN: This asks for money to be sent on the strength of outside material.';
    return 'OK';
  }

  async info(): Promise<EngineInfo> {
    return {
      engine: this.name,
      account: null,
      connectors: [
        { name: 'Gmail', status: 'connected', tools: 9 },
        { name: 'Google Calendar', status: 'connected', tools: 7 },
        { name: 'Google Drive', status: 'connected', tools: 6 },
      ],
      models: [
        { value: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', resolved: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'opus', name: 'Opus 5.5', description: 'For complex work and everyday tasks', resolved: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'sonnet', name: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', resolved: 'claude-sonnet-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
        { value: 'haiku', name: 'Haiku 5.5', description: 'Fastest for quick answers', resolved: 'claude-haiku-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      ],
      checkedAt: Date.now(),
    };
  }
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
