import os from 'node:os';
import path from 'node:path';
import { CALENDAR_OUTSIDE } from './calendar.ts';
import { isOfficeOwned } from './skills.ts';
import type { Level } from '../../../shared/contract.ts';
import { actionClass, LEVEL_SHORT } from '../../../shared/contract.ts';

/**
 * The one gate every tool call passes.
 *
 * `classify` turns a tool call into an action class and a mode. `decide` applies the staff
 * member's level for that class. Both are pure so they can be tested exhaustively.
 */

export type Mode = 'read' | 'draft' | 'execute';

export interface Classified {
  /** null means internal housekeeping that is always allowed. */
  classId: string | null;
  mode: Mode;
  /** A hard refusal regardless of level, with the message for the staff member. */
  refuse?: string;
  /** When this call reads outside material: how to describe it on a slip. */
  outside?: string;
  /**
   * A read that sends an address of the staff member's choosing to any server on the internet, so
   * the address itself can carry information out. `loaded` when it is long enough to hold some.
   */
  sends?: { loaded: boolean };
  /** What a slip for this call should say. */
  slip: {
    title: string;
    meta: { label: string; value: string }[];
    text: string;
    /** Input field holding `text`, when the owner may edit it before signing. */
    textField?: string;
  };
}

export interface GateContext {
  /** The staff member's own folder. */
  home: string;
  /** The shared Books folder. */
  books: string;
  /** Root holding every staff folder. */
  staffRoot: string;
  /** Addresses already in the Books, lower case. */
  knownEmails: Set<string>;
  /** The office's folder in Google Drive, when it has one. */
  drive?: string | null;
}

export type Outcome =
  | { outcome: 'allow'; log: boolean }
  | { outcome: 'ask'; because?: string }
  | { outcome: 'deny'; message: string };

/** Tools that only organize the staff member's own work. */
const INTERNAL = new Set([
  'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskStop', 'Agent', 'Task', 'Skill', 'ToolSearch',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool', 'WaitForMcpServers', 'BashOutput', 'KillShell',
  'KillBash', 'Monitor', 'SubagentHandback', 'ListAgents', 'LSP',
]);

/** Tools that make no sense for unattended staff; they are also removed from the model's view. */
export const DISALLOWED_TOOLS = [
  'AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'EnterPlanMode',
  'ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'Workflow', 'PushNotification', 'SendUserFile', 'SendUserMessage',
  'Artifact', 'ClaudeDesign', 'ProposeGoal', 'EndConversation', 'SendFeedback', 'Projects', 'SendMessage',
];

const READ_FILE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITE_FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const MONEY = /(^|[_-])(pay|payment|payments|payout|transfer|wire|purchase|buy|checkout|refund|charge|withdraw|withdrawal|deposit|send_money|place_order|order)([_-]|$)/i;
const READ_VERB = /(^|[_-])(get|list|search|read|fetch|find|query|lookup|view|retrieve|describe|count|check|download|show|export|summarize)([_-]|$)/i;
const WRITE_VERB = /(^|[_-])(create|send|update|delete|remove|add|insert|modify|move|write|post|reply|forward|trash|archive|label|share|upload|set|patch|put|cancel|accept|decline|invite|rename|copy|append|schedule)([_-]|$)/i;

/** Shell commands that only look at things. */
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'date', 'echo', 'which', 'file', 'stat', 'du', 'df',
  'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'tree', 'diff', 'cal', 'whoami', 'uname', 'sw_vers',
  'jq', 'column', 'nl', 'true', 'printf', 'test', 'md5', 'shasum',
]);
const READ_ONLY_GIT = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'ls-files', 'blame']);

export function isReadOnlyCommand(command: string): boolean {
  const c = command.trim();
  if (!c) return true;
  // Anything that can write, substitute or chain in ways we do not parse is not read-only.
  if (/[`<>]|\$\(|\$\{|\bsudo\b|\bxargs\b|\btee\b|\s-(exec|execdir|delete|ok|okdir|fls|fprint\w*)\b/.test(c)) return false;
  const parts = c.split(/\|\||&&|;|\|/).map((p) => p.trim()).filter(Boolean);
  // Asking a program for its version or help text changes nothing.
  if (parts.length === 1 && /^[\w./-]+(\s+(--version|-V|--help|version))$/.test(parts[0]!)) return true;
  for (const part of parts) {
    const words = part.split(/\s+/);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i += 1; // VAR=value prefixes
    const cmd = words[i];
    if (!cmd) return false;
    if (cmd === 'git') {
      const sub = words.slice(i + 1).find((w) => !w.startsWith('-'));
      if (!sub || !READ_ONLY_GIT.has(sub)) return false;
      continue;
    }
    if (cmd === 'cd') continue;
    if (!READ_ONLY_COMMANDS.has(cmd)) return false;
  }
  return true;
}

function within(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
}

function emailsIn(v: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === 'string') for (const m of x.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.push(m[0].toLowerCase());
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(v);
  return [...new Set(out)];
}

export function humanize(name: string): string {
  const s = name.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const TEXT_FIELDS = ['body', 'message', 'text', 'content', 'html_body', 'htmlBody', 'description', 'note'];

function pickText(input: Record<string, unknown>): { field?: string; text: string } {
  for (const f of TEXT_FIELDS) if (typeof input[f] === 'string' && (input[f] as string).trim()) return { field: f, text: input[f] as string };
  return { text: '' };
}

export function classify(toolName: string, rawInput: unknown, ctx: GateContext): Classified {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const plain = (title: string, text = ''): Classified['slip'] => ({ title, meta: [], text });

  if (INTERNAL.has(toolName)) return { classId: null, mode: 'read', slip: plain(toolName) };

  // -------------------------------------------------------------- files
  if (READ_FILE_TOOLS.has(toolName) || WRITE_FILE_TOOLS.has(toolName)) {
    const given = str(input.file_path ?? input.path ?? input.notebook_path);
    const file = given ? path.resolve(ctx.home, given) : ctx.home;
    const writing = WRITE_FILE_TOOLS.has(toolName);
    const rel = path.relative(ctx.home, file);
    if (within(ctx.home, file)) {
      // Their profile, skills and settings are set by the owner, not by the person themselves.
      if (writing && isOfficeOwned(rel)) {
        return { classId: 'mac.files', mode: 'execute', refuse: 'Your briefing, skills and settings are set by the owner, so you cannot change them yourself. If one should change, say what and why, and the owner can change it.', slip: plain('') };
      }
      return { classId: null, mode: writing ? 'execute' : 'read', slip: plain(`${toolName} ${rel}`) };
    }
    // Claude Code's own folder (its memory, settings and sessions) is not the person's to use.
    if (within(path.join(os.homedir(), '.claude'), file) || (process.env.CLAUDE_CONFIG_DIR && within(process.env.CLAUDE_CONFIG_DIR, file))) {
      return {
        classId: 'mac.files', mode: writing ? 'execute' : 'read',
        refuse: writing
          ? 'That is Claude Code’s own folder, not yours. To remember something, write it in notes/memory.md in your own folder: you can always read and write your own folder, whatever your other permissions.'
          : 'That is Claude Code’s own folder, not yours. Your notes are in notes/ in your own folder.',
        slip: plain(''),
      };
    }
    if (within(ctx.books, file)) {
      const relBooks = path.relative(ctx.books, file) || 'the Books';
      if (!writing) return { classId: null, mode: 'read', slip: plain(`Read ${relBooks}`) };
      const text = str(input.content ?? input.new_string);
      return {
        classId: 'books.change', mode: 'execute',
        slip: { title: `Change the Books: ${relBooks}`, meta: [{ label: 'File', value: relBooks }], text: clip(text, 1200) },
      };
    }
    if (within(ctx.staffRoot, file)) {
      // Another person's folder: their library is shared reading, the rest is theirs.
      const parts = path.relative(ctx.staffRoot, file).split(path.sep);
      if (!writing && parts[1] === 'library') return { classId: null, mode: 'read', slip: plain(`Read ${parts.join('/')}`) };
      return { classId: 'mac.files', mode: writing ? 'execute' : 'read', refuse: 'That folder belongs to another member of staff. Ask them with hand_to, or read their library folder.', slip: plain('') };
    }
    if (ctx.drive && within(ctx.drive, file)) {
      // The office's Drive folder is Drive, although it is reached as files on this Mac.
      const relDrive = path.relative(ctx.drive, file);
      if (within(path.join(ctx.drive, 'Backups'), file)) {
        return { classId: 'drive.change', mode: writing ? 'execute' : 'read', refuse: 'The Backups folder is the office’s own. Staff do not read or change it.', slip: plain('') };
      }
      // Whatever is in there was put there from outside the office.
      if (!writing) return { classId: 'drive.change', mode: 'read', outside: relDrive ? `“${clip(relDrive, 70)}” in the office Drive folder` : 'The office Drive folder', slip: plain(`Read ${relDrive || 'the office Drive folder'}`) };
      return {
        classId: 'drive.change', mode: 'execute',
        slip: { title: `Save in Drive: ${clip(relDrive, 70)}`, meta: [{ label: 'File', value: relDrive }], text: clip(str(input.content ?? input.new_string), 1200) },
      };
    }
    return {
      classId: 'mac.files', mode: writing ? 'execute' : 'read',
      slip: { title: `${writing ? 'Change' : 'Read'} a file on this Mac`, meta: [{ label: 'File', value: file }], text: writing ? clip(str(input.content ?? input.new_string), 1200) : '' },
    };
  }

  // -------------------------------------------------------------- shell
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = str(input.command);
    const readOnly = isReadOnlyCommand(command);
    return {
      classId: 'scripts.run', mode: readOnly ? 'read' : 'execute',
      outside: ctx.drive && command.includes(ctx.drive) ? 'The office Drive folder' : undefined,
      slip: {
        title: str(input.description) ? clip(str(input.description), 90) : 'Run a command on this Mac',
        meta: [], text: command, textField: 'command',
      },
    };
  }

  // ---------------------------------------------------------------- web
  if (toolName === 'WebSearch') {
    return { classId: 'web.read', mode: 'read', outside: `Web search for “${clip(str(input.query), 60)}”`, slip: plain('Search the web') };
  }
  if (toolName === 'WebFetch') {
    const url = str(input.url);
    let host = url;
    let loaded = true;
    try {
      const u = new URL(url);
      host = u.host;
      loaded = u.search.length > 100 || url.length > 300 || !!u.username || !!u.password;
    } catch { /* keep as given, and treat as loaded */ }
    return { classId: 'web.read', mode: 'read', outside: `Web page at ${host}`, sends: { loaded }, slip: { title: `Open a web page at ${clip(host, 60)}`, meta: [], text: clip(url, 2000) } };
  }

  // ------------------------------------------------------ connected apps
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) {
    const server = mcp[1]!;
    const tool = mcp[2]!;
    if (server === 'bureau') {
      // The office's own tools for its Drive folder go through the gate like any other change in Drive.
      if (tool === 'drive_list') return { classId: 'drive.change', mode: 'read', outside: 'The office Drive folder', slip: plain('Look in the office Drive folder') };
      if (tool === 'drive_move' || tool === 'drive_put') {
        const from = clip(str(input.from), 90);
        const to = clip(str(input.to), 90);
        return {
          classId: 'drive.change', mode: 'execute',
          slip: { title: tool === 'drive_move' ? `Move in Drive: ${clip(str(input.from), 40)} to ${clip(str(input.to), 40)}` : `Put in Drive: ${clip(str(input.to), 60)}`, meta: [{ label: 'From', value: from }, { label: 'To', value: to }], text: '' },
        };
      }
      return { classId: null, mode: 'read', slip: plain(tool) };
    }
    const s = server.toLowerCase();
    const serverName = humanize(server.replace(/^claude_ai_/i, ''));

    if (MONEY.test(tool)) {
      return { classId: 'money.move', mode: 'execute', slip: plain(`${humanize(tool)} in ${serverName}`, JSON.stringify(input, null, 2)) };
    }

    const isWrite = WRITE_VERB.test(tool);
    const isRead = READ_VERB.test(tool) && !isWrite;
    const domain = /mail|gmail|outlook/.test(s) ? 'mail' : /calendar/.test(s) ? 'calendar' : /drive|docs|sheets|slides/.test(s) ? 'drive' : 'other';

    if (domain === 'mail') {
      if (isRead) {
        const q = str(input.query ?? input.q);
        return { classId: 'mail.read', mode: 'read', outside: q ? `Mail matching “${clip(q, 50)}”` : 'Mail in your inbox', slip: plain('Read mail') };
      }
      const recipients = emailsIn([input.to, input.cc, input.bcc, input.recipients]);
      const unknown = recipients.filter((e) => !ctx.knownEmails.has(e));
      const classId = unknown.length ? 'mail.send_new' : 'mail.send';
      const { field, text } = pickText(input);
      const meta = [
        { label: 'To', value: recipients.join(', ') || str(input.to) },
        ...(str(input.cc) ? [{ label: 'Cc', value: str(input.cc) }] : []),
        ...(str(input.subject) ? [{ label: 'Subject', value: str(input.subject) }] : []),
      ];
      if (/draft/i.test(tool) && !/send/i.test(tool)) {
        return { classId, mode: 'draft', slip: { title: `Draft mail to ${recipients[0] ?? 'someone'}`, meta, text, textField: field } };
      }
      const title = /send|reply|forward/i.test(tool)
        ? `Send mail to ${recipients[0] ?? 'someone'}${recipients.length > 1 ? ` and ${recipients.length - 1} more` : ''}`
        : `${humanize(tool)} in Gmail`;
      return { classId, mode: 'execute', slip: { title, meta, text: text || JSON.stringify(input, null, 2), textField: field } };
    }

    if (domain === 'calendar') {
      // Anyone can put an invitation on a calendar, so what is read there is outside material.
      if (isRead) return { classId: 'calendar.write', mode: 'read', outside: CALENDAR_OUTSIDE, slip: plain('Read your calendar') };
      const what = str(input.summary ?? input.title ?? input.name);
      const when = str(input.start ?? input.start_time ?? input.startTime ?? input.date);
      return {
        classId: 'calendar.write', mode: 'execute',
        slip: {
          title: what ? `${/delete|cancel|remove/i.test(tool) ? 'Remove from' : 'Put on'} your calendar: ${clip(what, 60)}` : `${humanize(tool)} in Calendar`,
          meta: [...(when ? [{ label: 'When', value: clip(when, 60) }] : []), ...(emailsIn(input.attendees).length ? [{ label: 'Guests', value: emailsIn(input.attendees).join(', ') }] : [])],
          text: str(input.description),
        },
      };
    }

    if (domain === 'drive') {
      if (isRead) return { classId: 'drive.change', mode: 'read', outside: 'A file in Drive', slip: plain('Read Drive') };
      const name = str(input.name ?? input.title ?? input.file_name ?? input.fileName);
      return { classId: 'drive.change', mode: 'execute', slip: { title: name ? `${humanize(tool)}: ${clip(name, 60)}` : `${humanize(tool)} in Drive`, meta: [], text: clip(pickText(input).text, 1200) } };
    }

    if (isRead) return { classId: 'apps.other', mode: 'read', outside: `${serverName} (${humanize(tool).toLowerCase()})`, slip: plain(`${humanize(tool)} in ${serverName}`) };
    return {
      classId: 'apps.other', mode: 'execute',
      slip: { title: `${humanize(tool)} in ${serverName}`, meta: [], text: JSON.stringify(input, null, 2) },
    };
  }

  // Anything we do not recognise is treated as an action in a connected app.
  return { classId: 'apps.other', mode: 'execute', slip: { title: humanize(toolName), meta: [], text: JSON.stringify(input, null, 2) } };
}

/**
 * Whether a piece of outside material is private to the owner (mail, calendar, Drive, connected
 * apps, the office Drive folder) rather than public (the web, a skills catalog). Anything not
 * recognised counts as private.
 */
export function isPrivateOutside(label: string): boolean {
  return !/^(Web search for |Web page at |The skills catalog$|The skill “)/.test(label);
}

/** Classes whose effects leave the owner's control or run code. Reading outside material first downgrades "acts" to "asks". */
const OUTWARD = new Set(['mail.send', 'mail.send_new', 'calendar.write', 'apps.other', 'scripts.run', 'mac.files']);

const NEED: Record<Mode, Level> = { read: 1, draft: 2, execute: 3 };

export function decide(level: Level, c: Classified, opts: { tainted: boolean; /** Some of the outside material read was private. */ private?: boolean; /** What staff call the owner. */ owner?: string }): Outcome {
  const owner = opts.owner || 'the owner';
  if (c.classId === null) return { outcome: 'allow', log: false };
  if (c.refuse) return { outcome: 'deny', message: c.refuse };
  const def = actionClass(c.classId);
  const label = def?.label.toLowerCase() ?? c.classId;
  if (def?.locked) {
    return { outcome: 'deny', message: `Nobody on staff moves money. Prepare everything ${owner} needs (amount, payee, due date, where to pay) and put it in front of ${owner} with request_signoff. ${owner} makes the payment.` };
  }
  if (level < NEED[c.mode]) {
    if (level === 0) return { outcome: 'deny', message: `This is outside your authority (${label}). If it needs doing, hand it to a colleague who holds it with hand_to, or tell ${owner}.` };
    if (level === 1) return { outcome: 'deny', message: `You may only look here (${label}: ${LEVEL_SHORT[level]}). Do not attempt this again. Tell ${owner} what you found and what you would do.` };
    return { outcome: 'deny', message: `Your authority for this is ${LEVEL_SHORT[level]} (${label}). Prepare the draft and put it in front of ${owner} with request_signoff; ${owner} will either do it or raise your authority. Do not retry the action.` };
  }
  if (c.mode !== 'execute') {
    // Opening a web address is a read, but the address goes to a server someone else runs. After
    // private outside material has been read, text in that material could steer the staff member
    // into putting the owner's information in the address. So it waits for a signature, whatever
    // the level. After public material only, it waits when the address is long enough to carry some.
    if (c.sends && opts.tainted && (opts.private || c.sends.loaded)) {
      return { outcome: 'ask', because: opts.private ? 'private material from outside was read earlier in this piece of work, and a web address can carry information out' : 'this web address is unusually long, and outside material was read earlier in this piece of work' };
    }
    return { outcome: 'allow', log: false };
  }
  if (level === 3) return { outcome: 'ask' };
  if (opts.tainted && OUTWARD.has(c.classId)) return { outcome: 'ask', because: 'outside material was read earlier in this piece of work' };
  return { outcome: 'allow', log: true };
}
