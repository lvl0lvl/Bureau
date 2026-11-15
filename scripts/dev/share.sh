#!/bin/sh
# Make the copy of the code that is shared with other people.
#   scripts/dev/share.sh check          export the last commit and look for private terms
#   scripts/dev/share.sh to <folder>    the same, then put the copy into <folder>
#
# The copy is the last commit without owner/ (and anything else marked export-ignore in
# .gitattributes) and without history. <folder> is an empty folder or a checkout of the shared
# repository; its .git is left alone, everything else in it is replaced. Nothing is committed
# or pushed here: look at the result, then commit and push from <folder> yourself.
set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
TERMS="$REPO/owner/private-terms.txt"
cd "$REPO"

[ -d "$REPO/owner" ] || { echo "There is no owner/ folder here, so this is already a shared copy. Nothing to do."; exit 0; }
[ -f "$TERMS" ] || { echo "owner/private-terms.txt is missing; refusing to share without it."; exit 1; }
if [ -n "$(git status --porcelain)" ]; then
  echo "There are uncommitted changes. The copy is made from the last commit, so commit first."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git archive HEAD | tar -x -C "$TMP"

LIST="$TMP/.terms"
grep -v '^[[:space:]]*#' "$TERMS" | grep -v '^[[:space:]]*$' > "$LIST" || true
[ -s "$LIST" ] || { echo "owner/private-terms.txt lists no terms; refusing to share."; exit 1; }
HITS="$(cd "$TMP" && { grep -rIinF -f "$LIST" --exclude=.terms . || true; find . -type f | grep -iF -f "$LIST" | sed 's/$/: (in the file name)/' || true; })"
rm -f "$LIST"
if [ -n "$HITS" ]; then
  echo "Private terms were found in what would be shared. Nothing was copied."
  echo "$HITS" | cut -c1-220 | head -60
  exit 1
fi
if [ -e "$TMP/owner" ]; then echo "owner/ is in the export. Check .gitattributes. Nothing was copied."; exit 1; fi

COUNT="$(cd "$TMP" && find . -type f | wc -l | tr -d ' ')"
SHA="$(git rev-parse --short HEAD)"

case "${1:-}" in
  check)
    echo "Clean: $COUNT files from commit $SHA, no private terms, no owner/ folder."
    echo "Screenshots are not read by this check. Look at new ones yourself."
    ;;
  to)
    DEST="${2:-}"
    [ -n "$DEST" ] || { echo "Usage: scripts/dev/share.sh to <folder>"; exit 1; }
    mkdir -p "$DEST"
    DEST="$(cd "$DEST" && pwd)"
    case "$DEST/" in "$REPO/"*) echo "The folder must be outside this repository."; exit 1 ;; esac
    if [ -n "$(ls -A "$DEST" | grep -v '^\.git$' || true)" ] && [ ! -d "$DEST/.git" ]; then
      echo "$DEST is not empty and is not a git checkout. Choose an empty folder."
      exit 1
    fi
    # Replace everything but .git, so files deleted here are deleted there too.
    find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    (cd "$TMP" && tar -cf - .) | tar -xf - -C "$DEST"
    echo "Copied $COUNT files from commit $SHA into $DEST"
    echo "Next, in that folder: look at 'git status', then commit and push."
    echo "Screenshots are not read by the check. Look at new ones yourself."
    ;;
  *)
    echo "Usage: scripts/dev/share.sh check | to <folder>"
    exit 1
    ;;
esac
