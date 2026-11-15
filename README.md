# Bureau (working name)

A personal office of AI staff that runs on your own Mac and your own Claude subscription,
reachable from your other devices. An office, not a chat app: staff prepare work, anything that
matters comes to your Desk as a slip, and nothing leaves until you sign it.

**Setting it up on your Mac:** clone this repository, open your coding agent in the folder and
say "Read SETUP.md and set Bureau up for me."

```sh
git clone https://github.com/lvl0lvl/Bureau.git bureau
cd bureau
```

[SETUP.md](./SETUP.md) walks the agent (or you) through everything:
what to install, what only you can do, and how to check each step. `pnpm setup:check` reports
what is in place at any time.

**Working on the code:** start with [CLAUDE.md](./CLAUDE.md), then
[docs/vision.md](./docs/vision.md) and [docs/decisions.md](./docs/decisions.md).

## Try it without spending any usage

The demo office is scripted. It uses no Claude usage and keeps its files in `~/Bureau-demo`.

```sh
pnpm install
pnpm build          # builds the interface once
pnpm start:demo     # http://localhost:8787
```

Things to try in the demo: sign the slip on the Desk and watch the undo window, open a staff
member and ask for "an invoice", "a research note" or "run the backup script", ask someone to
"pay" something (they cannot), and change a level on the Staff page.

## Run the real office

Needs Node 24 or newer, pnpm, and Claude Code installed and signed in (`claude` on your PATH).
Bureau starts that same `claude` program for each staff member; it never touches your sign-in.

```sh
pnpm build
pnpm start          # http://localhost:8787, files in ~/Bureau
```

Standing duties are switched off in a new office, so nothing runs until you turn a duty on or
send a message.

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm dev:demo` | Server and interface with live reload, for working on Bureau itself |
| `pnpm test` | Server tests |
| `pnpm typecheck` | Type-check everything |
| `pnpm setup:check` | Report what is installed and set up on this Mac, and what is missing |
| `pnpm pair` | Print a one-time code for pairing another device |
| `pnpm service:install` | Keep Bureau running in the background and start it at login |
| `pnpm service:status`, `service:logs`, `service:uninstall` | Manage that background service |
| `pnpm remote:on` | Make Bureau reachable from your other devices over Tailscale, with HTTPS |
| `pnpm remote:status`, `remote:off` | Check or stop remote access |
| `pnpm mac:install` | Build the Mac app, put it in `/Applications` and open it |
| `pnpm mac:build` | Build the Mac app only (`apps/mac/build/Bureau.app`) |

Settings that can be changed with environment variables: `BUREAU_HOME` (office folder),
`BUREAU_PORT` (8787), `BUREAU_CLAUDE_PATH` (which `claude` to start), `BUREAU_OWNER` (your name,
for a new office; afterwards it is under You in Settings, with what staff are told about you),
`BUREAU_CLAUDE_CONFIG_DIR` (see below).

**Which Claude account.** The office runs on this Mac's ordinary Claude Code sign-in, the one you
get by typing `claude` in a new terminal. Settings, under Connected apps, shows the account and
what it can reach. To run the office on a different account, sign in to it in its own folder
(`CLAUDE_CONFIG_DIR=~/claude-second claude`) and start the office with
`BUREAU_CLAUDE_CONFIG_DIR=~/claude-second`. A single staff member can be given their own account
folder on their settings page. The office never takes the account from the terminal or session
that happened to start it, and never switches accounts by itself.

## Hiring and setting up staff

Staff are set up by talking to your chief of staff. Open **Hire someone**, say what you need, and
answer the questions that come back. It can take several rounds. The result is a draft beside
the conversation: a name, a role, a profile, starting authority and a short list of skills, each
with a reason. Change anything, then sign. Nothing exists until you do. The same desk sets an
existing member of staff up again.

Skills come from a catalog. Four house skills for a one-person business ship with Bureau
(invoicing, filing receipts, closing a month, the quarterly tax packet). Anthropic's public
collections are listed as sources but are downloaded only when you press Fetch in Settings.
A skill is copied into that one person's folder and does not change afterwards. Only the skill
is installed: if it comes from a plugin that also carries connectors or hooks, those are shown
and left out.

Each person's folder is at `~/Bureau/staff/<name>/`. `BRIEFING.md` there is a copy of exactly
what they are told before each piece of work.

## The work list

Anything that takes more than one exchange goes on the work list: who holds each piece, what it
waits on, and what came of it. Give someone a piece of work from the **Work** page, or ask your
chief of staff to break a job down. Finishing one piece starts whoever holds the next.

The list is kept in [beads](https://github.com/gastownhall/beads). Bureau uses the `bd` program
if it is installed (`BUREAU_BD_PATH` to point at a specific one) and keeps its data in
`~/Bureau/work`, where you can also run `bd ready` or `bd list` yourself. Without `bd` the work
list is switched off and everything else works as before.

## The office's folder in Google Drive

The office can have one folder in your Google Drive. It is how documents get in and out: you see
it on every device, and staff see it as ordinary files on the Mac through Google Drive for
desktop, which has to be installed, signed in and running. Bureau holds no Google password or
token for this.

Choose the folder in **Settings → Drive folder** (for example
`~/Library/CloudStorage/GoogleDrive-you@gmail.com/My Drive/Office`). Bureau then creates four
folders inside it and leaves anything else you keep there alone:

- **Drop here** — leave a receipt, a statement, a letter or a photo of a document for the office.
  Staff move each one to *Filed* when it has been dealt with, so what is left still needs doing.
- **From staff** — finished documents for you: a packet, a report, a spreadsheet.
- **Filed** — original documents kept for the record, as `Filed/<year>/<kind>/`.
- **Backups** — see below. Staff cannot read or change it.

For staff, changing anything in the folder falls under "Change files in Drive", and whatever they
read there counts as outside material, the same as mail. If Google Drive is not running, the
folder cannot be seen; Bureau says so and never creates a stand-in.

## Backing up the office

This repository holds the code. Your office (`~/Bureau`: the database, the Books, each person's
folder, the work list) is backed up separately, into the **Backups** folder above.

1. Install the encryption tool once: `brew install age`.
2. Choose the Drive folder, then press **Create recovery key** in **Settings → Backup**. The key
   is shown once. Save it in 1Password. Bureau keeps only the half that locks a backup, so
   nothing on the Mac or in Drive can open one, and neither can Bureau.
3. From then on the office makes one encrypted copy a day (after 3 am, waiting up to two hours
   if staff are mid-task) while it is running, and keeps the newest of each of the last 14 days
   and of each of the last 12 months. **Back up now** makes one at once.

If backups have not worked for a day and a half, a notice appears on the Desk under "Coming due"
with the reason. Without the recovery key a backup cannot be opened by anyone.

To restore, on any Mac with this repository and `age`:

```sh
pnpm office:restore "<path to>/Backups/bureau-2026-11-13-0300.tar.gz.age" ~/Bureau-restored
```

It asks for the recovery key (or reads it from a pipe, for example from 1Password's `op read`),
refuses to write into a folder that is not empty, and tells you how to start Bureau on the
result. The skills catalog is not in a backup; fetch it again in Settings.

## The Mac app

The interface works in any browser at `http://localhost:8787`. The Mac app is the same interface
in its own window, plus a menu bar item showing how many slips are waiting, a Dock badge,
notifications when a slip arrives, and Touch ID or your password before a signature.

```sh
pnpm mac:install
```

It connects to the office; it does not start it. Keep the office running with `pnpm start` or
`pnpm service:install`. See [apps/mac/README.md](./apps/mac/README.md).

## Your other devices

1. Install Tailscale on the Mac and on the phone, signed in to the same account.
2. On the Mac: `pnpm remote:on`. It prints the address.
3. On the phone, open that address and enter a pairing code (Settings on the Mac, or `pnpm pair`).

Only devices on your own Tailscale network can reach the address, and each one still has to be
paired. Nothing is exposed to the public internet.

**As an installed web app.** In Safari on the phone: Share, then Add to Home Screen. Open it from
the home screen and turn on notifications in Settings.

**As a native iPhone app.** Open `apps/ios/Bureau.xcodeproj` in Xcode, choose your team under
Signing & Capabilities, and run it on your phone. The native app adds Face ID before a signature,
notifications with a Sign button, and haptics. See [apps/ios/README.md](./apps/ios/README.md) for
the one-time Apple Push key setup.

## Where things are

- `apps/server` — the office: storage, sync, the authority gate, slips, turns, the Claude engine.
- `apps/web` — the interface, served by the server.
- `apps/ios` — the iPhone app.
- `apps/mac` — the Mac app.
- `shared/contract.ts` — the types the server and the interface agree on.
- `docs/` — vision, decisions, architecture, research, design.
- `~/Bureau` — your office: `bureau.db`, `books/` (a git repository of shared records),
  `staff/<name>/` (each staff member's notes and library) and `work/` (the work list).
- The office's Drive folder, if you chose one — documents in and out, and the backups.

## Hard rules

- Claude is reached only by starting the installed `claude` program you signed in to yourself.
  No credentials are read, copied or proxied, and accounts are never switched automatically.
- Staff prepare payments and filings; you carry them out. Nobody on staff can move money.
- Staff that have read outside material (email, the web) lose the right to act without asking for
  the rest of that piece of work, and every slip shows what it traces back to.

## Status and licence

A first working build made for one person's daily use and shared as it is. Only macOS is
supported. Nothing here is affiliated with or endorsed by Anthropic; you use your own Claude
subscription under Anthropic's terms, which are yours to read. Staff act on real mail, calendars
and files, so start with the demo, keep authority low, and read what you sign.

The code is under the [MIT licence](./LICENSE). `.claude/skills/frontend-design` is Anthropic's
skill under its own licence (Apache 2.0, included there). The typefaces come from Fontsource
packages under the SIL Open Font License.
