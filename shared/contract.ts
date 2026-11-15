/**
 * The wire contract between the Bureau server and its clients.
 * Types plus a few pure helpers. No runtime dependencies, erasable syntax only
 * (Node runs this file directly).
 */

export const PROTOCOL = 1;

// ---------------------------------------------------------------- authority

/** 0 none, 1 watches, 2 drafts, 3 asks first, 4 acts then reports. */
export type Level = 0 | 1 | 2 | 3 | 4;

export const LEVEL_LABEL: readonly string[] = ['No access', 'Watches', 'Drafts', 'Asks first', 'Acts, then reports'];
export const LEVEL_SHORT: readonly string[] = ['None', 'Watches', 'Drafts', 'Asks first', 'Acts'];

export interface ActionClass {
  id: string;
  group: string;
  label: string;
  /** One line shown when choosing a level. */
  hint: string;
  /** Locked for everyone at "never". Cannot be changed in the app. */
  locked?: boolean;
  lockedNote?: string;
  /** Only the chief of staff holds this. */
  chiefOnly?: boolean;
}

export const ACTION_CLASSES: readonly ActionClass[] = [
  { id: 'mail.read', group: 'Correspondence', label: 'Read your inbox', hint: 'Search and read mail in Gmail.' },
  { id: 'mail.send', group: 'Correspondence', label: 'Write to people you know', hint: 'Send mail to addresses already in the Books.' },
  { id: 'mail.send_new', group: 'Correspondence', label: 'Write to someone new', hint: 'Send mail to an address that is not in the Books.' },
  { id: 'books.change', group: 'Money and records', label: 'Keep the Books', hint: 'Change the shared records: accounts, contacts, obligations.' },
  { id: 'money.move', group: 'Money and records', label: 'Move money', hint: 'Pay, transfer, buy or refund.', locked: true, lockedNote: 'Nobody. Staff prepare payments and filings, and you make them.' },
  { id: 'calendar.write', group: 'Calendar and files', label: 'Put things on your calendar', hint: 'Create and change events in Google Calendar.' },
  { id: 'drive.change', group: 'Calendar and files', label: 'Change files in Drive', hint: 'Create, edit and move files in Google Drive.' },
  { id: 'mac.files', group: 'Calendar and files', label: 'Use files on this Mac', hint: 'Read and change files outside the office folder.' },
  { id: 'scripts.run', group: 'Calendar and files', label: 'Run scripts on this Mac', hint: 'Run shell commands and scripts.' },
  { id: 'apps.other', group: 'Calendar and files', label: 'Use other connected apps', hint: 'Anything else connected to your Claude account.' },
  { id: 'web.read', group: 'Calendar and files', label: 'Research on the web', hint: 'Search and read public web pages.' },
  { id: 'team.assign', group: 'The team', label: 'Hand work to other staff', hint: 'Message another member of staff and get an answer back.' },
  { id: 'team.check', group: 'The team', label: 'Check someone else’s work', hint: 'Review a slip before it reaches you.', chiefOnly: true },
];

export function actionClass(id: string): ActionClass | undefined {
  return ACTION_CLASSES.find((c) => c.id === id);
}

// -------------------------------------------------------------------- staff

export interface StaffRecord {
  /** Slips decided in the last 30 days. */
  asWritten: number;
  edited: number;
  declined: number;
}

export interface Staff {
  id: string;
  rev: number;
  name: string;
  /** Single letter shown in the bubble. */
  letter: string;
  /** A color for the bubble, by id from STAFF_COLORS, to tell people apart. Null or missing is the plain bubble. */
  color?: string | null;
  role: string;
  /** One or two sentences describing what this person is for. */
  about: string;
  /** The profile: how this person works and the owner's standing rules for them, in the owner's own words. */
  instructions: string;
  /** Skills installed in this person's own folder. Older offices may lack the field. */
  skills?: InstalledSkill[];
  isChief: boolean;
  /** Claude model alias or id; null uses the account default. */
  model: string | null;
  /** How hard the model works on each piece of work; null or missing uses the model's default. */
  effort?: Effort | null;
  /** CLAUDE_CONFIG_DIR for the Claude account this person runs on; null uses the server's own. */
  configDir: string | null;
  authority: Record<string, Level>;
  record: StaffRecord;
  order: number;
  hiredAt: number;
  retired: boolean;
  /** Rows the owner has not seen in this thread. */
  unread: number;
  /** Last line of the thread, for the roster. */
  lastLine: string | null;
  /** When this person last started or finished work, or raised a slip. Orders the staff shown first on a phone. */
  lastActiveAt?: number;
  /** How full this person's conversation is. Null or missing when there is no conversation or it has not been read. */
  context?: ContextUse | null;
}

/** A skill installed in one staff member's folder (`.claude/skills/<id>`). */
export interface InstalledSkill {
  /** Folder name. */
  id: string;
  name: string;
  description: string;
  /** Where it came from, for people: "Anthropic knowledge work plugins". */
  source: string;
  /** The plugin it was taken from, if any. */
  plugin: string | null;
  /** Its id in the catalog, to find it again. */
  ref: string | null;
  /** The catalog version it was copied from. An installed copy never changes by itself. */
  commit: string | null;
  /** Hash of the files as installed. */
  hash: string;
  files: number;
  /** Files in it that can be run (scripts). Running one still goes through the authority gate. */
  scripts: number;
  installedAt: number;
  /** The files stopped matching what was installed, so the skill was set aside and is not loaded. */
  held?: boolean;
}

// ----------------------------------------------------------- catalog & hiring

/** A place skills come from: a public GitHub repository, fetched only when the owner asks. */
export interface CatalogSource {
  id: string;
  /** "owner/name" on GitHub, or a folder on this Mac for the samples. */
  repo: string;
  label: string;
  /** Published by Anthropic. */
  official: boolean;
  fetchedAt: number | null;
  commit: string | null;
  skills: number;
  error?: string;
}

export interface CatalogSkill {
  /** "<source id>:<path inside the source>". */
  id: string;
  name: string;
  description: string;
  sourceId: string;
  source: string;
  official: boolean;
  plugin: string | null;
  files: number;
  scripts: number;
  bytes: number;
}

/** What else a plugin carries besides skills. None of it is installed by Bureau. */
export interface CatalogPlugin {
  id: string;
  sourceId: string;
  name: string;
  description: string;
  skills: number;
  /** Names of connectors (MCP servers) the plugin would add. */
  connectors: string[];
  hooks: boolean;
  commands: number;
  agents: number;
}

export interface CatalogPage {
  sources: CatalogSource[];
  skills: CatalogSkill[];
  /** Skills matching the search before the limit was applied. */
  total: number;
}

export interface CatalogSkillDetail extends CatalogSkill {
  /** The skill's own instructions (SKILL.md). */
  body: string;
  fileList: { path: string; size: number; script: boolean }[];
  pluginInfo: CatalogPlugin | null;
}

export interface HireSkill {
  /** Catalog skill id. */
  ref: string;
  name: string;
  description: string;
  source: string;
  plugin: string | null;
  scripts: number;
  /** Install it when the hire is signed. */
  take: boolean;
  /** The chief of staff's reason for taking or skipping it. */
  why: string;
}

/** A proposed setup for a member of staff, worked out with the chief of staff and signed by the owner. */
export interface Hire {
  id: string;
  rev: number;
  /** An existing member of staff being set up again, or null for someone new. */
  staffId: string | null;
  status: 'draft' | 'hired' | 'dropped';
  name: string;
  letter: string;
  color?: string | null;
  role: string;
  about: string;
  profile: string;
  authority: Record<string, Level>;
  skills: HireSkill[];
  /** What the chief of staff says is still open, or what changed in the last revision. */
  note: string;
  proposedBy: string;
  createdAt: number;
  updatedAt: number;
  decidedAt?: number;
  /** The member of staff this became. */
  resultStaffId?: string;
  /** Skills that could not be installed when it was signed. */
  problems?: string[];
}

// ---------------------------------------------------------------------- work

/**
 * A piece of work that outlives one exchange. Kept in beads (`bd`) in `<office>/work`; this is
 * the copy the interface shows.
 */
export interface WorkItem {
  /** The bead's id, for example "job-a3f". */
  id: string;
  rev: number;
  title: string;
  detail: string;
  notes: string;
  status: 'open' | 'in_progress' | 'closed';
  /** Open, and nothing it waits on is still open. */
  ready: boolean;
  /** Who has it; null when nobody does. */
  staffId: string | null;
  /** Who opened it: a staff id, or "owner". */
  createdBy: string;
  /** Items this one waits on. */
  after: string[];
  /** What was said when it was closed. */
  result: string | null;
  /** Outside material the opener had read before opening it. Whoever takes it inherits that. */
  read: string[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface WorkPage {
  /** False when beads is not installed on this Mac. */
  available: boolean;
  items: WorkItem[];
}

/** What a member of staff is doing right now. Never persisted. */
export interface Live {
  staffId: string;
  running: boolean;
  /** Present-tense line, e.g. "Reconciling October, 31 of 47 matched". */
  activity: string | null;
  since: number | null;
  steps: number;
  waitingSlipId: string | null;
  queued: number;
}

// ---------------------------------------------------------------- transcript

export type StepStatus = 'running' | 'done' | 'error' | 'waiting' | 'declined';

export interface Step {
  id: string;
  label: string;
  /** Short extra, e.g. a file name or a count. */
  detail?: string;
  /** A sentence the staff member said while working. */
  said?: string;
  status: StepStatus;
  startedAt: number;
  endedAt?: number;
}

export type RowBody =
  | {
      type: 'message';
      from: 'owner' | 'staff' | 'system';
      text: string;
      streaming?: boolean;
      /** Set when the message did not come from the owner typing in the app. */
      via?: { kind: 'duty' | 'staff' | 'imessage' | 'work' | 'drop'; name: string; staffId?: string };
      /** Files that came with the message. They are in the recipient's folder, under inbox/. */
      files?: { name: string; bytes: number }[];
    }
  | {
      type: 'work';
      turnId: string;
      status: 'running' | 'done' | 'stopped' | 'error';
      startedAt: number;
      endedAt?: number;
      steps: Step[];
      error?: string;
    }
  | { type: 'slip'; slipId: string }
  | { type: 'note'; text: string; tone: 'info' | 'warn' | 'error' };

export interface Row {
  id: string;
  staffId: string;
  /** Position in the thread. */
  seq: number;
  rev: number;
  at: number;
  body: RowBody;
}

// --------------------------------------------------------------------- slips

export type SlipKind = 'action' | 'question' | 'review' | 'promotion' | 'lesson';
export type SlipStatus = 'pending' | 'signing' | 'signed' | 'declined' | 'expired';

export interface SlipCheck {
  by: string;
  state: 'checking' | 'ok' | 'concern' | 'skipped';
  note?: string;
  at?: number;
}

export interface Slip {
  id: string;
  rev: number;
  kind: SlipKind;
  /** Who prepared it. */
  staffId: string;
  title: string;
  detail: string;
  /** Where this came from. */
  origin: {
    /** e.g. "You asked at 8:12 am" or "Duty: Morning inbox". */
    trigger: string;
    /** Outside material read during the turn, e.g. "Mail from priya@northbeam.example". */
    read: string[];
  };
  actionClass?: string;
  /** Text the owner can read and, where editable, change before signing. */
  draft?: {
    /** Small facts shown above the text, e.g. To, Subject, Attached. */
    meta: { label: string; value: string }[];
    text: string;
    editable: boolean;
  };
  /** Question slips: the choices on offer. */
  options?: string[];
  /** Promotion slips. */
  promotion?: { staffId: string; classId: string; from: Level; to: Level; record: string; limit?: string };
  /**
   * Lesson slips: a standing rule proposed after the owner corrected someone's work. The rule itself
   * is the draft text. Signing adds it to that person's profile.
   */
  lesson?: { staffId: string; from: 'edit' | 'decline'; about: string };
  check?: SlipCheck;
  status: SlipStatus;
  /** While status is "signing": when the action will go ahead unless undone. */
  commitAt?: number;
  createdAt: number;
  decidedAt?: number;
  /** The owner changed the draft before signing. */
  edited?: boolean;
  answer?: string;
  declineReason?: string;
}

// ------------------------------------------------------------ the desk lists

export interface Duty {
  id: string;
  rev: number;
  staffId: string;
  title: string;
  /** Plain words, e.g. "Every Friday". */
  cadence: string;
  /** Five-field cron; null for duties done as work arrives. */
  cron: string | null;
  /** What the staff member is told when the duty runs. */
  prompt: string;
  enabled: boolean;
  lastDoneAt: number | null;
  nextDueAt: number | null;
  /** Short status in the staff member's words, e.g. "1 waiting on you". */
  note: string | null;
  /** Set when the last scheduled run was held back by the usage limit, and cleared when it next runs. */
  held?: { at: number; why: string } | null;
  attention: boolean;
}

/** The times one scheduled duty runs on one day, for the calendar. */
export interface DutyRun {
  dutyId: string;
  /** Local date in the office's time zone, YYYY-MM-DD. */
  day: string;
  /** The first run that day. */
  first: number;
  /** How many times it runs that day. */
  count: number;
}

export interface DueItem {
  id: string;
  rev: number;
  /** Local date, YYYY-MM-DD. */
  date: string;
  title: string;
  note: string | null;
  /** Shown in red: the owner has to decide something. */
  attention: boolean;
  staffId: string | null;
  done: boolean;
  /** Time of day for an appointment, 'HH:MM' in the office's time zone. Absent for a plain date. */
  time?: string | null;
  /** Set when a member of staff copied this from the owner's Google Calendar. The key names the event and its day. */
  source?: { kind: 'google-calendar'; key: string } | null;
  /** Outside material behind the words of this item. Staff who read it carry that on. */
  read?: string[];
  /** When a member of staff put it on the Desk. Missing on older items and on the owner's own. */
  at?: number;
}

export interface DoneItem {
  id: string;
  rev: number;
  at: number;
  staffId: string;
  text: string;
}

export interface Brief {
  id: 'brief';
  rev: number;
  text: string;
  staffId: string;
  at: number;
}

export interface Settings {
  id: 'settings';
  rev: number;
  ownerName: string;
  /**
   * What every member of staff is told about the owner: their work, the tools they use, anything
   * that holds for the whole office. In the owner's own words. Missing or empty means one plain line.
   */
  ownerAbout?: string;
  /** Initials for the owner's own marker. */
  ownerInitials: string;
  /** Hand-drawn signature as SVG path data in a 600 by 160 box; null falls back to a script face. */
  signature: { paths: string[]; width: number; height: number } | null;
  signatureText: string;
  /** Seconds a signed action waits before it goes ahead. */
  undoSeconds: number;
  /** Have the chief of staff check slips before they reach the owner. */
  checkSlips: boolean;
  timezone: string;
  /** "claude" or "demo". */
  engine: string;
  hostName: string;
  /** The office's folder in Google Drive, as a path on this Mac. Null or missing when none is set. */
  driveFolder?: string | null;
  /** When to hold scheduled duties so the office does not use up the Claude plan. Missing means the defaults. */
  usageGuard?: UsageGuard;
  /** The window, in tokens, that staff conversations are compacted to stay within. Missing means COMPACT_AT_DEFAULT. */
  compactAt?: number;
  /** Hand whatever lands in "Drop here" to the chief of staff. Missing means yes. */
  watchDrop?: boolean;
}

/** Percentages of the plan's limits at which scheduled duties are held. */
export interface UsageGuard {
  on: boolean;
  /** Hold when this much of the week's allowance is used, 1 to 100. */
  week: number;
}
export const USAGE_GUARD_DEFAULT: UsageGuard = { on: true, week: 80 };
export function usageGuard(s: { usageGuard?: UsageGuard } | null | undefined): UsageGuard {
  const g = s?.usageGuard;
  const pct = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : d);
  return g ? { on: g.on !== false, week: pct(g.week, USAGE_GUARD_DEFAULT.week) } : { ...USAGE_GUARD_DEFAULT };
}

/**
 * The size, in tokens, of the window a staff conversation is kept within. Claude Code summarizes
 * ("compacts") the earlier part of a conversation shortly before it would outgrow this.
 */
export const COMPACT_AT_DEFAULT = 400_000;
export const COMPACT_AT_MIN = 100_000;
export const COMPACT_AT_MAX = 1_000_000;
export function compactAt(s: { compactAt?: number } | null | undefined): number {
  const n = s?.compactAt;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(COMPACT_AT_MAX, Math.max(COMPACT_AT_MIN, Math.round(n))) : COMPACT_AT_DEFAULT;
}

/** How full one member of staff's conversation is, as Claude Code measures it. All in tokens. */
export interface ContextUse {
  used: number;
  /** The window the conversation is kept within. */
  window: number;
  /** Compaction starts when `used` reaches this: the window less Claude Code's reserve. */
  compactsAt: number;
  /** When this was read. */
  at: number;
}

/** One limit on the Claude plan the office runs on. */
export interface UsageWindow {
  /** Share of the allowance used, 0 to 100. */
  used: number;
  /** When it starts again, in milliseconds. Null when not reported. */
  resetsAt: number | null;
}

/** How much of the Claude plan has been used, by everything signed in to that account. */
export interface PlanUsage {
  /** False when the engine cannot say (the demo engine reports made-up figures and says so here). */
  available: boolean;
  week: UsageWindow | null;
  /** When this was read from Claude. Null when it never has been. */
  checkedAt: number | null;
  guard: UsageGuard;
  /** Set while scheduled duties are being held. */
  holding: { used: number; limit: number } | null;
  /** Why the figures could not be read, in a sentence. */
  error?: string;
}

/** The office's Drive folder as it stands on this Mac. */
export interface DriveStatus {
  folder: string | null;
  /** False when the folder cannot be seen, which usually means Google Drive is not running. */
  found: boolean;
  folders: { name: string; purpose: string; files: number }[];
  /** Places on this Mac where a Google Drive is mounted, to choose a folder under. */
  mounts: string[];
}

export interface BackupStatus {
  /** The age program is installed. */
  available: boolean;
  /** Why backups cannot run right now, in a sentence. Null when they can. */
  problem: string | null;
  /** Where archives go. */
  folder: string | null;
  folderFound: boolean;
  hasKey: boolean;
  keyCreatedAt: number | null;
  /** The last characters of the public half of the recovery key, to tell keys apart. */
  keyEnding: string | null;
  last: { at: number; file: string; bytes: number } | null;
  lastError: { at: number; message: string } | null;
  /** Archives currently kept, and the oldest of them. */
  kept: number;
  oldestAt: number | null;
  running: boolean;
}

export interface Device {
  id: string;
  rev: number;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  current?: boolean;
}

// ---------------------------------------------------------------------- sync

export interface Snapshot {
  protocol: number;
  rev: number;
  serverTime: number;
  settings: Settings;
  staff: Staff[];
  slips: Slip[];
  duties: Duty[];
  due: DueItem[];
  done: DoneItem[];
  brief: Brief | null;
  live: Live[];
  /** Hiring drafts still open, and ones decided in the last week. Older servers may omit it. */
  hires?: Hire[];
  /** Open work, and work closed in the last week. Absent when beads is not installed. */
  work?: WorkItem[];
}

export type Change =
  | { k: 'staff'; v: Staff }
  | { k: 'slip'; v: Slip }
  | { k: 'duty'; v: Duty }
  | { k: 'due'; v: DueItem }
  | { k: 'done'; v: DoneItem }
  | { k: 'brief'; v: Brief }
  | { k: 'settings'; v: Settings }
  | { k: 'row'; v: Row }
  | { k: 'hire'; v: Hire }
  | { k: 'work'; v: WorkItem }
  | { k: 'del'; kind: 'staff' | 'slip' | 'duty' | 'due' | 'done' | 'row' | 'hire' | 'work'; id: string };

/** Client to server, over the socket. */
export type ClientMsg =
  | { t: 'hello'; protocol: number; cursor: number | null; thread: string | null }
  | { t: 'open'; staffId: string }
  | { t: 'close' }
  | { t: 'seen'; staffId: string }
  | { t: 'ping'; n: number };

/** Server to client, over the socket. */
export type ServerMsg =
  | { t: 'snapshot'; snapshot: Snapshot }
  | { t: 'delta'; rev: number; changes: Change[] }
  | { t: 'thread'; staffId: string; rows: Row[]; hasMore: boolean }
  /** Text appended to a streaming message row. Not persisted per delta. */
  | { t: 'stream'; rowId: string; staffId: string; add: string }
  | { t: 'live'; v: Live }
  | { t: 'pong'; n: number; serverTime: number };

// ---------------------------------------------------------------------- http

export interface SessionInfo {
  paired: boolean;
  ownerName: string;
  hostName: string;
  protocol: number;
}

export interface ThreadPage {
  rows: Row[];
  hasMore: boolean;
}

export interface BooksEntry {
  path: string;
  dir: boolean;
  size: number;
  modifiedAt: number;
}

export interface BooksCommit {
  sha: string;
  at: number;
  author: string;
  subject: string;
  files: string[];
}

export interface LibraryFile {
  staffId: string;
  path: string;
  size: number;
  modifiedAt: number;
}

/** Counts for one stretch of seven days, for the office or for one person. */
export interface WeekTotals {
  /** Pieces of work started: requests, duties, hand-offs. */
  turns: number;
  /** Time spent working, in minutes. */
  minutes: number;
  /** What the same work would have cost at API prices, in USD, as Claude Code reports it. Not a charge. */
  costUsd: number;
  /** Things logged as finished. */
  done: number;
  /** Slips signed, and how: as written or after an edit. */
  signed: number;
  asWritten: number;
  edited: number;
  declined: number;
  /** Rules signed into profiles after a correction. */
  rules: number;
  /** Scheduled duties that ran. Counted from the day this was first recorded. */
  dutyRuns: number;
  workClosed: number;
  /** Dates put on the Desk as needing a decision. */
  flagged: number;
}

/** The last seven days, counted from the office's own records. */
export interface WeekReport {
  from: number;
  to: number;
  totals: WeekTotals;
  /** The seven days before that. */
  previous: WeekTotals;
  staff: ({ staffId: string } & WeekTotals)[];
  done: { at: number; staffId: string; text: string }[];
  flagged: { date: string; title: string; note: string | null; staffId: string; done: boolean }[];
  /** Slips waiting for the owner now. */
  waiting: number;
  /** Duties being held by the usage limit now. */
  held: number;
  /** The earliest work on record. */
  since: number;
}

export interface UsageSummary {
  /** Turns run in the last 7 days, per staff. */
  turns: Record<string, number>;
  /** Reported cost in USD for the last 7 days where the engine reports one. */
  costUsd: number;
}

/** An app the staff can reach through the owner's Claude account (Gmail, Calendar and so on). */
export interface Connector {
  name: string;
  status: 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled';
  /** How many tools it offers, when connected. */
  tools: number;
}

/** What the engine reports about itself. Read from Claude Code; nothing here is a credential. */
/**
 * Colors the owner can give a member of staff. They only tell people apart. Blue, red and yellow
 * are left out because they already mean the owner, "needs you" and "working now".
 */
export const STAFF_COLORS: readonly { id: string; label: string; value: string }[] = [
  { id: 'teal', label: 'Teal', value: '#0e8a8c' },
  { id: 'green', label: 'Green', value: '#2c8a4b' },
  { id: 'moss', label: 'Moss', value: '#6c7421' },
  { id: 'copper', label: 'Copper', value: '#b4561f' },
  { id: 'brown', label: 'Brown', value: '#7a5230' },
  { id: 'plum', label: 'Plum', value: '#8e3b8a' },
  { id: 'purple', label: 'Purple', value: '#6f3fc9' },
  { id: 'slate', label: 'Slate', value: '#4d6274' },
  { id: 'black', label: 'Black', value: '#000000' },
];
export const staffColor = (id: string | null | undefined): string | null => STAFF_COLORS.find((c) => c.id === id)?.value ?? null;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A model the office's Claude account can use, as Claude Code lists it. */
export interface ModelOption {
  /** What is saved for a member of staff: an alias such as "opus", or a full model id. */
  value: string;
  name: string;
  description: string;
  /** The model this resolves to today. */
  resolved: string | null;
  /** Effort levels the model accepts. Empty when effort cannot be set for it. */
  efforts: Effort[];
}

export interface EngineInfo {
  engine: string;
  /** The Claude account staff run on, as Claude Code reports it. */
  account: { email: string | null; plan: string | null } | null;
  connectors: Connector[];
  /** Models this account can use. The first is the account's default. Missing when it could not be asked. */
  models?: ModelOption[];
  checkedAt: number;
  /** Set when Claude Code could not be started or asked. */
  error?: string;
}

// ------------------------------------------------------------------- helpers

export function pendingSlips(slips: Slip[]): Slip[] {
  return slips.filter((s) => s.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
}

export function recordTotal(r: StaffRecord): number {
  return r.asWritten + r.edited + r.declined;
}
