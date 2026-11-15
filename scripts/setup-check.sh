#!/bin/sh
# What is in place for Bureau on this Mac, and what is still missing.
#   sh scripts/setup-check.sh        (or: pnpm setup:check)
# It only looks. It installs nothing, changes nothing and starts nothing. SETUP.md says what to
# do about each line. Exit status is 0 when everything needed to run the office is there.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${BUREAU_PORT:-8787}"
HOME_DIR="${BUREAU_HOME:-$HOME/Bureau}"
NEED=0

ok()   { printf '  ok       %s\n' "$1"; }
miss() { printf '  MISSING  %s\n' "$1"; NEED=$((NEED + 1)); }
opt()  { printf '  not yet  %s\n' "$1"; }
note() { printf '           %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "Needed to run the office"

if [ "$(uname -s)" = "Darwin" ]; then
  OS="$(sw_vers -productVersion 2>/dev/null || echo '?')"
  case "${OS%%.*}" in
    ''|*[!0-9]*) ok "macOS $OS" ;;
    *) if [ "${OS%%.*}" -ge 13 ]; then ok "macOS $OS"; else miss "macOS 13 or newer (this Mac has $OS)"; fi ;;
  esac
else
  miss "a Mac (Bureau's background service, Mac app and Drive folder are macOS only)"
fi

if have git; then ok "git"; else miss "git (xcode-select --install)"; fi

if have node; then
  NODE_V="$(node -v 2>/dev/null | sed 's/^v//')"
  if [ "${NODE_V%%.*}" -ge 24 ] 2>/dev/null; then ok "Node.js $NODE_V"; else miss "Node.js 24 or newer (found $NODE_V)"; fi
else
  miss "Node.js 24 or newer"
fi

if have pnpm; then ok "pnpm $(pnpm -v 2>/dev/null)"; else miss "pnpm"; fi

CLAUDE="${BUREAU_CLAUDE_PATH:-claude}"
if have "$CLAUDE"; then
  ok "Claude Code $("$CLAUDE" --version 2>/dev/null | head -1 | cut -d' ' -f1)"
  # The office runs on the ordinary sign-in, whatever account this shell happens to carry.
  STATUS="$(env -u CLAUDE_CONFIG_DIR ${BUREAU_CLAUDE_CONFIG_DIR:+CLAUDE_CONFIG_DIR="$BUREAU_CLAUDE_CONFIG_DIR"} "$CLAUDE" auth status 2>/dev/null || true)"
  WHO="$(printf '%s' "$STATUS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.loggedIn?[j.authMethod,j.email,j.subscriptionType].filter(Boolean).join(", "):"")}catch{console.log("")}})' 2>/dev/null || true)"
  if [ -n "$WHO" ]; then
    ok "Claude Code is signed in ($WHO)"
    case "$WHO" in claude.ai*) ;; *) note "The office is meant to run on a Claude subscription sign-in (claude.ai), not an API key." ;; esac
  else
    miss "Claude Code sign-in: the owner runs 'claude' in a plain terminal and signs in"
  fi
  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    note "This shell has CLAUDE_CONFIG_DIR set. The office ignores it and uses the sign-in above."
  fi
else
  miss "Claude Code (the 'claude' command)"
fi

if [ -d "$REPO/node_modules" ] && [ -d "$REPO/apps/server/node_modules" ]; then ok "dependencies installed"; else miss "dependencies (pnpm install)"; fi
if [ -f "$REPO/apps/web/dist/index.html" ]; then ok "interface built"; else miss "the interface (pnpm build)"; fi

echo
echo "The office"

if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/"; then
  ok "answering at http://localhost:$PORT"
else
  opt "nothing is answering on port $PORT (pnpm start, or pnpm service:install)"
fi
if [ -f "$HOME_DIR/bureau.db" ]; then ok "office folder at $HOME_DIR"; else opt "no office folder yet at $HOME_DIR (made on first start)"; fi
if launchctl print "gui/$(id -u)/dev.bureau.server" >/dev/null 2>&1; then
  ok "background service installed"
else
  opt "background service (optional: pnpm service:install)"
fi
case "$REPO/" in
  "$HOME/Documents/"*|"$HOME/Desktop/"*|"$HOME/Downloads/"*)
    note "This copy is inside Documents, Desktop or Downloads. As a background service, macOS will"
    note "ask the owner whether \"node\" may open that folder, and waits until they answer." ;;
esac

echo
echo "Optional pieces"

if have "${BUREAU_BD_PATH:-bd}"; then ok "beads ($("${BUREAU_BD_PATH:-bd}" --version 2>/dev/null | head -1)): the work list"; else opt "beads (bd): the work list stays off without it"; fi
if have "${BUREAU_AGE_PATH:-age}"; then ok "age: encrypted backups"; else opt "age: backups cannot run without it"; fi

MOUNT=""
for D in "$HOME"/Library/CloudStorage/GoogleDrive-*; do
  if [ -d "$D/My Drive" ]; then MOUNT="$D"; break; fi
done
if pgrep -f "Google Drive.app/Contents/MacOS/Google Drive" >/dev/null 2>&1; then
  if [ -n "$MOUNT" ]; then ok "Google Drive for desktop is running and My Drive is there"; else opt "Google Drive for desktop is running but shows no My Drive (the owner signs in to it)"; fi
elif [ -n "$MOUNT" ]; then
  opt "My Drive can be seen but Google Drive for desktop is not running, so nothing is syncing"
else
  opt "Google Drive for desktop: needed only for the office's Drive folder and backups"
fi

TS=""
if have tailscale; then TS="tailscale"; elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"; fi
if [ -n "$TS" ]; then
  TS_STATE="$("$TS" status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.BackendState+" "+((j.CertDomains||[])[0]||""))}catch{console.log("")}})' 2>/dev/null || true)"
  case "$TS_STATE" in
    Running*)
      ok "Tailscale is connected"
      if [ -n "${TS_STATE#Running }" ] && [ "${TS_STATE#Running }" != "$TS_STATE" ]; then ok "HTTPS is on for this tailnet (${TS_STATE#Running })"; else opt "HTTPS certificates are not enabled for this tailnet (pnpm remote:on offers to turn them on)"; fi
      if "$TS" serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then ok "remote access is on"; else opt "remote access is off (optional: pnpm remote:on)"; fi ;;
    *) opt "Tailscale is installed but not connected: the owner signs in from its menu bar icon" ;;
  esac
else
  opt "Tailscale: needed only to reach the office from a phone or another computer"
fi

if xcodebuild -version >/dev/null 2>&1 || [ -d /Applications/Xcode.app ] || [ -d "$HOME/Applications/Xcode.app" ] || [ -d "$HOME/Downloads/Xcode.app" ]; then
  ok "Xcode: the Mac app and the iPhone app can be built"
else
  opt "Xcode: needed only for the Mac app and the native iPhone app"
fi
if [ -d /Applications/Bureau.app ]; then ok "Bureau.app is in /Applications"; else opt "the Mac app (optional: pnpm mac:install)"; fi

echo
if [ "$NEED" -eq 0 ]; then
  echo "Everything needed to run the office is here."
else
  echo "$NEED thing(s) needed before the office can run. SETUP.md says how to get each one."
fi
exit "$([ "$NEED" -eq 0 ] && echo 0 || echo 1)"
