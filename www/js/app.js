import * as store from "./store.js";
import * as sync from "./sync.js";
import { getAccount, signIn, isNative } from "./auth.js";
import { isConfigured } from "./config.js";

const FLIGHT_KEY = "tw.feedback.flight";
const CATEGORIES = [
  ["crew", "Cabin Crew & Service"],
  ["comfort", "Comfort, Cabin & Hygiene"],
  ["catering", "Catering & Refreshments"],
  ["overall", "Overall Experience"],
];
const SCALE = [["poor", "Poor"], ["fair", "Fair"], ["good", "Good"], ["exceptional", "Exceptional"]];

const $ = (id) => document.getElementById(id);
const form = $("feedback-form");

// ---- Form -------------------------------------------------------------------

$("ratings").innerHTML = CATEGORIES.map(([key, label]) => `
  <fieldset class="rating">
    <legend>${label}</legend>
    <div class="scale">
      ${SCALE.map(([v, text]) => `<label><input type="radio" name="${key}" value="${v}"><span>${text}</span></label>`).join("")}
    </div>
  </fieldset>`).join("");

function showFlight() {
  const flight = store.getJSON(FLIGHT_KEY, {});
  $("show-route").textContent = flight.route || "—";
  $("show-tail").textContent = flight.tail || "—";
  $("crew-route").value = flight.route || "";
  $("crew-tail").value = flight.tail || "";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const ratings = Object.fromEntries(CATEGORIES.map(([k]) => [k, data.get(k)]));
  const chooseAgain = data.get("chooseAgain");
  const comments = (data.get("comments") || "").trim();

  if (!Object.values(ratings).some(Boolean) && !chooseAgain && !comments) {
    $("form-error").textContent = "Please rate at least one item or leave a comment.";
    $("form-error").hidden = false;
    return;
  }
  $("form-error").hidden = true;

  const flight = store.getJSON(FLIGHT_KEY, {});
  await sync.submit({
    route: flight.route || null,
    tail: flight.tail || null,
    name: (data.get("name") || "").trim() || null,
    ratings,
    chooseAgain: chooseAgain === null ? null : chooseAgain === "yes",
    comments: comments || null,
    crew: getAccount()?.username || null,
  });

  // Saved locally — the passenger is done regardless of connectivity.
  form.reset();
  form.hidden = true;
  $("thanks").hidden = false;
  setTimeout(() => { $("thanks").hidden = true; form.hidden = false; window.scrollTo(0, 0); }, 4000);
});

// ---- Crew mode --------------------------------------------------------------
// The crew bar and panel are hidden from passengers. Crew swipe down with two fingers to
// show them (again to hide), or use Ctrl+Alt+C in a desktop browser. They hide themselves
// after 2 minutes without crew activity, so the device can be handed back safely.
// When the app is opened (or brought back to the front) the bar shows for 10 seconds, so
// crew see any warnings; touching it keeps it open as usual.

const CREW_IDLE_MS = 2 * 60 * 1000;
const CREW_PEEK_MS = 10 * 1000;
const SWIPE_DOWN_PX = 80;
let crewTimer;

function setCrewMode(on, hideAfterMs = CREW_IDLE_MS) {
  $("crew-bar").hidden = !on;
  if (!on) $("crew-panel").hidden = true;
  clearTimeout(crewTimer);
  if (on) crewTimer = setTimeout(() => setCrewMode(false), hideAfterMs);
}

setCrewMode(true, CREW_PEEK_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !crewModeOn()) setCrewMode(true, CREW_PEEK_MS);
});
const crewModeOn = () => !$("crew-bar").hidden;

const avgY = (touches) => (touches[0].clientY + touches[1].clientY) / 2;
let swipeStartY = null;
document.addEventListener("touchstart", (e) => {
  swipeStartY = e.touches.length === 2 ? avgY(e.touches) : null;
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (swipeStartY === null || e.touches.length !== 2) return;
  e.preventDefault(); // no scrolling or zooming during the gesture
  if (avgY(e.touches) - swipeStartY > SWIPE_DOWN_PX) {
    swipeStartY = null; // once per gesture
    setCrewMode(!crewModeOn());
  }
}, { passive: false });
document.addEventListener("touchend", () => { swipeStartY = null; });

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "c") setCrewMode(!crewModeOn());
});

// Any crew activity keeps crew mode open.
for (const id of ["crew-bar", "crew-panel"]) {
  for (const type of ["click", "input"]) $(id).addEventListener(type, () => crewModeOn() && setCrewMode(true));
}

$("crew-hide").addEventListener("click", (e) => { e.stopPropagation(); setCrewMode(false); });

// ---- Crew panel -------------------------------------------------------------

$("crew-toggle").addEventListener("click", () => { $("crew-panel").hidden = !$("crew-panel").hidden; });

$("crew-save").addEventListener("click", () => {
  store.setJSON(FLIGHT_KEY, { route: $("crew-route").value.trim(), tail: $("crew-tail").value.trim() });
  showFlight();
  $("crew-panel").hidden = true;
});

$("crew-signin").addEventListener("click", async () => {
  try {
    if (await signIn()) {
      sync.clearAuthProblem();
      await sync.reconcile();
    }
  } catch (err) {
    alert(isConfigured ? err.message + "\nSigning in needs an internet connection." : err.message);
  }
  renderStatus();
});

$("crew-sync").addEventListener("click", () => sync.reconcile());
$("crew-retry").addEventListener("click", () => sync.retryRejected());

// ---- Status -----------------------------------------------------------------

function renderStatus() {
  const records = store.all();
  const pending = records.filter((r) => r.status === "pending").length;
  const rejected = records.filter((r) => r.status === "rejected");
  const el = $("sync-status");
  $("crew-retry").hidden = !rejected.length;

  if (!isConfigured) {
    el.textContent = `${pending} waiting · setup needed: Entra settings in config.js`;
    el.className = "sync problem";
  } else if (sync.hasAuthProblem()) {
    el.textContent = `${pending} waiting · crew sign-in needed`;
    el.className = "sync problem";
  } else if (rejected.length) {
    el.textContent = (pending ? `${pending} waiting · ` : "") +
      `${rejected.length} not accepted by server (${rejected[0].lastError}) · open Crew to retry`;
    el.className = "sync problem";
  } else if (pending) {
    el.textContent = `${pending} waiting to send` + (isNative ? " (sends automatically)" : "");
    el.className = "sync pending";
  } else {
    el.textContent = "All feedback sent";
    el.className = "sync";
  }

  const acct = getAccount();
  $("crew-account").textContent = acct ? `Signed in as ${acct.name || acct.username}` : "Not signed in";
  // Unsent first, then the 10 most recently sent with the time the server confirmed them.
  const time = (iso) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  const unsent = records.filter((r) => r.status !== "sent");
  const sent = records.filter((r) => r.status === "sent")
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt)).slice(0, 10);
  // textContent, not innerHTML: the route is typed in on the device and must never run as HTML.
  const li = (text) => Object.assign(document.createElement("li"), { textContent: text });
  $("queue-list").replaceChildren(
    ...unsent.map((r) => li(`Saved ${time(r.createdAt)} · ${r.payload.route || "no route"} · ${r.status}${r.lastError ? ` (${r.lastError})` : ""}`)),
    ...sent.map((r) => li(`Saved ${time(r.createdAt)} · sent ${time(r.sentAt)}`)),
  );
}

sync.onChange(renderStatus);
showFlight();
renderStatus();
sync.startTriggers();
