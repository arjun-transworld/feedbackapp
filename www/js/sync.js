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
function applyResult(id, status, at = Date.now()) {
  if (status >= 200 && status < 300) {
    store.update(id, { status: "sent", sentAt: new Date(at).toISOString() });
  } else if (status === 401 || status === 403) {
    store.setJSON(AUTH_PROBLEM, true); // stays pending; resent after crew signs in again
  } else if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    store.update(id, { status: "rejected", lastError: "HTTP " + status }); // bad data; never retried
  }
}

/** Saves a submission locally and hands it to the uploader. */
export async function submit(payload) {
  const record = store.add(payload);
  changed();
  if (isNative) {
    await enqueueNative(record).catch((e) => console.warn("[sync] enqueue failed", e));
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
      applyResult(record.id, res.status);
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
  for (const r of results) applyResult(r.id, r.status, r.at);
  if (results.length) await Native.clearResults({ ids: results.map((r) => r.id) });

  if (!store.getJSON(AUTH_PROBLEM, false)) {
    const inFlight = new Set(active);
    for (const record of store.pending()) {
      if (!inFlight.has(record.id)) await enqueueNative(record).catch(() => {});
    }
  }
  changed();
}

export function startTriggers() {
  window.addEventListener("online", reconcile);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reconcile());
  window.Capacitor?.Plugins?.App?.addListener("resume", reconcile);
  setInterval(reconcile, 60_000);
  reconcile();
}
