#!/bin/sh
# Reach Bureau from your other devices over Tailscale, with HTTPS.
#   scripts/remote.sh on | off | status
# Only devices signed in to your own tailnet can reach it, and each still has to be paired.
set -eu

PORT="${BUREAU_PORT:-8787}"
# The Mac app carries the command inside it; a "tailscale" on the PATH is not required.
TS="$(command -v tailscale 2>/dev/null || true)"
[ -n "$TS" ] || { [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] && TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale; } || true
[ -n "$TS" ] || { echo "Tailscale is not installed. Get it at https://tailscale.com/download"; exit 1; }

address() {
  "$TS" status --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const n=JSON.parse(d).Self.DNSName.replace(/\.$/,"");console.log(n?"https://"+n:"")}catch{console.log("")}})'
}

case "${1:-}" in
  on)
    "$TS" serve --bg --https=443 "http://127.0.0.1:$PORT"
    URL="$(address)"
    echo
    echo "Bureau is reachable from your other devices at:"
    echo "  ${URL:-the address shown above}"
    echo "On the other device: open that address, then enter a pairing code."
    echo "Make a code in Settings on this Mac, or run: pnpm pair"
    echo "On an iPhone, use Share, then Add to Home Screen, to install it and allow notifications."
    ;;
  off)
    "$TS" serve --https=443 off
    echo "Bureau is no longer reachable from other devices."
    ;;
  status)
    "$TS" serve status
    echo "Address: $(address)"
    ;;
  *)
    echo "Usage: scripts/remote.sh on | off | status"
    exit 1
    ;;
esac
