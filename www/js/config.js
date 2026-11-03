// ─── APP SETTINGS: THE ONLY FILE TO EDIT PER ENVIRONMENT ────────────────────
//
// feedbackUrl  Full URL the app POSTs each submission to (see API-CONTRACT.md).
//              Must be https; the iOS app blocks plain http.
// entra        From the Azure portal → Entra ID → App registrations → your app:
//   clientId   "Application (client) ID" on the Overview page
//   tenantId   "Directory (tenant) ID" on the Overview page
//   scope      Full scope of the API being called, from "Expose an API",
//              e.g. "api://<clientId>/access_as_user"
//   androidKeyHash  Android only: signature hash of the key the APK is signed with.
//              Run tools\android-keyhash.ps1 to get it. Debug builds (emulator)
//              and release builds use DIFFERENT keys, so dev and prod differ.
//
// None of these are secrets: a mobile app is a "public client" and never holds a
// client secret. Do NOT put a client secret or password in this file.
//
// These values are bundled into the app at build time. After changing them run
// `npx cap sync ios` and rebuild (see DEPLOY.md, part 8).

const ENVIRONMENTS = {
  dev: {
    feedbackUrl: "https://test-coral-tau-34.vercel.app/test",
    entra: {
      clientId: "d802aa12-690f-4281-9076-804109081af3",
      tenantId: "76ae1d97-467c-42c2-86d2-9ccea3131137",
      scope: "api://d802aa12-690f-4281-9076-804109081af3/UserAccess",
      androidKeyHash: "", // debug key (emulator / Android Studio Run)
    },
  },
  prod: {
    feedbackUrl: "https://test-coral-tau-34.vercel.app/test",
    entra: {
      clientId: "d802aa12-690f-4281-9076-804109081af3",
      tenantId: "76ae1d97-467c-42c2-86d2-9ccea3131137",
      scope: "api://d802aa12-690f-4281-9076-804109081af3/UserAccess",
      androidKeyHash: "", // debug key (emulator / Android Studio Run)
    },
  },
};

const ACTIVE = "dev"; // ← "prod" for the release build

// ─── nothing to edit below ───────────────────────────────────────────────────

const env = ENVIRONMENTS[ACTIVE];

// Browser testing only: localStorage.setItem("tw.feedback.url", "http://localhost:8000/feedback")
export const FEEDBACK_URL = localStorage.getItem("tw.feedback.url") || env.feedbackUrl;
export const ENTRA = env.entra;

const isAndroid = window.Capacitor?.getPlatform?.() === "android";

export const isConfigured = ![ENTRA.clientId, ENTRA.tenantId, ENTRA.scope, ...(isAndroid ? [ENTRA.androidKeyHash] : [])]
  .some((v) => !v || v.includes("00000000-0000-0000-0000-000000000000"));
