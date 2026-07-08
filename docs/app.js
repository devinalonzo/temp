/* Work order app — static, no backend.
   Data ships encrypted (data.enc); decrypted in-browser with a passcode. */

"use strict";

const PBKDF2_ITERATIONS = 600000;
const LABOR_ROWS = 5;
const PARTS_ROWS = 8;
const LABOR_TYPES = ["", "Travel to Site", "Onsite Labor", "Travel to Shop", "Mileage"];

let DATA = null;            // { customers, sites, billto, notes, built, months }
let SITE_INDEX = null;      // customerId -> [site,...]
let CUST_BY_ID = null;      // customerId -> name
let selectedCustomer = null; // {id, name} for WO tab
let notesCustomer = null;    // {id, name} for Notes tab
let editingHistoryId = null; // when reopening a saved WO

const $ = (id) => document.getElementById(id);

/* ================= crypto / unlock ================= */

async function deriveKey(passcode, salt) {
  const material = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    material, 256);
  return new Uint8Array(bits);
}

async function decryptBundle(buf, keyBytes) {
  const bytes = new Uint8Array(buf);
  if (new TextDecoder().decode(bytes.slice(0, 4)) !== "KWO1") throw new Error("bad bundle header");
  const iv = bytes.slice(20, 32);
  const ct = bytes.slice(32);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(pako.ungzip(new Uint8Array(plain), { to: "string" }));
}

async function fetchBundle() {
  const res = await fetch("data.enc", { cache: "no-store" });
  if (!res.ok) throw new Error("could not load data.enc");
  return res.arrayBuffer();
}

function indexData() {
  CUST_BY_ID = {};
  for (const c of DATA.customers) CUST_BY_ID[c.id] = c.name;
  SITE_INDEX = {};
  for (const s of DATA.sites) (SITE_INDEX[s.c] ||= []).push(s);
  // search fields: customer name (primary) and site store-names/locations/cities (secondary)
  for (const c of DATA.customers) {
    c.nameLower = c.name.toLowerCase();
    const parts = [];
    for (const s of SITE_INDEX[c.id] || []) parts.push(s.n || "", s.l, s.ci);
    c.siteSearch = parts.join(" ").toLowerCase();
  }
}

function showApp() {
  indexData();
  $("lock-screen").hidden = true;
  $("app").hidden = false;
  $("data-info").textContent =
    `${DATA.customers.length} customers · notes last ${DATA.months} mo · data as of ${DATA.built}`;
  initForm();
}

async function tryCachedKey() {
  const b64 = localStorage.getItem("kwoKey") || sessionStorage.getItem("kwoKey");
  if (!b64) return false;
  try {
    const keyBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    DATA = await decryptBundle(await fetchBundle(), keyBytes);
    showApp();
    return true;
  } catch {
    localStorage.removeItem("kwoKey");
    sessionStorage.removeItem("kwoKey");
    return false;
  }
}

$("unlock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("unlock-btn"), status = $("lock-status");
  const passcode = $("passcode").value;
  if (!passcode) return;
  btn.disabled = true;
  status.textContent = "Unlocking…";
  try {
    const buf = await fetchBundle();
    const salt = new Uint8Array(buf).slice(4, 20);
    const keyBytes = await deriveKey(passcode, salt);
    DATA = await decryptBundle(buf, keyBytes);
    localStorage.setItem("kwoKey", btoa(String.fromCharCode(...keyBytes)));
    status.textContent = "";
    showApp();
  } catch (err) {
    console.error(err);
    status.textContent = err.name === "OperationError"
      ? "Wrong passcode — check spelling and dashes."
      : "Unlock failed: " + (err.message || err);
  } finally {
    btn.disabled = false;
  }
});

tryCachedKey();

$("lock-btn").addEventListener("click", () => {
  if (!confirm("Lock the app on this device? You'll need the passcode again.")) return;
  localStorage.removeItem("kwoKey");
  sessionStorage.removeItem("kwoKey");
  location.reload();
});

/* ================= tabs ================= */

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    for (const name of ["wo", "notes", "history"]) $("tab-" + name).hidden = name !== btn.dataset.tab;
    if (btn.dataset.tab === "history") renderHistory();
  });
});

/* ================= autocomplete ================= */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function searchCustomers(q) {
  const query = q.toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const c of DATA.customers) {
    let score = 0;
    if (c.nameLower.startsWith(query)) score = 100;
    else if (c.nameLower.includes(query)) score = 80;
    else if (c.id.includes(query)) score = 70;
    else if (tokens.every((t) => c.nameLower.includes(t))) score = 50;
    else if (tokens.every((t) => c.nameLower.includes(t) || c.siteSearch.includes(t))) score = 20;
    if (score) scored.push([score, c]);
  }
  scored.sort((a, b) => b[0] - a[0] || (b[1].ct || 0) - (a[1].ct || 0) ||
    a[1].name.localeCompare(b[1].name));
  return scored.slice(0, 15).map((x) => x[1]);
}

function setupAutocomplete(inputId, listId, onPick, onClear) {
  const input = $(inputId), list = $(listId);
  let items = [];

  function close() { list.hidden = true; list.innerHTML = ""; items = []; }

  function render(matches) {
    items = matches;
    if (!matches.length) return close();
    list.innerHTML = matches.map((c, i) =>
      `<div class="ac-item${i === 0 ? " hl" : ""}" data-i="${i}">${escapeHtml(c.name)}` +
      `${c.sc > 1 ? ` <span class="cid">${c.sc} sites</span>` : ""}</div>`).join("");
    list.hidden = false;
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (!q && onClear) onClear();
    if (q.length < 2) return close();
    render(searchCustomers(q));
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    const hl = list.querySelector(".hl");
    let i = hl ? +hl.dataset.i : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      i = Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), items.length - 1);
      list.querySelectorAll(".ac-item").forEach((el) => el.classList.toggle("hl", +el.dataset.i === i));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (i >= 0) pick(i);
    } else if (e.key === "Escape") close();
  });

  for (const evt of ["mousedown", "click"]) {
    list.addEventListener(evt, (e) => {
      const item = e.target.closest(".ac-item");
      if (item) { e.preventDefault(); pick(+item.dataset.i); }
    });
  }

  input.addEventListener("blur", () => setTimeout(close, 150));

  function pick(i) {
    const c = items[i];
    if (!c) return; // already picked (mousedown+click both fire)
    input.value = c.name;
    close();
    onPick(c);
  }
}

/* ================= WO form ================= */

function siteLabel(s) {
  const addr = [s.a1, s.ci].filter(Boolean).join(", ");
  const store = s.n ? s.n + " · " : "";
  return `${store}${s.l}${addr ? " — " + addr : ""}`;
}

function fillSiteFields(s) {
  $("f-sitename").value = s.n || (selectedCustomer ? selectedCustomer.name : "");
  $("f-siteaddress").value = [s.a1, s.a2].filter(Boolean).join(", ");
  $("f-sitecity").value = s.ci;
  $("f-sitestate").value = s.st;
  $("f-sitezip").value = s.z;
}

function clearSiteFields() {
  for (const id of ["f-sitename", "f-siteaddress", "f-sitecity", "f-sitezip"])
    $(id).value = "";
  $("f-sitestate").value = "";
}

function onCustomerCleared() {
  selectedCustomer = null;
  const input = $("site-search");
  input.value = "";
  input.placeholder = "— pick customer first —";
  input.disabled = true;
  clearSiteFields();
}

function onCustomerPicked(c) {
  selectedCustomer = c;
  const sites = SITE_INDEX[c.id] || [];
  const input = $("site-search");
  input.disabled = !sites.length;
  if (!sites.length) {
    input.value = "";
    input.placeholder = "— no sites on file —";
    $("f-sitename").value = c.name;
    return;
  }
  input.placeholder = "Type store #, address or city…";
  if (sites.length === 1) {
    input.value = siteLabel(sites[0]);
    fillSiteFields(sites[0]);
  } else {
    input.value = "";
    clearSiteFields();
    input.focus();
  }
}

function searchSites(q) {
  const sites = SITE_INDEX[selectedCustomer?.id] || [];
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return sites.slice(0, 100);
  return sites.filter((s) => tokens.every((t) =>
    (s.l || "").toLowerCase().includes(t) ||
    (s.n || "").toLowerCase().includes(t) ||
    (s.a1 || "").toLowerCase().includes(t) ||
    (s.ci || "").toLowerCase().includes(t) ||
    (s.z || "").includes(t))).slice(0, 100);
}

function setupSitePicker() {
  const input = $("site-search"), list = $("site-list");
  let items = [];

  function close() { list.hidden = true; list.innerHTML = ""; items = []; }

  function render() {
    items = searchSites(input.value.trim());
    if (!items.length) return close();
    list.innerHTML = items.map((s, i) =>
      `<div class="ac-item${i === 0 ? " hl" : ""}" data-i="${i}">${escapeHtml(siteLabel(s))}</div>`).join("");
    list.hidden = false;
  }

  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    const hl = list.querySelector(".hl");
    let i = hl ? +hl.dataset.i : -1;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      i = Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), items.length - 1);
      list.querySelectorAll(".ac-item").forEach((el) => el.classList.toggle("hl", +el.dataset.i === i));
      list.querySelector(".hl")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (i >= 0) pick(i);
    } else if (e.key === "Escape") close();
  });
  for (const evt of ["mousedown", "click"]) {
    list.addEventListener(evt, (e) => {
      const item = e.target.closest(".ac-item");
      if (item) { e.preventDefault(); pick(+item.dataset.i); }
    });
  }
  input.addEventListener("blur", () => setTimeout(close, 150));

  function pick(i) {
    const s = items[i];
    if (!s) return;
    input.value = siteLabel(s);
    close();
    fillSiteFields(s);
  }
}

function todayIso() { return new Date().toISOString().slice(0, 10); }
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function minutesBetween(t1, t2) {
  if (!t1 || !t2) return null;
  const [h1, m1] = t1.split(":").map(Number);
  const [h2, m2] = t2.split(":").map(Number);
  let diff = h2 * 60 + m2 - (h1 * 60 + m1);
  if (diff < 0) diff += 24 * 60; // crossed midnight
  return diff;
}

function getTechName() { return localStorage.getItem("kwoTech") || ""; }

function buildRows() {
  const laborBody = $("labor-table").querySelector("tbody");
  laborBody.innerHTML = "";
  for (let i = 0; i < LABOR_ROWS; i++) {
    laborBody.insertAdjacentHTML("beforeend", `<tr class="labor-row">
      <td><input data-l="date" type="date"></td>
      <td class="wide"><input data-l="tech" type="text"></td>
      <td><input data-l="qty" type="number" min="0" step="1" size="5"></td>
      <td><select data-l="type">${LABOR_TYPES.map((t) => `<option>${t}</option>`).join("")}</select></td>
      <td><input data-l="serial" type="text"></td>
      <td><input data-l="model" type="text"></td>
      <td><input data-l="equip" type="text"></td>
      <td class="break-cell"><input data-l="lunchOn" type="checkbox" title="Lunch / break taken during this time"></td>
    </tr>
    <tr class="lunch-row" hidden>
      <td colspan="8" class="lunch-td">Lunch / break:
        <input data-l="lunchStart" type="time"> to <input data-l="lunchEnd" type="time">
        <span class="lunch-note">— deducted from Qty automatically</span>
      </td>
    </tr>`);
  }
  const partsBody = $("parts-table").querySelector("tbody");
  partsBody.innerHTML = "";
  for (let i = 0; i < PARTS_ROWS; i++) {
    partsBody.insertAdjacentHTML("beforeend", `<tr>
      <td><input data-p="date" type="date"></td>
      <td class="wide"><input data-p="desc" type="text"></td>
      <td><input data-p="qty" type="text" size="4"></td>
      <td><input data-p="partno" type="text"></td>
      <td><input data-p="serial" type="text"></td>
      <td><input data-p="equip" type="text"></td>
    </tr>`);
  }
}

/* ----- labor row lunch/qty logic -----
   Each labor row keeps a "gross" minute count in dataset.gross.
   Displayed Qty = gross - lunch minutes. Manual Qty edits are taken as the
   value the tech wants displayed right now, so gross = typed + current lunch. */

function laborRowEls(tr) {
  const get = (k) => tr.querySelector(`[data-l="${k}"]`);
  return { qty: get("qty"), lunchOn: get("lunchOn"),
           lunchStart: tr.nextElementSibling.querySelector('[data-l="lunchStart"]'),
           lunchEnd: tr.nextElementSibling.querySelector('[data-l="lunchEnd"]') };
}

function lunchMinutes(tr) {
  const { lunchOn, lunchStart, lunchEnd } = laborRowEls(tr);
  if (!lunchOn.checked) return 0;
  return minutesBetween(lunchStart.value, lunchEnd.value) || 0;
}

function recomputeRowQty(tr) {
  const { qty } = laborRowEls(tr);
  if (tr.dataset.gross === undefined || tr.dataset.gross === "") return;
  qty.value = Math.max(0, +tr.dataset.gross - lunchMinutes(tr));
}

function setRowGross(tr, minutes) {
  tr.dataset.gross = minutes;
  recomputeRowQty(tr);
}

function initLaborEvents() {
  const tbody = $("labor-table").querySelector("tbody");
  tbody.addEventListener("change", (e) => {
    const key = e.target.dataset.l;
    if (key === "lunchOn") {
      const tr = e.target.closest("tr");
      tr.nextElementSibling.hidden = !e.target.checked;
      recomputeRowQty(tr);
    } else if (key === "lunchStart" || key === "lunchEnd") {
      const tr = e.target.closest("tr").previousElementSibling;
      recomputeRowQty(tr);
    }
  });
  tbody.addEventListener("input", (e) => {
    if (e.target.dataset.l === "qty") {
      const tr = e.target.closest("tr");
      tr.dataset.gross = (+e.target.value || 0) + lunchMinutes(tr);
    }
  });
}

/* ----- timer buttons ----- */

function firstEmptyLaborRow() {
  for (const tr of document.querySelectorAll("#labor-table tbody tr.labor-row")) {
    const { qty } = laborRowEls(tr);
    const type = tr.querySelector('[data-l="type"]').value;
    if (!qty.value && !type) return tr;
  }
  return null;
}

function addLaborLine(type, minutes, autoKind) {
  const tr = firstEmptyLaborRow();
  if (!tr) { alert("All 5 labor rows are full."); return null; }
  tr.querySelector('[data-l="date"]').value = todayIso();
  tr.querySelector('[data-l="tech"]').value = getTechName();
  tr.querySelector('[data-l="type"]').value = type;
  if (autoKind) tr.dataset.auto = autoKind;
  setRowGross(tr, minutes);
  return tr;
}

/* Keep the auto-calculated labor rows in sync with the header times.
   Manual edits to Travel Start / On-Site Start / Off-Site End recompute
   the tagged rows (creating them once both ends are set); lunch/break
   deductions are preserved because only the gross is updated. */
function syncAutoRows() {
  const defs = [
    { kind: "travel", type: "Travel to Site", start: $("f-travelstart").value, end: $("f-onsitestart").value },
    { kind: "onsite", type: "Onsite Labor", start: $("f-onsitestart").value, end: $("f-offsiteend").value },
    { kind: "toshop", type: "Travel to Shop", start: $("f-homestart").value, end: $("f-homeend").value },
  ];
  const result = {};
  for (const d of defs) {
    const mins = minutesBetween(d.start, d.end);
    let tr = document.querySelector(`#labor-table tr.labor-row[data-auto="${d.kind}"]`);
    if (mins === null) continue;
    if (!tr) tr = addLaborLine(d.type, mins, d.kind);
    else setRowGross(tr, mins);
    result[d.kind] = mins;
  }
  return result;
}

function flashStatus(msg) {
  const s = $("wo-status");
  s.className = "status ok";
  s.textContent = msg;
}

/* Show only the buttons that make sense for the current state:
   each Start hides once its time is set and the matching End appears. */
function updateTimerButtons() {
  const travel = $("f-travelstart").value, arrived = $("f-onsitestart").value;
  const jobEnd = $("f-offsiteend").value, home = $("f-homestart").value, homeEnd = $("f-homeend").value;
  $("btn-travel-start").hidden = !!travel || !!arrived;
  $("btn-travel-end").hidden = !travel || !!arrived;
  $("btn-job-start").hidden = !!arrived;
  $("btn-job-end").hidden = !arrived || !!jobEnd;
  $("btn-home-start").hidden = !jobEnd || !!home;
  $("btn-home-end").hidden = !home || !!homeEnd;
}

function initTimerButtons() {
  document.querySelectorAll(".now-btn").forEach((b) =>
    b.addEventListener("click", () => {
      $(b.dataset.now).value = nowHHMM();
      syncAutoRows();
      updateTimerButtons();
    }));

  // manual edits to the header times recompute the auto labor rows
  for (const id of ["f-travelstart", "f-onsitestart", "f-offsiteend", "f-homestart", "f-homeend"])
    $(id).addEventListener("change", () => { syncAutoRows(); updateTimerButtons(); });

  // 1-way miles -> Mileage labor row
  $("f-miles").addEventListener("change", () => {
    const miles = +$("f-miles").value || 0;
    let tr = document.querySelector('#labor-table tr.labor-row[data-auto="mileage"]');
    if (!miles && !tr) return;
    if (!tr) tr = addLaborLine("Mileage", miles, "mileage");
    else setRowGross(tr, miles);
  });

  $("btn-travel-start").addEventListener("click", () => {
    $("f-travelstart").value = nowHHMM();
    syncAutoRows();
    updateTimerButtons();
    flashStatus("Travel started " + nowHHMM());
  });

  $("btn-travel-end").addEventListener("click", () => {
    const now = nowHHMM();
    $("f-onsitestart").value = now;
    const mins = syncAutoRows().travel;
    updateTimerButtons();
    flashStatus(mins !== undefined
      ? `Arrived ${now} — ${mins} min travel in Labor. Job clock running.`
      : `Arrived ${now} — no Travel Start set, job clock running.`);
  });

  $("btn-job-start").addEventListener("click", () => {
    const now = nowHHMM();
    $("f-onsitestart").value = now;
    syncAutoRows();
    updateTimerButtons();
    flashStatus("Job started " + now);
  });

  $("btn-job-end").addEventListener("click", () => {
    const now = nowHHMM();
    $("f-offsiteend").value = now;
    const mins = syncAutoRows().onsite;
    updateTimerButtons();
    flashStatus(mins !== undefined
      ? `Job ended ${now} — ${mins} min labor in Labor. Check the row's Break box if you took lunch.`
      : `Job ended ${now} — no start time set, add labor minutes manually.`);
  });

  $("btn-home-start").addEventListener("click", () => {
    $("f-homestart").value = nowHHMM();
    syncAutoRows();
    updateTimerButtons();
    flashStatus("Travel home started " + nowHHMM());
  });

  $("btn-home-end").addEventListener("click", () => {
    const now = nowHHMM();
    $("f-homeend").value = now;
    const mins = syncAutoRows().toshop;
    updateTimerButtons();
    flashStatus(mins !== undefined
      ? `Travel home ended ${now} — ${mins} min Travel to Shop in Labor.`
      : `Travel home ended ${now}.`);
  });
}

/* ----- defaults ----- */

function applyDefaults() {
  $("f-date").value = todayIso();
  $("f-tech").value = getTechName();
  document.querySelectorAll('#labor-table [data-l="date"], #parts-table [data-p="date"]')
    .forEach((el) => { el.value = todayIso(); });
  document.querySelectorAll('#labor-table [data-l="tech"]')
    .forEach((el) => { el.value = getTechName(); });
}

function initForm() {
  if (initForm.done) return;
  initForm.done = true;
  buildRows();
  initLaborEvents();
  initTimerButtons();
  setupAutocomplete("cust-search", "cust-list", onCustomerPicked, onCustomerCleared);
  setupAutocomplete("notes-cust-search", "notes-cust-list", onNotesCustomerPicked);
  setupSitePicker();
  $("f-tech").addEventListener("input", () => {
    localStorage.setItem("kwoTech", $("f-tech").value.trim());
  });
  applyDefaults();
  updateTimerButtons();
}

/* ================= collect / restore form state ================= */

function rowValues(table, attr) {
  return [...$(table).querySelectorAll(`tbody tr${attr === "l" ? ".labor-row" : ""}`)].map((tr) => {
    const row = {};
    tr.querySelectorAll(`[data-${attr}]`).forEach((el) => {
      row[el.dataset[attr]] = el.type === "checkbox" ? el.checked : el.value;
    });
    if (attr === "l") {
      const next = tr.nextElementSibling;
      next.querySelectorAll("[data-l]").forEach((el) => { row[el.dataset.l] = el.value; });
      row.gross = tr.dataset.gross || "";
      row.auto = tr.dataset.auto || "";
    }
    return row;
  });
}

function collectForm() {
  return {
    customerId: selectedCustomer?.id || "",
    customerName: selectedCustomer?.name || $("f-sitename").value,
    date: $("f-date").value,
    tech: $("f-tech").value,
    wonum: $("f-wonum").value,
    po: $("f-po").value,
    calltype: $("f-calltype").value,
    agreement: $("f-agreement").value,
    travelStart: $("f-travelstart").value,
    onsiteStart: $("f-onsitestart").value,
    offsiteEnd: $("f-offsiteend").value,
    homeStart: $("f-homestart").value,
    homeEnd: $("f-homeend").value,
    miles: $("f-miles").value,
    reason: $("f-reason").value,
    site: {
      name: $("f-sitename").value, address: $("f-siteaddress").value,
      city: $("f-sitecity").value, state: $("f-sitestate").value, zip: $("f-sitezip").value,
    },
    worknotes: $("f-worknotes").value,
    labor: rowValues("labor-table", "l"),
    parts: rowValues("parts-table", "p"),
    returnTrip: $("f-returntrip").value,
    supportTech: $("f-supporttech").value,
    warranty: $("f-warranty").value,
    billingNotes: $("f-billingnotes").value,
    authorizedBy: $("f-authorizedby").value,
  };
}

function restoreForm(wo) {
  clearForm();
  if (wo.customerId && CUST_BY_ID[wo.customerId]) {
    $("cust-search").value = CUST_BY_ID[wo.customerId];
    onCustomerPicked({ id: wo.customerId, name: CUST_BY_ID[wo.customerId] });
  }
  $("f-date").value = wo.date || todayIso();
  $("f-tech").value = wo.tech || getTechName();
  $("f-wonum").value = wo.wonum || "";
  $("f-po").value = wo.po || "";
  $("f-calltype").value = wo.calltype || "";
  $("f-agreement").value = wo.agreement || "";
  $("f-travelstart").value = wo.travelStart || "";
  $("f-onsitestart").value = wo.onsiteStart || "";
  $("f-offsiteend").value = wo.offsiteEnd || "";
  $("f-homestart").value = wo.homeStart || "";
  $("f-homeend").value = wo.homeEnd || "";
  $("f-miles").value = wo.miles || "";
  updateTimerButtons();
  $("f-reason").value = wo.reason || "";
  if (wo.site) {
    $("f-sitename").value = wo.site.name || "";
    $("f-siteaddress").value = wo.site.address || "";
    $("f-sitecity").value = wo.site.city || "";
    $("f-sitestate").value = wo.site.state || "";
    $("f-sitezip").value = wo.site.zip || "";
    if (wo.site.name) $("site-search").value = wo.site.name + (wo.site.city ? " — " + wo.site.city : "");
  }
  $("f-worknotes").value = wo.worknotes || "";
  [...document.querySelectorAll("#labor-table tbody tr.labor-row")].forEach((tr, i) => {
    const row = wo.labor?.[i];
    if (!row) return;
    tr.querySelectorAll("[data-l]").forEach((el) => {
      const v = row[el.dataset.l];
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = v || "";
    });
    const next = tr.nextElementSibling;
    next.querySelectorAll("[data-l]").forEach((el) => { el.value = row[el.dataset.l] || ""; });
    next.hidden = !row.lunchOn;
    tr.dataset.gross = row.gross || "";
    if (row.auto) tr.dataset.auto = row.auto; else delete tr.dataset.auto;
  });
  [...document.querySelectorAll("#parts-table tbody tr")].forEach((tr, i) => {
    const row = wo.parts?.[i];
    if (!row) return;
    tr.querySelectorAll("[data-p]").forEach((el) => { el.value = row[el.dataset.p] || ""; });
  });
  $("f-returntrip").value = wo.returnTrip || "";
  $("f-supporttech").value = wo.supportTech || "";
  $("f-warranty").value = wo.warranty || "";
  $("f-billingnotes").value = wo.billingNotes || "";
  $("f-authorizedby").value = wo.authorizedBy || "";
}

function clearForm() {
  $("wo-form").reset();
  onCustomerCleared();
  editingHistoryId = null;
  document.querySelectorAll("#labor-table tbody tr.lunch-row").forEach((tr) => { tr.hidden = true; });
  document.querySelectorAll("#labor-table tbody tr.labor-row").forEach((tr) => {
    tr.dataset.gross = "";
    delete tr.dataset.auto;
  });
  applyDefaults();
  updateTimerButtons();
  $("wo-status").textContent = "";
  $("wo-status").className = "status";
}

$("clear-form-btn").addEventListener("click", () => {
  if (confirm("Clear the entire form?")) clearForm();
});

// Enter must never submit the form (generate the PDF) from a field —
// it belongs to autocomplete pick / moving on, not "I'm done".
$("wo-form").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && e.target.type !== "submit")
    e.preventDefault();
});

/* ================= PDF generation ================= */

function usDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function setText(form, name, value) {
  if (!value) return;
  try {
    const field = form.getTextField(name);
    field.disableReadOnly();
    field.setText(String(value));
  } catch (err) {
    console.warn("field", name, err.message);
  }
}

function setDropdown(form, name, value) {
  if (!value) return;
  try {
    const dd = form.getDropdown(name);
    if (dd.getOptions().includes(value)) dd.select(value);
  } catch (err) {
    console.warn("dropdown", name, err.message);
  }
}

const laborRowHasContent = (r) => r.qty || r.type || r.serial || r.model || r.equip;
const partsRowHasContent = (r) => r.desc || r.qty || r.partno || r.serial || r.equip;

async function generatePdf(wo) {
  const { PDFDocument } = PDFLib;
  const tpl = await fetch("template.pdf").then((r) => r.arrayBuffer());
  const doc = await PDFDocument.load(tpl);
  const form = doc.getForm();

  // The template flags some text fields as rich text (Problemdescription,
  // Worknotes); pdf-lib refuses to read those during appearance updates.
  // Clear the RichText flag (bit 26) on every field up front.
  for (const f of form.getFields()) {
    try { f.acroField.setFlagTo(1 << 25, false); } catch {}
  }

  setText(form, "Currentdate", usDate(wo.date));
  setText(form, "Workorder", wo.wonum);
  setText(form, "Servicetech", wo.tech);
  setText(form, "Custpo", wo.po);
  setText(form, "Calltype", wo.calltype);
  setText(form, "Serviceagreement", wo.agreement);
  setText(form, "Timetravel", wo.travelStart);
  setText(form, "Starttime", wo.onsiteStart);
  setText(form, "Timedone", wo.offsiteEnd);
  setText(form, "Problemdescription", wo.reason);

  // Bill To intentionally left blank — billing department fills it in.
  setText(form, "Name", wo.site.name);
  setText(form, "Address", wo.site.address);
  setText(form, "City", wo.site.city);
  setText(form, "State", wo.site.state);
  setText(form, "Zip", wo.site.zip);

  try { form.getTextField("Worknotes").setFontSize(9); } catch {}
  setText(form, "Worknotes", wo.worknotes);

  let n = 0;
  for (const row of wo.labor) {
    if (!laborRowHasContent(row) || n >= LABOR_ROWS) continue;
    n += 1;
    setText(form, `Date${n}1`, usDate(row.date));
    setText(form, `Tech${n}`, row.tech);
    setText(form, `Hours${n}1`, row.qty);
    setText(form, `Repair${n}1`, row.type);
    setText(form, `Lserial${n}1`, row.serial);
    setText(form, `Lmodel${n}1`, row.model);
    setText(form, `Lequiptype${n}1`, row.equip);
  }

  // Parts columns by position: Part{n}=Description, Rserial{n}1=Part No.,
  // Rmodel{n}1=Serial No., Requipmenttype{n}=Equip. Type (template names are misleading).
  n = 0;
  for (const row of wo.parts) {
    if (!partsRowHasContent(row) || n >= PARTS_ROWS) continue;
    n += 1;
    setText(form, `RDate${n}`, usDate(row.date));
    setText(form, `Part${n}`, row.desc);
    setText(form, `Qty${n}`, row.qty);
    setText(form, `Rserial${n}1`, row.partno);
    setText(form, `Rmodel${n}1`, row.serial);
    setText(form, `Requipmenttype${n}`, row.equip);
  }

  setDropdown(form, "Dropdown6", wo.returnTrip);
  setDropdown(form, "A9", wo.supportTech);
  setDropdown(form, "zz2", wo.warranty);
  setText(form, "Text2", wo.billingNotes);
  setText(form, "Authorizedby", wo.authorizedBy);

  form.updateFieldAppearances();
  return doc.save();
}

function fileSafe(s) {
  return String(s || "").replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
}

// CustomerName Location-Address CustomerPO# MM-DD-YYYY.pdf
function woFilename(wo) {
  const [y, m, d] = (wo.date || todayIso()).split("-");
  const parts = [
    fileSafe(wo.customerName).slice(0, 50),
    fileSafe(wo.site.address).slice(0, 50),
    fileSafe(wo.po).slice(0, 25),
    `${m}-${d}-${y}`,
  ].filter(Boolean);
  return parts.join(" ") + ".pdf";
}

$("wo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("wo-status");
  const btn = $("generate-btn");
  btn.disabled = true;
  status.className = "status";
  status.textContent = "Generating PDF…";
  try {
    const wo = collectForm();
    const pdfBytes = await generatePdf(wo);
    const filename = woFilename(wo);

    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);

    await saveWorkOrder(wo, filename);
    status.className = "status ok";
    status.textContent = `Saved & downloaded ${filename}. Attach it to an email to the office.` +
      (wo.returnTrip === "Yes" ? " Return trip: use History → Start return trip when you go back." : "");
  } catch (err) {
    console.error(err);
    status.className = "status err";
    status.textContent = "Failed: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ================= IndexedDB history ================= */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("wo-forms", 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("workorders", { keyPath: "id", autoIncrement: true });
      store.createIndex("customerId", "wo.customerId");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveWorkOrder(wo, filename) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("workorders", "readwrite");
    const record = { wo, filename, savedAt: new Date().toISOString() };
    if (editingHistoryId != null) record.id = editingHistoryId;
    tx.objectStore("workorders").put(record);
    tx.oncomplete = () => { editingHistoryId = null; resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllWorkOrders() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("workorders").objectStore("workorders").getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
    req.onerror = () => reject(req.error);
  });
}

async function deleteWorkOrder(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("workorders", "readwrite");
    tx.objectStore("workorders").delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function renderHistory() {
  const list = $("history-list");
  const records = await getAllWorkOrders();
  if (!records.length) {
    list.innerHTML = "<p class='hint'>Nothing saved on this device yet.</p>";
    return;
  }
  list.innerHTML = records.map((r) => `
    <div class="hist-card" data-id="${r.id}">
      <div class="hist-main">
        <div class="hist-title">${escapeHtml(r.wo.customerName || "Unknown customer")}${r.wo.returnTrip === "Yes" ? " <span class='badge local'>return trip needed</span>" : ""}</div>
        <div class="hist-sub">${escapeHtml(r.wo.date || "")} · ${escapeHtml(r.wo.tech || "no tech")} · saved ${escapeHtml(r.savedAt.slice(0, 16).replace("T", " "))}</div>
      </div>
      <button data-act="open">Open</button>
      <button data-act="return">Start return trip</button>
      <button data-act="delete" class="danger">Delete</button>
    </div>`).join("");
}

$("history-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = +btn.closest(".hist-card").dataset.id;
  const records = await getAllWorkOrders();
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  const act = btn.dataset.act;
  if (act === "delete") {
    if (confirm("Delete this saved work order from this device?")) {
      await deleteWorkOrder(id);
      renderHistory();
    }
    return;
  }
  restoreForm(rec.wo);
  if (act === "open") {
    editingHistoryId = id;
  } else if (act === "return") {
    // return-trip: keep customer/site/header context, clear the work + times
    editingHistoryId = null;
    $("f-date").value = todayIso();
    $("f-worknotes").value = "";
    $("f-reason").value = "Return trip: " + (rec.wo.reason || "");
    $("f-travelstart").value = $("f-onsitestart").value = $("f-offsiteend").value = "";
    $("f-homestart").value = $("f-homeend").value = "";
    updateTimerButtons();
    // same site, same drive — recreate the Mileage row from the kept miles value
    $("f-miles").dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelectorAll("#labor-table tbody tr.labor-row").forEach((tr) => {
      tr.querySelectorAll("input, select").forEach((el) => {
        if (el.type === "checkbox") el.checked = false;
        else el.value = el.dataset.l === "date" ? todayIso() : el.dataset.l === "tech" ? getTechName() : "";
      });
      tr.dataset.gross = "";
      delete tr.dataset.auto;
      tr.nextElementSibling.hidden = true;
      tr.nextElementSibling.querySelectorAll("input").forEach((el) => { el.value = ""; });
    });
    document.querySelectorAll("#parts-table tbody input").forEach((el) => {
      el.value = el.dataset.p === "date" ? todayIso() : "";
    });
    $("f-returntrip").value = "";
    $("f-authorizedby").value = "";
    flashStatus("Return trip loaded — customer, site and reason carried over. Hit Travel Start when you leave.");
  }
  document.querySelector('.tab[data-tab="wo"]').click();
  window.scrollTo(0, 0);
});

$("export-json").addEventListener("click", async () => {
  const records = await getAllWorkOrders();
  const blob = new Blob([JSON.stringify(records, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wo-export-${todayIso()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
});

/* ================= work notes ================= */

function noteCard(n, local) {
  const badge = local ? "<span class='badge local'>this device</span>" : "";
  const long = (n.t || "").length > 300 || (n.t || "").split("\n").length > 4;
  return `<div class="note-card">
    <div class="note-head"><span class="nd">${escapeHtml(n.d)}</span>
      ${n.l ? `<span>Site ${escapeHtml(n.l)}</span>` : ""}${badge}</div>
    ${n.de ? `<div class="note-desc">${escapeHtml(n.de)}</div>` : ""}
    ${n.t ? `<div class="note-text${long ? " clamp" : ""}">${escapeHtml(n.t)}</div>` : ""}
    ${long ? "<button class='note-more'>Show more</button>" : ""}
  </div>`;
}

document.addEventListener("click", (e) => {
  if (e.target.classList?.contains("note-more")) {
    const text = e.target.previousElementSibling;
    const clamped = text.classList.toggle("clamp");
    e.target.textContent = clamped ? "Show more" : "Show less";
  }
});

async function notesFor(custId, loc) {
  const bundled = DATA.notes.filter((n) => n.c === custId && (!loc || n.l === loc));
  const locals = (await getAllWorkOrders())
    .filter((r) => r.wo.customerId === custId)
    .map((r) => ({
      d: r.wo.date || r.savedAt.slice(0, 10),
      l: "", ap: r.wo.wonum || r.filename,
      de: r.wo.reason, t: r.wo.worknotes, local: true,
    }));
  return { bundled, locals };
}

async function renderNotes() {
  if (!notesCustomer) return;
  const loc = $("notes-site-select").value;
  const { bundled, locals } = await notesFor(notesCustomer.id, loc);
  $("notes-summary").textContent =
    `${bundled.length} notes (last ${DATA.months} months)` + (locals.length ? ` + ${locals.length} from this device` : "");
  $("notes-list").innerHTML =
    locals.map((n) => noteCard(n, true)).join("") +
    bundled.map((n) => noteCard(n, false)).join("") ||
    "<p class='hint'>No notes found.</p>";
}

function onNotesCustomerPicked(c) {
  notesCustomer = c;
  const sel = $("notes-site-select");
  sel.innerHTML = "<option value=''>All sites</option>";
  for (const s of SITE_INDEX[c.id] || []) {
    const opt = document.createElement("option");
    opt.value = s.l;
    opt.textContent = siteLabel(s);
    sel.appendChild(opt);
  }
  renderNotes();
}

$("notes-site-select").addEventListener("change", renderNotes);

/* quick view from the WO tab */
$("show-recent-notes").addEventListener("click", async () => {
  if (!selectedCustomer) { alert("Pick a customer first."); return; }
  const { bundled, locals } = await notesFor(selectedCustomer.id, "");
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `<div class="modal">
    <button class="modal-close">✕</button>
    <h3>Recent notes — ${escapeHtml(selectedCustomer.name)}</h3>
    ${locals.map((n) => noteCard(n, true)).join("")}
    ${bundled.map((n) => noteCard(n, false)).join("") || "<p class='hint'>No notes in the bundle.</p>"}
  </div>`;
  back.addEventListener("click", (e) => {
    if (e.target === back || e.target.classList.contains("modal-close")) back.remove();
  });
  document.body.appendChild(back);
});
