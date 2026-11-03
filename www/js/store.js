// Local record store. Every submission lives here until the server confirms it.
// On iOS the native plugin also keeps its own copy on disk, so a WebView storage
// purge cannot lose an upload that is already queued.

const QUEUE_KEY = "tw.feedback.queue.v1";
const KEEP_SENT_MS = 7 * 24 * 3600 * 1000;

function read() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch { return []; }
}
function write(records) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(records));
}

export function all() {
  return read();
}

export function pending() {
  return read().filter((r) => r.status === "pending");
}

export function add(payload) {
  const record = {
    id: crypto.randomUUID(), // idempotency key: the server ignores duplicates
    createdAt: new Date().toISOString(),
    status: "pending",       // pending | sent | rejected
    payload,
  };
  write([...read(), record]);
  return record;
}

export function update(id, changes) {
  write(read().map((r) => (r.id === id ? { ...r, ...changes } : r)));
}

export function pruneSent() {
  const cutoff = Date.now() - KEEP_SENT_MS;
  write(read().filter((r) => r.status !== "sent" || Date.parse(r.sentAt || r.createdAt) > cutoff));
}

// Small key/value helpers for flight prefill and the device key.
export function getJSON(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
export function setJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
