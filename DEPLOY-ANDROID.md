# Android guide — build and test on the emulator (Windows)

Same app, same `www/` code and same behaviour as iOS. Android can be built on **Windows**, no Mac needed.
Do the parts in order. Each one ends with a **✅ Check**.

| Part | Time |
|---|---|
| [1. Install the tools](#1-install-the-tools) | 30–45 min (downloads) |
| [2. Create the Android project](#2-create-the-android-project) | 10 min |
| [3. Get the signature hash](#3-get-the-signature-hash) | 2 min |
| [4. Entra: add the Android platform](#4-entra-add-the-android-platform) | 5 min (Azure admin) |
| [5. Fill in config.js](#5-fill-in-configjs) | 2 min |
| [6. Add the native code](#6-add-the-native-code) | 15 min |
| [7. Run on the emulator](#7-run-on-the-emulator) | 10 min |
| [8. Test checklist](#8-test-checklist) | 1–3 h (includes waiting) |
| [9. Release](#9-release-to-crew-devices) | |
| [Troubleshooting](#troubleshooting) | |

### How Android sends while the app is closed
Each submission is handed to **WorkManager**, Android's built-in job scheduler. It holds the job
until the device has internet, runs it even if the app is closed or the phone rebooted, and retries
with backoff (15 min, 30 min … up to 5 h). Before each attempt, the app gets a fresh token for the
signed-in crew member silently from MSAL's cache, the same approach as iOS.

| Situation | What happens |
|---|---|
| App closed, swiped from recents, phone rebooted | Uploads still go out once online |
| Device idle (Doze) | Android delays the job to its next maintenance window, typically minutes, up to a few hours overnight |
| **Settings → Apps → Force stop** | Android cancels pending jobs. They're re-queued the next time the app opens |
| Some brands (Xiaomi, Huawei, OnePlus; Samsung "deep sleeping apps") | May block background work. On crew devices, set the app's battery usage to **Unrestricted** |

---

## 1. Install the tools

1. **Node.js 20 LTS**: download from nodejs.org and install with the defaults. Close and reopen any terminal afterwards.
2. **Android Studio**: download from developer.android.com/studio and install with the defaults.
   On first launch, choose the **Standard** setup. It downloads the Android SDK and an emulator image.
3. **Create an emulator.** In Android Studio go to **More Actions → Virtual Device Manager → Create Virtual Device** → **Pixel 8** →
   system image **API 34 or 35** with **Google Play** in the "Services" column (it includes Chrome, which Microsoft sign-in uses) → **Finish**.

✅ **Check:** in a new terminal, `node -v` prints v20 or later, and the emulator boots from Device Manager (▶).

---

## 2. Create the Android project

In a terminal in the `FeedbackApp` folder:

```bash
npm install
```

```bash
npx cap add android
```

```bash
npx cap sync android
```

This creates the `android/` folder. Open it in Android Studio and wait for **Gradle sync** to finish (bottom status bar, the first time takes a few minutes):

```bash
npx cap open android
```

✅ **Check:** in Android Studio, **Build → Make Project** succeeds. This first build also creates the debug signing key used in part 3.

---

## 3. Get the signature hash

Android identifies an app to Microsoft sign-in by its package name and the hash of the key it's signed with.
Emulator builds are signed with your PC's **debug key**:

```bash
powershell -ExecutionPolicy Bypass -File tools\android-keyhash.ps1
```

It prints three values. Keep them for parts 4–6:

```
Signature hash (androidKeyHash / Entra 'Signature hash'):
  Xo8WBi6jzSxKDVR4drqm84yr9iU=
Redirect URI Entra will show:
  msauth://com.transworld.jets.feedback/Xo8WBi6jzSxKDVR4drqm84yr9iU%3D
AndroidManifest.xml <data android:path> value:
  /Xo8WBi6jzSxKDVR4drqm84yr9iU=
```

> Each developer PC has its **own** debug key, so each developer gets a different hash. Register every one in Entra (part 4), or share one debug keystore across the team.

---

## 4. Entra: add the Android platform

In the **same app registration** as iOS (Azure portal → Entra ID → App registrations → your app):

1. Go to **Authentication → Add a platform → Android**.
2. Package name: `com.transworld.jets.feedback`. Signature hash: the value from part 3.
3. Click **Configure**. Entra shows the redirect URI `msauth://com.transworld.jets.feedback/...`. Nothing else is needed.

✅ **Check:** Authentication lists an Android platform with your hash.

---

## 5. Fill in config.js

In [`www/js/config.js`](www/js/config.js), fill in the `dev` environment: `feedbackUrl`, `clientId`, `tenantId`, `scope` (see [DEPLOY.md](DEPLOY.md) part 3), **plus**:

```js
androidKeyHash: "Xo8WBi6jzSxKDVR4drqm84yr9iU=",   // from part 3, exactly as printed (not URL-encoded)
```

Then copy the web files into the Android project:

```bash
npx cap sync android
```

---

## 6. Add the native code

All paths below are inside `android/`. In Android Studio, use the **Project** view (dropdown at the top left of the file tree).

### 6a. Copy the Java files

Copy every file from `native-android/` into
`android/app/src/main/java/com/transworld/jets/feedback/`:

* `BackgroundUploadPlugin.java`, `UploadQueue.java`, `UploadWorker.java`, `TokenProvider.java`
* `MainActivity.java`: **overwrite** the generated one.

### 6b. Dependencies: `android/app/build.gradle`

Inside the existing `dependencies { ... }` block, add:

```gradle
implementation "androidx.work:work-runtime:2.9.1"
implementation "com.microsoft.identity.client:msal:<VERSION>"
```

For `<VERSION>`, use **the same MSAL version the sign-in plugin uses**. Open
`node_modules/@recognizebv/capacitor-plugin-msal/android/build.gradle` and copy the version from its
`com.microsoft.identity.client:msal` line. Two different versions will conflict.

### 6c. MSAL's package feed: `android/build.gradle`

In `allprojects { repositories { ... } }`, add this line below `mavenCentral()`:

```gradle
maven { url "https://pkgs.dev.azure.com/MicrosoftDeviceSDK/DuoSDK-Public/_packaging/Duo-SDK-Feed/maven/v1" }
```

### 6d. Sign-in return screen: `android/app/src/main/AndroidManifest.xml`

Inside `<application> ... </application>`, next to the existing `<activity>`, add the following. Use your hash from part 3, with the leading `/` and **not** URL-encoded:

```xml
<activity
    android:name="com.microsoft.identity.client.BrowserTabActivity"
    android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data
            android:scheme="msauth"
            android:host="com.transworld.jets.feedback"
            android:path="/Xo8WBi6jzSxKDVR4drqm84yr9iU=" />
    </intent-filter>
</activity>
```

Also check the [plugin's README](https://github.com/recognizegroup/capacitor-plugin-msal#android) for any extra Android steps in the version you installed.

✅ **Check:** click **File → Sync Project with Gradle Files**, then **Build → Make Project**. Both succeed.

---

## 7. Run on the emulator

1. Start the emulator from Device Manager.
2. In Android Studio's top bar, select the emulator and press **▶ Run 'app'**.

✅ **Check:** the navy feedback form opens in the emulator.

**Useful while testing:**
* **See the JS console:** open Chrome on your PC, go to `chrome://inspect`, and click **inspect** under the app's WebView.
* **See queued uploads:** in Android Studio, **View → Tool Windows → App Inspection → Background Task Inspector**.
  It lists each `UploadWorker` job and whether it's *Enqueued*, *Running*, *Succeeded* or *Retrying*.
* **Native logs:** the **Logcat** tab. Filter by `WM-` for WorkManager, or `MSAL`.

---

## 8. Test checklist

Go offline/online with the emulator's quick-settings **Airplane mode** tile (swipe down from the top), or with these commands:

```bash
adb shell cmd connectivity airplane-mode enable
```

```bash
adb shell cmd connectivity airplane-mode disable
```

(`adb` is in `%LOCALAPPDATA%\Android\Sdk\platform-tools`.)

| # | Do this | Expect |
|---|---|---|
| 1 | **Crew → Crew sign in**, sign in with a Microsoft account | Chrome opens for sign-in, returns to the app: "Signed in as …" |
| 2 | Enter route + tail no. → **Save flight** | Shown at the top of the form |
| 3 | Submit a form **online** | Top bar "All feedback sent" within seconds |
| 4 | Airplane mode **on**, submit 3 forms | Top bar "3 waiting to send"; Background Task Inspector shows 3 jobs *Enqueued* |
| 5 | Swipe the app away from recents. Airplane mode **off**, note the time. Wait 5 min, then open the app → Crew | All 3 show a **sent** time from before you reopened the app. The inspector shows them *Succeeded* |
| 6 | Airplane mode on, submit 1, close the app, **wait 2 hours**, airplane mode off, wait, open app | Sent while closed. The token had expired and was refreshed silently |
| 7 | Airplane mode on, submit 1, **Settings → Apps → Private Skies Feedback → Force stop**, airplane mode off, open the app | Sent shortly after opening (force stop cancels jobs; the app re-queues them) |
| 8 | Airplane mode on, submit 1, restart the emulator (power button → Restart), airplane mode off | Sent without opening the app |
| 9 | *(Optional, simulates overnight idle)* With 1 item queued: `adb shell dumpsys deviceidle force-idle`, airplane mode off, then `adb shell dumpsys deviceidle unforce` | Sent after leaving idle |

---

## 9. Release to crew devices

1. **Create a release key** (once, and store it safely). In Android Studio: **Build → Generate Signed App Bundle / APK → Android App Bundle → Create new…**.
   If the key is lost, the app can't be updated.
2. Get its hash, then add it as a **second** Android platform entry in Entra (part 4) and in the `prod` block of `config.js`:
   ```bash
   powershell -ExecutionPolicy Bypass -File tools\android-keyhash.ps1 -Keystore C:\path\release.jks -Alias <alias> -StorePass <password>
   ```
   Add a second `<data ... android:path="/<release hash>" />` line to the manifest `intent-filter` from 6d.
3. Set `ACTIVE = "prod"` in `config.js`, then run `npx cap sync android`.
4. In Android Studio, increase `versionCode` (and `versionName`) in `android/app/build.gradle`.
5. Use **Build → Generate Signed App Bundle** with the release key to produce an `.aab` file.
6. Distribute it:
   * **Managed Google Play via Intune** *(recommended for company devices)*: publish as a private app to your organisation.
   * **Play Console → Internal testing**: for a pilot of up to 100 testers.

> If you use **Play App Signing**, Google re-signs the app with its own key. Take the hash from
> **Play Console → Setup → App signing → App signing key certificate (SHA-1)**, convert it as in part 3,
> and register that hash too.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npx` not recognised | Node.js isn't installed, or the terminal was open during install. Reopen it |
| `keytool not found` | Install Android Studio. The script uses its bundled Java |
| `Keystore not found` (debug) | Build any project once in Android Studio (part 2 check) |
| Gradle: `Could not find com.microsoft.identity.client:msal` | The Duo feed line is missing (6c) |
| Gradle: duplicate class / version conflict on MSAL | Your `msal` version differs from the plugin's. Use the same (6b) |
| `cannot find symbol class Worker` / `WorkManager` | `work-runtime` dependency missing (6b) |
| JS error `"BackgroundUpload" plugin is not implemented on android` | `MainActivity.java` wasn't replaced (6a), or its `package` line doesn't match `com.transworld.jets.feedback` |
| Sign-in: *"The redirect URI in the configuration file doesn't match"* / *intent filter* error | The hash in `config.js`, the manifest `android:path` and Entra must all be the same, and the manifest path must start with `/` |
| Sign-in error **AADSTS50011** | Android platform not added in Entra, or it was added with a different hash |
| Sign-in page doesn't open | Emulator image without Chrome. Use a "Google Play" image (part 1) |
| Top bar "setup needed: Entra settings" | `androidKeyHash` (or another value) is empty for the active environment in `config.js`. Run `npx cap sync android` after fixing |
| Items stay *Enqueued* although online | Emulator "airplane mode" may still be on, or the emulator has no internet (check Chrome on the emulator). On a real device, check battery optimisation |
| Items go to "crew sign-in needed" | Logcat → filter `MSAL`. Usually the account isn't in MSAL's cache (sign in again) or the server rejects the token's scope (see [DEPLOY.md](DEPLOY.md) troubleshooting) |
