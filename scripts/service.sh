#!/bin/sh
# Run Bureau in the background on this Mac, starting at login.
#   scripts/service.sh install | uninstall | status | logs
set -eu

LABEL="dev.bureau.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/Bureau"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="gui/$(id -u)"
PORT="${BUREAU_PORT:-8787}"

case "${1:-}" in
  install)
    NODE="$(command -v node)" || { echo "Node.js was not found on your PATH."; exit 1; }
    [ -f "$REPO/apps/web/dist/index.html" ] || { echo "Build the web app first: pnpm build"; exit 1; }
    mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
    # The service needs the same PATH you have now, so it can find claude, git and tailscale.
    # The office ignores a CLAUDE_CONFIG_DIR left in this shell and runs on this Mac's ordinary
    # Claude Code sign-in. Only BUREAU_CLAUDE_CONFIG_DIR, set on purpose, names another account.
    CONFIG_DIR_ENTRY=""
    if [ -n "${BUREAU_CLAUDE_CONFIG_DIR:-}" ]; then
      CONFIG_DIR_ENTRY="    <key>BUREAU_CLAUDE_CONFIG_DIR</key><string>$BUREAU_CLAUDE_CONFIG_DIR</string>"
    fi
    cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$REPO/apps/server/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
    <key>HOME</key><string>$HOME</string>
$CONFIG_DIR_ENTRY
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server.log</string>
</dict>
</plist>
PLIST_EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # An office started by hand holds the port; the service cannot start beside it.
    RUNNING="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$RUNNING" ]; then
      echo "Stopping the office that is already running on port $PORT."
      kill $RUNNING 2>/dev/null || true
      sleep 2
    fi
    launchctl bootstrap "$DOMAIN" "$PLIST"
    # A background service is asked by macOS before it may open Documents or Google Drive.
    # Until the owner answers, the office waits without a word, so say what is going on.
    UP=""
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      sleep 1
      if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/"; then UP=1; break; fi
    done
    if [ -z "$UP" ]; then
      echo "The office has not started yet."
      echo "Look for a macOS question on screen: \"node\" would like to access files in your"
      echo "Documents folder. Choose Allow. A second one may ask about Google Drive."
      echo "Bureau starts as soon as you answer. Check with: scripts/service.sh status"
      echo "To go back to how it was: scripts/service.sh uninstall, then pnpm start"
      exit 0
    fi
    echo "Bureau now runs in the background and starts when you log in."
    echo "  Open:  http://localhost:$PORT"
    echo "  Logs:  $LOG_DIR/server.log"
    if [ -n "${BUREAU_CLAUDE_CONFIG_DIR:-}" ]; then
      echo "  Claude account folder: $BUREAU_CLAUDE_CONFIG_DIR"
    else
      echo "  Claude account: this Mac's ordinary Claude Code sign-in (Settings shows which)"
    fi
    echo "Keep this Mac awake and logged in for staff to work while you are away."
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Bureau no longer runs in the background. Your office folder is untouched."
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =|last exit code" | sed 's/^[[:space:]]*/  /'
      if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/"; then
        echo "  Answering at http://localhost:$PORT"
      else
        echo "  Not answering yet. If macOS is asking whether \"node\" may open your Documents folder, choose Allow."
      fi
    else
      echo "  Not installed as a background service."
    fi
    ;;
  logs)
    tail -n 80 -f "$LOG_DIR/server.log"
    ;;
  *)
    echo "Usage: scripts/service.sh install | uninstall | status | logs"
    exit 1
    ;;
esac
