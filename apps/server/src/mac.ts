import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Mac app, handed to the owner's other Macs by the office itself. One line in Terminal on the
 * other Mac downloads it from here, puts it in Applications, points it at this office and opens
 * it with a pairing code. Fetched with curl, so macOS does not hold it back as a download.
 *
 * The copy handed out is the newest of the app built in this checkout and the one installed in
 * this Mac's Applications folder.
 */

const REPO_BUILD = path.resolve(import.meta.dirname, '../../mac/build/Bureau.app');

export function macAppSource(): string | null {
  const candidates = [process.env.BUREAU_MAC_APP, REPO_BUILD, '/Applications/Bureau.app'].filter((c): c is string => !!c);
  let best: { dir: string; at: number } | null = null;
  for (const dir of candidates) {
    const st = fs.statSync(path.join(dir, 'Contents', 'MacOS', 'Bureau'), { throwIfNoEntry: false });
    if (st && (!best || st.mtimeMs > best.at)) best = { dir, at: st.mtimeMs };
  }
  return best?.dir ?? null;
}

const zipping = new Map<string, Promise<string>>();

/** A zip of the app, made once per build and kept in the office's cache folder. */
export function macZip(cacheDir: string): Promise<string> | null {
  const src = macAppSource();
  if (!src) return null;
  const st = fs.statSync(path.join(src, 'Contents', 'MacOS', 'Bureau'));
  const zip = path.join(cacheDir, `Bureau-${Math.round(st.mtimeMs)}-${st.size}.zip`);
  if (fs.existsSync(zip)) return Promise.resolve(zip);
  const pending = zipping.get(zip);
  if (pending) return pending;
  fs.mkdirSync(cacheDir, { recursive: true });
  // Older copies are of no use once a new build is out.
  for (const f of fs.readdirSync(cacheDir)) if (/^Bureau-.*\.zip(\.part)?$/.test(f)) fs.rmSync(path.join(cacheDir, f), { force: true });
  const p = new Promise<string>((resolve, reject) => {
    // ditto keeps the bundle exactly as built, signature included.
    execFile('/usr/bin/ditto', ['-c', '-k', '--keepParent', src, `${zip}.part`], { timeout: 120_000 }, (err) => {
      zipping.delete(zip);
      if (err) return reject(err);
      fs.renameSync(`${zip}.part`, zip);
      resolve(zip);
    });
  });
  zipping.set(zip, p);
  return p;
}

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** The script the other Mac runs. `office` and `code` are checked here, so neither can break out of its quotes. */
export function installScript(office: string, code: string): string {
  if (!ORIGIN.test(office)) throw new Error('Not an office address.');
  const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 32);
  return `#!/bin/sh
# Bureau for Mac, from the office at ${office}
set -eu
OFFICE='${office}'
CODE='${c}'
[ "$(uname)" = Darwin ] || { echo "This installs the Bureau Mac app. Run it on a Mac."; exit 1; }
v="$(sw_vers -productVersion)"
[ "\${v%%.*}" -ge 14 ] || { echo "Bureau needs macOS 14 (Sonoma) or later. This Mac has $v."; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading Bureau from $OFFICE"
curl -fsSL "$OFFICE/api/mac/Bureau.zip" -o "$TMP/Bureau.zip"
ditto -x -k "$TMP/Bureau.zip" "$TMP"
[ -d "$TMP/Bureau.app" ] || { echo "The download was not the Bureau app. Nothing was installed."; exit 1; }
DEST=/Applications
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
osascript -e 'tell application id "dev.bureau.mac" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "$DEST/Bureau.app"
ditto "$TMP/Bureau.app" "$DEST/Bureau.app"
xattr -dr com.apple.quarantine "$DEST/Bureau.app" 2>/dev/null || true
defaults write dev.bureau.mac serverURL "$OFFICE"
if [ -n "$CODE" ]; then
  defaults write dev.bureau.mac pairCode "$CODE"
  defaults write dev.bureau.mac pairLabel "$(scutil --get ComputerName 2>/dev/null || echo Mac)"
fi
open "$DEST/Bureau.app"
echo "Bureau is in $DEST and is opening your office."
`;
}
