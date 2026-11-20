# Bureau (working name) — project guide

A personal team of AI agents ("staff") that runs on the owner's Mac, on the owner's own Claude
subscription, and is reachable from the owner's other devices. Staff handle business and personal
affairs: inbox, calendar, books, obligations, research, the occasional script.

**Setting Bureau up on a Mac for the first time? Follow `SETUP.md`, not this file.** This file
is for working on the code.

**If this checkout has an `owner/` folder, read `owner/RESUME.md` and `owner/README.md` before
anything else.** They hold one person's private notes about their own installation (which
accounts, what is running, what was in the air when the last session stopped). That folder is
never part of the shared copy of the code; see "Sharing the code" below.

## What exists

A first working build, walked end to end and in daily use since 2026-11-14: the server
(`apps/server`, 129 tests), the web interface (`apps/web`), the iPhone shell (`apps/ios`) and the
Mac app (`apps/mac`, installed at `/Applications/Bureau.app` with `pnpm mac:install`). Demo mode
(`pnpm start:demo`) shows the whole product without spending usage. Screenshots of the build are
in `docs/built/`, taken from a demo office with an invented owner.

- **Other Macs.** Settings, Devices, "Add a Mac" gives one Terminal line for the other Mac that
  installs the Mac app from the office itself, points it at the office's Tailscale address and
  pairs it (`apps/server/src/mac.ts`, `reach.ts`). Settings warns when another app has taken
  the office's Tailscale address. See "The Mac app" in `docs/architecture.md`.
- **The Claude account.** The office runs on the Mac's ordinary Claude Code sign-in. It does not
  follow the account of the shell or Claude Code session that starts it: an inherited
  `CLAUDE_CONFIG_DIR` is dropped. Settings shows the account and its connected apps. Gmail,
  Google Calendar and Google Drive reach staff only as connectors on that account.
- **Hiring and skills.** Staff are set up through a conversation with the chief of staff at
  `/hire` that ends in a draft the owner edits and signs. Each person has a profile and skills
  installed in their own folder from a catalog fetched on request. See "What a member of staff is
  made of" in `docs/architecture.md`.
- **Work list.** Open work is kept in beads (`bd`) in `~/Bureau/work`, wrapped by
  `apps/server/src/work.ts`; the page is `/work`. Tests in `test/work.test.ts` run against the
  real `bd` and are skipped when it is not installed.
- **Drive folder and backups.** The office has one folder in the owner's Google Drive, reached as
  local files through Google Drive for desktop (`apps/server/src/drive.ts`), with Drop here, From
  staff, Filed and Backups. The office backs itself up there once a day as an age-encrypted
  archive (`apps/server/src/backup.ts`, `pnpm office:restore`). Only the public half of the key
  is kept; the owner holds the recovery key. Tests in `test/backup.test.ts` need `age`.
- **Artifacts.** Finished work is whatever staff write in their own `library/` folder; versions
  are files named "Title v2", "Title v3". The newest show in a person's details (new work and work staff marked for the
  owner with `mark_artifacts` stand out until opened) and open in a
  large viewer (a script laid out as a script, tables, charts in a sealed frame) with Save to
  Drive, Retire and Delete. The owner can leave notes on passages and send them to the writer as
  one message, or edit the text and save it as a version of their own. `/artifacts` lists everyone's. See "Artifacts" in
  `docs/architecture.md`.
- **Calendar.** `/calendar` is a list over a week or month grid. Staff copy the owner's Google
  Calendar onto it with the office tool `copy_calendar` (`apps/server/src/calendar.ts`); the
  server itself never reads Google. Calendar reads count as outside material.
- **Usage and conversation size.** The week's plan usage and how far a staff conversation is from
  compaction are always on screen (`apps/web/src/components/Usage.tsx`). The week is read from
  Claude Code through the SDK without sending a message (`Engine.usage`,
  `apps/server/src/usage.ts`); past the limit in Settings the scheduler skips scheduled duties,
  and whatever the owner asks for still runs. That SDK call is marked experimental, so the guard
  fails open. There is no five-hour figure: a plan with a five-hour limit is neither shown nor
  guarded. Staff conversations compact at 400,000 tokens (`Settings.compactAt`, passed to each
  turn as `autoCompactWindow`, because staff turns do not read the owner's own Claude Code
  settings). Demo figures: `BUREAU_DEMO_USAGE="61,5540"` (week percent, minutes to reset).
- **Corrections, ways in, the week.** An edit before signing or a decline with a reason can come
  back as a proposed rule (a slip of kind `lesson`); signing adds a line to that person's profile
  (`Slips.maybeLearn`). Files reach the office attached to a message (`PUT /api/uploads`), left
  in the Drive folder's Drop here (`DropWatch` in `apps/server/src/intake.ts`, handed to the
  chief of staff; the phone's camera button puts a photo there with `PUT /api/drop`), or
  forwarded to the owner's own address with `+office` (a briefing convention, untested against
  real mail). All three are outside material. `/week` counts the last seven
  days from the office's records (`apps/server/src/week.ts`); staff do not write it.
- **Themes.** Five looks, chosen per device under Appearance in Settings and kept in that
  browser (`apps/web/src/lib/theme.ts`, key `bureau.theme`): Drafting table (the default), Graph
  paper, Night shift, Control room, Stationery. A theme is a block of token overrides in
  `apps/web/src/styles/themes.css` keyed on `data-theme`; components use tokens only, never a
  literal color, typeface or radius. An inline script in `apps/web/index.html` applies the choice
  before the first paint. Rules for themes are in `docs/design/brief.md`.
- **The owner has no name in the code.** What staff call the owner and what they are told about
  the owner are settings (`Settings.ownerName`, `Settings.ownerAbout`, both under "You" in
  Settings). The owner's messages are `from: 'owner'` and the question tool is `ask_owner`.

Known gaps: a turn waiting on the owner holds that person's queue and does not survive a
restart; mail forwarded with `+office` has not been tried. Not built: iMessage, 1Password. Not
tested: Apple Push, Face ID on a real phone, the status bar over a dark theme on a real iPhone,
and on the Mac a real Touch ID match and notification banners (the owner has to allow
notifications for Bureau in System Settings first).

## Read these first when working on the code

1. `docs/decisions.md` — what has been decided and why, plus open questions.
2. `docs/vision.md` — the product concept (the Desk, staff, earned authority, the Books).
3. `docs/design/brief.md` — visual direction and the list of screens designed in Paper.
4. `docs/architecture.md` — how the server, sync, authority gate and clients fit together.
5. `docs/research/` — findings from the two reference repos.

## Hard rules

- **Claude access:** only through the Claude Agent SDK launching the installed `claude` binary
  that the owner signed in to personally (the T3 Code pattern). Never read, copy or proxy
  credentials. The office uses the Mac's ordinary sign-in unless `BUREAU_CLAUDE_CONFIG_DIR` names
  another account folder. A second account is a separate folder assigned to a staff member
  explicitly. No automatic account switching.
- **Money:** staff prepare payments and filings; the owner executes them. Staff cannot move money.
- **Untrusted content:** staff that read email or the web do not hold authority to send or pay.
  Every sign-off shows where the request came from.
- **The recovery key:** never put a backup recovery key in a file, a log, a commit or a reply.
- **Design:** the layout idea came from Grok Bot via bot-hq, but no Grok Bot artwork, colors,
  avatars or copy may be reused. T3 Code is a reference for patterns, not a source of code.
- **A running office:** the background service and remote access (`scripts/service.sh`,
  `scripts/remote.sh`) are opt-in and are the owner's to run; never run them unasked. A real turn
  reads the owner's real mail, calendar and Drive and spends their subscription, so use demo mode
  for anything that does not need one. Restart a real office only when no turn is running or
  waiting: a waiting slip expires on restart.

## Layout

- `SETUP.md` — first-time setup on a new Mac, written for an agent to follow with its owner.
  `scripts/setup-check.sh` (`pnpm setup:check`) reports what is installed and what is missing.
- `docs/` — vision, decisions, research, design brief, architecture.
- `reference/` — shallow clones of the two reference repos (git-ignored, read-only).
  Re-create with the commands in `docs/research/README.md` if missing.
- `.claude/skills/frontend-design/` — Anthropic's frontend-design skill, used for design work.
- `apps/server`, `apps/web`, `apps/ios`, `apps/mac`, and `shared/contract.ts` (the wire types
  both sides import).
- `scripts/` — background service (launchd), remote access (Tailscale Serve), the Mac app build.
  `scripts/dev/drive.mjs` drives the web app in headless Chrome for screenshots (demo offices
  only). `scripts/dev/share.sh` makes the shared copy of the code.
- `owner/` — present only in the owner's private checkout. Private notes; never shared.

## Conventions

- The office assumes Google Workspace (Gmail, Calendar, Drive) through Claude connectors, not
  Apple's apps.
- Designs live in Paper (file "Bureau"); see `docs/design/brief.md` for the screen list.
- Commit after each meaningful step so a restart loses nothing.
- Node 24 runs the server's TypeScript directly: erasable syntax only, `.ts` import extensions.
- `pnpm test` before committing server changes, and type-check each app directly
  (`cd apps/server && npx tsc -p tsconfig.json`, same in `apps/web`). `pnpm -s typecheck` hides
  errors; do not rely on it. Use demo mode (`BUREAU_DEMO=1`, office in `~/Bureau-demo`) for
  anything that does not need a real Claude turn.
- The web app is served from `apps/web/dist`. `pnpm build` in a checkout that a running office
  serves from changes what that office's devices load at once, so build there only when the
  server is about to be restarted on the same code, or when the change is to the web app alone.
- Web styles use the tokens at the top of `apps/web/src/styles/app.css` (`--surface`, `--edge`,
  `--round`, `--on-blue` and the rest). A literal `#fff`, a font name or a bare pixel radius in a
  rule breaks the themes. Copy never names a color. Look at a change in at least one dark theme.
- **Never name a person in code, prompts, tests, docs or screenshots.** The person the office
  works for is "the owner"; sample data uses invented people (Robin Hale is the owner in tests
  and fixtures). Names, addresses, accounts, host names and anything about someone's life belong
  in `owner/`.

## Sharing the code

The code is shared as a clean copy, not as this repository's history. `scripts/dev/share.sh`
exports the current commit without `owner/` (marked `export-ignore` in `.gitattributes`), then
refuses to go on if the copy contains any term listed in `owner/private-terms.txt` (names,
addresses, host names). Run it before every push to the shared repository. If `owner/` does not
exist, this checkout is already a shared copy and there is nothing to strip.
