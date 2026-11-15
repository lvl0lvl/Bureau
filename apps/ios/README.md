# Bureau for iPhone

A small native app around the interface your Mac serves. It adds what a web page cannot do:

- **Face ID before a signature.** The page asks the app (`window.bureauNative.confirm`) and the
  app asks Face ID, falling back to the passcode.
- **Notifications with a Sign button.** A plain action slip can be signed from the notification.
  The phone must be unlocked to do it. Questions, reviews, promotions and anything that traces
  back to outside material have to be opened and read.
- **Haptics** on signing and declining.

Everything else, including pairing, is the same interface as on the Mac.

## Run it on your phone

1. Open `Bureau.xcodeproj` in Xcode (16 or newer).
2. Select the Bureau target, then Signing & Capabilities, and choose your team. Change the bundle
   identifier from `dev.bureau.app` to one of your own, for example `com.yourname.bureau`.
3. Add the Push Notifications capability if Xcode has not already (the entitlement file is there).
4. Plug in the phone, pick it as the destination and run.
5. On first launch enter the address `pnpm remote:on` printed on the Mac, then a pairing code.

## Notifications (one-time setup)

The Mac sends notifications straight to Apple with a key from your developer account.

1. At developer.apple.com, under Certificates, Identifiers & Profiles, then Keys, create a key
   with Apple Push Notifications service enabled. Download the `.p8` file. Note the Key ID and
   your Team ID.
2. Store the `.p8` somewhere private on the Mac, for example `~/Bureau/AuthKey.p8`.
3. Create `~/Bureau/apns.json`:

   ```json
   {
     "keyId": "ABC123DEFG",
     "teamId": "TEAM123456",
     "bundleId": "com.yourname.bureau",
     "keyPath": "/Users/you/Bureau/AuthKey.p8"
   }
   ```

No restart is needed; the file is read when a notification is sent. Settings in the app has a
button that sends a test notification.

Until this is done the app still works; it simply receives no notifications. The installed web
app (Add to Home Screen) needs none of this and is the quicker way to get notifications.

## What has and has not been tested

Tested in the iPhone 16 Pro simulator (iOS 18.3) against the demo office:

- The first-run address screen, loading the office, and the unreachable screen's code path.
- Signing through the bridge: the page asks the app, the app shows the system authentication
  prompt with the slip's title, and nothing is signed until it passes. With the Face ID setting
  off, the signature goes through and the undo countdown shows.

Not tested, because they need a real phone: a real Face ID match, haptics, dictation, and Apple
Push delivery (which also needs the key above).

## Walking the app from the command line

Debug builds accept three launch arguments, so the app can be driven in a simulator without
tapping:

```sh
xcrun simctl launch booted dev.bureau.app \
  -serverURL "http://localhost:8787" \
  -skipNotificationPrompt YES \
  -debugJS "$(printf %s 'document.querySelector(".slip-head").click()' | base64)"
xcrun simctl io booted screenshot shot.png
```

`-debugJS` is compiled out of release builds.

## Files

- `Bureau/BureauApp.swift` — app entry, notification categories and the Sign action.
- `Bureau/RootView.swift` — first-run address screen, the unreachable screen, the mark.
- `Bureau/OfficeWebView.swift` — the web view and the bridge the page talks to.
- `Bureau/Office.swift` — address checking, signing from a notification, Face ID.
- `Info.plist`, `Bureau.entitlements` — local-network allowance and the push entitlement.
