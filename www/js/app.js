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

// ---- Status -----------------------------------------------------------------

function renderStatus() {
  const records = store.all();
  const pending = records.filter((r) => r.status === "pending").length;
  const el = $("sync-status");

  if (!isConfigured) {
    el.textContent = `${pending} waiting · setup needed: Entra settings in config.js`;
    el.className = "sync problem";
  } else if (sync.hasAuthProblem()) {
    el.textContent = `${pending} waiting · crew sign-in needed`;
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
  $("queue-list").innerHTML = [
    ...unsent.map((r) => `<li>Saved ${time(r.createdAt)} · ${r.payload.route || "no route"} · ${r.status}${r.lastError ? " (" + r.lastError + ")" : ""}</li>`),
    ...sent.map((r) => `<li>Saved ${time(r.createdAt)} · sent ${time(r.sentAt)}</li>`),
  ].join("");
}

sync.onChange(renderStatus);
showFlight();
renderStatus();
sync.startTriggers();
