# Setting up Bureau on a Mac

This guide is written for a coding agent (Claude Code or similar) working in a terminal on the
Mac that will run the office, with the person who will own the office at the keyboard. If you
are that person and have no agent, the steps work by hand too.

To use it, the owner clones the repository somewhere outside Documents, Desktop and Downloads
(`git clone https://github.com/lvl0lvl/Bureau.git ~/bureau`), opens their agent in that folder
and says:

> Read SETUP.md and set Bureau up for me. Stop and tell me whenever a step is mine to do.

Bureau is a personal office of AI staff. It runs on one Mac, on its owner's own Claude
subscription, and the owner reaches it from a browser, a Mac app and their phone. `README.md`
describes the product; this file only gets it running.

## Rules for the agent doing the setup

1. **Sign-ins and passwords are the owner's.** Never type, read, store or repeat a password, a
   sign-in code, a recovery key or a token. When a step needs a sign-in, say exactly what to
   open and wait for the owner to say it is done. Do not open or copy files under `~/.claude`.
2. **macOS questions are the owner's.** Permission dialogs, System Settings, the Mac's password
   for an installer, approving a system extension: describe what will appear and wait.
3. **Ask before each optional part** (parts 5 to 10). They are independent. An owner who wants
   only the office in a browser on this Mac stops after part 4.
4. **Use the demo for trying things.** A real office reads the owner's real mail, calendar and
   Drive and spends their Claude plan. Do not send a real member of staff anything as a test
   beyond the one check in part 4.
5. **Check, do one thing, check again.** `sh scripts/setup-check.sh` only looks; run it as often
   as you like. Report what it says in plain words. If a step fails, show the owner the error
   and stop; do not work around it by changing Bureau's code or the Mac's settings.
6. **The backup recovery key never passes through you.** In part 6 the owner presses the button
   and saves the key themselves. Do not ask to see it, and do not take a screenshot while it is
   on screen.

## What the owner will need

| Needed for | What |
| --- | --- |
| Everything | A Mac on macOS 13 or newer that can stay on, awake and logged in |
| Everything | A paid Claude plan that includes Claude Code (Pro, Max or higher), used by this one person |
| Mail, calendar, files | Gmail, Google Calendar and Google Drive connected to that Claude account as connectors |
| Phone and other computers | A free Tailscale account |
| Drive folder and backups | Google Drive for desktop, and a password manager to keep one recovery key |
| The Mac app, the native iPhone app | Xcode (large; from the App Store). The iPhone app also needs an Apple developer account |

Bureau starts the `claude` program the owner installed and signed in to, on the owner's own Mac,
for the owner's own use. It never reads or copies the sign-in. It is not a way to share one
subscription between people: each person runs their own office on their own plan. Anthropic's
terms are the owner's to read and follow.

## 1. Look at what is already there

```sh
sh scripts/setup-check.sh
```

Each line is `ok`, `MISSING` (needed) or `not yet` (optional). Work through the missing ones in
part 2. Note where this folder is: if it is inside Documents, Desktop or Downloads, macOS will
later ask the owner whether `node` may open that folder (part 7). Moving the folder somewhere
like `~/bureau` now avoids that question. Move it before installing anything, not after.

## 2. Install what is needed

Use Homebrew if it is installed (`brew --version`). If it is not, installing it asks for the
Mac's password, so the owner runs the command from https://brew.sh themselves in a terminal.

| Missing | Install | Notes |
| --- | --- | --- |
| git | `xcode-select --install` | A dialog opens; the owner clicks Install |
| Node.js 24 or newer | `brew install node@24 && brew link --overwrite --force node@24` | If the owner uses nvm, fnm or similar, use that instead (`nvm install 24`) |
| pnpm | `brew install pnpm` | Or `npm install -g pnpm@10` |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | Or `brew install --cask claude-code`. Open a new terminal afterwards so `claude` is found |

Then, in this folder:

```sh
pnpm install
pnpm build
pnpm test
```

`pnpm test` should end with every test passing; tests for the work list and for backups are
skipped until `bd` and `age` are installed (parts 5 and 6). Nothing here uses the Claude plan.

## 3. Show the owner the demo

```sh
pnpm start:demo
```

Open http://localhost:8787. This is a scripted office with invented people and figures. It uses
no Claude usage and keeps its files in `~/Bureau-demo`. Suggest the owner sign the slip on the
Desk, open a member of staff and ask for "an invoice", ask someone to "pay" something (they
cannot), and look at the Staff page. Stop it with Ctrl-C when they have seen enough. It can be
deleted afterwards with `rm -rf ~/Bureau-demo`.

If the page says the office cannot be reached, another program is using port 8787; start the
demo with `BUREAU_PORT=8790 pnpm start:demo` and tell the owner which port you chose. The real
office would need the same setting every time, so prefer freeing the port.

## 4. The real office

**The Claude sign-in (owner).** The office runs on this Mac's ordinary Claude Code sign-in: the
account you get by typing `claude` in a new terminal window.

1. The owner opens a new terminal window, runs `claude`, and signs in with the account the
   office should use. If they are already signed in, `/status` inside Claude Code shows which
   account it is.
2. The owner opens https://claude.ai in a browser, signed in to that same account, goes to
   Settings, then Connectors, and connects Gmail, Google Calendar and Google Drive. Staff reach
   mail, calendar and files only through these. An office without them still works; staff
   simply cannot see mail or calendar.
3. While there, the owner may want to look at the privacy settings of that account, since
   staff will be reading their mail through it.

Check from the terminal: `sh scripts/setup-check.sh` should say "Claude Code is signed in".
If your own agent session runs under a different Claude account, that does not matter: the
office ignores the account of the terminal that starts it.

**Start it.**

```sh
pnpm start
```

Open http://localhost:8787. The office folder is `~/Bureau`. A new office has six members of
staff and every standing duty switched off, so nothing runs until the owner asks for something.

**Settings to fill in together** (the owner's name at the foot of the sidebar, or the last tab
on a phone):

- **You.** What staff call the owner, initials, and **About you**: two or three sentences on
  what the owner does and the tools they use. Every member of staff is told this before each
  piece of work, so it is worth getting right. Ask the owner and type what they say.
- **Appearance.** Five looks, two of them dark. The choice belongs to the device it is made
  on, so the owner picks again on the phone. Nothing depends on it.
- **Claude and connected apps.** Should show the Claude account and Gmail, Google Calendar and Google
  Drive as connected. If it shows a different account from the one the owner expects, stop
  the office, have the owner sign in again as in step 1, and start it again.
- **Claude usage.** The office shares the owner's weekly plan allowance with everything else
  they do on that account. Past the limit set here (80% to begin with) scheduled duties pause
  until the week resets; anything the owner asks for still runs. Plans that also have a
  five-hour limit: Bureau does not show or guard that one.

**One real check.** Have the owner open Forge and ask: "Which version of macOS is this Mac
running?" A slip should appear asking to run a command; the owner signs it and the answer
comes back. That proves the sign-in, the staff, the gate and the Desk without touching mail.

Leave the office running in this terminal for now, or stop it with Ctrl-C. Part 7 keeps it
running without a terminal.

## 5. The work list (optional)

Jobs that take more than one exchange are tracked with beads.

```sh
brew install beads        # installs the bd command
```

Restart the office. The Work page appears in the sidebar. Without `bd` everything else works.

## 6. The office's Drive folder and backups (optional, recommended)

One folder in the owner's Google Drive is how documents get in and out, and where the office
backs itself up.

1. `brew install --cask google-drive`, then the owner opens Google Drive from Applications and
   signs in. macOS asks to allow it in Finder; the owner allows it. Wait until
   `sh scripts/setup-check.sh` says My Drive is there.
2. `brew install age` (the encryption tool).
3. The owner makes a folder for the office in Google Drive, for example `Bureau`, then in the
   office opens Settings, Drive folder, and chooses it. The office creates Drop here, From
   staff, Filed and Backups inside it. If the office runs as a background service (part 7),
   macOS may ask whether `node` may open Google Drive; the owner allows it.
4. **The owner alone:** Settings, Backup, Create recovery key. The key is shown once. The owner
   saves it in their password manager and confirms. Look away from this step: do not read the
   screen, the page or the logs while it is shown. Without that key no one, including Bureau,
   can open a backup.
5. The owner presses Back up now. A file named `bureau-<date>.tar.gz.age` should appear in
   Backups. From then on the office makes one a day.

Restoring is `pnpm office:restore`; see "Backing up the office" in `README.md`.

## 7. Keep it running in the background (optional, needed for scheduled duties)

Ask the owner first. This installs a login item (a launchd agent named `dev.bureau.server`)
that starts the office when they log in and restarts it if it stops.

```sh
pnpm service:install
```

- If something else is running the office on the same port, the installer stops it.
- If the script says the office has not started yet, macOS is showing the owner a question:
  "node" would like to access files in a folder. The owner chooses Allow, once per folder.
- `pnpm service:status` and `pnpm service:logs` say how it is doing.
  `pnpm service:uninstall` removes it and leaves the office folder alone.
- The service remembers where `node` and `claude` were when it was installed. After changing
  Node versions or moving this folder, run `pnpm service:install` again.
- The Mac has to stay awake and logged in for staff to work while the owner is away. Keeping a
  Mac awake is set in System Settings (Energy, or Battery then Options, on a laptop); that is
  the owner's to change.

To restart it later (after an update, for example), first make sure nobody on staff is working
or waiting for an answer: a slip that is waiting expires when the office restarts. Then:

```sh
launchctl kickstart -k gui/$(id -u)/dev.bureau.server
```

## 8. Reach it from a phone or another computer (optional)

Remote access goes over Tailscale, a private network between the owner's own devices. Nothing
is opened to the public internet, and each device still has to be paired with a code.

1. `brew install --cask tailscale-app` (or the owner installs Tailscale from the App Store).
   The owner opens Tailscale, allows the system extension and VPN configuration when macOS
   asks, and signs in from its menu bar icon.
2. The owner installs Tailscale on the phone and signs in to the same account.
3. Ask the owner, then:

   ```sh
   pnpm remote:on
   ```

   It prints an address like `https://<mac-name>.<tailnet>.ts.net`. The first time, Tailscale
   may print a link instead, asking to turn on HTTPS for the owner's network; the owner opens
   it, agrees, and you run the command again. A browser may need a minute before the address
   works the first time while the certificate is made.
4. On the phone, in Safari: open that address. It asks for a pairing code. The owner makes one
   on the Mac in Settings, Devices (or you run `pnpm pair` and read it out), and types it in.
5. Still in Safari on the phone: Share, then Add to Home Screen. The owner opens Bureau from the
   Home Screen, goes to Settings (the last tab), turns on notifications and presses the test
   button. A notification should arrive. On an iPhone, notifications only work from the Home
   Screen copy, not from a Safari tab.

`pnpm remote:status` shows the address again; `pnpm remote:off` closes it.

## 9. The Mac app (optional)

The same interface in its own window, with a menu bar count of waiting slips, notifications and
Touch ID before a signature. It needs Xcode (the full app from the App Store, not only the
command line tools); the owner installs that and opens it once to accept the license.

```sh
pnpm mac:install
```

The first time a slip arrives macOS asks whether Bureau may send notifications; the owner
allows it. See `apps/mac/README.md`.

## 10. The native iPhone app (optional, most people skip it)

The Home Screen copy from part 8 does nearly everything. The native app adds Face ID before a
signature and a Sign button on notifications. It needs Xcode, an Apple developer account and a
push key. The steps are in `apps/ios/README.md` and most of them are the owner's.

## 11. Hand the office over

Tell the owner, in a few lines:

- **Where things are.** The office is at http://localhost:8787 (and the Tailscale address, if
  set up). Its files are in `~/Bureau`; the code is in this folder.
- **Staff are a starting set, not a fixed one.** Open Hire someone and talk to the chief of
  staff to set a person up again around the owner's real work, or to add or retire someone.
  Nothing changes until the owner signs the draft.
- **Duties are off.** Each member of staff has standing duties that are switched off. Turn on
  one, press Run now, read what comes back, and only then turn on the next. The inbox and
  morning brief duties read real mail.
- **Authority starts low.** Staff draft and ask; the owner signs. The Staff page shows who may
  do what and is where that is raised. Nobody on staff can move money at any level.
- **Usage is shared** with whatever else the owner does on the same Claude account.
- **Updating:** `git pull`, `pnpm install`, `pnpm build`, then restart the office when it is
  idle (part 7).

Finish by running `sh scripts/setup-check.sh` once more and telling the owner what is in place
and what was left out on purpose.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `pnpm install` warns about ignored build scripts | Harmless unless `pnpm build` then fails; if it does, show the owner the warning |
| The page loads but says the office cannot be reached | The server is not running (`pnpm start`), or the port is taken (`lsof -i tcp:8787`) |
| Staff answer "not signed in" or every request fails at once | The owner runs `claude` in a new terminal and signs in again; check Settings, Claude and connected apps |
| Settings shows the wrong Claude account | The office uses the ordinary sign-in. To use another account on purpose, the owner signs in to it in its own folder (`CLAUDE_CONFIG_DIR=~/claude-office claude`), and the office is started with `BUREAU_CLAUDE_CONFIG_DIR=~/claude-office` |
| Staff cannot see mail or calendar | The connectors are not connected on that Claude account (part 4, step 2) |
| The background service is installed but nothing answers | A macOS permission question is waiting on screen, or see `pnpm service:logs` |
| The Drive folder "cannot be seen" | Google Drive for desktop is not running or not signed in |
| `pnpm remote:on` prints a link | The owner opens it to allow HTTPS on their Tailscale network, then run it again |
| The phone gets no notifications | It must be the Home Screen copy; notifications must be allowed for it in the phone's settings; send the test from Settings |
| Wrong name on the Desk | Settings, You. Or start a brand-new office with `BUREAU_OWNER="First Last" pnpm start` |

## Removing it

`pnpm remote:off`, `pnpm service:uninstall`, then delete `/Applications/Bureau.app`, this folder
and, if the owner wants the records gone too, `~/Bureau`. Backups in the Drive folder stay
until the owner deletes them.
