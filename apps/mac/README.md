# Bureau for Mac

A native Mac app around the interface the office serves. It adds what a browser tab cannot do:

- **A menu bar item** with the number of slips waiting. Its menu lists them; choosing one opens
  it on the Desk.
- **A Dock badge** with the same count.
- **Touch ID, Apple Watch or the account password before a signature.** macOS shows "Bureau is
  trying to sign “<slip title>”". This can be switched off in the app's settings (⌘,).
- **Notifications when a slip arrives**, with a Sign button on plain action slips. Questions,
  reviews, promotions and anything that traces back to outside material have to be opened.
- **Its own window** that keeps running when closed, with ⌘1 to ⌘6 for the main pages.

Everything else is the same interface as in the browser.

## Install

```sh
pnpm mac:install     # builds, copies to /Applications/Bureau.app and opens it
pnpm mac:build       # builds apps/mac/build/Bureau.app only
```

Xcode is needed for the build. The script finds it in `/Applications`, `~/Applications` or
`~/Downloads`.

On first launch the app looks for an office on this Mac (`http://localhost:8787`) and opens it.
If there is none it asks for an address, which is how a second Mac connects: enter the address
`pnpm remote:on` printed, then a pairing code.

The app does not start the office. Start it with `pnpm start`, or keep it running with
`pnpm service:install`.

## Notifications

macOS asks once whether Bureau may send notifications. If that was declined or missed, turn it on
in System Settings, Notifications, Bureau. The app's settings and its menu bar menu both say when
notifications are off.

The Mac app needs no Apple Push key. It keeps its own connection to the office and posts the
notification itself, so it only notifies while it is running (closing the window does not quit it).

## Signing identity

There is no developer certificate on this Mac, so the app is signed ad hoc (`CODE_SIGN_IDENTITY
= "-"`). That is fine for an app built and run on the same Mac. To give a copy to another Mac,
choose a team under Signing & Capabilities in Xcode and build there.

## What has and has not been tested

Tested on macOS 14.6 against the demo office:

- First launch finds the office on this Mac and loads it; the installed copy in `/Applications`
  connects.
- The watcher counts waiting slips and notices a new one as it is filed.
- Signing from the app's own code path (the one a notification's Sign button uses) is accepted by
  the office.
- Signing in the window with the confirmation switched off goes through and shows the undo
  countdown.
- Signing in the window with the confirmation on: the app asks macOS, and the slip stays unsigned
  while the system prompt is waiting.

Not tested: an actual Touch ID or password match (it needs a person), notification banners and
their Sign button (macOS had not been told to allow notifications for Bureau when this was
written), and connecting to an office on another Mac.

## Walking the app from the command line

Debug builds accept launch arguments, so the app can be driven without clicking:

```sh
open -n Bureau.app --stderr run.log --args \
  -debugLog YES \
  -confirmBeforeSigning NO \
  -debugJS "$(printf %s 'document.querySelector(".slip-head").click()' | base64)" \
  -debugSnapshot shot.png -debugSnapshotAfter 6
```

`-debugSignNew YES` signs each new signable slip as it arrives, to exercise the notification
path. All of these are compiled out of release builds.

## Files

- `Bureau/main.swift`, `Bureau/AppDelegate.swift` — app entry, menus, window, menu bar item,
  Dock badge, notifications.
- `Bureau/AppModel.swift` — the app's settings and what it knows about waiting slips.
- `Bureau/Watcher.swift` — the app's own connection to `/api/sync`, used for the count and for
  noticing new slips.
- `Bureau/OfficeController.swift` — the web view and the bridge the page talks to.
- `Bureau/Office.swift` — finding the office, signing from a notification, authentication.
- `Bureau/Views.swift` — the first-run, unreachable and settings screens.
- `scripts/make-icon.mjs` — draws the app icon.
