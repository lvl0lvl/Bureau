# Decisions

Newest first. Each entry: what was decided, why, and what it rules out.

## 2026-11-13

### Build our own system; do not fork T3 Code
T3 Code is about 1.5M lines of TypeScript on Effect and changes daily. The parts we want
(subscription use, remote access, apps) are woven through it and are not liftable packages.
We copy its approach, not its code. The redesign requirement means the client would be rebuilt
even in a fork.

### Engine: Claude Agent SDK driving the installed `claude` binary
Same mechanism as T3 Code (`@anthropic-ai/claude-agent-sdk`, `pathToClaudeCodeExecutable`,
`CLAUDE_CONFIG_DIR` per account, `resume` for continuity, `canUseTool` for approvals,
an in-process MCP server for the app's own tools). Chosen because the office must stay within
Anthropic's terms and T3 Code states this pattern is within them.
Open: confirm current Agent SDK subscription terms and billing on Anthropic's site before building.

### Drop Hermes
Hermes signing in to a Claude subscription is a third-party harness on a consumer plan.
Keep an engine interface so Codex or others can be added later.

### Keep bot-hq's product layer, drop its infrastructure
Keep: roster, per-staff serial turn queue, transcript rows with revisions, live activity state,
approval and question cards, routines, tasks, Library, staff-to-staff messages, group chats.
Drop: Orgo screens and VNC, Hermes gateways, Composio sign-in.

### Connected apps: claude.ai connectors first, Composio optional
Claude Code docs confirm Agent SDK sessions on a subscription login load the user's claude.ai
connectors (Gmail, Calendar, Drive and so on). Composio can be added later as one more MCP
server for apps without a connector and for event triggers ("when an email arrives").

### Remote access: Tailscale HTTPS plus pairing codes
Server on the Mac owns all execution; clients are thin. No hosted relay (T3 Connect needs
Clerk, Cloudflare tunnels and a relay service).

### Clients: web app first, then a small native iPhone app
The native app needs an Apple developer account. The web app doubles as the desktop app. The iPhone app
focuses on the Desk and chat: lock-screen sign-off, Face ID on high-stakes approvals, share
sheet, voice notes. The Mac can send push notifications directly with the owner's own APNs key.

### iMessage as a second channel
Feasible on the Mac host (read the Messages database, send through Messages.app). Build after
the app works. Works best with a separate Apple ID for the staff.

### Secrets and account permissions: 1Password
Staff credentials and per-account permissions should come from it rather
than from files on disk. T3 Code has a 1Password secret provider worth reading for the pattern
(`reference/t3code/packages/secret-provider-onepassword`, `docs/user/secrets*.md`).
Not yet designed: which vaults staff may read, and how a secret request shows up as a slip.

### Visual direction: drafting table
White Swiss layout, sign-off slips, the owner's signature in blue. See `docs/design/brief.md`.
First pass of six screens is in Paper.

### Product concept: an office, not a chat app
The Desk is the home screen. See `docs/vision.md`.

### Speed is a requirement
T3 Code was chosen as a reference partly for its responsiveness. Build in from day one:
cached state on open, cursor-based resume, windowed history, virtualized transcript,
coalesced streaming updates, tool output loaded on expand, dead-socket detection on wake,
and measured budgets in tests.

### Built in the first pass (2026-11-13)
Server, web interface and iPhone shell exist and run. Choices made while building:

- **Authority classes are the enforceable ones.** The matrix in the first mock-up listed things
  like "File expenses" and "Send invoices". The built classes are what the gate can actually
  tell apart: read mail, reply to known contacts, write to new contacts, change the Books, move
  money (locked), calendar, Drive, files on the Mac, run scripts, other apps, read the web,
  assign work, check slips.
- **The gate is a `PreToolUse` hook**, not the permission callback alone, because the callback is
  only consulted when Claude Code itself would have prompted.
- **Staff run with project settings only**, so the owner's personal Claude Code hooks, skills and
  permissions do not leak into the office.
- **Duties are seeded switched off.** A new office spends no usage until a duty is turned on.
- **Promotions are proposed by rule**: eight action slips in a row signed without edits at Asks
  first. The proposal is filed under the chief's name but no model is consulted.
- **Signing from a notification** is limited to plain action slips with no outside material in
  their origin. Everything else must be opened.
- **Background service and remote access are opt-in** one-line commands, not automatic.
- **Demo mode** (`BUREAU_DEMO=1`) is a scripted engine with its own office folder, for showing
  the product and for tests without spending usage.

- **Connected apps come from the owner's Claude account.** Staff sessions set Claude Code's
  `ENABLE_CLAUDEAI_MCP_SERVERS` switch, so whatever connectors the account has (Gmail, Calendar,
  Drive) are available to staff, subject to the gate. Composio stays an option for apps Claude
  has no connector for.
- **The office's account is the Mac's ordinary sign-in, not the launching shell's.** Someone with
  several subscriptions may run Claude Code sessions under per-account folders. A server started
  from such a session inherited its `CLAUDE_CONFIG_DIR` and ran on that session's account, which
  had none of the connected apps, while one started from a plain terminal ran on the default
  sign-in. The server now drops an inherited `CLAUDE_CONFIG_DIR`; the office account is the
  default sign-in unless `BUREAU_CLAUDE_CONFIG_DIR` is set, and a staff member's own folder
  still wins over both.
- **Dictation instead of realtime voice.** The phone's request bar uses the browser's speech
  recognition. No voice model is involved. Where the browser refuses (an iPhone can for a page
  opened from the Home Screen), the bar says so once and shows Send; the keyboard's own
  microphone still dictates into the box.

- **A native Mac app as well as the web app** (`apps/mac`), added the same day at the owner's
  request. It is a client only: it does not start the office, so the office can keep running as
  a background service while the app is quit. It watches the office over its own socket rather
  than through push, so it needs no Apple key. With "ask before I sign" on, a Mac that cannot
  authenticate refuses the signature rather than letting it through.
- **Changing a staff member's Claude account starts a fresh conversation for them.** A Claude
  Code conversation is stored under the account that held it. Authority, notes, files and duties
  belong to the office and are unchanged; connected apps are whatever the new account has.
  Switching stays a deliberate choice by the owner, never automatic.

- **Setting someone up is a hiring conversation, not a form.** The owner asked for agents to have a
  proper profile and skills loaded on demand, the way Claude Code agents are usually set up,
  and for setup to take as many rounds of discussion as it needs. The chief of staff runs the
  intake, searches the catalog, and saves a draft; the owner edits and signs it.
- **Skills live in the agent's own folder, and only skills are installed.** A plugin's
  connectors and hooks are shown but never installed: connectors come from the Claude account
  and go through the gate, and hooks would run commands outside it.
- **Installed copies are pinned.** Refreshing the catalog changes nothing already installed.
- **Staff cannot change their own setup.** The briefing is generated from the database each
  time; skills and settings in the folder are checked against what was installed before each
  piece of work, and anything else is moved out and reported. This is so that something read
  in an email cannot plant an instruction that survives into later work.
- **The catalog is fetched only on request.** Default sources are Anthropic's
  `knowledge-work-plugins`, `skills` and `financial-services-plugins`. On 2026-11-13 they held
  225, 20 and 112 skills. The `small-business` plugin in the first one (month close, invoice
  chasing, tax season, inbox) is the closest fit for a one-person business; most of it assumes an
  accounting package, which is why four house skills were written for the Books as they are.

- **One Claude subscription for the office.** Per-staff account folders remain possible but are
  not the plan.
- **Beads for work in progress, not a message board.** A git-backed board between peer sessions
  was the other candidate. A board solves coordination between peer
  sessions with nothing in the middle; Bureau has a server in the middle, so the board's
  transport is not needed. What the office lacked was a record of open work with dependencies
  and claiming, which is what beads is. The server wraps `bd`; staff get typed tools. Still
  wanted from the board idea and not built: relaying a ruling the owner gives one person to the
  others (with a mark when it was written after reading outside material).
- **A second mailbox (business mail) is deferred.** One agent cannot see two Google accounts
  through one Claude account's connector unless the connector allows it; unverified.
- **Coded tools with their own screens** (health, money) are wanted and not started: each would
  be a data store, typed tools and a tailored screen, built as part of the platform.

- **Model and effort are chosen per person from what the account offers.** The model field was
  free text and accepted "Opus 5.5", which Claude Code rejects on every turn. It is now a list
  from `supportedModels()`, with an effort level beside it. Neither is in the hiring draft yet.
- **Staff can have a bubble color**, chosen in the hiring draft or the person's settings.
- **The calendar is the office's own, and staff copy Google Calendar onto it.** It holds what
  staff and the owner have put on "Coming due", when scheduled duties run, and appointments a
  member of staff has copied from Google Calendar with `copy_calendar`. The server holds no
  Google credential and does not read Google Calendar itself. The copy goes one way; nothing is
  written to Google Calendar by it. The page is a list over a week or month grid, and choosing
  a day shows that day in the list.
- **After private material has been read, opening a web page needs a signature.** A signature
  on outward actions does not cover a page fetch, and a fetch can send the owner's information
  out inside the address if hostile text in a message steers the agent. Splitting staff into
  readers and actors was considered and not done: while the owner signs every outward action it
  would cost quality and add little. Known limit: a turn steered by a web page alone, which then
  reads the Books, is only held back by the long-address check.
- **What is read from a calendar is outside material.** An invitation can come from anyone, so
  reading a calendar now marks the turn the way reading mail does, and copied appointments keep
  that mark when other staff read them. Before this, a calendar read left the turn unmarked.
- **The code and the office are kept apart.** The code is in a git repository. The office
  folder (`~/Bureau`) is not in it and is backed up separately.
- **The office is backed up to Google Drive as encrypted daily archives, not by syncing the live
  folder.** A sync client copies a running SQLite database, the beads database and git
  repositories mid-write. Archives are encrypted with age to a key pair because they hold the
  books and mail-derived material and staff can reach Drive. A key pair was chosen over a
  passphrase so the Mac holds nothing that can open a backup: the recovery key is shown once and
  The owner keeps it in a password manager. Bureau cannot recover it.
- **One Drive folder for the office, reached through Google Drive for desktop.**
  It gives documents a way in from any device (Drop here), a way out (From staff), a place for
  originals (Filed) and the backups. Reached as local files so that the office holds no Google
  credential and staff can read PDFs and images directly; governed as Drive, not as Mac files.
  An out-of-date Drive for desktop mounts nothing (version 90 was refused by Google as
  deprecated on 2026-11-13); the current version has to be installed.

- **Scheduled duties stop at a usage limit; nothing else does.** The office and the owner share one
  plan, and a schedule that runs unattended is the one thing that can spend the week without
  anyone noticing. So past a limit the owner sets (80% of the week to begin
  with) the scheduler skips duties and says so, while anything the owner asks for always runs. Held
  runs are skipped rather than queued, so a reset is not followed by a burst. The idea came from
  a friend's agent team; the figures come from Claude Code itself through the Agent SDK, which
  costs nothing to ask and reads no credential. That SDK call is marked experimental, so the
  guard fails open: if the figures cannot be read, duties run.
- **Usage and conversation size are always on screen.** The week's usage with time to reset,
  and how far a conversation is from compaction, sit at the foot of the sidebar and above the
  message box on a phone, modelled on the owner's terminal status line. The countdown is in days
  until 24 hours remain, then hours. No five-hour figure: the plan the office was built on has no five-hour limit, so a plan
  that has one is neither shown nor guarded.
- **Staff conversations compact at 400,000 tokens.** The same window the owner uses in the
  terminal. The office has to set it itself, because staff turns do not read the owner's personal
  Claude Code settings; left alone they would have grown to nearly 1,000,000 before compacting.
  It is one setting for the whole office, adjustable in Settings.

- **Corrections become proposed rules, and the owner signs them.** An edit before signing, or a
  decline with a reason, is the best evidence there is of how the owner wants work done, and it was
  being thrown away. The office now asks whether a correction holds a standing rule and, if so,
  puts the rule on the Desk as a slip. Signing adds one line to that person's profile. It is a
  proposal and not automatic because a profile is read on every turn: a wrong rule learned
  silently would bend all later work. Rules cannot add authority or name recipients.
- **Three ways in, all treated as outside material.** Files can be attached to a message, left in
  Drop here, or forwarded by email to the owner's own address with `+office`. A document is the
  commonest place for an instruction that the owner did not write, so a turn that starts from any of
  these is tainted from its first step. Forwarding is a briefing convention handled on the inbox
  pass, not a mail hook: the server still never reads Google.
- **A native share sheet is not built.** Sharing from another iPhone app into Bureau needs a
  share extension with its own signing and an app group. Attaching from the message box covers
  photos and files on the phone for now.
- **The week is counted by code, not written by staff.** A page that reports on staff has to be
  one they cannot flatter. `/week` counts from the usage log, the done log and the slips. It is
  the page to read before raising or lowering what someone may do.

Not built yet: iMessage, 1Password, search within a thread, a share sheet on the
iPhone, updating an installed skill to a newer catalog version, and plugins' connectors.

## 2026-11-14

### What the first days of real use showed

- **No notification history.** One was asked for after a banner was dismissed by accident. The only thing the
  office notifies about is a slip, and a slip stays on the Desk until answered, so the answer
  was to make who-is-waiting visible on the phone instead.
- **Staff along the top of the phone Desk:** chief of staff first, then waiting
  on the owner, then working, then most recently active (`lastActiveAt`); overflow is a count that
  opens the Staff page. The owner's square at the end of the phone tabs opens Settings.
- **Devices:** the pairing code closes when a device uses it; one-request sessions from this Mac
  are cleared when the list is read.

### Team leads: not for now

Should some staff lead a team of specialists? Decided against as a staff
structure: each person costs the owner attention (a conversation, a row of authority, a bubble),
hand-offs already work between any two staff, and seven people do not strain the chief of
staff. Revisit at around ten. Where one job needs many deep specialists (health), one member of
staff dispatches them as sub-tasks from profiles in their own folder; they are not staff.

### Getting information in from other apps

Do not connect apps one by one. A schedule arrives as a calendar link, a change arrives as an
email, and anything else as a screenshot or PDF attached from the phone. Staff do not sign in to
other apps as the owner. A calendar-copy duty can read every calendar on the account and name
the calendar in each note. Adding a calendar by link can only be done on
calendar.google.com; no staff tool can subscribe. Proposed and not built: "follow this
calendar", where the owner pastes an `.ics` link to the chief of staff and the office reads it
hourly in code.

## Open questions

- Is the host an always-on Mac or a laptop that sleeps?
- Which Claude accounts will staff use, and how are they assigned?
- Final product name (working name: Bureau).
- Voice (bot-hq used xAI realtime voice): wanted or not?
- Is a "watch its browser" live view per staff member wanted?

## 2026-11-15

### The code is shared as a clean copy, and nobody is named in it

- **The owner has no name in the code.** The first office was built for one person, and that
  person's first name had become a value on the wire, part of the name of a tool staff call,
  a hard-coded sentence about their work in every briefing, and wording in the gate's refusals.
  Another person's staff would have been told all of it. Now the owner's messages are
  `from: 'owner'`, the tool is `ask_owner`, refusals use `Settings.ownerName`, and what staff
  are told about the owner is `Settings.ownerAbout`, written by the owner under You in Settings.
  The one office that existed before this was changed by hand; the code carries no migration.
- **Private notes live in `owner/`, and the shared copy is an export without it.** One person's
  accounts, devices, family and open threads are useful to the next working session and are
  nobody else's business. They are kept in one folder in the private repository.
  `scripts/dev/share.sh` exports a commit without that folder and without history, and refuses
  if the copy contains any term on a private list. A fresh repository was chosen over rewriting
  the private one's history: nothing is destroyed, and a force-pushed repository can keep old
  commits reachable by their ids.
- **Setup is a guide an agent follows with its owner** (`SETUP.md`) plus a script that only
  looks (`scripts/setup-check.sh`). An installer that did everything was not written: most of
  what takes time is a sign-in, a macOS permission question or a choice, and those are the
  owner's. The guide says which steps are whose.
- **Remote access finds Tailscale inside the Mac app**, so a `tailscale` command on the PATH is
  no longer a setup step. The service's "is it up" check asks for the page, not `/api/session`,
  which was creating a local device each time.

### Themes: five looks, chosen per device

- **The owner asked for switchable themes** and supplied four reference pictures. Each became a
  theme beside the drafting table: Graph paper, Night shift, Control room, Stationery. The list
  and the rules are in `docs/design/brief.md`.
- **Per device, not per office.** The choice is kept in the browser (`localStorage`), not in
  Settings on the server. A dark theme that suits a phone at night should not turn the Mac
  dark, and a choice that is only about looks does not belong in the office's records. The
  cost: a new device starts on the default.
- **A theme is tokens, not a second stylesheet.** The first build had white, black and Archivo
  written into rules directly. Those became tokens once, so each theme is a short block of
  overrides and the default looks exactly as before. Layout and copy are the same in all five.
- **The three meanings survive every theme.** The owner, "needs you" and "working now" can be
  told apart at a glance in each one. Where copy named a color (the calendar's key, a hint under bubble colors) it
  now shows the mark or describes it without the color.
- **Fonts are bundled, not fetched.** The five extra faces come from Fontsource packages (all
  under the SIL Open Font License) and are loaded only when a theme that uses them is on
  screen, so the office still makes no request to a font service.
- **Not verified on a real iPhone:** the color of the status bar above a dark theme when the
  office is opened from the Home Screen. The page sets `theme-color` before the first paint;
  iOS decides what to do with it.
