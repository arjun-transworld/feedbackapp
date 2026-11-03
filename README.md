# Private Skies Feedback — offline-first iOS & Android app

Crew sign in with their Microsoft (Entra ID) account. Passengers fill in the form with or
without internet. The phone sends each record on its own once it's back online, **even
if the app is closed**. Every request carries the crew member's own access token.

**Scope:** this is the app only. Its job ends when the server answers **2xx** to a submission.
What the backend must provide is in [API-CONTRACT.md](API-CONTRACT.md).

> **Step-by-step guides:**
> * **iOS:** [DEPLOY.md](DEPLOY.md) (Entra setup → settings → Mac/Xcode build → device test → release). Needs a Mac.
> * **Android:** [DEPLOY-ANDROID.md](DEPLOY-ANDROID.md) (Windows + Android Studio emulator → test → release).
>   Uses the same Entra settings and `config.js` from DEPLOY.md parts 1–3.
>
> Same `www/` code on both. Only the small native uploader differs:
> iOS uses a background URLSession, and Android uses WorkManager.

## How it works

```
 www/ (plain HTML/JS, your team owns this)            iOS (≈200 lines Swift, write once)
 ┌───────────────────────────────┐   enqueue()   ┌──────────────────────────────────┐
 │ form → store.js (localStorage)│ ────────────▶ │ BackgroundUploader               │
 │        status: pending        │               │  • writes body to app file store │
 │                               │ ◀──────────── │  • TokenProvider: fresh MSAL     │
 │ reconcile() on launch/resume  │  getState()   │    token before every attempt    │
 └───────────────────────────────┘               │  • background URLSession task:   │
                                                 │    iOS waits for network, sends, │
                                                 │    relaunches app with result    │
                                                 └───────────────┬──────────────────┘
                                                                 ▼
                       POST /feedback   Authorization: Bearer <user token>   (idempotent by record id)
```

* **Background URLSession** does the hard part. iOS runs the upload outside the app process,
  waits for connectivity itself, and keeps trying while the app is suspended or killed by the system.
* **Tokens on behalf of the user.** Access tokens last about an hour, but an upload may wait
  days for a connection. So the token is **not** taken from JS when the form is saved. Instead,
  the Swift `TokenProvider` reads the same MSAL keychain cache the sign-in plugin wrote to:
  * When a request is queued, it attaches a cached token if one is still valid. Offline, it
    may have none.
  * If the server answers **401**, iOS relaunches the app in the background. MSAL then
    silently gets a new token with the refresh token (network is available at that point)
    and the request is resent immediately.
  * Retries after a server error get a fresh token too.
  The refresh token is what keeps this working while the app is closed. It lasts about 90 days
  and renews whenever it's used.
* **Idempotent.** Each record has a client UUID, and the server ignores duplicates. Retries are always safe.
* **Two copies until confirmed.** The record stays in JS storage until the server confirms it.
  The native side keeps the request body on disk until it gets a final HTTP answer.

### Known limits (iOS behaviour, not bugs)

| Situation | What happens |
|---|---|
| App in background, suspended or terminated by iOS | Uploads continue; results are collected on next launch |
| Device locked | Uploads continue (files use "until first unlock" protection) |
| **User force-quits the app (swipes it away)** | iOS cancels pending transfers. They are re-queued automatically the next time the app opens. Brief crew: *don't swipe the app away* |
| Low Power Mode or poor network | iOS may delay uploads; they still go eventually |
| Refresh token no longer valid (90 days unused, password reset, account disabled, Conditional Access) | Silent refresh fails, so the upload ends with 401. Records stay pending and the status bar shows "crew sign-in needed". After **Crew sign in**, they are resent |
| Server rejects data (400/422) | Marked `rejected` locally and not retried |

## Configuration — where things are set

| What | Where | Notes |
|---|---|---|
| **Endpoint to POST to** | [`www/js/config.js`](www/js/config.js): `feedbackUrl` per environment, picked by `ACTIVE` | The only place. Native code receives it with each record. Change it, then run `npx cap sync` and rebuild |
| Entra clientId / tenantId / scope | [`www/js/config.js`](www/js/config.js): `entra` | Per environment. No client secret: a mobile app is a public client |
| Android signature hash | [`www/js/config.js`](www/js/config.js): `entra.androidKeyHash` | From `tools\android-keyhash.ps1`. Debug and release differ |
| What the backend must do | [API-CONTRACT.md](API-CONTRACT.md) | Out of scope for this app; hand to the backend team |
| App ID / name | `capacitor.config.json` | `com.transworld.jets.feedback` is the iOS bundle ID and Android package name registered in Entra |

## Previewing the screen on Windows

Don't double-click `index.html`, because browsers block the app's JavaScript on `file://` pages. Serve it instead:

```bash
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open http://localhost:8080. To point the browser at a different endpoint while testing, run this in DevTools:
`localStorage.setItem("tw.feedback.url", "http://localhost:8000/feedback")`.

### Why not just use `transworld-auth.js` inside the app?
It uses the MSAL.js redirect flow with `redirectUri = window.location.origin`. In the iOS
shell, that origin is `capacitor://localhost`, which Entra does not accept for SPA redirects,
and the redirect would navigate the WebView away from the app. MSAL.js also can't refresh
tokens while the app is closed. So `auth.js` uses the shared `TransworldAuth` in browsers and
native MSAL in the app. Both use the same Entra settings from `config.js` and produce the same kind of token.

## Project layout

```
DEPLOY.md                  step-by-step guide: iOS (+ shared Entra/config steps)
DEPLOY-ANDROID.md          step-by-step guide: Android / emulator
www/                       web app (also runs in a normal browser)
  js/config.js             endpoint + Entra settings (single place)
  js/store.js              local queue
  js/sync.js               native enqueue + reconcile; fetch fallback in browsers
  js/auth.js               crew sign-in (TransworldAuth in browser, native MSAL in app)
  static/js/               shared transworld-auth.js + msal-browser
native-ios/                Swift files to add to the Xcode project
  BackgroundUploader.swift background URLSession, retries, results
  TokenProvider.swift      silent MSAL token for the signed-in user
  BackgroundUploadPlugin.swift  JS bridge
  MainViewController.swift registers the plugin
  replace/AppDelegate.swift     paste over the generated AppDelegate
native-android/            Java files to copy into android/app/src/main/java/com/transworld/jets/feedback/
  UploadQueue.java         WorkManager queue + results store
  UploadWorker.java        sends one record (runs with the app closed)
  TokenProvider.java       silent MSAL token for the signed-in user
  BackgroundUploadPlugin.java   JS bridge (same API as iOS)
  MainActivity.java        replaces the generated one; registers the plugin
API-CONTRACT.md            what the app sends / expects (for the backend team)
tools/serve.ps1            local preview server for Windows
tools/android-keyhash.ps1  prints the Android signature hash for Entra + config.js
```
