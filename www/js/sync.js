// Sending queued records to the backend.
//
// iOS / Android app: each record is handed to the native BackgroundUpload plugin,
// which queues it with the OS (iOS: background URLSession, Android: WorkManager).
// The OS waits for connectivity and sends it even if the app is closed; results
// are collected when the app next runs (reconcile()).
//
// Browser: plain fetch with the MSAL.js token while the page is open, retried on
// 'online', on focus and every minute.

import { FEEDBACK_URL, ENTRA, isConfigured } from "./config.js";
import * as store from "./store.js";
import { isNative, getAccount, getAccessToken } from "./auth.js";

const AUTH_PROBLEM = "tw.feedback.authProblem";
const Native = isNative ? window.Capacitor.Plugins.BackgroundUpload : null;

const listeners = [];
export function onChange(fn) { listeners.push(fn); }
function changed() { listeners.forEach((fn) => fn()); }

export function hasAuthProblem() {
  return store.getJSON(AUTH_PROBLEM, false) || !getAccount();
}
export function clearAuthProblem() {
  store.setJSON(AUTH_PROBLEM, false);
}

function body(record) {
  return JSON.stringify({ id: record.id, createdAt: record.createdAt, ...record.payload });
}

// HTTP status from the server -> what to do with the record.
// `at` = when the server answered (from native), so the UI shows the real send time.
// `detail` = native's reason, e.g. "not sent, no token: AADSTS53000 …" or "server answered 401 …";
// shown in the crew list so a stuck record says why.
function applyResult(id, status, at = Date.now(), detail) {
  if (status >= 200 && status < 300) {
    store.update(id, { status: "sent", sentAt: new Date(at).toISOString(), lastError: undefined });
  } else if (status === 401 || status === 403) {
    store.setJSON(AUTH_PROBLEM, true); // stays pending; resent after crew signs in again
    store.update(id, { lastError: detail || "HTTP " + status });
  } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    const reason = detail || "HTTP " + status + (status === 404 ? ": address not found on the server" : "");
    store.update(id, { status: "rejected", lastError: reason }); // resent with the next submission or "Retry rejected"
  }
}

// Rejected records go back to pending, so they are sent again. Returns them.
function requeueRejected() {
  const rejected = store.all().filter((r) => r.status === "rejected");
  for (const r of rejected) store.update(r.id, { status: "pending", lastError: undefined });
  return rejected;
}

/** Saves a submission locally and hands it to the uploader, together with any earlier rejected ones. */
export async function submit(payload) {
  const retried = requeueRejected();
  const record = store.add(payload);
  changed();
  if (isNative) {
    for (const r of [...retried, record]) {
      await enqueueNative(r).catch((e) => console.warn("[sync] enqueue failed", e));
    }
  } else {
    flushWeb();
  }
}

// Native attaches "Authorization: Bearer <token>" itself, fetching a fresh token
// from the MSAL cache before every attempt.
async function enqueueNative(record) {
  if (!isConfigured || !getAccount()) return; // enqueued by reconcile() after crew signs in
  await Native.enqueue({
    id: record.id,
    url: FEEDBACK_URL,
    headers: { "Content-Type": "application/json" },
    body: body(record),
    auth: { clientId: ENTRA.clientId, tenantId: ENTRA.tenantId, scope: ENTRA.scope, keyHash: ENTRA.androidKeyHash },
  });
}

let flushing = false;
async function flushWeb() {
  if (flushing || !getAccount() || !navigator.onLine || !store.pending().length) return;
  flushing = true;
  try {
    const token = await getAccessToken();
    if (!token) return; // redirecting to sign-in
    for (const record of store.pending()) {
      let res;
      try {
        res = await fetch(FEEDBACK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: body(record),
        });
      } catch {
        break; // offline / server unreachable: try again on the next trigger
      }
      applyResult(record.id, res.status, Date.now(), res.status === 401 ? "server answered 401" : undefined);
      if (res.status >= 500 || res.status === 401 || res.status === 403) break;
    }
  } finally {
    flushing = false;
    changed();
  }
}

/**
 * Brings the local store in line with what the uploader has done, and
 * (re)queues anything still pending — e.g. after the user force-quit the app,
 * which makes iOS cancel its background transfers.
 */
export async function reconcile() {
  store.pruneSent();
  if (!isNative) return flushWeb();

  const { results, active } = await Native.getState();
  for (const r of results) applyResult(r.id, r.status, r.at, r.detail);
  if (results.length) await Native.clearResults({ ids: results.map((r) => r.id) });

  if (!store.getJSON(AUTH_PROBLEM, false)) {
    const inFlight = new Set(active);
    for (const record of store.pending()) {
      if (!inFlight.has(record.id)) await enqueueNative(record).catch(() => {});
    }
  }
  changed();
}

/** Crew action: send rejected records again, e.g. after the server address or endpoint was fixed. */
export function retryRejected() {
  requeueRejected();
  return reconcile();
}

export function startTriggers() {
  window.addEventListener("online", reconcile);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reconcile());
  window.Capacitor?.Plugins?.App?.addListener("resume", reconcile);
  setInterval(reconcile, 60_000);
  reconcile();
}
