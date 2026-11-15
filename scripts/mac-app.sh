#!/bin/sh
# Build the Bureau Mac app.
#   scripts/mac-app.sh build     builds apps/mac/build/Bureau.app
#   scripts/mac-app.sh install   builds it, then copies it to /Applications and opens it
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/apps/mac/build"

# Use a full Xcode even when the command line tools are the selected developer folder.
if ! xcodebuild -version >/dev/null 2>&1; then
  for X in "/Applications/Xcode.app" "$HOME/Applications/Xcode.app" "$HOME/Downloads/Xcode.app"; do
    if [ -d "$X/Contents/Developer" ]; then export DEVELOPER_DIR="$X/Contents/Developer"; break; fi
  done
fi
xcodebuild -version >/dev/null 2>&1 || { echo "Xcode is needed to build the Mac app. Install it from the App Store."; exit 1; }

build() {
  echo "Building Bureau.app"
  xcodebuild -project "$ROOT/apps/mac/Bureau.xcodeproj" -target Bureau -configuration Release \
    SYMROOT="$OUT/products" OBJROOT="$OUT/intermediates" build >"$OUT/build.log" 2>&1 || {
      grep -E "error" "$OUT/build.log" | head -20
      echo "The build failed. The full log is at $OUT/build.log"
      exit 1
    }
  rm -rf "$OUT/Bureau.app"
  cp -R "$OUT/products/Release/Bureau.app" "$OUT/Bureau.app"
  echo "Built $OUT/Bureau.app"
}

case "${1:-}" in
  build)
    mkdir -p "$OUT"
    build
    ;;
  install)
    mkdir -p "$OUT"
    build
    # Quit a running copy so the new one replaces it cleanly.
    osascript -e 'tell application id "dev.bureau.mac" to quit' >/dev/null 2>&1 || true
    sleep 1
    rm -rf "/Applications/Bureau.app"
    cp -R "$OUT/Bureau.app" "/Applications/Bureau.app"
    echo "Installed /Applications/Bureau.app"
    open "/Applications/Bureau.app"
    ;;
  *)
    echo "Usage: scripts/mac-app.sh build | install"
    exit 1
    ;;
esac
