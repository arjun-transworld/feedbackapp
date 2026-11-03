# Deployment guide — Private Skies Feedback

Step by step, written for a web team with no iOS experience.
Do the parts in order. Each one ends with a **✅ Check** so you know it worked before moving on.

**Android?** Do parts 1–3 here (Entra, backend details, `config.js`), then continue with
[DEPLOY-ANDROID.md](DEPLOY-ANDROID.md). It runs on Windows, no Mac needed.

**Scope:** this covers the app only. The app's job ends when the server answers **2xx** to a
submission. The backend is owned by the backend team, and what it must do is described in
[API-CONTRACT.md](API-CONTRACT.md).

| Part | Who | Where | Time |
|---|---|---|---|
| [0. Prerequisites](#0-prerequisites) | Team lead | — | once |
| [1. Microsoft Entra setup](#1-microsoft-entra-setup) | Azure admin | Azure portal | 15 min |
| [2. Get the backend details](#2-get-the-backend-details) | Backend team | — | 5 min |
| [3. Fill in the app settings](#3-fill-in-the-app-settings-entra--endpoint) | Any dev | Any PC | 5 min |
| [4. Build the iOS app](#4-build-the-ios-app-mac) | Any dev | **Mac** | 45 min first time |
| [No Mac? Build with Codemagic](#building-without-a-mac-codemagic) | Any dev | Browser | 1 h first time |
| [5. Install on a test device](#5-install-on-a-test-device) | Any dev | Mac + iPhone | 10 min |
| [6. Test checklist](#6-test-checklist) | QA / crew lead | iPhone | 2–3 h (includes waiting) |
| [7. Release to crew devices](#7-release-to-crew-devices) | Team lead + IT | App Store Connect / Intune | 1–2 days |
| [8. Shipping updates](#8-shipping-updates) | Any dev | Mac | 15 min |
| [Troubleshooting](#troubleshooting) | | | |

---

## 0. Prerequisites

| You need | Notes |
|---|---|
| **A Mac** with macOS 14 or later | Apple only allows iOS apps to be built on a Mac. A rented cloud Mac (e.g. MacinCloud) works |
| **Xcode 16+** | Free from the Mac App Store. The first download takes about an hour |
| **Node.js 20+** on the Mac | From nodejs.org (LTS) |
| **Apple Developer Program** membership | $99/year, enrolled as the company (needs a D-U-N-S number, which takes a few days). Required for TestFlight and crew devices. A free Apple ID is enough for a 7-day test install on your own phone |
| **An iPhone or iPad** + cable | The Simulator can't test background uploads |
| **A dev/test backend URL** | From the backend team, implementing [API-CONTRACT.md](API-CONTRACT.md) |

---

## 1. Microsoft Entra setup

Use the **same app registration** your other Transworld apps use (the `CLIENT_ID` in the HsCodeSummary `.env`).

1. Go to the Azure portal → **Microsoft Entra ID** → **App registrations**, then open that registration.
2. On the **Overview** page, copy:
   * **Application (client) ID** → `clientId` in part 3
   * **Directory (tenant) ID** → `tenantId` in part 3
3. Under **Authentication**, click **Add a platform** → **iOS / macOS**.
   * Bundle ID: `com.transworld.jets.feedback`
   * Click **Configure**. Entra shows the redirect URI `msauth.com.transworld.jets.feedback://auth`. Nothing else is needed.
4. Under **Expose an API**, copy the full scope, e.g. `api://<client-id>/access_as_user` → `scope` in part 3.
   (If the backend API has its **own** app registration, take the scope from that registration instead,
   and add it under **API permissions** of this one.)
5. Under **API permissions**, make sure that scope (and `User.Read`) has admin consent.
6. *(Recommended)* Ask whoever manages **Conditional Access** whether policies apply to crew,
   e.g. "require compliant device" or a short sign-in frequency. These decide how long the app
   can keep sending in the background before crew must sign in again.

> **No client secret is needed.** A mobile app is a *public client*. Never put a secret or password in the app.

✅ **Check:** the registration's Authentication page lists an iOS platform with the bundle ID above,
and you have the three values: clientId, tenantId and scope.

---

## 2. Get the backend details

The backend isn't part of this app. Send [API-CONTRACT.md](API-CONTRACT.md) to the backend team and ask them for:

1. The **full endpoint URL** that submissions are POSTed to, for dev/test and later for production
   (e.g. `https://dev-api.transworld.com/feedback`). It must be **HTTPS**, because iOS blocks plain HTTP.
2. The **scope** their API validates, which must match the one from part 1.
3. Confirmation that the endpoint:
   * accepts the crew member's Entra token;
   * returns **2xx** on success and **2xx again for a repeated `id`**;
   * returns **401** for an expired token.

✅ **Check:** you have an https endpoint URL for dev.

---

## 3. Fill in the app settings (Entra + endpoint)

**Everything goes in one file: [`www/js/config.js`](www/js/config.js).** There's no `.env` file. The app runs on the
phone, so these values are bundled into it at build time. Replace the placeholder zeros:

```js
const ENVIRONMENTS = {
  dev: {
    feedbackUrl: "https://dev-api.transworld.com/feedback",            // part 2
    entra: {
      clientId: "1b2c3d4e-....",                                        // part 1: Application (client) ID
      tenantId: "9f8e7d6c-....",                                        // part 1: Directory (tenant) ID
      scope: "api://1b2c3d4e-..../access_as_user",                      // part 1: Expose an API
    },
  },
  prod: { ... same shape, production values ... },
};

const ACTIVE = "dev";   // ← "prod" for the release build
```

Commit the change. Changing a value later means a new build (see part 8).

✅ **Check (on Windows):** run `powershell -ExecutionPolicy Bypass -File tools\serve.ps1` and
open http://localhost:8080. The top bar should **no longer** say *"setup needed: Entra settings in config.js"*.

---

## 4. Build the iOS app (Mac)

### 4a. Generate the Xcode project

Copy the `FeedbackApp` folder to the Mac (git clone is best), then in **Terminal**:

```bash
cd FeedbackApp
npm install
npx cap add ios
npx cap sync ios
npx cap open ios
```

Xcode opens. In the left sidebar, **App → App** is where everything below happens.

### 4b. Add the native files

1. In Finder, open `FeedbackApp/native-ios/`.
2. Drag these **four** files onto the yellow **App** folder in Xcode's left sidebar:
   `BackgroundUploader.swift`, `BackgroundUploadPlugin.swift`, `TokenProvider.swift`, `MainViewController.swift`.
3. In the dialog, tick **Copy items if needed** and make sure the **App** target is ticked. Then click **Finish**.
4. Open **AppDelegate.swift** in Xcode, select all, and replace it with the contents of
   `native-ios/replace/AppDelegate.swift`. Don't drag that file in as a second copy.

### 4c. Register the plugin

1. Click **Main.storyboard** in the sidebar.
2. In the outline, click **Bridge View Controller**.
3. In the right panel, open the **Identity inspector** (the ID-card icon) and set **Class** to `MainViewController`. Press Enter.

### 4d. Signing and capabilities

1. Click the blue **App** project at the top of the sidebar → under **TARGETS** select **App** → open the **Signing & Capabilities** tab.
2. Tick **Automatically manage signing**, and choose your company **Team**. (For a quick personal test, your own Apple ID also works.)
3. Check that **Bundle Identifier** is `com.transworld.jets.feedback`.
4. Click **+ Capability** → **Keychain Sharing** → under Keychain Groups click **+** and enter `com.microsoft.adalcache`.
   *This is required. It lets the background uploader use the crew member's sign-in.*

### 4e. Microsoft sign-in settings (Info.plist)

Right-click **Info.plist** → **Open As → Source Code**. Paste the following just before the last `</dict>`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>msauth.$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    </array>
  </dict>
</array>
<key>LSApplicationQueriesSchemes</key>
<array>
  <string>msauthv2</string>
  <string>msauthv3</string>
</array>
```

(If `CFBundleURLTypes` already exists, add the inner `<dict>` to that array instead.)

### 4f. Version and display name

On the **General** tab, set **Display Name** to `Private Skies Feedback`, **Version** to `1.0.0` and **Build** to `1`.
Add an app icon under **Assets → AppIcon**: one 1024×1024 PNG is enough.

✅ **Check:** **Product → Build** (⌘B) shows "Build Succeeded". If it fails, see [Troubleshooting](#troubleshooting).

---

## Building without a Mac (Codemagic)

[`codemagic.yaml`](codemagic.yaml) builds the app on Codemagic's cloud Macs.
[`tools/ios-setup.rb`](tools/ios-setup.rb) does the Xcode steps 4b–4f automatically, so nobody opens Xcode.
It has two workflows:

### A. Free Apple ID, test on your own iPhone (`ios-unsigned`)

No Apple Developer membership needed. Codemagic builds an **unsigned** `.ipa`; **Sideloadly** on Windows
signs it with a free Apple ID and installs it over USB.

1. Push the repo, then in Codemagic click **Check for configuration file** → **Start new build** →
   workflow *iOS unsigned .ipa (free Apple ID)*. When it finishes, download `PrivateSkiesFeedback-unsigned.ipa` from the build's **Artifacts**.
2. On the PC, install **iTunes** and **iCloud** from apple.com (the website versions, not the Microsoft Store ones), then **Sideloadly** (sideloadly.io).
3. Connect the iPhone with a cable, unlock it and tap **Trust**.
4. Open Sideloadly, drag in the `.ipa`, enter an Apple ID, and click **Start**.
   Use a **separate test Apple ID**, not your personal one, because you're giving its password to a third-party tool.
   Keep the bundle ID `com.transworld.jets.feedback`, since Entra's iOS redirect depends on it.
5. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode** (it restarts), then
   **Settings → General → VPN & Device Management → [the Apple ID] → Trust**.
6. Open the app and run the [part 6](#6-test-checklist) checklist.

Limits of a free Apple ID: the app **stops opening after 7 days** (re-install with Sideloadly),
at most 3 such apps per phone, and Apple may refuse the bundle ID if it's already registered to another team.

> **If sign-in fails** with a keychain error (e.g. `-34018`), the re-signing didn't keep the Keychain
> Sharing setting (`com.microsoft.adalcache`) that MSAL needs. Use workflow B, or build once on a borrowed Mac (parts 4–5).

### B. TestFlight (`ios-testflight`, needs the paid membership)

Install on the iPhone through TestFlight instead of part 5. One-time setup:

1. **Apple Developer portal** → Certificates, Identifiers & Profiles → **Identifiers → +** → App IDs → App:
   Bundle ID (explicit) `com.transworld.jets.feedback`. No extra capabilities are needed.
2. **App Store Connect** → Apps → **+ New App**: iOS, name "Private Skies Feedback", that bundle ID, SKU `tw-feedback`.
3. **App Store Connect** → Users and Access → **Integrations → App Store Connect API** → **+**: role **App Manager**.
   Download the `.p8` file (only possible once) and note the Issuer ID and Key ID.
4. **Codemagic** → Team settings → **Team integrations → Developer Portal → Connect**: upload the `.p8` with the
   Issuer ID and Key ID, and name it exactly **`Transworld ASC`** (the name in `codemagic.yaml`).
5. **Codemagic** → Team settings → **Code signing identities**:
   * **iOS certificates → Generate certificate**, type *Apple Distribution*, using that API key.
   * **iOS provisioning profiles → Fetch profiles**. If none is listed for the bundle ID, create one in the Apple portal
     (**Profiles → +** → *App Store Connect* → the bundle ID → the certificate Codemagic generated), then fetch again.
6. Push the repo (with `codemagic.yaml` at the root), and in Codemagic click **Check for configuration file**,
   then **Start new build** → workflow *iOS → TestFlight*.
7. When the build finishes (about 15–25 min, plus 15–30 min of Apple processing), go to **App Store Connect → TestFlight →
   Internal Testing**, add yourself, and install from the **TestFlight** app on the iPhone. Then run the [part 6](#6-test-checklist) checklist.

Each new push → **Start new build** gives a new TestFlight build. The build number comes from Codemagic's
counter, and the visible version is `APP_VERSION` in `codemagic.yaml`.

---

## 5. Install on a test device

1. Connect the iPhone with a cable and unlock it. Tap **Trust This Computer** if asked.
2. On the iPhone, turn on **Settings → Privacy & Security → Developer Mode** and let it restart. You only do this once.
3. In Xcode's top bar, pick your iPhone as the run destination, then press **▶ Run**.
4. If you used a personal Apple ID, the first launch is blocked. On the iPhone go to **Settings → General →
   VPN & Device Management → [your Apple ID] → Trust**, then press Run again.

✅ **Check:** the feedback form opens on the phone, styled in navy.

---

## 6. Test checklist


Everything is checked on the device itself. The top bar shows how many items are waiting. **Crew → the list** shows each item's "saved" time
and, once the server answered 2xx, its "**sent**" time: the moment the server confirmed it,
even if the app was closed then.

| # | Do this | Expect |
|---|---|---|
| 1 | Tap **Crew** → **Crew sign in**, sign in with a Microsoft account | Panel shows "Signed in as …"; top bar no longer says "sign-in needed" |
| 2 | Enter route + tail no. → **Save flight** | They appear at the top of the form |
| 3 | Submit a form **online** | Within seconds, top bar "All feedback sent" |
| 4 | Turn on **Airplane Mode**, submit 3 forms | Each shows "Thank you"; top bar "3 waiting to send" |
| 5 | Go to the home screen (**don't swipe the app away**). Turn Airplane Mode **off** and note the time. Wait **15 min** without opening the app, then open it → Crew | All 3 show a **sent** time within a few minutes of turning Airplane Mode off, before you reopened the app. That proves they were sent while the app was closed |
| 6 | Airplane Mode on, submit 1 form, go home, **wait 2 hours**, Airplane Mode off, wait 15 min, open app | **Sent** time is before you opened the app. The token had expired and was refreshed silently |
| 7 | Airplane Mode on, submit 1 form, **swipe the app away**, Airplane Mode off, reopen app | Sent shortly after reopening (iOS cancels uploads on force-quit; the app re-queues them) |
| 8 | Sign in as a test user who is then disabled in Entra, queue a form offline, reconnect | Not lost: shows "crew sign-in needed"; after a valid user signs in, it sends |
| 9 | Restart the phone with items queued (offline), unlock, go online | Items still get a **sent** time |

*(Optional)* Ask the backend team to confirm the test records arrived, matching by the `id` values.

---

## 7. Release to crew devices

### 7a. Upload a build

1. In `www/js/config.js`, set `ACTIVE = "prod"`, then run `npx cap sync ios` on the Mac.
2. In **App Store Connect** (appstoreconnect.apple.com) → **Apps** → **+ New App**:
   platform iOS, name "Private Skies Feedback", bundle ID `com.transworld.jets.feedback`, SKU `tw-feedback`.
3. In Xcode, set the run destination to **Any iOS Device (arm64)**, then choose **Product → Archive**.
4. When the Organizer window opens, click **Distribute App** → **App Store Connect** → **Upload**, accepting the defaults.
5. Wait about 15–30 minutes for processing. The build then appears in App Store Connect under **TestFlight**.

### 7b. Pilot with TestFlight

* In **TestFlight** → **Internal Testing**, add up to 100 people from your App Store Connect team.
  They install the **TestFlight** app and accept the invite.
* Answer the export-compliance question: the app uses only standard HTTPS encryption, so answer
  **No** to non-exempt encryption.

### 7c. Roll out to crew (pick one)

| Option | When to use | How |
|---|---|---|
| **Intune (MDM) + Apple Business Manager "Custom App"** *(recommended)* | Company-managed crew iPads/iPhones | App Store Connect → the app → **Pricing and Availability** → *Private / Custom App* for your Apple Business Manager organisation. Then in ABM, buy licences (free) and assign them in Intune → **Apps → iOS → Add → iOS store app (VPP)** to the crew group. Installs silently, isn't public, and updates automatically |
| **TestFlight** | Small groups, short term | Builds expire after 90 days, so you must keep uploading |
| **Public App Store** | Not recommended | Apple review will ask for a demo account and may question a sign-in-only app |

> Tell crew: **don't swipe the app away** from the app switcher. Pressing Home or locking the device is fine.

---

## 8. Shipping updates

Most changes are only in `www/` (HTML/CSS/JS), and they still need a new build because the files are inside the app:

1. Make the change and commit it.
2. On the Mac, run `git pull` then `npx cap sync ios`.
3. In Xcode → **General**, increase **Build** (e.g. `1` → `2`). Increase **Version** for a visible release.
4. Choose **Product → Archive** → **Distribute App**, as in 7a.
5. With Intune/ABM, devices update automatically once the build is released in App Store Connect.

If the backend team changes `/feedback`, they must keep accepting the current payload
([API-CONTRACT.md](API-CONTRACT.md)), because older app versions on devices may keep sending queued records for days.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Page looks unstyled when opened on Windows | You double-clicked `index.html`. Serve it: `powershell -ExecutionPolicy Bypass -File tools\serve.ps1` |
| `npx: command not found` (Mac) | Install Node.js from nodejs.org and reopen Terminal |
| Xcode: `No such module 'MSAL'` | Run `npx cap sync ios` again. If it persists: **File → Add Package Dependencies…** → `https://github.com/AzureAD/microsoft-authentication-library-for-objc` → add **MSAL** to the App target |
| Xcode: `Cannot find 'BackgroundUploadPlugin' in scope` | The Swift files weren't added to the App target. Select each file → right panel **Target Membership** → tick **App** |
| JS error `BackgroundUpload plugin is not implemented on ios` | Main.storyboard's class isn't set to `MainViewController` (step 4c) |
| Sign-in opens but never returns to the app | The Info.plist URL scheme is missing (4e), or the iOS platform isn't added in Entra (part 1) |
| Sign-in error **AADSTS50011** (redirect URI mismatch) | The bundle ID in Xcode doesn't match the one registered in Entra |
| Status always "crew sign-in needed" after signing in | Keychain Sharing group `com.microsoft.adalcache` missing (4d) |
| Top bar says "setup needed: Entra settings in config.js" | The placeholder zeros in `www/js/config.js` weren't replaced, or `ACTIVE` points to an environment you didn't fill in. Fix, then `npx cap sync ios` |
| Sign-in error **AADSTS65001 / AADSTS650057** (consent / invalid resource) | `scope` is wrong or not granted. Check part 1, steps 4–5 |
| Signed in, but items go to "crew sign-in needed" straight away | The server rejects the token (401/403). Usually the `scope` in `config.js` doesn't match the audience the backend expects. Give the backend team a token to compare (they can paste it into jwt.ms) |
| Item shows **rejected (HTTP 4xx)** | The server refused the data. Send the backend team the status code and [API-CONTRACT.md](API-CONTRACT.md) |
| Nothing arrives until the app is opened | The app was swiped away (force-quit), or the device is in Low Power Mode, where iOS delays it. Otherwise check the device actually has internet |
| Online and signed in, but items stay "waiting" | `feedbackUrl` in `config.js` is wrong or unreachable from the phone. Check it's https and the host opens in Safari on the phone |
| Personal-Apple-ID build stops opening after 7 days | Expected with free signing. Run it from Xcode again, or use the company team |
