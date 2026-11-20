# Architecture

One server on the Mac owns everything: staff, their Claude sessions, the database, the Books.
Clients (the web app, the Mac app and the iPhone app) are thin and talk to it over HTTP and one WebSocket.

```
browser / phone ── HTTPS (Tailscale) ──► server (Node, SQLite) ──► Claude Agent SDK ──► `claude`
        ▲                                   │  authority gate, slips, turn queue
        └────── WebSocket: deltas ──────────┘  Books (git), duties (cron)
```

## Layout

- `shared/contract.ts` — every type that crosses the wire. Both sides import it.
- `apps/server` — Node 24 running TypeScript directly (no build step), `node:sqlite`, Hono, ws.
- `apps/web` — React and Vite. Built to `apps/web/dist`, which the server serves.
- `apps/ios` — a native iPhone shell around the same interface (see below).
- `apps/mac` — a native Mac app around the same interface (see below).
- Data lives outside the repo in `BUREAU_HOME` (default `~/Bureau`):
  `bureau.db`, `books/` (a git repository), `staff/<id>/` (each person's folder: `CLAUDE.md`,
  `notes/`, `library/`).

## Sync

Every durable change bumps one global revision number. A client holds the last revision it saw.

- First load: `GET /api/snapshot` (works before the socket is up; the client also paints from
  its local cache immediately).
- Socket `/api/sync`: client sends `hello` with its cursor and the thread it has open. The
  server answers with a `delta` of everything changed since, or a fresh `snapshot` if the cursor
  is too old. After that, changes are pushed as `delta` messages.
- Transcript rows are only sent for the thread a client has open (`open` / `thread` messages).
  Older rows page in over `GET /api/threads/:staffId?before=<seq>`.
- Streaming text arrives as small `stream` messages appended to a row; the row itself is saved
  a few times a second. `live` messages carry what each person is doing right now.
  The interface shows three states from them: working (a dot and a ring that pulse), waiting on
  the owner (`waitingSlipId` set: red, still, naming the slip), and, once a turn ends badly, the
  work log drawn in red ("Stopped after", "Ran into a problem after").
- Commands are plain HTTP POSTs so they get a real acknowledgement.

## HTTP API

All under `/api`, JSON, cookie session after pairing.

| Method and path | Purpose |
|---|---|
| `GET /session` | `SessionInfo`; says whether this browser is paired |
| `POST /pair` `{code,label}` | Pair this device; sets the session cookie |
| `GET /snapshot` | `Snapshot` |
| `GET /threads/:staffId?before=&limit=` | `ThreadPage` |
| `POST /threads/:staffId/messages` `{text, files?}` | The owner writes to a member of staff; `files` are ids from `PUT /uploads` |
| `PUT /uploads?name=` (raw body) | Hold a file to attach to the next message; returns `{id,name,bytes}`. 25 MB each |
| `PUT /drop?name=` (raw body) | Leave a file in the Drive folder's Drop here (the phone's camera button); returns `{name,bytes,watched}`. 25 MB. 409 when no Drive folder is set or it cannot be seen |
| `POST /threads/:staffId/stop` | Stop the running turn |
| `POST /threads/:staffId/new` | Start a fresh conversation (memory files stay) |
| `POST /slips/:id/sign` `{text?}` | Sign; `text` when the draft was edited |
| `POST /slips/:id/undo` | Undo during the wait after signing |
| `POST /slips/:id/decline` `{reason?}` | Decline |
| `POST /slips/:id/answer` `{answer}` | Answer a question slip |
| `POST /staff` / `PUT /staff/:id` / `DELETE /staff/:id` | Hire, change, retire |
| `PUT /staff/:id/authority` `{classId,level}` | Change one authority level |
| `POST /duties` / `PUT /duties/:id` / `DELETE /duties/:id` / `POST /duties/:id/run` | Duties |
| `POST /due` / `PUT /due/:id` / `DELETE /due/:id` | Coming-due items |
| `GET /duties/runs?from=&to=` | `DutyRun[]`: when scheduled duties run, per day, for the calendar |
| `GET /books/tree`, `GET /books/file?path=`, `GET /books/history`, `POST /books/revert` `{sha}` | The Books |
| `GET /artifacts?staff=`, `GET /artifacts/file?staff=&path=` | Finished work in staff libraries, grouped by version; one version's file |
| `POST /artifacts/retire`, `/artifacts/drive`, `/artifacts/delete` | Take one off the list, copy a version to From staff in Drive, delete every version |
| `PUT /settings` | Owner name, signature, undo seconds, slip checking, usage limit (`usageGuard`), compaction window (`compactAt`), whether Drop here is watched (`watchDrop`) |
| `GET /drive`, `PUT /drive` `{folder}` | The office's Drive folder: `DriveStatus`; choose or clear it |
| `GET /backup`, `POST /backup/key` `{replace?}`, `POST /backup/run` | `BackupStatus`; make the recovery key (returned once); back up now |
| `GET /devices`, `POST /devices/code`, `DELETE /devices/:id` | Paired devices |
| `GET /reach?fresh=` | `ReachInfo`: the Tailscale address other devices use, whether another app has taken it, whether a Mac app can be handed out |
| `GET /mac/install?code=`, `GET /mac/Bureau.zip` | Open to anyone who can reach the office: the installer script for another Mac, and the app it downloads |
| `GET /usage` | `UsageSummary` |
| `GET /usage/plan?fresh=` | `PlanUsage`: the plan's week figure, the limit, and whether duties are held |
| `GET /week` | `WeekReport`: the last seven days and the seven before, counted from the office's records |
| `GET /push` | Web Push public key, and how many devices are subscribed |
| `POST /push/web` `{subscription}`, `DELETE /push/web` `{endpoint}` | Subscribe or unsubscribe a browser |
| `POST /push/apns` `{token,sandbox}` | Register the iPhone app's device token |
| `POST /push/test` | Send a test notification to every subscribed device |

## How authority is enforced

Every tool call a member of staff makes passes one gate (`apps/server/src/authority.ts`):

1. The call is classified into an action class and a mode: read, draft or execute.
2. The person's level for that class decides: read needs Watches, draft needs Drafts,
   execute at Asks first becomes a slip and waits, execute at Acts goes ahead and is logged.
3. `money.move` is denied for everyone.
4. If the turn has read outside material (mail, the calendar, Drive, web pages), anything that
   would go ahead on its own at Acts is turned into a slip instead, and the slip says what was
   read.
5. Opening a web page (`WebFetch`) is a read, but its address goes to a server someone else
   runs, so it can carry information out. Once the turn has read private outside material
   (mail, the calendar, Drive, connected apps, the office Drive folder), opening a page becomes
   a slip showing the whole address, at every level. After public material only (web pages, a
   skills catalog), it becomes a slip only when the address is long (over 300 characters, or a
   query over 100). A web search never does. Signing these never leads to a promotion.
6. A batch: with `request_batch` a person puts two or more calls of one action class, each
   needing a signature, to the owner as one slip (`Slip.batch`), every call written out. The
   owner may untick items (`POST /slips/:id/sign {items}`); the signed ones become grants on
   that turn (`Running.grants`), and a call whose tool and input match one exactly
   (`canonical`, keys in order) goes ahead once without another slip. Anything else, a changed
   item or a second use, asks as usual; grants end with the turn. A batch is never signed from
   a notification. While a person waits on a batch, a question or a review, the Desk shows them
   waiting on the owner (`Turns.waitOnOwner`).

The gate runs in a `PreToolUse` hook, so it applies to every call regardless of Claude Code's
own permission rules. Calls that need a signature wait inside the SDK's permission callback.

## What a member of staff is made of

Each person is a separate Claude Code conversation started in their own folder,
`<office>/staff/<id>/`. Three things shape them:

- **The briefing**, built by the server for every piece of work (`prompt.ts`): how the office
  works, who the colleagues are, the person's authority as it stands in the database, the names
  of their skills, and their profile. A copy is written to `BRIEFING.md` in their folder so the
  owner can read exactly what they are told. It is a copy; editing it changes nothing.
- **The profile** (`staff.instructions`): who they are and how the owner wants the work done.
  Edited in the app.
- **Skills**, in `<folder>/.claude/skills/<skill>/`. Claude Code loads them for that person only
  (sessions use project settings only, so the owner's personal skills stay out) and reads a
  skill's instructions only when the work calls for it.

Their own notes (`notes/`, loaded through `CLAUDE.md`) and finished work (`library/`) are theirs
to write. `.claude/`, `CLAUDE.md`, `BRIEFING.md` and `.mcp.json` belong to the office: the gate
refuses file writes to them, and because a person can also run commands, `Skills.guard` checks
the folder before every piece of work. It compares each installed skill with the hash recorded
at install, and moves anything changed, or anything that appeared without being installed, to
`<office>/held/<id>/`, with a warning in the thread. Nothing a person writes there carries over
to their next piece of work.

## The catalog and hiring

`catalog.ts` keeps a list of sources: the house skills that ship in `apps/server/house-skills`,
and public GitHub repositories (three of Anthropic's by default). A repository is cloned to
`<office>/catalog/<id>` only when the owner presses Fetch. Nothing in it is run. The index reads
each `SKILL.md`'s name and description and notes which plugin a skill sits in and what else that
plugin carries. Installing copies the skill's folder into one person's folder and records the
source commit and a hash; plugins' connectors, hooks and commands are never installed.

Hiring (`hires.ts`) is a draft (`Hire`) that the chief of staff writes with three tools,
`search_skills`, `read_skill` and `propose_hire`, during an ordinary conversation in the chief's
own thread. Messages sent from the hiring desk carry a hint naming the open draft so the chief
revises it instead of starting another. The hiring desk and the chief's thread show the same
conversation, so a draft can be made in either; while one is open, a bar at the top of the
chief's thread opens it on the hiring desk (`/hire?draft=<id>`, which on a phone goes straight to
the draft). The owner can edit every field. Signing creates the
person (or updates an existing one) and installs the chosen skills. The chief cannot propose
authority above "asks first" and cannot sign.

Catalog text is treated as outside material: once the chief has searched or read it, outward
actions in that piece of work need a signature.

## The work list

Work that outlives one exchange is kept in [beads](https://github.com/gastownhall/beads) (`bd`),
in its own folder `<office>/work`. Beads holds the items, what waits on what, and who has claimed
what; the owner can run `bd ready` or `bd list` in that folder. `work.ts` is the only part of the
office that talks to it, one whole operation at a time (beads' embedded mode allows one writer),
and after each change copies the items into the office's store as `WorkItem`s, which is what the
interface and the staff tools read. Changes made from a terminal are picked up within a minute.

Staff use five tools: `list_work`, `add_work`, `claim_work`, `note_work`, `close_work`. They never
run `bd` themselves, so the work list sits inside the authority gate (giving work to a colleague
needs the same authority as `hand_to`).

- **Starting.** Work given to someone else that can start now starts them (a `work` trigger).
  Work a person opens for themselves is listed at the top of their next piece of work.
- **Releasing.** When a piece closes, anything that waited on it and is now ready starts its
  holder, with the results of what came before. A follow-up "for myself, after theirs" is how
  someone hears back without waiting.
- **Provenance.** A work item records the outside material its opener had read. Whoever takes it
  starts with that already counted, so the "asks first after reading outside material" rule
  follows the work from person to person.
- **Depth.** Each hand-on adds one; past three, ready work is reported in the thread and not
  started.

Without `bd` on the Mac the work list is off: staff are not told about it and the page says why.
`hand_to` remains for quick questions the asker waits for.

## The Drive folder

`drive.ts`. The office has at most one folder in the owner's Google Drive, stored as a path in
`Settings.driveFolder`. It is reached as local files through Google Drive for desktop, so the
office holds no Google credential and does not depend on the Claude account's Drive connector
(which staff may also have, for the rest of Drive).

- **Layout.** `Drop here`, `From staff`, `Filed`, `Backups`, each with an "About this folder"
  note. Created inside the chosen folder when it is chosen, at start, and every ten minutes after
  (Drive may open later). The chosen folder itself is never created: if it is missing, Drive is
  not running, and creating it would leave a stray local folder where the mount belongs.
- **At the gate.** A file tool call on a path inside the folder is classified `drive.change`
  (read needs Watches, write needs Asks first or Acts), not `mac.files`. Every read there adds to
  the turn's outside material. `Backups` is refused to staff for reading and writing.
- **Tools.** `drive_list`, `drive_move`, `drive_put` are office tools that are nevertheless
  classified as `drive.change`, so a move waits for a signature at "Asks first" and is logged at
  "Acts". They cannot leave the folder, enter `Backups`, or write over an existing file, and
  a link inside the folder does not carry them out of it: the part of a path that exists is
  followed to where it really is before anything is read or written (`drive_move` moves a link
  itself without following it). `drive_list` names every folder (ending in `/`) and says when one
  is empty; a link, a Google Drive shortcut or a folder that cannot be read is listed with the
  reason instead of being left out, so an unreadable folder never looks like an empty one.
  `drive_put` copies only from the person's own folder or the Books.
- A shell command is still `scripts.run` whatever path it names; one that mentions the folder
  marks the turn as having read outside material.

## The calendar and Google Calendar

The calendar page shows three things: due dates (`due` documents staff and the owner add), the
times scheduled duties run (`GET /duties/runs`), and appointments copied from the owner's Google
Calendar. The server holds no Google credential, so the copy is done by a member of staff
(`apps/server/src/calendar.ts`):

- **How.** The person reads Google Calendar through the connector on the Claude account, then
  calls the office tool `copy_calendar` once with a first day, a last day and every event
  between them. The server turns each start into a date and time of day in the office time zone
  and makes the office calendar match: new events are added, changed ones updated, and ones
  copied earlier that are no longer listed are taken off. An event is known by its Google id and
  its day, so running it again makes no duplicates. Nothing is written to Google Calendar.
- **What a copied item is.** A `due` document with `time`, `source` (`google-calendar` and the
  key) and `read`. It has no checkbox and no "Change date" on the page, because it belongs to
  Google Calendar; once its day has gone it is over, not overdue. An appointment the owner
  removes on the page is remembered (private kind `_calendar_skip`) and not copied back.
- **Outside material.** Anyone can put an invitation on a calendar. Reading a calendar through
  a connector now adds "Events on your calendar" to the turn's outside material, and every
  copied item carries that in `read`. A date added with `add_due` after reading outside material
  carries what was read in the same way. When staff read these back with `list_due` or
  `read_desk`, their own turn takes on that outside material, so "acts" becomes "asks".
- **The Desk** lists due dates and today's appointments only.

## Backups

`backup.ts`. One archive is the whole office folder except `catalog/` (clones that can be fetched
again) and the live database files, plus a consistent copy of the database made with SQLite's
`VACUUM INTO` and a small `backup.json`. It is packed with `tar`, piped straight into
[age](https://age-encryption.org), and the result is copied into `<Drive folder>/Backups` as
`bureau-YYYY-MM-DD-HHMM.tar.gz.age`, checked against what was made, then older archives are
thinned (newest of each of 14 days and 12 months).

- **Keys.** `age-keygen` makes a key pair when the owner presses the button. The office stores
  the public half in a private doc (`_backup`) and returns the private half, the recovery key, in
  that one HTTP answer. It is never stored or logged. Making a backup therefore needs no secret,
  and nothing on the Mac or in Drive can open one.
- **Consistency.** The work list's lock is held while its folder is read (`Work.quiet`). The
  nightly run waits up to two hours for running turns to finish; "Back up now" does not wait.
- **Schedule.** A ten-minute timer in `index.ts`; a backup is due when none has been made since
  3 am office time. Runs only while the server is running.
- **Failure.** The reason is kept in `BackupStatus.lastError`. After 36 hours without a backup a
  "Coming due" item with a fixed id (`due_backup`) appears on the Desk and is removed by the next
  success.
- **Restore.** `restore()` and `pnpm office:restore`: decrypts with the key on standard input,
  unpacks into a new or empty folder only, and removes what it wrote if it fails.

## Engines

`apps/server/src/engine/claude.ts` drives the installed `claude` through the Agent SDK.
`engine/demo.ts` is a scripted stand-in used by tests and by demo mode (`BUREAU_DEMO=1`), so the
whole app can be exercised without spending subscription usage.

## Plan usage, the hold on scheduled duties, and conversation size

The office shares one Claude plan with everything else the owner does on that account, so the week's
usage is always on screen and a limit in Settings keeps scheduled work from spending the lot.
Beside it is how far a staff conversation is from being compacted.

- **Reading the week.** `Engine.usage()`. The Claude engine opens the SDK with no message and
  asks for what Claude Code's own usage screen shows (`seven_day`: percent used and reset time).
  Nothing is sent to a model, so it spends nothing, and no credential is read: it is the
  installed `claude` answering for the account it is signed in to. The SDK marks this call
  experimental; if it goes away the readout says it could not be read and nothing is held. The owner's
  plan has no five-hour limit, so that window is not read or shown.
  The demo engine returns made-up figures (`BUREAU_DEMO_USAGE="week %,minutes to reset"`).
- **`apps/server/src/usage.ts`, `UsageWatch`.** Reads on start, every ten minutes, and twenty
  seconds after a turn ends; never more than once a minute. A week whose reset time has passed
  counts as empty until the next read. `GET /usage/plan` returns the last reading; `?fresh=1`
  reads again.
- **The hold.** `Settings.usageGuard` is `{ on, week }` in percent (defaults: on, 80).
  `Scheduler.fire` asks `UsageWatch.hold()` before each scheduled run. At or past the limit the
  run is skipped, the duty records `held: { at, why }`, and one notice goes on the Desk for that
  spell (`due_usage`), taken off when usage is back under the limit or the limit is raised.
  Held runs are not saved up: the duty runs at its next scheduled time.
- **What is never held.** Anything the owner asks for, Run now, work handed between staff, and work
  list items. Only the scheduler asks. If the figure cannot be read, duties run.
- **Limits of it.** The figure covers the office's account only; a member of staff given a second
  account folder is not counted. A long duty that starts under the limit is not stopped part-way.
- **Compaction.** Each member of staff has one running conversation. `Settings.compactAt`
  (tokens, default 400,000, from 100,000 to 1,000,000) is passed to every turn as Claude Code's
  `autoCompactWindow` setting. It has to be passed: staff turns load only the staff folder's
  settings, never the owner's own `~/.claude/settings.json`, and without it the default model
  compacts near 1,000,000. Claude Code keeps 33,000 in reserve, so with 400,000 compaction starts
  at 367,000.
- **Reading a conversation's size.** As a turn ends, the engine asks Claude Code for its own count
  (`getContextUsage`, answered locally) and the turn stores it on the staff record as
  `context: { used, window, compactsAt, at }`. On start, and for everyone when `compactAt`
  changes, `Turns.readContexts` measures saved conversations without a turn (`Engine.context`:
  the conversation is opened without being written to and no message is sent; it reads slightly
  low because the office's tools are not loaded). A new conversation clears the figure.
- **On screen.** `apps/web/src/components/Usage.tsx`: at the foot of the sidebar, the week
  (percent, a bar with a mark at the hold limit, time to reset) and Context (percent of the way to
  compaction and tokens left) for the person whose thread is open, or otherwise whoever is nearest
  to compaction. A phone shows the same in one line above the message box, and a thread on a phone
  shows its own line under the name. The reset countdown is in days while more than 24 hours
  remain, then hours, then minutes. Settings has both sections: Claude usage and Conversation size.

## Learning from corrections

When the owner edits a draft before signing it, or declines one and says why, the office asks
whether the correction holds a standing rule (`Slips.maybeLearn`, `lessonPrompt` in
`prompt.ts`, answered by `Engine.ask` with no tools). If it does, the rule comes back as a slip
of kind `lesson`: "A rule for Piper, from your edit". Nothing is learned unsigned.

- Signing appends the line to that person's profile (`staff.instructions`) under the heading
  "Learned from corrections:", where it is read on every turn and can be changed or removed in
  Settings like any other line. The owner can reword it before signing. Declining drops it.
- The prompt forbids rules that add authority, name a recipient or an account, or tell staff to
  send, pay or share. A rule changes how work is prepared; it never changes what the gate allows.
  The lesson slip carries the outside material the corrected slip had read, so the owner can see it.
- At most three proposed rules wait per person, a rule already in the profile is not proposed
  again, and lesson slips have no checker, no notification and no row in the thread.
- An edit is noticed by comparing what was signed with what was drafted (`_slipx.originalText`).

## Artifacts

Finished work staff keep for the owner is whatever they write in their own `library/` folder
(`apps/server/src/artifacts.ts`). The files are the record; nothing is registered. A version mark
in a name ("Cold open v3 - 2026-11-16.fountain", "budget_v2.csv", "notes (v4).md") makes files
versions of one piece; a file with no mark is version 1. Links are not followed.

- **Where they show.** In a person's details, under Open work: the newest four as rows, with
  anything marked for the owner on top. Any of them opens the viewer, which is as large as the window, with that person's list beside it (search
  past six, retired ones folded at the end), a version menu, Save to Drive, and a menu with
  Download, Retire and Delete. `/artifacts` (once the Library) is the same for the whole office:
  one list, newest first, each row naming the writer. The viewer's address is `?artifact=<id>` (and `&staff=` on `/artifacts`), so the
  back button closes it. On a phone the list and the document take the screen in turn.
- **How each kind is drawn.** `.fountain` as a script (`apps/web/src/lib/fountain.ts`: title page,
  scene headings, dialogue, transitions); `.md` as a document; `.csv`/`.tsv` as a table; images;
  PDFs in the browser's viewer (opened on their own on a phone, where a framed PDF shows one
  page); `.html` in a frame with `sandbox="allow-scripts"` and no same-origin, given a content
  policy that allows inline scripts and the usual script CDNs but no network connections, forms
  or base URL, so a chart runs and cannot reach the office or send anything anywhere. The file
  endpoint hands a page over as text and everything else with `sandbox` in its own policy.
  Spreadsheets and other files can only be downloaded or saved to Drive.
- **What the owner does.** Save to Drive copies the version on screen to
  `From staff/<name>/` and never over another file (a name taken gets " (2)"); the copy is
  remembered, so the button then reads "In Drive". Retire hides a piece from the list and keeps
  the files. Delete removes every version and any folder it leaves empty, after a confirmation;
  copies in Drive and earlier backups keep theirs. Both are kept in private `_artifact` docs.
- **Notes and edits.** Scripts, documents, text and tables can be marked up in the viewer
  (`apps/web/src/components/ArtifactNotes.tsx`). Selecting words offers Add note (a floating
  button on a computer, a bar at the bottom on a phone); a note keeps its quote and a little of the
  text before it, so the passage is found again and marked with the CSS Custom Highlight API. Notes
  collect in a column beside the page (a sheet on a phone) and go to the writer together: Send
  makes one owner message with each passage quoted and the version it was on, and starts a turn
  (`Artifacts.composeNotes`). A sent note reads "waiting" until a newer version by the writer
  appears, then "answered"; the owner puts notes away. Edit opens the text of the version on
  screen; saving writes the next version in the writer's `library/` (never over a file) and marks
  it the owner's, which the version menu shows as "yours" and the next message to the writer
  points at. Notes are private `_artifactNote` docs and go when the piece is deleted.
- **New and marked.** A piece with a version from staff the owner has not opened has a
  highlighted border and "New". Staff can mark pieces for the owner with `mark_artifacts` (the
  chief of staff in anyone's library), for "which one is the budget?"; a marked piece stands out
  the same way and says who marked it and why. Opening it in the viewer clears both
  (`POST /artifacts/seen`, `seenAt` and `marked` in the `_artifact` doc); the computer picking the
  newest piece to show beside the list does not count. Work older than the first listing after
  this was built (`_artifactSince`) counts as seen.
- **Editing a note.** Tapping a marked passage opens its note in the same card as a new one, to
  change or remove it; a sent note shows where it stands and can be put away. A note whose passage
  cannot be found on the page says so in its card.
- The list loads again when that person finishes a turn, after anything the owner does in the
  viewer, and when the app comes back to the front. It always loads the first time, even while
  someone is working.

## Ways in

Three ways to get a document or a message to the office (`apps/server/src/intake.ts`):

- **Attach to a message.** The plus beside the message box (phone or computer) sends each file to
  `PUT /uploads`; the message then names the ids. `Uploads.take` moves them into that person's
  own folder under `inbox/<day>/`, the prompt lists them, and the turn starts already marked as
  having read outside material ("Attached file ..."). Ten files of 25 MB each; held files that
  are never sent are swept after a day. On a phone or tablet a camera button beside the plus
  takes a photo and attaches it the same way. The phone's request bar on the Desk has a plus too
  (inside the box): what is chosen there, from the photo library or Files, goes with the message
  to the chief of staff. A photo the phone hands over as "image.jpg" is given a dated name.
- **Drop here.** `DropWatch` looks in the Drive folder's Drop here once a minute. What was there
  the first time it looked is left alone; after that a file is handed to the chief of staff once
  it looks the same on two looks running (so a copy in progress is not read half-written), with a
  turn of kind `drop` that is marked outside from the start. Files inside a folder wait until
  nothing in that folder has changed for three looks, then go as one hand-off (a list past thirty
  files is summed up), so a folder Google Drive is still filling makes one notice, not several.
  The chief deals with it or hands it on and moves it under Filed. `Settings.watchDrop` switches
  it off. A folder can be left alone (private docs of kind `_dropPark`): by the owner under
  Drive folder in Settings (`POST /drop/park`), or by staff with `drop_leave_alone` when the owner
  says so; nothing in it is handed over until it is watched again.
  The camera button in the phone's request bar puts a photo there from the app (`PUT /drop`,
  `leaveInDrop`): it is written under a dated name ("Photo 2026-11-15 15.42.07.jpg"), never over
  a file already there, and the watch picks it up like any other. With no Drive folder to be
  seen, the app attaches the photo to a message to the chief of staff instead.
- **Forward a message.** A convention, not a mechanism: staff who may read mail are told that a
  message the owner forwards to their own address with `+office` is a request from the owner, with the
  forwarded part still outside material. It is picked up on the next pass through the inbox, so
  it needs an inbox duty switched on. Not yet tried against real mail.

A hand-off carries the taint both ways: `hand_to` passes what the sender had read to the
receiver's turn (`Trigger.read`), and the answer brings back what the receiver read
(`TurnResult.read`), so passing work to a colleague cannot wash outside material off.

All three count as outside material: a turn that began with them cannot send mail, change the
calendar or run anything on the Mac without a signature, whatever that person's authority.

## The week

`/week` shows the last seven days beside the seven before, counted by `weekReport`
(`apps/server/src/week.ts`) from the office's own records: `_usage` rows (pieces of work, time,
which were scheduled duties), the done log, slips (signed as written, edited, declined, rules
signed), closed work and dates flagged for a decision. No member of staff writes any of it. The
page also shows the plan's week figure, which covers everything on the account and not only the
office; the office's share of it cannot be read. The cost figure is what Claude Code reports the
same work would cost at API prices, shown as a measure of volume and labelled as not a charge.
Scheduled runs are counted from 2026-11-13, when `_usage` began recording what started a turn.

## Notifications

When a slip is filed the server notifies every subscribed device (`apps/server/src/push.ts`).
Both routes go straight from the Mac to the push service; there is no relay.

- Web Push for the installed web app. Keys are generated on first use and kept in the database.
- Apple Push for the iPhone app, using the owner's own key described in `<office>/apns.json`.
  Without that file this route is off.

A notification offers Sign only for a plain action slip whose origin lists no outside material.
Questions, reviews, promotions and anything tainted must be opened.

## The iPhone app

`apps/ios` is a `WKWebView` around the served interface plus a small bridge, injected as
`window.bureauNative`:

- `confirm(reason)` resolves true after Face ID or the passcode. The web interface calls it
  before posting a signature when it is present.
- `haptic(kind)` with `light`, `medium`, `success` or `warning`.
- `ready()` tells the app the interface is showing, which is when it asks about notifications.

The Sign action on a notification posts to `/api/slips/:id/sign` with the same device session
cookie the web view holds. The undo window still applies.

## The Mac app

`apps/mac` is an AppKit app: one `WKWebView` window that hides instead of closing, a menu bar
item and a Dock badge. It injects the same `window.bureauNative` bridge with `platform: 'macos'`;
`confirm` asks macOS for Touch ID, Apple Watch or the account password, and answers no if the
Mac cannot ask.

Beside the web view the app holds its own socket to `/api/sync` (`Watcher.swift`), authenticated
with the web view's session cookie. From it the app keeps the count of pending slips and posts a
local notification when a slip becomes pending after the first snapshot. No push service is
involved, so the Mac app notifies only while it is running. The Sign action follows the same rule
as on the phone and posts to `/api/slips/:id/sign`.

The app does not start or stop the server.

**Another Mac.** Settings, Devices, "Add a Mac" makes a pairing code and shows one line for
Terminal on the other Mac: `curl -fsSL '<address>/api/mac/install?code=<code>' | sh`. The script
(`apps/server/src/mac.ts`) downloads `GET /api/mac/Bureau.zip`, puts the app in `/Applications`
(or `~/Applications` without write access), sets `serverURL`, `pairCode` and `pairLabel` (the
computer's name) in the app's defaults and opens it; the app's first page is
`/pair?code=…&label=…`, and the code is removed from its defaults. Fetched with curl, the app is
not marked as a download, so Gatekeeper does not hold back an app signed ad hoc. The copy handed
out is the newer of `apps/mac/build/Bureau.app` and `/Applications/Bureau.app` (or
`BUREAU_MAC_APP`), zipped with `ditto` once per build into `<office>/cache/`. The address comes
from Tailscale (`apps/server/src/reach.ts` reads `tailscale status` and `tailscale serve status`,
at most once a minute); `BUREAU_REACH` fixes it for demo offices and tests. The installer and the
zip are open without pairing because the other Mac is not paired yet; neither holds anything of
the office's.

## Running in the background and from other devices

`scripts/service.sh` installs a launchd agent (`dev.bureau.server`) that starts the server at
login and restarts it if it stops. `scripts/remote.sh` turns on Tailscale Serve, which gives the
Mac an HTTPS address reachable only from the owner's own tailnet. Neither is run automatically.
Tailscale Serve gives one app per port: another app that turns on Tailscale HTTPS on port 443
(T3 Code does by default) takes the address from the office, and every other device loses it.
Settings, Devices says so when it happens (`ReachInfo.taken`); the other app moves to another
port (8443) and `pnpm remote:on` takes 443 back.

The first time the service starts, macOS asks whether `node` may open the Documents folder (the
code lives there) and, later, files managed by Google Drive. Until the owner answers, the server
waits inside its first file read and says nothing, so the installer stops any office already on
the port, waits fifteen seconds for an answer on `/api/session`, and explains the question if
none comes. Only the owner can answer it; the question does not appear for an office started from a
terminal, which inherits the terminal's permission.

A turn that is waiting on the owner (a question, or a draft to sign) holds that person's queue:
their later duties wait behind it until the owner answers, and restarting the server expires the
waiting slip. Deferring the wait and resuming when the owner answers is not built.
