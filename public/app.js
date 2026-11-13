/* app.js — IT Ticket System frontend (vanilla JS, talks to the Flask API) */

const state = {
  user: null,
  branches: [],
  categories: [], priorities: [], statuses: [],
  tab: "dashboard",
  itStaff: [],
};

// ---------------------------------------------------------------- API helper

async function api(path, { method = "GET", body, formData, keepalive = false } = {}, btn = null) {
  if (btn) setBtnLoading(btn, true);
  try {
    const opts = { method, credentials: "same-origin" };
    if (keepalive) opts.keepalive = true; // let this request finish even if the
    // page is about to navigate away/unload (logout, reload, tab close) right
    // after it fires - otherwise a fire-and-forget call like a notification
    // "mark seen" can get silently cancelled mid-flight, and the count comes
    // right back next time the page loads (see markNotifSeen / goTab below).
    if (formData) {
      opts.body = formData;
    } else if (body !== undefined) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api${path}`, opts);
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* non-json response */ }
    if (!res.ok) {
      const msg = (data && data.error) || (raw && raw.slice(0, 200)) || `Request failed (${res.status})`;
      const err = new Error(msg);
      if (data && data.code) err.code = data.code;
      // The account was marked unavailable mid-session (a direct Super
      // Admin lock, or an approved 'field' request - see server.js's
      // requireLogin) - the server already ended the session, so force the
      // same "back to the login screen" flow as an idle timeout instead of
      // just letting this bubble up as a one-off error toast; every other
      // in-flight/queued request will hit the same 401 and no-op against
      // the guard in forceLogoutUnavailable.
      if (data && data.code === "account_unavailable") {
        forceLogoutUnavailable(msg);
      }
      throw err;
    }
    return data;
  } finally {
    if (btn) setBtnLoading(btn, false);
  }
}

/** Show/hide a spinner on an action button while its async work is in
 * flight - pass `btn` as api()'s third argument to get this automatically.
 * Disables the button (so it can't be clicked twice) and swaps its label
 * for a spinner, restoring the original label when loading ends. Safe to
 * call redundantly (e.g. loading=false on a button that was never set
 * loading). */
function setBtnLoading(btn, loading) {
  if (!btn) return;
  if (loading) {
    if (btn.dataset.loading === "1") return;
    btn.dataset.loading = "1";
    btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span>${btn.dataset.originalHtml}`;
  } else {
    if (btn.dataset.loading !== "1") return;
    btn.dataset.loading = "";
    btn.disabled = false;
    if (btn.dataset.originalHtml !== undefined) btn.innerHTML = btn.dataset.originalHtml;
  }
}

// ---------------------------------------------------------------- device identity
// Used only by the Branch Staff login-approval gate (see server's
// /api/login): a random id generated once per browser and kept in
// localStorage so the same device is recognized across future logins,
// plus a human-readable label (browser/OS, phone vs desktop) shown to
// whoever reviews the approval - it carries no security weight itself.

function getDeviceId() {
  let id = localStorage.getItem("td_device_id");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    localStorage.setItem("td_device_id", id);
  }
  return id;
}

// "Desktop" / "Phone" / "Tablet", used both in getDeviceLabel() below and
// sent as its own device_kind field on login (see /api/login) so the Super
// Admin-only Attendance panel can filter/group by device type without
// re-parsing the free-text label.
function getDeviceKind() {
  const ua = navigator.userAgent || "";
  const isPhone = /iPhone|Android.*Mobile|Windows Phone/i.test(ua);
  const isTablet = !isPhone && /iPad|Android/i.test(ua);
  return isPhone ? "Phone" : isTablet ? "Tablet" : "Desktop";
}

function getDeviceLabel() {
  const ua = navigator.userAgent || "";
  const kind = getDeviceKind();
  let browser = "Browser";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Safari\//.test(ua)) browser = "Safari";
  let os = "";
  if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iOS/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";
  return `${browser}${os ? " on " + os : ""} (${kind})`;
}

function toast(message, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---------------------------------------------------------------- big new-ticket alert popup
// A large, centered popup for brand new ticket assignments - a third,
// harder-to-miss layer on top of the OS-level desktop push (sw.js, the
// only one of the three that still fires with every Ticket Desk tab fully
// closed) and the quieter toast/bell. Anyone with a tab open - even just
// sitting minimized or in the background - gets this the instant a new
// assignment lands: the service worker's postMessage listener below calls
// refreshNotifications() the moment a push arrives, and that poll is what
// drives this popup too (see the "tickets" branch in refreshNotifications).
// Auto-dismisses on its own after a few seconds; can also be closed early
// with the ✕, or clicked through straight to the ticket(s).
let _bigAlertTimer = null;
let _bigAlertShowing = false;
// Now that every growing category (not just new-ticket assignments) can
// trigger this popup, more than one can go off in the very same poll (e.g.
// a new memo AND a new ticket land together). There's only one popup
// element, so queue extras instead of the later call silently clobbering
// the earlier one - each gets shown in turn, one after another.
let _bigAlertQueue = [];
function showBigAlert(title, sub, onClick) {
  if (_bigAlertShowing) {
    _bigAlertQueue.push({ title, sub, onClick });
    return;
  }
  const el = document.getElementById("big-alert");
  if (!el) return;
  _bigAlertShowing = true;
  el.querySelector(".big-alert-title").textContent = title;
  el.querySelector(".big-alert-sub").textContent = sub || "";

  clearTimeout(_bigAlertTimer);
  el.classList.remove("hidden");
  el.classList.remove("big-alert-show");
  void el.offsetWidth; // restart the entrance animation if one's already showing
  el.classList.add("big-alert-show");

  const hide = () => {
    el.classList.remove("big-alert-show");
    clearTimeout(_bigAlertTimer);
    setTimeout(() => {
      el.classList.add("hidden"); // let the fade-out finish first
      _bigAlertShowing = false;
      const next = _bigAlertQueue.shift();
      if (next) showBigAlert(next.title, next.sub, next.onClick);
    }, 300);
  };
  el.querySelector(".big-alert-close").onclick = (e) => { e.stopPropagation(); hide(); };
  el.querySelector(".big-alert-card").onclick = () => { hide(); if (onClick) onClick(); };

  _bigAlertTimer = setTimeout(hide, 9000);
}

// ---------------------------------------------------------------- boot

document.addEventListener("DOMContentLoaded", boot);

// Real-time bell updates: sw.js posts this the instant a push notification
// arrives (an admin poking a ticket, a new assignment, a void/reopen
// decision, etc.) - independent of whether THIS tab is focused, minimized,
// or in the background. Registered once at load, before login, so it's
// already listening the moment enterApp() subscribes/is subscribed; the
// handler itself is cheap to call even if the panel isn't open (it's the
// same call the 5s poll already makes, just triggered early). Only fires
// for whoever actually enabled desktop notifications - see initPushUI -
// everyone else still gets the badge within one 5s poll, same as before.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "ticket-desk-push" && state.user) {
      refreshNotifications();
    }
  });
}

async function boot() {
  wireAuthScreen();
  try {
    const { user } = await api("/me");
    if (user) {
      state.user = user;
      await enterApp();
      handleNotificationLandingParams();
      return;
    }
  } catch (e) { /* ignore */ }
  showAuth();
}

/** Land on the right tab/ticket when we were opened from a notification
 * click. sw.js's notificationclick handler navigates the browser to the
 * URL that came in the push payload - and push.js/server.js already send
 * per-ticket links like "/?ticket=123" (a status change, void/reopen
 * decision, new assignment, etc.) or section links like "/?tab=itstaff"
 * (a pending approval) - but nothing used to read that back out once the
 * page reloaded, so clicking a desktop notification just dropped you on
 * the plain Dashboard and made you go find the ticket yourself. Now, a
 * "?ticket=" link switches to the Tickets tab AND opens that ticket's
 * detail modal directly; a "?tab=" link just switches tabs. Either way the
 * query string is stripped from the address bar right after, so a later
 * manual refresh of the page doesn't relaunch the same ticket/tab again. */
function handleNotificationLandingParams() {
  const params = new URLSearchParams(window.location.search);
  const ticketId = params.get("ticket");
  const tab = params.get("tab");
  if (!ticketId && !tab) return;

  if (ticketId) {
    goTab("tickets");
    // Same as the bell dropdown's ticketOnClick: opening the ticket is what
    // clears a poke server-side, so refresh the bell right after so the
    // badge doesn't keep showing a follow-up notification the person just
    // acted on by clicking it.
    openTicketDetail(ticketId)
      .then(refreshNotifications)
      .catch(e => toast(e.message, "error"));
  } else if (tab) {
    goTab(tab);
  }
  setSidebarOpen(false);

  window.history.replaceState({}, "", window.location.pathname);
}

function showAuth() {
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("app-shell").classList.add("hidden");
}

// ---------------------------------------------------------------- auth screen wiring

function wireAuthScreen() {
  document.getElementById("login-btn").onclick = doLogin;
  document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  // Show/hide password toggle
  const pwInput = document.getElementById("login-password");
  const pwToggle = document.getElementById("login-password-toggle");
  if (pwToggle) {
    pwToggle.onclick = () => {
      const show = pwInput.type === "password";
      pwInput.type = show ? "text" : "password";
      pwToggle.classList.toggle("showing", show);
      pwToggle.setAttribute("aria-pressed", String(show));
      const label = show ? "Hide password" : "Show password";
      pwToggle.setAttribute("aria-label", label);
      pwToggle.title = label;
      pwInput.focus();
    };
  }
}

// While a device sign-in approval is Pending, the login screen polls
// /api/login every few seconds (reusing the same username/password kept in
// memory here) so the branch device signs itself in the moment IT approves
// it, with no extra action needed on that screen. Cleared on success, on a
// terminal decline, or if the person navigates away from the login form.
let _devicePollTimer = null;
function stopDevicePoll() {
  if (_devicePollTimer) { clearInterval(_devicePollTimer); _devicePollTimer = null; }
}

async function doLogin() {
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errBox = document.getElementById("login-error");
  const loginBtn = document.getElementById("login-btn");
  stopDevicePoll();
  errBox.classList.add("hidden");
  errBox.innerHTML = "";
  if (!username || !password) {
    errBox.textContent = "Enter your username and password.";
    errBox.classList.remove("hidden");
    return;
  }
  setBtnLoading(loginBtn, true);
  try {
    await attemptLogin(username, password, errBox);
  } finally {
    // enterApp() (on success) swaps the whole screen away, so this is a
    // no-op then; on failure it restores the button for another attempt.
    setBtnLoading(loginBtn, false);
  }
}

// Not using the generic api() helper here: 403s for account_unavailable /
// device_pending / device_declined each need their own UI, not just an
// error string, so the raw response is inspected directly. `silent` is set
// for the background polling retries so a transient network hiccup doesn't
// blow away the "waiting for approval" message.
async function attemptLogin(username, password, errBox, { silent = false } = {}) {
  let res, data;
  try {
    res = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, device_id: getDeviceId(), device_label: getDeviceLabel(), device_kind: getDeviceKind() }),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    if (!silent) { errBox.textContent = "Could not reach the server."; errBox.classList.remove("hidden"); }
    return;
  }
  if (res.ok) {
    stopDevicePoll();
    state.user = data.user;
    await enterApp();
    return;
  }
  if (data && (data.account_unavailable || data.account_absent)) {
    stopDevicePoll();
    errBox.innerHTML = `<div>${escapeHtml(data.error)}</div>`;
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary btn-sm";
    btn.style.marginTop = "8px";
    btn.textContent = "Request approval from Super Admin";
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await api("/availability/request", { method: "POST", body: { username, password } }, btn);
        toast(r.message, "success");
      } catch (e) {
        toast(e.message, "error");
        btn.disabled = false;
      }
    };
    errBox.appendChild(btn);
    errBox.classList.remove("hidden");
    return;
  }
  if (data && data.device_pending) {
    errBox.innerHTML = `<div>🔒 This device isn't recognized yet. A request has been sent to IT — this page will sign you in automatically once it's approved.</div>`;
    errBox.classList.remove("hidden");
    if (!_devicePollTimer) {
      _devicePollTimer = setInterval(() => attemptLogin(username, password, errBox, { silent: true }), 5000);
    }
    return;
  }
  if (data && data.device_declined) {
    stopDevicePoll();
    errBox.innerHTML = `<div>🚫 ${escapeHtml(data.error)}</div>`;
    errBox.classList.remove("hidden");
    return;
  }
  stopDevicePoll();
  errBox.textContent = (data && data.error) || "Invalid username or password.";
  errBox.classList.remove("hidden");
}

// ---------------------------------------------------------------- app shell

async function enterApp() {
  _forcedLogoutInProgress = false;
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");

  const meta = await api("/categories");
  state.categories = meta.categories; state.priorities = meta.priorities; state.statuses = meta.statuses;
  const br = await api("/branches");
  state.branches = br.branches;
  const dept = await api("/departments");
  state.departments = dept.departments;

  document.getElementById("user-name").textContent = state.user.full_name;
  document.getElementById("user-role").textContent = state.user.role + (state.user.branch ? ` · ${state.user.branch}` : "");
  document.getElementById("user-avatar").textContent = state.user.full_name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  document.getElementById("logout-btn").onclick = doLogout;

  initMobileNav();
  buildNav();
  goTab(defaultTabForRole(state.user.role));
  initPushUI();
  startIdleAutoLogout();
  startClock();
}

// ---------------------------------------------------------------- live clock (topbar)
// A small "actual" date/time readout next to the page title - lives in the
// topbar (not view-root), so it's unaffected by tab switches and only ever
// needs to be started once per session, right alongside the other
// once-per-login setup above.
function startClock() {
  const el = document.getElementById("live-clock");
  if (!el) return;
  const tick = () => {
    const now = new Date();
    el.textContent = "🕒 " + now.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " · " + now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------- mobile nav drawer
// Below 860px (see styles.css), .sidebar is an off-canvas drawer instead of
// a fixed column. menu-toggle-btn (only visible at that width) slides it
// in; tapping the backdrop, picking a tab, or resizing back to desktop
// width all close it again.

function setSidebarOpen(open) {
  document.getElementById("sidebar").classList.toggle("open", open);
  document.getElementById("sidebar-backdrop").classList.toggle("show", open);
  document.getElementById("menu-toggle-btn").classList.toggle("open", open);
  document.getElementById("menu-toggle-btn").setAttribute("aria-expanded", open ? "true" : "false");
}

function initMobileNav() {
  document.getElementById("menu-toggle-btn").onclick = () => {
    setSidebarOpen(!document.getElementById("sidebar").classList.contains("open"));
  };
  document.getElementById("sidebar-close-btn").onclick = () => setSidebarOpen(false);
  document.getElementById("sidebar-backdrop").onclick = () => setSidebarOpen(false);
  window.addEventListener("resize", () => {
    if (window.innerWidth > 860) setSidebarOpen(false);
  });
}

// ---------------------------------------------------------------- desktop push notifications
// Only IT Department / Super Admin accounts ever get tickets assigned to
// them, so only they see the toggle. Real push (delivered even with the
// tab/browser closed) needs: a registered service worker (sw.js), the
// user's one-time permission grant, and a PushSubscription handed to our
// server (see server.js's /api/push/* routes and push.js).

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window;
}

async function getExistingPushSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function subscribePush() {
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    toast("Notifications were blocked - enable them in your browser's site settings to turn this on.", "error");
    return false;
  }

  const { public_key } = await api("/push/public-key");
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(public_key),
  });
  await api("/push/subscribe", { method: "POST", body: { subscription: subscription.toJSON() } });
  return true;
}

async function unsubscribePush() {
  const sub = await getExistingPushSubscription();
  if (sub) {
    await api("/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
  }
}

async function initPushUI() {
  const btn = document.getElementById("notify-toggle-btn");
  if (!["IT Department", "Super Admin"].includes(state.user.role) || !pushSupported()) {
    btn.classList.add("hidden");
    return;
  }
  btn.classList.remove("hidden");

  const refreshLabel = async () => {
    const sub = Notification.permission === "granted" ? await getExistingPushSubscription() : null;
    btn.textContent = sub ? "Disable notifications" : "Enable notifications";
  };

  try {
    await navigator.serviceWorker.register("/sw.js");
    await refreshLabel();
  } catch (e) { /* service worker registration failed (e.g. not served over https) - leave the button as-is */ }

  btn.onclick = async () => {
    setBtnLoading(btn, true);
    try {
      const sub = Notification.permission === "granted" ? await getExistingPushSubscription() : null;
      if (sub) {
        await unsubscribePush();
        toast("Desktop notifications turned off.", "success");
      } else {
        const ok = await subscribePush();
        if (ok) toast("Desktop notifications enabled.", "success");
      }
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBtnLoading(btn, false);
      await refreshLabel();
    }
  };
}

// Mid-session forced logout when this account gets marked unavailable
// (directly by a Super Admin, or by them approving a 'field' request - see
// server.js's requireLogin). Triggered from api()'s account_unavailable
// check above - guarded so a burst of in-flight requests that all hit the
// same 401 (e.g. the notification poll plus a click) only run this once.
let _forcedLogoutInProgress = false;
async function forceLogoutUnavailable(message) {
  if (_forcedLogoutInProgress || !state.user) return;
  _forcedLogoutInProgress = true;
  stopIdleAutoLogout();
  stopNotifPolling();
  state.user = null;
  showAuth();
  const errBox = document.getElementById("login-error");
  if (errBox) {
    errBox.textContent = message || "Your account has been marked unavailable. Sign in again once a Super Admin restores access.";
    errBox.classList.remove("hidden");
  }
  // Best-effort - the server already deleted the session row itself (see
  // requireLogin), this just clears the now-stale cookie client-side too.
  try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); } catch (e) {}
}

async function doLogout() {
  stopIdleAutoLogout();
  stopNotifPolling();
  await api("/logout", { method: "POST" });
  state.user = null;
  location.reload();
}

// ---------------------------------------------------------------- inactivity auto-logout
// After IDLE_LIMIT_MS with no mouse/keyboard/touch activity anywhere on the
// page, the session is ended automatically - mainly for shared branch
// computers, so a ticket queue left open at a counter doesn't stay signed
// in indefinitely. Runs for every logged-in role, not just Branch Staff,
// since any account left open on a shared machine is the same risk.
const IDLE_LIMIT_MS = 15 * 60 * 1000;
const IDLE_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"];
let idleTimer = null;

function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(handleIdleTimeout, IDLE_LIMIT_MS);
}

async function handleIdleTimeout() {
  stopIdleAutoLogout();
  stopNotifPolling();
  try { await api("/logout", { method: "POST" }); } catch (e) { /* best effort - show the login screen either way */ }
  state.user = null;
  showAuth();
  const errBox = document.getElementById("login-error");
  errBox.textContent = "You were signed out after 15 minutes of inactivity.";
  errBox.classList.remove("hidden");
}

/** Starts the idle-logout watch - called once from enterApp() after a
 * successful sign-in. Safe to call more than once (e.g. across
 * boot()/enterApp() calls in the same page load); it won't double-attach
 * listeners. */
function startIdleAutoLogout() {
  if (idleTimer !== null) return; // already running
  IDLE_EVENTS.forEach((evt) => document.addEventListener(evt, resetIdleTimer, { passive: true }));
  resetIdleTimer();
}

/** Stops the idle-logout watch and removes its listeners - called on
 * logout (manual or automatic) so it doesn't keep firing against a signed-
 * out session. */
function stopIdleAutoLogout() {
  clearTimeout(idleTimer);
  idleTimer = null;
  IDLE_EVENTS.forEach((evt) => document.removeEventListener(evt, resetIdleTimer));
}

function defaultTabForRole(role) {
  return "dashboard";
}

// "Overview" (workload snapshot + the Super Admin-only Attendance panel) is
// deliberately left out of IT Department's group below - that page, and the
// login-time/device data behind it, is Super Admin-only. IT Department
// keeps Shared Files and Memos, same as before. See server's
// /api/team-workspace and /api/attendance* routes, which enforce this
// server-side too.
const WORKSPACE_GROUP_SUPER_ADMIN = {
  group: "workspace",
  label: "Team Workspace",
  children: [
    ["workspace", "Overview"],
    ["workspace-files", "Shared Files"],
    ["workspace-memos", "Memos"],
    ["workspace-itrequest", "IT Request"],
    ["workspace-borrow", "Item Borrowing"],
  ],
};
// IT Department keeps the Team Workspace group for Shared Files/Memos/IT
// Request, but NOT "Item Borrowing" - that page is for deciding requests
// and managing the item catalog, both Super Admin-only now. An IT
// Department account borrows items itself via the "Borrow Items" tab,
// same page a Head Office Employee uses (see NAV_BY_ROLE below).
const WORKSPACE_GROUP_IT_DEPARTMENT = {
  group: "workspace",
  label: "Team Workspace",
  children: [
    ["workspace-files", "Shared Files"],
    ["workspace-memos", "Memos"],
    ["workspace-itrequest", "IT Request"],
  ],
};

// Accounts / Branches / Departments collapsed into one expandable "Admin"
// group, same dropdown pattern as Team Workspace above.
const ADMIN_GROUP_SUPER_ADMIN = {
  group: "admin",
  label: "Admin",
  children: [
    ["accounts", "Accounts"],
    ["branches", "Branches"],
    ["departments", "Departments"],
    ["categories", "Categories"],
    ["itstaff", "IT Staff & Availability"],
  ],
};

// All the report pages collapsed into one expandable "Reports" group, same
// dropdown pattern as Team Workspace / Admin. Super Admin gets the team-wide
// Reporting page, per-staff reports and per-corporation reports; IT
// Department gets its own report plus the (BSP-scoped) corporation report.
const REPORTS_GROUP_SUPER_ADMIN = {
  group: "reports",
  label: "Reports",
  children: [
    ["reporting", "Reporting"],
    ["staffreport", "Staff Reports"],
    ["corpreport", "Corporation Reports"],
  ],
};
const REPORTS_GROUP_IT_DEPARTMENT = {
  group: "reports",
  label: "Reports",
  children: [
    ["myreport", "My Report"],
    ["corpreport", "Corporation Reports"],
  ],
};

const NAV_BY_ROLE = {
  "Super Admin": [
    ["dashboard", "Dashboard"], ["tickets", "All Tickets"], ["newticket", "Submit Ticket"],
    REPORTS_GROUP_SUPER_ADMIN,
    WORKSPACE_GROUP_SUPER_ADMIN,
    ADMIN_GROUP_SUPER_ADMIN,
  ],
  "IT Department": [
    ["dashboard", "Dashboard"], ["tickets", "My Queue"], REPORTS_GROUP_IT_DEPARTMENT, ["borrow-items", "Borrow Items"], WORKSPACE_GROUP_IT_DEPARTMENT, ["itstaff", "Team Availability"],
  ],
  "Head Office Employee": [
    ["dashboard", "Dashboard"], ["tickets", "My Tickets"], ["newticket", "Submit Ticket"], ["borrow-items", "Borrow Items"],
  ],
  "Branch Staff": [
    ["dashboard", "Dashboard"], ["tickets", "My Tickets"], ["newticket", "Submit Ticket"],
  ],
};

function buildNav() {
  const nav = document.getElementById("nav-tabs");
  nav.innerHTML = "";
  (NAV_BY_ROLE[state.user.role] || []).forEach((item) => {
    if (Array.isArray(item)) {
      const [id, label] = item;
      const a = document.createElement("div");
      a.className = "nav-tab";
      a.dataset.tab = id;
      a.innerHTML = `<span>${escapeHtml(label)}</span><span class="dot"></span>`;
      a.onclick = () => { goTab(id); setSidebarOpen(false); };
      nav.appendChild(a);
      return;
    }
    // A group entry ({group, label, children}) renders as an expandable
    // parent - e.g. "Team Workspace" with Overview/Shared Files/Memos
    // underneath, instead of one flat nav item.
    const groupEl = document.createElement("div");
    groupEl.className = "nav-group";
    groupEl.dataset.group = item.group;
    if (item.children.some(([cid]) => cid === state.tab)) groupEl.classList.add("open");

    const toggle = document.createElement("div");
    toggle.className = "nav-tab nav-group-toggle";
    toggle.innerHTML = `<span>${escapeHtml(item.label)}</span><span class="dot"></span><span class="caret">›</span>`;
    toggle.onclick = () => groupEl.classList.toggle("open");
    groupEl.appendChild(toggle);

    const subWrap = document.createElement("div");
    subWrap.className = "nav-subitems";
    item.children.forEach(([cid, clabel]) => {
      const sub = document.createElement("div");
      sub.className = "nav-subitem";
      sub.dataset.tab = cid;
      sub.innerHTML = `<span>${escapeHtml(clabel)}</span><span class="dot"></span>`;
      sub.onclick = (e) => { e.stopPropagation(); goTab(cid); setSidebarOpen(false); };
      subWrap.appendChild(sub);
    });
    groupEl.appendChild(subWrap);
    nav.appendChild(groupEl);
  });
  // All the little pending-work signals (assist-needed tickets, void
  // requests, availability/device approvals, unread memos/files) now live
  // in one place: the notification bell in the topbar, not scattered dots
  // across the sidebar.
  if (["Super Admin", "IT Department", "Branch Staff", "Head Office Employee"].includes(state.user.role)) {
    initNotifBell();
    refreshNotifications();
    startNotifPolling();
  }
}

// Keeps the bell current even if the user never touches the page (no
// clicks/tab-switches needed) - polls /api/stats every NOTIF_POLL_MS and
// refreshes the dropdown's contents/badge in the background. Paired with
// stopNotifPolling() on logout/idle-timeout so it doesn't keep firing
// against a signed-out session.
const NOTIF_POLL_MS = 15 * 1000; // was 5s; each poll costs ~19 DB queries per user. Push messages (sw.js) still refresh the bell instantly.
let notifPollTimer = null;

function startNotifPolling() {
  if (notifPollTimer !== null) return; // already running
  notifPollTimer = setInterval(refreshNotifications, NOTIF_POLL_MS);
  ticketSyncTimer = setInterval(syncTickets, TICKET_SYNC_MS);
  // Backstop for the interval above: browsers heavily throttle (or fully
  // pause) setInterval in a background/minimized tab, so the 30s timer can
  // fall behind while the tab isn't in view. Firing one refresh the instant
  // the tab becomes visible/focused again means the bell is never more than
  // a moment stale when someone actually looks at it, even if the interval
  // itself got throttled while they were away.
  document.addEventListener("visibilitychange", _onNotifVisibilityChange);
  window.addEventListener("focus", refreshNotifications);
}

function stopNotifPolling() {
  clearInterval(notifPollTimer);
  notifPollTimer = null;
  clearInterval(ticketSyncTimer);
  ticketSyncTimer = null;
  state.ticketFp = null;
  document.removeEventListener("visibilitychange", _onNotifVisibilityChange);
  window.removeEventListener("focus", refreshNotifications);
  // Reset the toast baseline so the next login re-establishes silently
  // instead of immediately toasting whatever's pending as if it just
  // arrived - see _notifPrevCounts below.
  _notifPrevCounts = null;
}

function _onNotifVisibilityChange() {
  if (document.visibilityState === "visible") { refreshNotifications(); syncTickets(); }
}


// ---------------------------------------------------------------- live ticket refresh
// IT Department / Super Admin screens update on their own when a ticket
// changes (e.g. IT sets it In Progress / Resolved and the admin's list and
// open ticket follow, and the red countdown clears). Every TICKET_SYNC_MS we
// ask the server for a tiny fingerprint (/api/tickets/sync); only when it
// differs do we reload the current view - the Tickets list in place (same
// filters and page), or the dashboard - and refresh an open ticket window
// unless the person is in the middle of typing in it.
const TICKET_SYNC_MS = 5 * 1000;
let ticketSyncTimer = null;
let _ticketSyncBusy = false;

function ticketSig(t) {
  return [t.status, t.assigned_to, t.void_status, t.reopen_status, t.is_province, (t.collaborator_ids || []).join(",")].join("|");
}

function ticketModalIsBusy() {
  const val = id => { const el = document.getElementById(id); return el && el.value.trim(); };
  if (val("d-comment-text") || val("d-void-reason") || val("d-reopen-reason")) return true;
  const a = document.activeElement, box = document.getElementById("modal-box");
  return !!(a && box && box.contains(a) && ["TEXTAREA", "INPUT", "SELECT"].includes(a.tagName));
}

async function syncTickets() {
  if (!state.user || !["Super Admin", "IT Department"].includes(state.user.role)) return;
  if (document.hidden || _ticketSyncBusy) return;
  _ticketSyncBusy = true;
  try {
    const { fp } = await api("/tickets/sync");
    if (state.ticketFp === null || state.ticketFp === undefined) { state.ticketFp = fp; return; } // first look = baseline
    if (fp === state.ticketFp) return;
    state.ticketFp = fp;

    // 1) the ticket window, if one is open
    const backdrop = document.getElementById("modal-backdrop");
    if (state.openTicketId && backdrop && !backdrop.classList.contains("hidden")) {
      try {
        const { ticket: latest } = await api(`/tickets/${state.openTicketId}`);
        if (ticketSig(latest) !== state.openTicketSig) {
          if (ticketModalIsBusy()) toast("This ticket was just updated. Close and reopen it to see the latest.", "success");
          else await openTicketDetail(state.openTicketId);
        }
      } catch (e) { /* ticket gone or no access: leave the window alone */ }
    }
    // 2) the list / dashboard behind it
    if (typeof state.liveRefresh === "function") await state.liveRefresh();
  } catch (e) { /* offline / server hiccup: try again next tick */ }
  finally { _ticketSyncBusy = false; }
}

// ---------------------------------------------------------------- notification bell (topbar)
// Facebook-style bell: lives in the topbar (upper right). Clicking it opens
// a dropdown listing everything currently pending for this user - pending
// availability requests, device approvals, unread memos/files, tickets
// needing coverage, and void requests awaiting a decision. This is the
// single home for all of that; nothing duplicates it as a separate sidebar
// dot anymore.

let _notifItems = [];
// key -> count value the user had already seen/dismissed for that category.
// Only used for categories where "seen" genuinely means the pending count
// itself went to zero server-side by the time this next syncs in (memos,
// files, tickets, branch_tickets, void_decision - see COUNT_NOTIF_CATEGORIES
// below for the categories deliberately excluded from this).
let _notifSeenCount = {};

// key -> count value as of the LAST poll (unlike _notifSeenCount, this
// isn't about acknowledgment - it's purely "did this grow since I last
// checked", used only to decide whether to pop a toast for it. null until
// the first refreshNotifications() call, so whatever's already pending at
// login/page-load establishes the baseline instead of toasting as if it
// just arrived.
let _notifPrevCounts = null;

// Action-queue categories: each one is a live count of requests still
// awaiting a decision (an availability/device/void request Pending in the
// DB, or an absent colleague's tickets still needing coverage). These
// NEVER get locally "marked seen" - tapping the row just navigates to go
// review it, it doesn't resolve the underlying request. Marking them seen
// on tap used to zero the badge the moment someone glanced at the list,
// even though the request was still sitting there Pending - so the badge
// would go to 0 and never come back until the count changed again, even
// though the actual pending item was still unresolved (see server.js's
// /api/notifications/debug diagnostic, added while tracking this exact
// "badge disappears but the request is still pending" bug). Contrast with
// memos/files/tickets/branch_tickets/void_decision below, where opening the
// relevant tab genuinely clears the server-side count (see
// data.getWorkspaceUnreadCount / getNewAssignedTicketsCount / etc) - for
// those, local "seen" tracking is just a snappier echo of a real
// server-side reset, not a substitute for one.

// Action-queue categories (see the block comment above) - excluded from
// local/server "seen" suppression entirely. A row for one of these is
// always shown as unseen while its count is > 0, since count > 0 IS the
// thing that needs attention; only a poll seeing the count actually change
// (the request got approved/denied/covered) should ever clear it.
const COUNT_NOTIF_CATEGORIES = ["availability", "device", "void", "assist", "reopen", "reopen_assigned", "poked", "borrow", "stale_open"];
// Mirrors data.REOPEN_WINDOW_HOURS server-side - a Resolved ticket can only
// be requested for reopening within this window; the "Request reopen"
// button just stops rendering once it's passed (see canRequestReopen in
// openTicketDetail).
const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

function initNotifBell() {
  const btn = document.getElementById("notif-bell-btn");
  const panel = document.getElementById("notif-panel");
  btn.classList.remove("hidden");

  btn.onclick = (e) => {
    e.stopPropagation();
    const opening = panel.classList.contains("hidden");
    if (opening) renderNotifPanel();
    panel.classList.toggle("hidden", !opening);
  };
  panel.onclick = (e) => e.stopPropagation();
  document.addEventListener("click", () => panel.classList.add("hidden"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") panel.classList.add("hidden");
  });
}

// Sum of counts across still-unseen categories - what the little red number
// on the bell shows. Capped at "99+" so it never blows out the circle.
function notifBadgeTotal() {
  return _notifItems.reduce((sum, item) => sum + (item.unseen ? item.count : 0), 0);
}

function updateNotifBadge() {
  const badge = document.getElementById("notif-bell-count");
  if (!badge) return;
  const total = notifBadgeTotal();
  badge.textContent = total > 99 ? "99+" : String(total);
  badge.classList.toggle("hidden", total === 0);
}

function renderNotifPanel() {
  const body = document.getElementById("notif-panel-body");
  updateNotifBadge();
  if (!_notifItems.length) {
    body.innerHTML = `<div class="empty-state">No new notifications</div>`;
    return;
  }
  body.innerHTML = _notifItems.map((item, i) => `
    <div class="notif-row ${item.unseen ? "unseen" : ""}" data-idx="${i}">
      <div class="notif-row-icon">${item.icon}</div>
      <div class="notif-row-body">
        <div class="notif-row-title">${escapeHtml(item.title)}</div>
        <div class="notif-row-sub">${escapeHtml(item.sub)}</div>
      </div>
      ${item.unseen ? `<div class="notif-row-dot"></div>` : ""}
    </div>`).join("");
  body.querySelectorAll(".notif-row").forEach(el => {
    el.onclick = () => {
      // Opening a notification marks it seen right away (number drops,
      // dot disappears) - same beat as Facebook - before navigating there.
      const item = _notifItems[Number(el.dataset.idx)];
      markNotifSeen(item);
      document.getElementById("notif-panel").classList.add("hidden");
      item.onClick();
    };
  });
}

function markNotifSeen(item) {
  if (COUNT_NOTIF_CATEGORIES.includes(item.key)) {
    // Availability/device/void/assist rows represent a live count of
    // still-Pending work, not "unread info" - tapping the row navigates
    // you to go act on it, but the item stays flagged until that action
    // actually happens (the request gets approved/denied, or the covered
    // ticket gets resolved) and the next poll sees the count drop. There's
    // nothing to "mark seen" here - and nowhere to persist it either,
    // since /api/notifications/mark-seen only ever covered this exact set
    // of categories in the first place.
    return;
  }
  // Everything else (memos, files, tickets, branch_tickets, void_decision)
  // has its own dedicated "seen" reset tied to actually opening that
  // section (see goTab() below / data.getWorkspaceUnreadCount /
  // getNewAssignedTicketsCount / etc) - this is just a snappier local echo
  // so the badge/dot clear instantly on tap instead of waiting for the
  // next poll to confirm the server-side reset already happened.
  _notifSeenCount[item.key] = item.count;
  item.unseen = false;
  updateNotifBadge();
}

// Single source of truth for the bell's contents. Pulls everything from one
// /api/stats call (it already returns all of these counts) and builds the
// dropdown's item list. Note: opening the page a count is "about" (e.g. the
// Memos tab) marks it seen server-side too, so a memo you just posted and
// are currently viewing won't show up here for you - that's expected, not a
// bug; it's meant for people who haven't looked yet.
async function refreshNotifications() {
  try {
    const {
      unavailable_today: unavailableToday,
      pending_void_requests: pendingVoidRequests,
      pending_void_ticket_ids: pendingVoidTicketIds,
      pending_reopen_requests: pendingReopenRequests,
      pending_reopen_ticket_ids: pendingReopenTicketIds,
      pending_reopen_assigned: pendingReopenAssigned,
      pending_reopen_assigned_ids: pendingReopenAssignedIds,
      pending_availability_requests: pendingAvailabilityRequests,
      pending_device_requests: pendingDeviceRequests,
      pending_borrow_requests: pendingBorrowRequests,
      pending_borrow_ids: pendingBorrowIds,
      workspace_unread_files: unreadFiles,
      workspace_unread_memos: unreadMemos,
      new_assigned_tickets: newAssignedTickets,
      new_assigned_ticket_ids: newAssignedTicketIds,
      branch_ticket_updates: branchTicketUpdates,
      branch_ticket_update_ids: branchTicketUpdateIds,
      void_decisions: voidDecisions,
      void_decision_ids: voidDecisionIds,
      reopen_decisions: reopenDecisions,
      reopen_decision_ids: reopenDecisionIds,
      availability_decisions: availabilityDecisions,
      borrow_decisions: borrowDecisions,
      borrow_decision_ids: borrowDecisionIds,
      poked_own: pokedOwn,
      poked_own_ticket_ids: pokedOwnTicketIds,
      stale_open_own: staleOpenOwn,
      stale_open_own_ticket_ids: staleOpenOwnTicketIds,
    } = await api("/stats");

    const isSuperAdmin = state.user.role === "Super Admin";
    const isItOrAdmin = ["Super Admin", "IT Department"].includes(state.user.role);
    const isBranchStaff = ["Branch Staff", "Head Office Employee"].includes(state.user.role);
    // unavailable_today covers BOTH marked-absent and account-locked staff
    // (see server.js's mergeUnavailableStaff) - either way, if they have
    // pending tickets, someone needs to step in.
    const assistPending = isItOrAdmin ? (unavailableToday || []).filter(a => a.pending_tickets > 0) : [];
    const needsAssist = assistPending.length > 0;

    // Goes to the Tickets tab, and - when the category behind this row
    // boils down to exactly one specific ticket (ticketIds has exactly one
    // id) - opens that ticket's detail modal straight away, the same
    // "land right on it" behavior as clicking a desktop push notification
    // (see handleNotificationLandingParams). A count backed by several
    // tickets, or with no id list at all, just lands on the tab like
    // before - there's no single ticket to jump to. ("assist" below has
    // its own onClick since it lands on a filtered person, not a ticket.)
    const ticketOnClick = (ticketIds) => () => {
      goTab("tickets");
      if (ticketIds && ticketIds.length === 1) {
        // Opening the ticket is what actually clears a poke server-side
        // (see server.js's GET /api/tickets/:id) - refresh right after so
        // the bell badge/panel drop immediately instead of waiting for the
        // next poll. Harmless no-op for the other action-queue categories
        // (void/reopen/assist), since nothing changed for those just from
        // viewing.
        openTicketDetail(ticketIds[0])
          .then(refreshNotifications)
          .catch(e => toast(e.message, "error"));
      }
      setSidebarOpen(false);
    };

    // Raw (key, count, ...) pairs - count is what both the row's number and
    // the bell badge are built from. A category only becomes a row once its
    // count is above zero.
    const raw = [
      isSuperAdmin && {
        key: "availability", count: pendingAvailabilityRequests || 0, icon: "🔔",
        title: n => `${n} pending availability request${n === 1 ? "" : "s"}`,
        sub: "IT staff waiting to be let back in — tap to review",
        onClick: () => { goTab("itstaff"); setSidebarOpen(false); },
      },
      isItOrAdmin && {
        key: "memos", count: unreadMemos || 0, icon: "📝",
        title: n => `${n} new memo${n === 1 ? "" : "s"}`,
        sub: "Team Workspace — tap to read",
        onClick: () => { goTab("workspace-memos"); setSidebarOpen(false); },
      },
      isItOrAdmin && {
        key: "files", count: unreadFiles || 0, icon: "📁",
        title: n => `${n} new shared file${n === 1 ? "" : "s"}`,
        sub: "Team Workspace — tap to view",
        onClick: () => { goTab("workspace-files"); setSidebarOpen(false); },
      },
      // Per-user: only tickets actually assigned to *this* IT staff member
      // (see data.getNewAssignedTicketIds) - never a colleague's.
      isItOrAdmin && {
        key: "tickets", count: newAssignedTickets || 0, icon: "🎫",
        title: n => `${n} new ticket${n === 1 ? "" : "s"} assigned to you`,
        sub: "Tap to view your tickets",
        onClick: ticketOnClick(newAssignedTicketIds),
      },
      needsAssist && {
        key: "assist", count: 1, icon: "🧑‍💻",
        title: () => "Tickets need coverage",
        sub: "An absent colleague has open tickets waiting — tap to view",
        // When exactly one colleague is absent with pending tickets, jump
        // straight to their filtered ticket list - the same
        // pendingFilter-driven landing the Dashboard's "Unavailable today"
        // panel already does (see its data-assist-user click handler
        // below). With more than one absent colleague there's no single
        // person to filter by, so land on the Dashboard instead, where
        // each one gets their own "View & manage tickets" row.
        onClick: () => {
          if (assistPending.length === 1) {
            const a = assistPending[0];
            goTab("tickets", { pendingFilter: { assignedTo: a.id, name: a.full_name } });
          } else {
            goTab("dashboard");
          }
          setSidebarOpen(false);
        },
      },
      isSuperAdmin && {
        key: "void", count: pendingVoidRequests || 0, icon: "🗑️",
        title: n => `${n} pending void request${n === 1 ? "" : "s"}`,
        sub: "Ticket void requests awaiting your decision — tap to review",
        onClick: ticketOnClick(pendingVoidTicketIds),
      },
      // IT Department: void requests THEY filed that a Super Admin has
      // since decided (approved/declined) - the counterpart to the "void"
      // row above, which is Super Admin's queue of requests still awaiting
      // a decision (see data.getVoidDecisionIds).
      state.user.role === "IT Department" && {
        key: "void_decision", count: voidDecisions || 0, icon: "🗑️",
        title: n => `${n} void request${n === 1 ? "" : "s"} decided`,
        sub: "A Super Admin decided on a void request you filed — tap to view",
        onClick: ticketOnClick(voidDecisionIds),
      },
      // Super Admin's queue of Resolved tickets an IT Department account
      // wants reopened - the reopen counterpart to "void" above (see
      // data.getReopenRequests).
      isSuperAdmin && {
        key: "reopen", count: pendingReopenRequests || 0, icon: "🟠",
        title: n => `${n} pending reopen request${n === 1 ? "" : "s"}`,
        sub: "Ticket reopen requests awaiting your decision — tap to review",
        onClick: ticketOnClick(pendingReopenTicketIds),
      },
      // An IT Department account's own "awaiting your decision" queue -
      // reopen requests on tickets actually assigned to them, now that the
      // assignee (not just Super Admin) decides these (see
      // data.getReopenRequestsForAssignee). Separate row from Super
      // Admin's system-wide "reopen" queue above.
      state.user.role === "IT Department" && {
        key: "reopen_assigned", count: pendingReopenAssigned || 0, icon: "🟠",
        title: n => `${n} reopen request${n === 1 ? "" : "s"} awaiting your decision`,
        sub: "A branch asked for one of your resolved tickets to reopen — tap to review",
        onClick: ticketOnClick(pendingReopenAssignedIds),
      },
      // Super Admin only: item borrow requests still awaiting a decision -
      // the Item Borrowing counterpart to "void"/"reopen" above. IT
      // Department can file borrow requests but does not decide them (see
      // /api/item-borrows/:id/decide, Super Admin-only).
      isSuperAdmin && {
        key: "borrow", count: pendingBorrowRequests || 0, icon: "📦",
        title: n => `${n} pending borrow request${n === 1 ? "" : "s"}`,
        sub: "Item borrow requests awaiting a decision — tap to review",
        onClick: () => { goTab("workspace-borrow"); setSidebarOpen(false); },
      },
      // Whoever filed a reopen request (IT Department for their own
      // ticket, or the Branch Staff/Head Office account that created it)
      // gets told once it's decided - the reopen counterpart to
      // "void_decision" above (see data.getReopenDecisionIds).
      ["IT Department", "Branch Staff", "Head Office Employee"].includes(state.user.role) && {
        key: "reopen_decision", count: reopenDecisions || 0, icon: "🟠",
        title: n => `${n} reopen request${n === 1 ? "" : "s"} decided`,
        sub: "Your reopen request was decided — tap to view",
        onClick: ticketOnClick(reopenDecisionIds),
      },
      // Either role: this user's own availability_requests (most commonly a
      // 'field' request they filed to be marked unavailable) that a Super
      // Admin has since decided - the availability-request counterpart to
      // void_decision/reopen_decision above.
      isItOrAdmin && {
        key: "availability_decision", count: availabilityDecisions || 0, icon: "🔔",
        title: n => `${n} availability request${n === 1 ? "" : "s"} decided`,
        sub: "A Super Admin decided on a request you filed — tap to view",
        onClick: () => { goTab("itstaff"); setSidebarOpen(false); },
      },
      // A Super Admin poked one of THIS user's own tickets for follow-up
      // (see data.pokeTicket) - the bell counterpart to the push
      // notification server.js's /poke route sends the assignee directly.
      // A poke only ever targets the assignee (no team broadcast), so this
      // is the only poke-related bell row. Stays flagged (and re-toasts if
      // it grows) until the ticket is actually acted on, same as the other
      // action-queue rows.
      state.user.role === "IT Department" && {
        key: "poked", count: pokedOwn || 0, icon: "🔔",
        title: n => `${n} of your ticket${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} follow-up`,
        sub: "A Super Admin flagged this — tap to view",
        onClick: ticketOnClick(pokedOwnTicketIds),
      },
      // Automatic counterpart to the manual poke just above - fires on its
      // own once a ticket's sat 'Open' 10+ minutes after being assigned to
      // this user, no Super Admin needed. The ticket itself also shows a
      // live countdown that turns red when the 10 minutes run out (see
      // escalationBadge / tickTicketTimers); this bell row is the same
      // signal in the usual dropdown.
      state.user.role === "IT Department" && {
        key: "stale_open", count: staleOpenOwn || 0, icon: "⏰",
        title: n => `${n} ticket${n === 1 ? "" : "s"} still Open 10+ min after being assigned to you`,
        sub: "Move it to In Progress (or hand it off) to clear this",
        onClick: ticketOnClick(staleOpenOwnTicketIds),
      },
      // Branch Staff/Head Office: their own submitted tickets whose STATUS
      // changed since they last opened Tickets - see
      // data.getBranchTicketUpdateIds, which is now scoped to status
      // changes only (never a comment, reassignment, or void decision).
      isBranchStaff && {
        key: "branch_tickets", count: branchTicketUpdates || 0, icon: "🎫",
        title: n => `${n} of your ticket${n === 1 ? "" : "s"} had a status update`,
        sub: "Tap to view your tickets",
        onClick: ticketOnClick(branchTicketUpdateIds),
      },
      // Head Office Employee, or an IT Department account borrowing for
      // itself: borrow requests THEY filed that a Super Admin/IT
      // Department account has since approved or denied - the Item
      // Borrowing counterpart to void_decision/reopen_decision above.
      ["Head Office Employee", "IT Department"].includes(state.user.role) && {
        key: "borrow_decision", count: borrowDecisions || 0, icon: "📦",
        title: n => `${n} borrow request${n === 1 ? "" : "s"} decided`,
        sub: "A borrow request you filed was approved or denied — tap to view",
        onClick: () => { goTab("borrow-items"); setSidebarOpen(false); },
      },
    ].filter(Boolean);

    // Detect any category that grew since the last poll (e.g. an IT staffer
    // just filed a void request) and pop a toast for it right away - the
    // badge/panel below already reflect the new count, but a toast is what
    // actually surfaces the change the moment it happens instead of only
    // being visible if someone happens to open the bell.
    const currentCounts = {};
    raw.forEach(r => { currentCounts[r.key] = r.count; });
    if (_notifPrevCounts === null) {
      // First poll after login/page-load: just establish the baseline
      // silently - whatever's already pending shouldn't toast as "new".
      _notifPrevCounts = currentCounts;
    } else {
      raw.forEach(r => {
        if (r.count > (_notifPrevCounts[r.key] || 0)) {
          // Every category gets the big popup now, not just new ticket
          // assignments - see showBigAlert() above. (Still paired with the
          // bell/panel update below, same as before.)
          showBigAlert(r.title(r.count), r.sub, r.onClick);
        }
      });
      _notifPrevCounts = currentCounts;
    }

    const visible = raw.filter(r => r.count > 0);
    _notifItems = visible.map(r => ({
      key: r.key,
      count: r.count,
      icon: r.icon,
      title: r.title(r.count),
      sub: r.sub,
      onClick: r.onClick,
      // Action-queue categories (availability/device/void/assist) are
      // ALWAYS shown as unseen while count > 0 - the count itself IS the
      // outstanding work, so there's no "already seen it" state that
      // should hide it (this is the fix for the badge going to 0 the
      // moment someone opened the bell, even though the request was still
      // Pending). Everything else keeps the local "seen" echo.
      unseen: COUNT_NOTIF_CATEGORIES.includes(r.key) ? true : _notifSeenCount[r.key] !== r.count,
    }));

    updateNotifBadge();
    const panel = document.getElementById("notif-panel");
    if (panel && !panel.classList.contains("hidden")) renderNotifPanel();
  } catch (e) { /* non-critical */ }
}

// Kept as thin aliases so every existing call site (after approving a
// request, marking a ticket handled, opening Memos, etc.) still works
// without having to hunt down each one - they all just refresh the one
// bell now instead of touching their own separate dot.
async function refreshAssistAlert() { await refreshNotifications(); }
async function refreshWorkspaceAlert() { await refreshNotifications(); }
async function refreshApprovalBells() { await refreshNotifications(); }


function goTab(tab, opts = {}) {
  const navId = (state.navId = (state.navId || 0) + 1); // guards against stale renders from a previous tab
  state.tab = tab;
  state.liveRefresh = null; // the view being rendered re-registers its own below
  if (tab === "tickets") state.pendingFilter = opts.pendingFilter || null;
  document.querySelectorAll(".nav-tab, .nav-subitem").forEach(el => el.classList.toggle("active", el.dataset.tab === tab));
  document.querySelectorAll(".nav-group").forEach(g => {
    if (g.querySelector(".nav-subitem.active")) g.classList.add("open");
  });
  const titles = {
    dashboard: "Dashboard", tickets: "Tickets", newticket: "Submit a Ticket",
    reporting: "Reporting", staffreport: "Staff Reports", corpreport: "Corporation Reports", myreport: "My Report", accounts: "Accounts", branches: "Branches", departments: "Departments", categories: "Categories", itstaff: "IT Staff & Availability",
    workspace: "Team Workspace — Overview",
    "workspace-files": "Team Workspace — Shared Files",
    "workspace-memos": "Team Workspace — Memos",
    "workspace-itrequest": "Team Workspace — IT Request",
    "workspace-borrow": "Team Workspace — Item Borrowing",
    "borrow-items": "Borrow Items",
  };
  document.getElementById("page-title").textContent = titles[tab] || "Ticket Desk";
  document.getElementById("topbar-actions").innerHTML = "";
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="empty-state">Loading…</div>`;
  const renderers = {
    dashboard: renderDashboard, tickets: renderTickets, newticket: renderNewTicket,
    reporting: renderReporting, staffreport: renderStaffReport, corpreport: renderCorporationReport, myreport: renderStaffReport, accounts: renderAccounts, branches: renderBranches, departments: renderDepartments, categories: renderCategories, itstaff: renderItStaff,
    workspace: renderTeamWorkspace,
    "workspace-files": renderWorkspaceFilesPage,
    "workspace-memos": renderWorkspaceMemosPage,
    "workspace-itrequest": renderITRequestsPage,
    "workspace-borrow": renderItemBorrowingPage,
    "borrow-items": renderBorrowItemsPage,
  };
  (renderers[tab] || renderDashboard)(root).catch(err => {
    if (navId !== state.navId) return; // user already switched tabs, ignore stale error
    root.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  });
  // Only clear the dot for the section actually being looked at - opening
  // "Shared Files" no longer clears an unread "Memos" dot (and vice versa).
  // "Overview" doesn't list files or memos itself, so it doesn't clear
  // either.
  if (["workspace-files", "workspace-memos"].includes(tab)
      && ["Super Admin", "IT Department"].includes(state.user.role)) {
    const section = tab === "workspace-memos" ? "memos" : "files";
    api("/workspace/mark-seen", { method: "POST", body: { section }, keepalive: true })
      .then(refreshWorkspaceAlert)
      .catch(() => {});
  }
  // Opening "Tickets" clears this user's own "N new tickets assigned to
  // you" bell notification (never a colleague's - see
  // data.getNewAssignedTicketsCount), the same per-section pattern as
  // Shared Files/Memos above.
  if (tab === "tickets" && ["Super Admin", "IT Department"].includes(state.user.role)) {
    api("/notifications/tickets-seen", { method: "POST", keepalive: true })
      .then(refreshNotifications)
      .catch(() => {});
  }
  // Clears an IT Department account's "N void requests decided" bell too -
  // same "opening Tickets acknowledges it" pattern as tickets-seen above
  // (see data.getVoidDecisionsCount / markVoidDecisionsSeen).
  if (tab === "tickets" && state.user.role === "IT Department") {
    api("/notifications/void-decisions-seen", { method: "POST", keepalive: true })
      .then(refreshNotifications)
      .catch(() => {});
  }
  // Clears a requester's "N reopen requests decided" bell too - same
  // pattern as void-decisions-seen above (see data.getReopenDecisionIds /
  // markReopenDecisionsSeen). Covers Branch Staff/Head Office too, since
  // either can now file a reopen request, not just IT Department.
  if (tab === "tickets" && ["IT Department", "Branch Staff", "Head Office Employee"].includes(state.user.role)) {
    api("/notifications/reopen-decisions-seen", { method: "POST", keepalive: true })
      .then(refreshNotifications)
      .catch(() => {});
  }
  // Same idea, Branch-Staff side: clears "N of your tickets updated" (see
  // data.getBranchTicketUpdatesCount) instead of the IT/Admin "assigned to
  // you" count above.
  if (tab === "tickets" && ["Branch Staff", "Head Office Employee"].includes(state.user.role)) {
    api("/notifications/branch-tickets-seen", { method: "POST", keepalive: true })
      .then(refreshNotifications)
      .catch(() => {});
  }
  // Clears "N of your availability requests were decided" - opening this
  // tab is where the requester would actually see the outcome (My
  // availability panel), same acknowledge-on-open pattern as the rows
  // above.
  if (tab === "itstaff" && ["Super Admin", "IT Department"].includes(state.user.role)) {
    api("/notifications/availability-decisions-seen", { method: "POST", keepalive: true })
      .then(refreshNotifications)
      .catch(() => {});
  }
  // Clears a Head Office Employee's "N of your borrow requests were
  // decided" bell - opening "Borrow Items" is where they'd actually see
  // the outcome (their own borrow history), same acknowledge-on-open
  // pattern as the rows above.
  if (tab === "borrow-items" && ["Head Office Employee", "IT Department"].includes(state.user.role)) {
    api("/notifications/borrow-decisions-seen", { method: "POST", keepalive: true })
      .then(refreshNotifications)
      .catch(() => {});
  }
}

// ---------------------------------------------------------------- helpers

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z]/g, ""); }
function fmtDateTime(s) { if (!s) return "—"; const d = new Date(s); return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function fmtDate(s) { if (!s) return "—"; return new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }

// Shared date-filter toolbar (All history / single day / monthly / date
// range) - same three filtered modes as the Reporting tab's toolbar, plus
// an "All" option since a history view (unlike a report) has a sensible
// unfiltered default. `prefix` namespaces the control ids so two of these
// can live on the same page (see the Absence/Unavailable history panels).
function dateFilterToolbarHtml(prefix) {
  const today = new Date();
  return `
    <div class="toolbar">
      <select id="${prefix}-mode">
        <option value="">All history</option>
        <option value="single">Single day</option>
        <option value="monthly">Monthly</option>
        <option value="range">Date range</option>
      </select>
      <input id="${prefix}-day" type="date" class="hidden">
      <input id="${prefix}-month" type="number" min="1" max="12" value="${today.getMonth() + 1}" style="width:70px;" title="Month" class="hidden">
      <input id="${prefix}-year" type="number" value="${today.getFullYear()}" style="width:90px;" title="Year" class="hidden">
      <input id="${prefix}-start" type="date" class="hidden">
      <input id="${prefix}-end" type="date" class="hidden">
      <button class="btn btn-secondary btn-sm" id="${prefix}-run">Filter</button>
    </div>`;
}

/** Wires up the mode dropdown's show/hide-the-right-inputs behaviour and
 * pre-fills sensible defaults (today). Returns a buildParams() function
 * that reads the current control values into a URLSearchParams matching
 * server.js's resolveRangeFromQuery (mode=single|monthly|range plus
 * day/month+year/start+end) - empty params when mode is "" (All history). */
function wireDateFilterToolbar(prefix) {
  const modeEl = document.getElementById(`${prefix}-mode`);
  const today = new Date();
  const update = () => {
    const mode = modeEl.value;
    document.getElementById(`${prefix}-day`).classList.toggle("hidden", mode !== "single");
    document.getElementById(`${prefix}-month`).classList.toggle("hidden", mode !== "monthly");
    document.getElementById(`${prefix}-year`).classList.toggle("hidden", mode !== "monthly");
    document.getElementById(`${prefix}-start`).classList.toggle("hidden", mode !== "range");
    document.getElementById(`${prefix}-end`).classList.toggle("hidden", mode !== "range");
  };
  modeEl.onchange = update;
  update();
  document.getElementById(`${prefix}-day`).value = today.toISOString().slice(0, 10);
  document.getElementById(`${prefix}-start`).value = today.toISOString().slice(0, 10);
  document.getElementById(`${prefix}-end`).value = today.toISOString().slice(0, 10);

  return () => {
    const mode = modeEl.value;
    const params = new URLSearchParams();
    if (!mode) return params;
    params.set("mode", mode);
    if (mode === "single") params.set("day", document.getElementById(`${prefix}-day`).value);
    if (mode === "monthly") {
      params.set("month", document.getElementById(`${prefix}-month`).value);
      params.set("year", document.getElementById(`${prefix}-year`).value);
    }
    if (mode === "range") {
      params.set("start", document.getElementById(`${prefix}-start`).value);
      params.set("end", document.getElementById(`${prefix}-end`).value);
    }
    return params;
  };
}
function priorityBadge(p) { return `<span class="badge badge-${slug(p)}">${p}</span>`; }
function statusBadge(s) { return `<span class="badge badge-${slug(s)}">${s}</span>`; }
function voidBadge(t) {
  if (!t.void_status || t.void_status === "None") return "";
  const labels = { Requested: "Void requested", Voided: "Voided", Rejected: "Void declined" };
  return `<span class="badge badge-${slug(t.void_status)}">${labels[t.void_status] || t.void_status}</span>`;
}
function reopenBadge(t) {
  if (!t.reopen_status || t.reopen_status === "None") return "";
  // "Approved" reuses the badge-resolved (good/green) color rather than
  // slug()-ing to a "badge-approved" class that doesn't exist in styles.css -
  // Requested/Rejected map onto the same badge-requested/badge-rejected
  // classes the void badges above already use.
  const map = {
    Requested: ["Reopen requested", "badge-requested"],
    Approved: ["Reopen approved", "badge-resolved"],
    Rejected: ["Reopen declined", "badge-rejected"],
  };
  const [label, cls] = map[t.reopen_status] || [t.reopen_status, "badge-neutral"];
  return `<span class="badge ${cls}">${label}</span>`;
}
function provinceBadge(t) {
  return t.is_province ? `<span class="badge badge-neutral" title="Excluded from IT performance stats">📍 Site visit</span>` : "";
}
function pokeBadge(t) {
  return t.poked_at ? `<span class="badge badge-critical" title="A Super Admin flagged this for follow-up">🔔 Follow-up</span>` : "";
}

// ---- 10-minute "Open" countdown -------------------------------------------
// A ticket that is still Open and assigned shows a live mm:ss countdown (IT
// Department / Super Admin only). The server sends escalate_in_seconds
// (computed in SQL, so no client/server clock or timezone mismatch); we turn
// it into an absolute deadline when the markup is built and one 1-second
// ticker updates every timer on screen. When it reaches zero the badge, the
// ticket card and the ticket detail header all turn red (.esc-overdue) so IT
// knows to take it first. Moving the ticket off Open / reassigning it resets
// the clock server-side, so the next render simply drops or restarts it.
function escalationDeadline(t) {
  if (!state.user || !["IT Department", "Super Admin"].includes(state.user.role)) return null;
  if (t.status !== "Open" || !t.assigned_to || t.void_status === "Voided") return null;
  if (t.escalate_in_seconds === null || t.escalate_in_seconds === undefined) return null;
  return Date.now() + Number(t.escalate_in_seconds) * 1000;
}
function fmtClock(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function escalationBadge(t) {
  const d = escalationDeadline(t);
  if (!d) return "";
  return `<span class="badge esc-timer" data-esc-deadline="${d}" title="Time left before this Open ticket is flagged as overdue">⏱ --:--</span>`;
}
function tickTicketTimers() {
  const now = Date.now();
  document.querySelectorAll("[data-esc-deadline]").forEach(el => {
    const left = Math.ceil((Number(el.dataset.escDeadline) - now) / 1000);
    const overdue = left <= 0;
    el.classList.toggle("esc-overdue", overdue);
    if (el.classList.contains("esc-timer")) {
      el.textContent = overdue ? "⚠ Overdue +" + fmtClock(-left) : "⏱ " + fmtClock(left);
    }
  });
}
setInterval(tickTicketTimers, 1000);

// Small dependency-free SVG histogram (bar) chart (no chart library is
// loaded in this app) - renders into a .chart-frame div.
//
// Accepts either:
//   - the legacy shape: a flat [{day:"YYYY-MM-DD", count:Number}, ...]
//     array (one series, drawn as before), or
//   - a multi-series shape: [{name, color, data:[{day,count}, ...]}, ...],
//     e.g. created vs. resolved for the same date range, as returned by
//     reporting.js's getDailyBreakdown()/getDailyResolvedBreakdown() (see
//     /api/reports/performance's `daily` / `daily_resolved`).
// Each day gets one slot; with multiple series each gets its own narrower
// bar side-by-side within that slot, a shared y-scale, and a small
// color-keyed legend so the two are easy to tell apart.
function buildDailyHistogramSvg(seriesOrLegacy) {
  const series = (Array.isArray(seriesOrLegacy) && seriesOrLegacy.length && seriesOrLegacy[0] && seriesOrLegacy[0].data)
    ? seriesOrLegacy.filter(s => s.data && s.data.length)
    : [{ name: "Created", color: "var(--accent)", data: seriesOrLegacy }];

  const hasLegend = series.length > 1;
  const n = series[0].data.length;
  const W = 700, H = hasLegend ? 208 : 190;
  const pad = { top: hasLegend ? 32 : 16, right: 12, bottom: 24, left: 34 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const maxCount = Math.max(1, ...series.flatMap(s => s.data.map(d => d.count)));
  const baseY = pad.top + innerH;

  // Each day gets an equal-width slot; when there's more than one series
  // its bars share that slot side-by-side (with a small gap between them)
  // rather than overlapping, so both are always fully visible.
  const slot = innerW / n;
  const groupW = slot * 0.7;
  const barGap = series.length > 1 ? 2 : 0;
  const barW = Math.max(1.5, (groupW - barGap * (series.length - 1)) / series.length);

  const bars = series.map((s, si) => s.data.map((d, i) => {
    const hasData = d.count > 0;
    const h = Math.max(hasData ? 1.5 : 0, (d.count / maxCount) * innerH);
    const groupX = pad.left + slot * i + (slot - groupW) / 2;
    const x = groupX + si * (barW + barGap);
    const y = baseY - h;
    const fill = hasData ? s.color : "var(--ink-100)";
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${fill}"><title>${s.name} · ${d.day}: ${d.count}</title></rect>`;
  }).join("")).join("");

  // Four evenly-spaced horizontal gridlines (25/50/75/100%) plus the
  // baseline, each with its own value label - a more readable scale than
  // just a bare top/bottom number, without cluttering a chart this size.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ y: baseY - f * innerH, val: Math.round(maxCount * f) }));
  const gridlines = ticks
    .filter(t => t.val !== 0)
    .map(t => `<line x1="${pad.left}" y1="${t.y.toFixed(1)}" x2="${W - pad.right}" y2="${t.y.toFixed(1)}" stroke="var(--ink-100)" stroke-dasharray="3 3" />`)
    .join("");
  const yLabels = ticks.map(t => `<text x="2" y="${(t.y + 3.5).toFixed(1)}" font-size="10" fill="var(--ink-600)">${t.val}</text>`).join("");

  // Thin out x-axis labels so they don't overlap on longer ranges - show
  // roughly 6 across the width, always including the first and last day.
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const xLabels = series[0].data.map((d, i) => {
    const x = pad.left + slot * i + slot / 2;
    return (i % labelEvery === 0 || i === n - 1)
      ? `<text x="${x.toFixed(1)}" y="${H - 6}" font-size="10" fill="var(--ink-600)" text-anchor="middle">${fmtDate(d.day)}</text>`
      : "";
  }).join("");

  const legend = hasLegend ? series.map((s, i) => {
    const lx = pad.left + i * 100;
    return `<rect x="${lx}" y="6" width="10" height="10" rx="2" fill="${s.color}"/>
      <text x="${lx + 15}" y="15" font-size="11" fill="var(--ink-800)">${s.name}</text>`;
  }).join("") : "";

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="none">
      ${gridlines}
      <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${baseY.toFixed(1)}" stroke="var(--line)" />
      <line x1="${pad.left}" y1="${baseY.toFixed(1)}" x2="${W - pad.right}" y2="${baseY.toFixed(1)}" stroke="var(--line)" />
      ${yLabels}
      ${bars}
      ${xLabels}
      ${legend}
    </svg>`;
}

function openModal(html) {
  document.getElementById("modal-box").innerHTML = html;
  document.getElementById("modal-backdrop").classList.remove("hidden");
  document.getElementById("modal-backdrop").onclick = (e) => { if (e.target.id === "modal-backdrop") closeModal(); };
}
// Every ticket-detail button (Close, the ✕, Save Changes, Post Comment,
// Request Void/Reopen, approve/decline, clicking outside the modal) routes
// through this one function to dismiss it - so refreshing the bell here,
// once, covers all of them, rather than having to remember to add it to
// each button's handler individually. Cheap (one /api/stats call) and safe
// to run for every modal in the app, not just tickets - if nothing
// changed, the bell just re-renders the same counts. Guarded on
// state.user since some modals (rare) can still be open right as a logout
// clears it.
function closeModal() {
  state.openTicketId = null;
  document.getElementById("modal-backdrop").classList.add("hidden");
  if (state.user && ["Super Admin", "IT Department", "Branch Staff", "Head Office Employee"].includes(state.user.role)) {
    refreshNotifications();
  }
}

// ---------------------------------------------------------------- Dashboard

async function renderDashboard(root) {
  state.liveRefresh = () => goTab("dashboard");
  const { stats, unavailable_today } = await api("/stats");

  // Built first and prepended below - unavailable/absent staff with
  // pending work is the most time-sensitive thing on this page (someone's
  // tickets are stuck until a colleague covers them), so it always leads
  // the dashboard regardless of what else is shown, rather than being
  // buried under stat cards and the performance chart.
  let html = "";
  if (unavailable_today && unavailable_today.length) {
    const needsAssist = unavailable_today.some(a => a.pending_tickets > 0);
    html += `<div class="panel notice-panel">
      <div class="panel-header"><h3>🔴 Unavailable today${needsAssist ? " — assistance needed" : ""}</h3></div>
      <div class="panel-body">
        ${unavailable_today.map(a => {
          // kind: "absent" (marked absent/on-field today), "locked"
          // (account is_available = false - can't log in at all), or
          // "absent_locked" if both apply at once. Locked accounts get a
          // 🔒 tag so it's clear they can't just log back in on their own
          // like an absence would end at day's end.
          const lockedTag = (a.kind === "locked" || a.kind === "absent_locked")
            ? `<span class="badge badge-critical">🔒 Account locked</span> `
            : "";
          return `
          <div class="notice-item ${a.pending_tickets > 0 ? "notice-item-hot" : ""}" data-assist-user="${a.id}" data-assist-name="${escapeHtml(a.full_name)}">
            <div>
              <span class="who">${escapeHtml(a.full_name)}</span>
              ${lockedTag}
              <span class="muted">${a.reason ? " — " + escapeHtml(a.reason) : ""}</span>
              ${a.pending_tickets > 0
                ? `<div class="pending-count">${a.pending_tickets} pending ticket${a.pending_tickets === 1 ? "" : "s"} need attention</div>`
                : `<div class="muted">No pending tickets right now</div>`}
            </div>
            <button class="btn btn-primary btn-sm">View &amp; manage tickets</button>
          </div>`;
        }).join("")}
      </div>
    </div>`;
  }

  const cards = [
    ["Open", stats.Open, "open"],
    ["In Progress", stats["In Progress"], "inprogress"],
    ["Resolved", stats.Resolved, "resolved"],
  ];
  html += `<div class="stat-grid">` +
    cards.map(([label, val, cls]) => `
      <div class="stat-card ${cls}">
        <div class="label">${label}</div>
        <div class="value">${val}</div>
      </div>`).join("") + `</div>`;

  // IT performance chart - auto-shown for Super Admin (team-wide) and IT
  // Department (their own numbers). Generation mode defaults to the
  // current month but can be switched to a single day or a full year.
  const showPerf = ["Super Admin", "IT Department"].includes(state.user.role);
  if (showPerf) {
    html += `<div class="panel" id="perf-widget-panel">
      <div class="panel-header"><h3>IT Team Performance</h3></div>
      <div class="panel-body" id="perf-widget-body"></div>
    </div>`;
  }

  if (state.user.role === "Super Admin") {
    const { requests } = await api("/void-requests");
    if (requests.length) {
      html += `<div class="panel notice-panel">
        <div class="panel-header"><h3>🔴 Void requests — review needed</h3></div>
        <div class="panel-body">
          ${requests.map(r => `
            <div class="notice-item notice-item-hot" data-void-ticket="${r.id}">
              <div>
                <span class="who">#T-${String(r.id).padStart(5, "0")} · ${escapeHtml(r.title)}</span>
                <div class="muted">Requested by ${escapeHtml(r.requested_by_name)} · ${escapeHtml(r.branch)} · ${fmtDateTime(r.void_requested_at)}</div>
                <div style="margin-top:4px;">${escapeHtml(r.void_reason || "")}</div>
              </div>
              <button class="btn btn-primary btn-sm">Review</button>
            </div>`).join("")}
        </div>
      </div>`;
    }

    const { requests: reopenRequests } = await api("/reopen-requests");
    if (reopenRequests.length) {
      html += `<div class="panel notice-panel">
        <div class="panel-header"><h3>🟠 Reopen requests — review needed</h3></div>
        <div class="panel-body">
          ${reopenRequests.map(r => `
            <div class="notice-item notice-item-hot" data-reopen-ticket="${r.id}">
              <div>
                <span class="who">#T-${String(r.id).padStart(5, "0")} · ${escapeHtml(r.title)}</span>
                <div class="muted">Requested by ${escapeHtml(r.requested_by_name)} · ${escapeHtml(r.branch)} · ${fmtDateTime(r.reopen_requested_at)}</div>
                <div style="margin-top:4px;">${escapeHtml(r.reopen_reason || "")}</div>
              </div>
              <button class="btn btn-primary btn-sm">Review</button>
            </div>`).join("")}
        </div>
      </div>`;
    }
  }

  // Super Admin already has the full "All Tickets" tab, so the dashboard's
  // condensed preview would just be the same list twice - only render it
  // for roles that don't have that dedicated tab.
  const showRecent = state.user.role !== "Super Admin";
  // Branch Staff / Head Office Employee have no other way to look up "what
  // did I even file" besides this dashboard - there's no email confirmation
  // sent anywhere, so this panel IS their record of ticket numbers to quote
  // when following up with IT. They get every ticket they've submitted
  // (not just a 6-item teaser) and a header that says what it's for; IT
  // Department keeps the short "Recent tickets" teaser since they also have
  // the full Tickets tab for everyday browsing.
  const isBranchOrOffice = ["Branch Staff", "Head Office Employee"].includes(state.user.role);
  if (showRecent) {
    const panelTitle = isBranchOrOffice ? "Your tickets" : "Recent tickets";
    const panelSubtitle = isBranchOrOffice
      ? `<div class="note-callout"><strong>Note:</strong> Quote the ticket number (e.g. #T-00001) when following up with IT.</div>`
      : "";
    html += `<div class="panel"><div class="panel-header"><div><h3>${panelTitle}</h3>${panelSubtitle}</div>
      <a onclick="goTab('tickets')">View all →</a></div><div class="panel-body" id="recent-tickets"></div></div>`;
  }
  root.innerHTML = html;

  if (showPerf) initPerformanceWidget(document.getElementById("perf-widget-body"));

  root.querySelectorAll("[data-assist-user]").forEach(row => {
    row.onclick = () => {
      goTab("tickets", { pendingFilter: { assignedTo: row.dataset.assistUser, name: row.dataset.assistName } });
    };
  });
  root.querySelectorAll("[data-void-ticket]").forEach(row => {
    row.onclick = () => openTicketDetail(row.dataset.voidTicket);
  });
  root.querySelectorAll("[data-reopen-ticket]").forEach(row => {
    row.onclick = () => openTicketDetail(row.dataset.reopenTicket);
  });

  if (showRecent) {
    const { tickets } = await api("/tickets");
    const recent = isBranchOrOffice ? tickets : tickets.slice(0, 6);
    document.getElementById("recent-tickets").innerHTML = recent.length
      ? `<div class="ticket-list">${recent.map(ticketCardHtml).join("")}</div>`
      : `<div class="empty-state"><div class="glyph">∅</div>No tickets yet.</div>`;
    wireTicketCardClicks();
  }
}

// Dashboard "IT performance" widget - both Super Admin and IT Department
// now see the whole team via /reports/performance (the API grants both
// roles read access), with the signed-in person's own row highlighted in
// the list so IT staff can spot themselves among their teammates. Only
// Super Admin gets the link out to the full Reporting page (export,
// branch drill-down, etc. stay admin-only). Loads automatically and
// re-fetches whenever the generation mode or date changes.
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function ratePillClass(rate) {
  if (rate == null) return "low";
  if (rate >= 80) return "high";
  if (rate >= 50) return "medium";
  return "low";
}

function initPerformanceWidget(container) {
  const today = new Date();
  const isAdmin = state.user.role === "Super Admin";

  container.innerHTML = `
    <div class="perf-toolbar">
      <div class="perf-field">
        <label>Period</label>
        <select id="perf-mode">
          <option value="monthly" selected>Monthly</option>
          <option value="single">Single day</option>
          <option value="annual">Annual</option>
        </select>
      </div>
      <div class="perf-field" id="perf-day-field">
        <label>Date</label>
        <input id="perf-day" type="date">
      </div>
      <div class="perf-field" id="perf-month-field">
        <label>Month</label>
        <select id="perf-month">
          ${MONTH_NAMES.map((m, i) => `<option value="${i + 1}" ${i + 1 === today.getMonth() + 1 ? "selected" : ""}>${m}</option>`).join("")}
        </select>
      </div>
      <div class="perf-field" id="perf-year-field">
        <label>Year</label>
        <input id="perf-year" type="number" value="${today.getFullYear()}">
      </div>
    </div>
    <div id="perf-results"><div class="empty-state">Loading…</div></div>`;

  document.getElementById("perf-day").value = today.toISOString().slice(0, 10);

  const modeEl = document.getElementById("perf-mode");
  const dayEl = document.getElementById("perf-day");
  const monthEl = document.getElementById("perf-month");
  const yearEl = document.getElementById("perf-year");
  const dayField = document.getElementById("perf-day-field");
  const monthField = document.getElementById("perf-month-field");
  const yearField = document.getElementById("perf-year-field");

  const updateFields = () => {
    const mode = modeEl.value;
    dayField.classList.toggle("hidden", mode !== "single");
    monthField.classList.toggle("hidden", mode !== "monthly");
    yearField.classList.toggle("hidden", mode === "single");
  };

  const buildParams = () => {
    const mode = modeEl.value;
    const params = new URLSearchParams({ mode });
    if (mode === "single") params.set("day", dayEl.value);
    if (mode === "monthly") { params.set("month", monthEl.value); params.set("year", yearEl.value); }
    if (mode === "annual") params.set("year", yearEl.value);
    return params;
  };

  const run = async () => {
    const resEl = document.getElementById("perf-results");
    resEl.innerHTML = `<div class="empty-state">Loading…</div>`;
    const params = buildParams();
    try {
      const data = await api(`/reports/performance?${params.toString()}`);
      const s = data.summary;
      const rows = data.report || [];
      resEl.innerHTML = `
        <div class="perf-summary">
          <div class="stat-card"><div class="label">Assigned</div><div class="value">${s.total_assigned ?? 0}</div></div>
          <div class="stat-card resolved"><div class="label">Resolved</div><div class="value">${s.total_resolved ?? 0}</div></div>
          <div class="stat-card open"><div class="label">Still open</div><div class="value">${s.total_open ?? 0}</div></div>
          <div class="stat-card"><div class="label">Resolution rate</div><div class="value">${s.overall_resolution_rate ?? 0}%</div></div>
        </div>
        <div class="perf-chart-panel">
          <div class="chart-title">Tickets created vs. resolved per day</div>
          <div class="chart-frame">${(data.daily && data.daily.length)
            ? buildDailyHistogramSvg([
                { name: "Created", color: "var(--accent)", data: data.daily },
                { name: "Resolved", color: "var(--resolved)", data: data.daily_resolved || [] },
              ])
            : `<div class="empty-state">No data for this period.</div>`}</div>
        </div>
        ${isAdmin ? `<p class="muted" style="margin-top:12px;">Need branch or export options? <a onclick="goTab('reporting')">Open the full Reporting page →</a></p>` : ""}`;
    } catch (err) {
      resEl.innerHTML = `<div class="empty-state">Couldn't load performance data.</div>`;
    }
  };

  modeEl.onchange = () => { updateFields(); run(); };
  dayEl.onchange = run;
  monthEl.onchange = run;
  yearEl.onchange = run;

  updateFields();
  run();
}

// ---------------------------------------------------------------- Tickets list

function ticketCardHtml(t) {
  const collabNames = t.collaborator_names || [];
  const assigneeLabel = t.assignee_name
    ? "→ " + escapeHtml(t.assignee_name) + (collabNames.length ? ` +${collabNames.length}` : "")
    : "unassigned";
  const escDeadline = escalationDeadline(t);
  return `
    <div class="ticket-card p-${slug(t.priority)}" data-id="${t.id}"${escDeadline ? ` data-esc-deadline="${escDeadline}"` : ""}>
      <div class="ticket-id">#T-${String(t.id).padStart(5, "0")}</div>
      <div class="ticket-main">
        <div class="ticket-title">${escapeHtml(t.branch)}</div>
        <div class="ticket-meta">
          <span>by ${escapeHtml(t.creator_name)}</span>
          <span>${assigneeLabel}</span>
          <span>${fmtDateTime(t.created_at)}</span>
        </div>
      </div>
      <div class="ticket-tags">${escalationBadge(t)}${priorityBadge(t.priority)}${statusBadge(t.status)}${voidBadge(t)}${reopenBadge(t)}${provinceBadge(t)}${pokeBadge(t)}</div>
    </div>`;
}

function wireTicketCardClicks() {
  document.querySelectorAll(".ticket-card").forEach(el => {
    el.onclick = () => openTicketDetail(el.dataset.id);
  });
}

async function renderTickets(root) {
  const filter = state.pendingFilter;
  const isSuperAdmin = state.user.role === "Super Admin";
  const isItDept = state.user.role === "IT Department";
  const canFilterProvince = isSuperAdmin || isItDept;
  // Void status and site-visit ("province") used to be two separate
  // dropdowns that both defaulted to the same confusing "All tickets"
  // label. They're unrelated filters, so rather than force one onto the
  // other, they're combined into one dropdown with a labeled group per
  // concern - still one value at a time, just one less near-identical
  // control cluttering the bar. A Super Admin gets both groups; an IT
  // Department account (which can't act on void requests) gets only the
  // site-visit group; a Branch Staff/Head Office account gets neither.
  const extraOptions = [
    isSuperAdmin ? `<optgroup label="Void status">
        <option value="void:Requested">Void requested</option>
        <option value="void:Voided">Voided</option>
        <option value="void:Rejected">Void declined</option>
      </optgroup>` : "",
    isSuperAdmin ? `<optgroup label="Reopen status">
        <option value="reopen:Requested">Reopen requested</option>
        <option value="reopen:Approved">Reopen approved</option>
        <option value="reopen:Rejected">Reopen declined</option>
      </optgroup>` : "",
    canFilterProvince ? `<optgroup label="Site visit">
        <option value="province:Yes">📍 Site visit only</option>
        <option value="province:No">No site visit</option>
      </optgroup>` : "",
  ].join("");
  root.innerHTML = `
    ${filter ? `<div class="filter-banner">Showing tickets assigned to <strong>${escapeHtml(filter.name)}</strong> (unavailable today) <a onclick="clearPendingFilter()">Clear filter</a></div>` : ""}
    <div class="toolbar toolbar-search">
      <input id="tk-search" class="grow" type="text" placeholder="Search tickets… (title, ticket #, branch, etc.)">
    </div>
    <div class="toolbar">
      <select id="tk-status"><option value="All">All statuses</option></select>
      <select id="tk-priority"><option value="All">All priorities</option></select>
      ${isSuperAdmin ? `<select id="tk-branch"><option value="All">All branches</option></select>` : ""}
      <input id="tk-date" type="date" title="Show tickets received on this day">
      ${extraOptions ? `<select id="tk-extra"><option value="All">All tickets</option>${extraOptions}</select>` : ""}
      <button class="btn btn-secondary btn-sm" id="tk-refresh">Refresh</button>
    </div>
    <div id="tk-list"><div class="empty-state">Loading…</div></div>
    <div id="tk-pagination" class="tk-pagination hidden"></div>`;

  fillSelect("tk-status", state.statuses, document.getElementById("tk-status"));
  fillSelect("tk-priority", state.priorities, document.getElementById("tk-priority"));
  if (document.getElementById("tk-branch")) fillSelect("tk-branch", state.branches, document.getElementById("tk-branch"));

  // Ticket list is server-paginated (see server.js's GET /api/tickets /
  // data.getTickets) rather than fetching every matching ticket at once -
  // with 2,000+ tickets in the system, "All Tickets"/"My Queue" would
  // otherwise ship the entire table to the browser on every load. tkPage
  // resets to 1 whenever a filter changes (see the "change"/Enter
  // listeners below) so a new search/filter always starts from the top of
  // its own results rather than page 7 of the PREVIOUS filter's results.
  const TK_PAGE_SIZE = 10;
  let tkPage = 1;

  const load = async () => {
    const q = document.getElementById("tk-search").value.trim();
    const status = document.getElementById("tk-status").value;
    const priority = document.getElementById("tk-priority").value;
    const branchEl = document.getElementById("tk-branch");
    const branch = branchEl ? branchEl.value : "";
    const date = document.getElementById("tk-date").value;
    const extraEl = document.getElementById("tk-extra");
    const extra = extraEl ? extraEl.value : "All";
    // extra is "All", or "<kind>:<value>" where kind is "void", "reopen", or "province".
    const [extraKind, extraValue] = extra === "All" ? [null, null] : extra.split(":");
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (status !== "All") params.set("status", status);
    if (priority !== "All") params.set("priority", priority);
    if (branch && branch !== "All") params.set("branch", branch);
    if (date) params.set("date", date);
    if (extraKind === "void") params.set("void_status", extraValue);
    if (extraKind === "reopen") params.set("reopen_status", extraValue);
    if (extraKind === "province") params.set("province", extraValue);
    if (state.pendingFilter) params.set("assigned_to", state.pendingFilter.assignedTo);
    params.set("page", tkPage);
    params.set("page_size", TK_PAGE_SIZE);
    const { tickets, total } = await api(`/tickets?${params.toString()}`);
    const listEl = document.getElementById("tk-list");
    if (!listEl || !root.contains(listEl)) return; // view was replaced while loading
    listEl.innerHTML = tickets.length
      ? `<div class="ticket-list">${tickets.map(ticketCardHtml).join("")}</div>`
      : `<div class="empty-state"><div class="glyph">∅</div>No tickets match.</div>`;
    wireTicketCardClicks();
    renderTkPagination(total, tickets.length);
  };

  // "Showing X to Y of Z entries" + Previous/Next, mirroring a typical
  // DataTables footer. Hidden entirely once everything fits on one page
  // (total <= TK_PAGE_SIZE), so it doesn't clutter small result sets.
  const renderTkPagination = (total, shownCount) => {
    const pagEl = document.getElementById("tk-pagination");
    if (!pagEl) return;
    if (total === null || total === undefined || total <= TK_PAGE_SIZE) {
      pagEl.classList.add("hidden");
      pagEl.innerHTML = "";
      return;
    }
    const totalPages = Math.max(1, Math.ceil(total / TK_PAGE_SIZE));
    const from = shownCount === 0 ? 0 : (tkPage - 1) * TK_PAGE_SIZE + 1;
    const to = (tkPage - 1) * TK_PAGE_SIZE + shownCount;
    pagEl.classList.remove("hidden");
    pagEl.innerHTML = `
      <span class="tk-pagination-info">Showing ${from} to ${to} of ${total.toLocaleString()} entries</span>
      <div class="tk-pagination-controls">
        <button class="btn btn-secondary btn-sm" id="tk-prev" ${tkPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="tk-pagination-page">Page ${tkPage} of ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" id="tk-next" ${tkPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>`;
    const prevBtn = document.getElementById("tk-prev");
    const nextBtn = document.getElementById("tk-next");
    if (prevBtn) prevBtn.onclick = () => { tkPage -= 1; load(); };
    if (nextBtn) nextBtn.onclick = () => { tkPage += 1; load(); };
  };

  document.getElementById("tk-refresh").onclick = () => { tkPage = 1; load(); };
  document.getElementById("tk-search").addEventListener("keydown", e => { if (e.key === "Enter") { tkPage = 1; load(); } });
  ["tk-status", "tk-priority", "tk-branch", "tk-extra", "tk-date"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => { tkPage = 1; load(); });
  });
  state.liveRefresh = load; // lets syncTickets reload this list in place (same filters + page)
  await load();
}

function clearPendingFilter() {
  goTab("tickets");
}

function fillSelect(id, items, el) {
  items.forEach(i => {
    const opt = document.createElement("option");
    opt.value = i; opt.textContent = i;
    el.appendChild(opt);
  });
}

// ---------------------------------------------------------------- Ticket detail modal

async function openTicketDetail(id) {
  const { ticket: t } = await api(`/tickets/${id}`);
  state.openTicketId = id;
  state.openTicketSig = ticketSig(t);
  const isSuperAdmin = state.user.role === "Super Admin";
  const isItDept = state.user.role === "IT Department";
  // Whether this IT Department viewer is the ticket's own assignee (or it's
  // unassigned, the rare leftover case - see data.createTicket). A Super
  // Admin can always manage; an IT Department account can only manage a
  // ticket that's actually theirs - anyone else viewing it (e.g. a
  // colleague who got the broadcast half of a Super Admin's "poke", or just
  // followed a link to it) gets a view-only ticket: they can still read
  // everything and leave a comment to nudge the assignee, but can't touch
  // status, province, or file a void/reopen request themselves. See the
  // matching checks on /status, /province, /void/request, /reopen/request
  // and /assign in server.js - this mirrors those, it doesn't replace them.
  const isOwnTicket = !t.assigned_to || t.assigned_to === state.user.id || (t.collaborator_ids || []).includes(state.user.id);
  const canManage = isSuperAdmin || (isItDept && isOwnTicket);
  // Only Super Admin may hand a ticket to an arbitrary staff member. IT
  // Department accounts can only move a ticket to themselves, via the
  // "Take over (assist)" action below - not through a free-choice dropdown.
  const canReassign = isSuperAdmin;
  // "Take over" only applies when the current assignee is genuinely
  // unavailable today (see data.isUserUnavailableToday) - otherwise this
  // ticket is just someone else's active work, not something to cover for.
  const canAssist = isItDept && !isOwnTicket && !!t.assignee_unavailable_today;
  // A view-only visit: an IT Department account looking at a ticket that
  // isn't theirs and isn't up for grabs (assignee's still around today).
  const isViewOnly = isItDept && !isOwnTicket && !canAssist;
  // An IT Department account can ask a Super Admin to void a ticket that
  // shouldn't be worked (duplicate, spam, unreproducible, etc.) as long as
  // there's no live request already - a past decline doesn't block trying
  // again with a better reason. Same ownership rule as canManage above.
  const canRequestVoid = isItDept && isOwnTicket && (t.void_status === "None" || t.void_status === "Rejected");
  const canDecideVoid = isSuperAdmin && t.void_status === "Requested";
  // An IT Department account (owning the ticket) OR the branch/requester
  // who originally created it can ask a Super Admin to reopen a Resolved
  // ticket whose issue has come back - only while it's actually Resolved,
  // still within the 24-hour reopen window (see REOPEN_WINDOW_MS below -
  // mirrors data.REOPEN_WINDOW_HOURS/isWithinReopenWindow server-side),
  // and there's no live request already (a past decline doesn't block
  // trying again with fresh details, same as void requests above). The
  // creator path exists so a branch with a recurring issue has a real
  // "this came back" action instead of filing a brand-new ticket every
  // time - see server.js's /reopen/request for the matching check.
  const isTicketCreator = t.created_by === state.user.id;
  const withinReopenWindow = !!t.resolved_at && (Date.now() - new Date(t.resolved_at).getTime()) <= REOPEN_WINDOW_MS;
  const canRequestReopen = (isTicketCreator || (isItDept && isOwnTicket)) && t.status === "Resolved" && withinReopenWindow && (t.reopen_status === "None" || t.reopen_status === "Rejected" || t.reopen_status === "Approved");
  // Reopen requests are decided by the ticket's own IT Department assignee
  // (the person who'll actually pick the work back up) OR a Super Admin as
  // a fallback/override - unlike void requests, which stay Super-Admin-only,
  // since a reopen is really "is this yours to reopen", not "should this
  // count against reports at all".
  const canDecideReopen = (isSuperAdmin || (isItDept && isOwnTicket)) && t.reopen_status === "Requested";
  // Images are attached by whoever raised the ticket (usually at submission
  // time) - IT staff can view them to understand the issue but shouldn't
  // need to add their own, so uploading stays limited to the creator.
  // Branch Staff and Head Office accounts no longer get the image feature
  // at all (no "Add image" button, no Attachments section) - see
  // isBranchOrHeadOffice below.
  const isBranchOrHeadOffice = ["Branch Staff", "Head Office Employee"].includes(state.user.role);
  const canUploadImage = t.created_by === state.user.id && !isBranchOrHeadOffice;
  const showAttachments = !isBranchOrHeadOffice;
  // Comments are IT Department/Super Admin's internal thread on a ticket -
  // a Branch Staff/Head Office account never sees it (the server already
  // withholds t.comments from them and rejects a POST to add one - see
  // server.js), so the whole section is left out of their view too.
  // Within IT/Super Admin, comments stay open regardless of who a ticket is
  // assigned to - unlike status/province/void/reopen (which the "view
  // only" restriction above locks to the ticket's own assignee), leaving a
  // comment is exactly how a colleague who got a Super Admin's "poke"
  // broadcast (or just found the ticket) follows up with the assignee
  // without touching the ticket itself. The assignee gets notified when
  // someone else comments - see server.js's /comments route.
  const canSeeComments = isSuperAdmin || isItDept;
  // A Super Admin can nudge whoever the ticket is currently assigned to -
  // doesn't make sense (and isn't offered) for a Resolved ticket, or one
  // with nobody assigned to actually poke.
  const canPoke = isSuperAdmin && t.status !== "Resolved" && !!t.assigned_to;

  let staffOptions = "";
  if (canReassign) {
    if (!state.itStaff.length) {
      const r = await api("/it-staff");
      state.itStaff = r.staff;
    }
    // No "Unassigned" option - every ticket must always be assigned to a
    // real IT staff member, so reassigning here only ever moves it between
    // people, never clears it.
    staffOptions = state.itStaff.map(s =>
      `<option value="${s.id}" ${t.assigned_to === s.id ? "selected" : ""}>${escapeHtml(s.full_name)}</option>`).join("");
  }

  let voidSectionHtml = "";
  if (t.void_status === "Requested") {
    voidSectionHtml = `
      <div class="notice-item" style="margin-top:14px; padding:12px; background:#FFFBFB; border:1px solid #FCA5A5; border-radius:var(--radius-sm); align-items:flex-start;">
        <div>
          <span class="who">Void requested by ${escapeHtml(t.void_requested_by_name || "—")}</span>
          <div class="muted" style="margin-top:2px;">${fmtDateTime(t.void_requested_at)}</div>
          <div style="margin-top:6px;">${escapeHtml(t.void_reason || "")}</div>
        </div>
        ${!canDecideVoid ? `<span class="badge badge-requested">Awaiting Super Admin</span>` : ""}
      </div>`;
  } else if (t.void_status === "Voided") {
    voidSectionHtml = `
      <div class="notice-item" style="margin-top:14px; padding:12px; background:var(--ink-100); border-radius:var(--radius-sm);">
        <div>
          <span class="who">This ticket has been voided.</span>
          <div class="muted" style="margin-top:4px;">${escapeHtml(t.void_reason || "")}${t.void_decision_note ? " — " + escapeHtml(t.void_decision_note) : ""}</div>
        </div>
      </div>`;
  } else if (t.void_status === "Rejected") {
    voidSectionHtml = `
      <div class="muted" style="margin-top:14px;">A void request for this ticket was declined${t.void_decision_note ? ": " + escapeHtml(t.void_decision_note) : "."}</div>`;
  }

  let reopenSectionHtml = "";
  if (t.reopen_status === "Requested") {
    reopenSectionHtml = `
      <div class="notice-item" style="margin-top:14px; padding:12px; background:#FFFBF0; border:1px solid #F3D08A; border-radius:var(--radius-sm); align-items:flex-start;">
        <div>
          <span class="who">Reopen requested by ${escapeHtml(t.reopen_requested_by_name || "—")}</span>
          <div class="muted" style="margin-top:2px;">${fmtDateTime(t.reopen_requested_at)}</div>
          <div style="margin-top:6px;">${escapeHtml(t.reopen_reason || "")}</div>
        </div>
        ${!canDecideReopen ? `<span class="badge badge-requested">Awaiting IT staff</span>` : ""}
      </div>`;
  } else if (t.reopen_status === "Rejected") {
    reopenSectionHtml = `
      <div class="muted" style="margin-top:14px;">A reopen request for this ticket was declined${t.reopen_decision_note ? ": " + escapeHtml(t.reopen_decision_note) : "."}</div>`;
  }

  // Shown to anyone who can manage the ticket (i.e. the assignee will see
  // it too) whenever a Super Admin has poked it and nobody's acted since -
  // cleared automatically the moment the status changes or a comment is
  // added (see data.updateTicketStatus/addComment).
  let pokeSectionHtml = "";
  if (t.poked_at && canManage) {
    pokeSectionHtml = `
      <div class="note-callout" style="margin-top:14px;">
        <strong>🔔 Follow-up requested</strong> by ${escapeHtml(t.poked_by_name || "a Super Admin")} on ${fmtDateTime(t.poked_at)} — this ticket needs an update.
      </div>`;
  }

  // Every actionable button lives in the footer (not scattered through the
  // body next to the field it acts on) so the modal always ends with a
  // single, consistent action bar - the fields/forms above stay purely for
  // input.
  const footerButtons = [];
  if (canAssist) footerButtons.push(`<button class="btn btn-primary btn-sm" id="d-assist">Take over (assist)</button>`);
  if (canDecideVoid) {
    footerButtons.push(`<button class="btn btn-primary btn-sm" id="d-void-approve">Approve void</button>`);
    footerButtons.push(`<button class="btn btn-secondary btn-sm" id="d-void-reject">Decline void</button>`);
  }
  if (canDecideReopen) {
    footerButtons.push(`<button class="btn btn-primary btn-sm" id="d-reopen-approve">Approve reopen</button>`);
    footerButtons.push(`<button class="btn btn-secondary btn-sm" id="d-reopen-reject">Decline reopen</button>`);
  }
  if (canManage) footerButtons.push(`<button class="btn btn-secondary btn-sm" id="d-save">Save changes</button>`);
  if (canPoke) footerButtons.push(`<button class="btn btn-secondary btn-sm" id="d-poke">🔔 Poke for follow-up</button>`);
  if (canRequestVoid) footerButtons.push(`<button class="btn btn-danger btn-sm" id="d-void-request">Request void</button>`);
  if (canRequestReopen) footerButtons.push(`<button class="btn btn-danger btn-sm" id="d-reopen-request">Request reopen</button>`);
  if (canUploadImage) footerButtons.push(`<button class="btn btn-secondary btn-sm" id="d-add-image">Add image</button>`);
  if (canSeeComments) footerButtons.push(`<button class="btn btn-primary btn-sm" id="d-comment-btn">Post comment</button>`);

  // The ticket title is auto-derived from the description's first line
  // (see deriveTicketTitle) - so for the common case of a short, single-
  // line description, the two are identical or near-identical. Showing
  // both a title in the header AND the full text again in the body reads
  // as the same sentence twice, so the header stays a plain ticket number
  // and the body gets one clearly-labeled "Description" section instead.
  //
  // "Submitted by" is likewise dropped when it's just the branch account
  // submitting for its own branch (creator name === branch name) - that's
  // already conveyed by "Branch" above it and repeating it added nothing.
  // It still shows whenever someone submits on a branch's behalf (Head
  // Office staff, etc.), where the two genuinely differ. Also dropped when
  // the creator's name is missing or just a placeholder dash ("-") -
  // usually a shared branch login whose account was never given a real
  // staff name - since showing a bare "-" reads as broken/blank rather
  // than as an actual submitter, and hiding it here matches the "no real
  // name to show" treatment above.
  //
  // "Last update" is dropped when it's still exactly the ticket's creation
  // timestamp (nothing has happened to it since) rather than showing the
  // same date/time as "Created" a second time.
  const creatorNameTrimmed = (t.creator_name || "").trim();
  const hideSubmittedBy = !creatorNameTrimmed || creatorNameTrimmed === "-"
    || creatorNameTrimmed.toLowerCase() === (t.branch || "").trim().toLowerCase();
  const hasBeenUpdated = t.updated_at !== t.created_at;

  openModal(`
    <div class="modal-header"${escalationDeadline(t) ? ` data-esc-deadline="${escalationDeadline(t)}"` : ""}>
      <h2>#T-${String(t.id).padStart(5, "0")}</h2>
      <button class="modal-close" onclick="closeModal()">✕</button>
    </div>
    <div class="modal-body">
      <div style="display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap;">${escalationBadge(t)}${priorityBadge(t.priority)}${statusBadge(t.status)}${voidBadge(t)}${reopenBadge(t)}${provinceBadge(t)}<span class="badge badge-neutral">${escapeHtml(t.category)}</span></div>

      <div class="section-title">Description</div>
      <p style="white-space:pre-wrap; line-height:1.5;">${escapeHtml(t.description)}</p>

      <div class="section-title">Details</div>
      <table>
        <tr><td class="muted">Branch</td><td>${escapeHtml(t.branch)}${t.branch_corporation ? `<div class="muted" style="font-size:11px;margin-top:2px;">${escapeHtml(t.branch_corporation)}</div>` : ""}</td></tr>
        <tr><td class="muted">Person Concerned</td><td>${escapeHtml(t.concern_name || "—")}</td></tr>
        ${t.anydesk_number ? `<tr><td class="muted">AnyDesk number</td><td>${escapeHtml(t.anydesk_number)}</td></tr>` : ""}
        ${t.branch_number ? `<tr><td class="muted">Branch number</td><td>${escapeHtml(t.branch_number)}</td></tr>` : ""}
        ${hideSubmittedBy ? "" : `<tr><td class="muted">Submitted by</td><td>${escapeHtml(t.creator_name)}</td></tr>`}
        <tr><td class="muted">Assigned to</td><td>${escapeHtml(t.assignee_name || "Unassigned")}${(t.collaborator_names || []).length ? ` <span class="muted">with ${escapeHtml((t.collaborator_names || []).join(", "))}</span>` : ""}</td></tr>
        <tr><td class="muted">Created</td><td>${fmtDateTime(t.created_at)}</td></tr>
        ${hasBeenUpdated ? `<tr><td class="muted">Last update</td><td>${fmtDateTime(t.updated_at)}</td></tr>` : ""}
      </table>

      ${canAssist ? `
      <div class="notice-item" style="margin-top:14px; padding:12px; background:var(--accent-ink); border-radius:var(--radius-sm);">
        <div>
          <span class="who">Currently assigned to ${escapeHtml(t.assignee_name)}, who's unavailable today.</span>
          <div class="muted">Taking over reassigns this ticket to you and logs the assist. Use "Take over" below.</div>
        </div>
      </div>` : ""}

      ${isViewOnly ? `
      <div class="notice-item" style="margin-top:14px; padding:12px; background:var(--ink-100); border-radius:var(--radius-sm);">
        <div>
          <span class="who">Assigned to ${escapeHtml([t.assignee_name, ...(t.collaborator_names || [])].filter(Boolean).join(", ") || "—")}.</span>
          <div class="muted">You can view this ticket and leave a comment, but only they or a Super Admin can update it.</div>
        </div>
      </div>` : ""}

      ${voidSectionHtml}
      ${reopenSectionHtml}
      ${pokeSectionHtml}

      ${canManage ? `
      <div class="section-title">Manage</div>
      <div class="form-row">
        <div>
          <label>Status</label>
          <select id="d-status">${state.statuses.map(s => `<option value="${s}" ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select>
        </div>
        ${canReassign ? `
        <div>
          <label>Assigned to</label>
          <select id="d-assignee">${staffOptions}</select>
        </div>` : `
        <div>
          <label>Assigned to</label>
          <div class="muted" style="padding-top:10px;">${escapeHtml(t.assignee_name || "Unassigned")} <span style="font-size:11.5px;">(only a Super Admin can reassign)</span></div>
        </div>`}
      </div>
      ${canReassign ? `
      <div style="margin-top:12px;">
        <label>Working together (optional)</label>
        <select id="d-collaborators" multiple size="4" style="height:auto;">
          ${state.itStaff.map(s =>
            `<option value="${s.id}" ${(t.collaborator_ids || []).includes(s.id) ? "selected" : ""}>${escapeHtml(s.full_name)}</option>`
          ).join("")}
        </select>
        <div class="muted" style="font-size:12px; margin-top:2px;">
          Ctrl/Cmd-click to select more than one. Everyone added here gets the same access as the assignee above (status, comments, resolving it) and is notified they've been added.
        </div>
      </div>` : ""}
      <label style="display:flex; align-items:center; gap:8px; margin-top:12px; font-weight:400;">
        <input type="checkbox" id="d-province" ${t.is_province ? "checked" : ""} style="width:auto;">
        Province / needs a physical site visit
      </label>
      <div class="muted" style="font-size:12px; margin-top:2px;">
        Excludes this ticket entirely from IT performance reports, so travel time to site isn't counted against whoever's assigned.
      </div>
      ` : ""}

      ${canRequestVoid ? `
      <div class="section-title">Request a void</div>
      <div class="muted">If this ticket shouldn't be worked — a duplicate, spam, or something that can't be reproduced — ask a Super Admin to void it. Use "Request void" below once you've explained why.</div>
      <textarea id="d-void-reason" placeholder="Why should this ticket be voided?" style="margin-top:8px;"></textarea>
      ` : ""}

      ${canRequestReopen ? `
      <div class="section-title">Request a reopen</div>
      <div class="muted">If this same issue has come back, ask IT to reopen this ticket instead of filing a fresh one — it goes to the assigned IT staffer for approval. Only available within 24 hours of this ticket being marked Resolved. Use "Request reopen" below once you've explained what's recurring.</div>
      <textarea id="d-reopen-reason" placeholder="What's happening again?" style="margin-top:8px;"></textarea>
      ` : (t.status === "Resolved" && t.resolved_at && !withinReopenWindow && (isTicketCreator || (isItDept && isOwnTicket)) && (t.reopen_status === "None" || t.reopen_status === "Rejected" || t.reopen_status === "Approved") ? `
      <div class="muted" style="margin-top:14px;">The 24-hour window to request a reopen on this ticket has passed. If this issue happens again, please submit a new ticket.</div>
      ` : "")}

      ${(t.assists && t.assists.length) ? `
      <div class="section-title">Assist history</div>
      <div id="d-assists">${t.assists.map(a => `
        <div class="comment">
          <div class="comment-head"><strong>${escapeHtml(a.assisted_by_name)}</strong><span>${fmtDateTime(a.assisted_at)}</span></div>
          <div class="muted">Covered for ${escapeHtml(a.original_assignee_name || "unassigned")}${a.note ? " — " + escapeHtml(a.note) : ""}</div>
        </div>`).join("")}</div>` : ""}

      ${showAttachments ? `
      <div class="section-title">Attachments</div>
      <div id="d-attachments">${(t.attachments || []).map(a => {
        const url = a.file_path.startsWith("http") ? a.file_path : `/api/attachments/${a.file_path}`;
        return `<a href="${url}" target="_blank"><img class="attachment-thumb" src="${url}" alt="${escapeHtml(a.original_filename)}"></a>`;
      }).join("") || `<span class="muted">No images attached.</span>`}</div>
      ${canUploadImage ? `<input type="file" id="d-file" accept="image/*" class="hidden">` : ""}
      ` : ""}

      ${canSeeComments ? `
      <div class="section-title">Comments</div>
      <div id="d-comments">${(t.comments || []).map(c => `
        <div class="comment">
          <div class="comment-head"><strong>${escapeHtml(c.full_name)}</strong><span>${fmtDateTime(c.created_at)}</span></div>
          <div>${escapeHtml(c.comment)}</div>
        </div>`).join("") || `<span class="muted">No comments yet.</span>`}</div>
      <textarea id="d-comment-text" placeholder="Add a comment…" style="margin-top:10px;"></textarea>
      ` : ""}
    </div>
    <div class="modal-footer" style="flex-wrap:wrap; justify-content:space-between; align-items:center;">
      <button class="btn btn-secondary btn-sm" onclick="closeModal()">Close</button>
      <div style="display:flex; gap:10px; flex-wrap:wrap; justify-content:flex-end;">${footerButtons.join("")}</div>
    </div>
  `);

  if (canUploadImage) {
    document.getElementById("d-add-image").onclick = () => document.getElementById("d-file").click();
  }

  if (canAssist) {
    const assistBtn = document.getElementById("d-assist");
    assistBtn.onclick = async () => {
      setBtnLoading(assistBtn, true);
      try {
        await api(`/tickets/${id}/assists`, { method: "POST", body: { note: `Covering for ${t.assignee_name} (unavailable)` } });
        await api(`/tickets/${id}/assign`, { method: "POST", body: { assignee_id: state.user.id } });
        if (t.status === "Open") await api(`/tickets/${id}/status`, { method: "POST", body: { status: "In Progress" } });
        toast("You're now assisting on this ticket.", "success");
        closeModal();
        goTab(state.tab);
        refreshAssistAlert();
      } catch (e) { toast(e.message, "error"); setBtnLoading(assistBtn, false); }
    };
  }

  if (canPoke) {
    const pokeBtn = document.getElementById("d-poke");
    pokeBtn.onclick = async () => {
      setBtnLoading(pokeBtn, true);
      try {
        await api(`/tickets/${id}/poke`, { method: "POST" });
        const notified = [t.assignee_name, ...(t.collaborator_names || [])].filter(Boolean).join(", ");
        toast(`${notified} has been notified.`, "success");
        openTicketDetail(id);
      } catch (e) { toast(e.message, "error"); setBtnLoading(pokeBtn, false); }
    };
  }

  if (canDecideVoid) {
    const voidApproveBtn = document.getElementById("d-void-approve");
    voidApproveBtn.onclick = async () => {
      if (!confirm("Void this ticket? This can't be undone.")) return;
      try {
        await api(`/tickets/${id}/void/decide`, { method: "POST", body: { approve: true } }, voidApproveBtn);
        toast("Ticket voided.", "success");
        closeModal();
        goTab(state.tab);
        refreshAssistAlert();
      } catch (e) { toast(e.message, "error"); }
    };
    const voidRejectBtn = document.getElementById("d-void-reject");
    voidRejectBtn.onclick = async () => {
      const note = prompt("Optional note for declining this request:") || "";
      try {
        await api(`/tickets/${id}/void/decide`, { method: "POST", body: { approve: false, note } }, voidRejectBtn);
        toast("Void request declined.", "success");
        closeModal();
        goTab(state.tab);
        refreshAssistAlert();
      } catch (e) { toast(e.message, "error"); }
    };
  }

  if (canRequestVoid) {
    const voidRequestBtn = document.getElementById("d-void-request");
    voidRequestBtn.onclick = async () => {
      const reason = document.getElementById("d-void-reason").value.trim();
      if (!reason) { toast("Please explain why this ticket should be voided.", "error"); return; }
      try {
        await api(`/tickets/${id}/void/request`, { method: "POST", body: { reason } }, voidRequestBtn);
        toast("Void request sent to the Super Admin.", "success");
        closeModal();
        goTab(state.tab);
      } catch (e) { toast(e.message, "error"); }
    };
  }

  if (canDecideReopen) {
    const reopenApproveBtn = document.getElementById("d-reopen-approve");
    reopenApproveBtn.onclick = async () => {
      if (!confirm("Approve reopening this ticket? It will move back to In Progress.")) return;
      try {
        await api(`/tickets/${id}/reopen/decide`, { method: "POST", body: { approve: true } }, reopenApproveBtn);
        toast("Ticket reopened.", "success");
        closeModal();
        goTab(state.tab);
        refreshAssistAlert();
      } catch (e) { toast(e.message, "error"); }
    };
    const reopenRejectBtn = document.getElementById("d-reopen-reject");
    reopenRejectBtn.onclick = async () => {
      const note = prompt("Optional note for declining this request:") || "";
      try {
        await api(`/tickets/${id}/reopen/decide`, { method: "POST", body: { approve: false, note } }, reopenRejectBtn);
        toast("Reopen request declined.", "success");
        closeModal();
        goTab(state.tab);
        refreshAssistAlert();
      } catch (e) { toast(e.message, "error"); }
    };
  }

  if (canRequestReopen) {
    const reopenRequestBtn = document.getElementById("d-reopen-request");
    reopenRequestBtn.onclick = async () => {
      const reason = document.getElementById("d-reopen-reason").value.trim();
      if (!reason) { toast("Please explain what's recurring.", "error"); return; }
      try {
        await api(`/tickets/${id}/reopen/request`, { method: "POST", body: { reason } }, reopenRequestBtn);
        toast("Reopen request sent to IT for approval.", "success");
        closeModal();
        goTab(state.tab);
      } catch (e) { toast(e.message, "error"); }
    };
  }

  if (canManage) {
    const saveBtn = document.getElementById("d-save");
    saveBtn.onclick = async () => {
      setBtnLoading(saveBtn, true);
      try {
        const status = document.getElementById("d-status").value;
        await api(`/tickets/${id}/status`, { method: "POST", body: { status } });
        if (canReassign) {
          const assignee = document.getElementById("d-assignee").value;
          await api(`/tickets/${id}/assign`, { method: "POST", body: { assignee_id: assignee ? Number(assignee) : null } });
          const collaboratorIds = Array.from(document.getElementById("d-collaborators").selectedOptions).map(o => Number(o.value));
          await api(`/tickets/${id}/collaborators`, { method: "POST", body: { user_ids: collaboratorIds } });
        }
        const isProvince = document.getElementById("d-province").checked;
        if (isProvince !== !!t.is_province) {
          await api(`/tickets/${id}/province`, { method: "POST", body: { is_province: isProvince } });
        }
        toast("Ticket updated.", "success");
        closeModal();
        goTab(state.tab);
      } catch (e) { toast(e.message, "error"); setBtnLoading(saveBtn, false); }
    };
  }

  document.getElementById("d-file")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      await api(`/tickets/${id}/attachments`, { method: "POST", formData: fd });
      toast("Attachment uploaded.", "success");
      openTicketDetail(id);
    } catch (err) { toast(err.message, "error"); }
  });

  if (canSeeComments) {
    const commentBtn = document.getElementById("d-comment-btn");
    commentBtn.onclick = async () => {
      const comment = document.getElementById("d-comment-text").value.trim();
      if (!comment) return;
      try {
        await api(`/tickets/${id}/comments`, { method: "POST", body: { comment } }, commentBtn);
        openTicketDetail(id);
      } catch (err) { toast(err.message, "error"); }
    };
  }
}

// ---------------------------------------------------------------- New ticket

// The ticket record still needs a title internally (ticket cards, tables,
// and void notices all display it) even though the submission form no
// longer asks the branch for one separately - it's derived from the first
// line of the description instead.
function deriveTicketTitle(description) {
  const firstLine = (description.split("\n")[0] || "").trim();
  const base = firstLine || description.trim();
  return base.length > 80 ? base.slice(0, 77).trimEnd() + "…" : base;
}

async function renderNewTicket(root) {
  // A Branch Staff/Head Office account's own username IS a specific branch,
  // so the server is happy to default the ticket's branch to user.branch for
  // them. A Super Admin isn't tied to one branch that way, so give them an
  // explicit picker instead of silently filing everything under whatever
  // branch their own login happens to be seeded with.
  const isSuperAdmin = state.user.role === "Super Admin";

  // Only a Super Admin gets to hand-pick who receives the ticket (and who
  // else works on it alongside them) - everyone else still goes through
  // the normal balanced auto-assignment in data.createTicket, same as
  // before. Reuses the same state.itStaff cache the ticket detail modal's
  // reassign/collaborators controls already rely on.
  if (isSuperAdmin && !state.itStaff.length) {
    const r = await api("/it-staff");
    state.itStaff = r.staff;
  }
  root.innerHTML = `
    <div class="panel"><div class="panel-body" style="max-width:560px;">
      <div id="nt-error" class="form-error hidden"></div>
      <div class="form-row">
        <div><label>Category</label><select id="nt-category">${state.categories.map(c => `<option>${c}</option>`).join("")}</select></div>
        <div><label>Priority</label><select id="nt-priority">${state.priorities.map(p => `<option>${p}</option>`).join("")}</select></div>
      </div>
      ${isSuperAdmin ? `
      <div class="form-row">
        <div>
          <label>Branch</label>
          <select id="nt-branch">
            <optgroup label="Branches">${state.branches.map(b => `<option>${escapeHtml(b)}</option>`).join("")}</optgroup>
            <optgroup label="Departments">${state.departments.map(d => `<option>${escapeHtml(d)}</option>`).join("")}</optgroup>
          </select>
        </div>
        <div>
          <label>Assign to</label>
          <select id="nt-assignee">
            <option value="">Auto-assign (balanced)</option>
            ${state.itStaff.map(s => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div style="margin-bottom:14px;">
        <label>Working together (optional)</label>
        <select id="nt-collaborators" multiple size="4" style="height:auto;">
          ${state.itStaff.map(s => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`).join("")}
        </select>
        <div class="muted" style="font-size:12px; margin-top:2px;">
          Ctrl/Cmd-click to select more than one. Everyone added here gets the same access as the assignee above (status, comments, resolving it) and is notified they've been added.
        </div>
      </div>
      ` : ""}
      <label>Description</label>
      <textarea id="nt-desc" placeholder="What's happening? Steps to reproduce, error messages, etc."></textarea>
      <div class="form-row">
        <div>
          <label>First Name (person concerned)</label>
          <input id="nt-concern-first" type="text" placeholder="e.g. Juan">
        </div>
        <div>
          <label>Last Name (person concerned)</label>
          <input id="nt-concern-last" type="text" placeholder="e.g. Cruz">
        </div>
      </div>
      <div class="form-row">
        <div>
          <label>AnyDesk Number (optional)</label>
          <input id="nt-anydesk" type="text" placeholder="e.g. 123 456 789">
        </div>
        <div>
          <label>Branch Number (optional)</label>
          <input id="nt-branch-number" type="text" placeholder="e.g. Branch 04">
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:18px;" id="nt-submit">Submit ticket</button>
    </div></div>`;

  const submitBtn = document.getElementById("nt-submit");
  submitBtn.onclick = async () => {
    const description = document.getElementById("nt-desc").value.trim();
    const category = document.getElementById("nt-category").value;
    const priority = document.getElementById("nt-priority").value;
    const concernFirst = document.getElementById("nt-concern-first").value.trim();
    const concernLast = document.getElementById("nt-concern-last").value.trim();
    const concern_name = `${concernFirst} ${concernLast}`.trim();
    const anydesk_number = document.getElementById("nt-anydesk").value.trim();
    const branch_number = document.getElementById("nt-branch-number").value.trim();
    const branchSelect = document.getElementById("nt-branch");
    const branch = branchSelect ? branchSelect.value : undefined;
    const assigneeSelect = document.getElementById("nt-assignee");
    const assigned_to = assigneeSelect && assigneeSelect.value ? Number(assigneeSelect.value) : undefined;
    const collaboratorsSelect = document.getElementById("nt-collaborators");
    const collaborator_ids = collaboratorsSelect
      ? Array.from(collaboratorsSelect.selectedOptions).map(o => Number(o.value))
      : undefined;
    const errBox = document.getElementById("nt-error");
    errBox.classList.add("hidden");
    if (!description) {
      errBox.textContent = "Please describe the issue.";
      errBox.classList.remove("hidden");
      return;
    }
    if (!concernFirst || !concernLast) {
      errBox.textContent = "Please enter both the first and last name of the person this concern is for.";
      errBox.classList.remove("hidden");
      return;
    }
    const title = deriveTicketTitle(description);
    setBtnLoading(submitBtn, true);
    try {
      const res = await api("/tickets", {
        method: "POST",
        body: { title, description, category, priority, concern_name, anydesk_number, branch_number, branch, assigned_to, collaborator_ids },
      });
      toast(`Ticket #T-${String(res.ticket_id).padStart(5, "0")} submitted.`, "success");
      goTab("tickets");
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
      setBtnLoading(submitBtn, false);
    }
  };
}

// ---------------------------------------------------------------- Accounts (Super Admin)

const ACCOUNT_ROLES_FILTER = ["Super Admin", "IT Department", "Head Office Employee", "Branch Staff"];

// Normal / BSP Mode switch (Super Admin). Shown on both the Accounts page and
// IT Staff & Availability so it's easy to find.
function systemModePanelHtml(mode) {
  // Restricted admin portal (can_change_mode = false): no system mode panel
  // at all. The server enforces this too (POST /api/settings/mode).
  if (state.modeLocked || (state.user && state.user.can_change_mode === false)) return "";
  return `
    <div class="panel">
      <div class="panel-header"><h3>System mode</h3></div>
      <div class="panel-body">
        <p class="muted">
          <strong>Normal</strong> — tickets go to any IT staffer, as usual; Line of Business tags are ignored.<br>
          <strong>BSP Mode</strong> — tagged IT staff only receive, see and report on tickets from branches under their own Line of Business, including tickets already resolved. Tickets from other Lines are hidden from their dashboard, queue, counts and reports. Staff tagged <strong>Global</strong> see every branch partnered with Global instead. Untagged staff or branches aren't restricted. Switch back to <strong>Normal</strong> to restore the original behavior.
        </p>
        <div id="system-mode-toggle" style="display:flex; gap:8px;">
          <button type="button" class="btn ${mode === "normal" ? "btn-primary" : "btn-secondary"}" data-mode="normal">Normal</button>
          <button type="button" class="btn ${mode === "bsp" ? "btn-primary" : "btn-secondary"}" data-mode="bsp">BSP Mode</button>
        </div>
      </div>
    </div>`;
}
function wireSystemModePanel(root, currentMode, tab) {
  root.querySelectorAll("#system-mode-toggle [data-mode]").forEach(btn => {
    btn.onclick = async () => {
      const mode = btn.dataset.mode;
      if (mode === currentMode) return;
      try {
        await api("/settings/mode", { method: "POST", body: { mode } }, btn);
        toast(mode === "bsp" ? "BSP Mode is now on." : "Switched back to Normal.", "success");
        goTab(tab);
      } catch (e) { toast(e.message, "error"); }
    };
  });
}

// Seasonal theme switch (Super Admin only - the server enforces this too).
const SITE_THEME_OPTIONS = [
  { id: "none", label: "Off" },
  { id: "halloween", label: "\uD83C\uDF83 Halloween" },
  { id: "christmas", label: "\uD83C\uDF84 Christmas" },
  { id: "newyear", label: "\uD83C\uDF86 New Year" },
  { id: "valentines", label: "\uD83D\uDC96 Valentine's" },
];
function siteThemePanelHtml(theme) {
  return `
    <div class="panel">
      <div class="panel-header"><h3>Site theme</h3></div>
      <div class="panel-body">
        <p class="muted">Applies to everyone, including the sign-in screen. Users can't change it. It updates on other screens within a few minutes (or on their next page load).</p>
        <div id="site-theme-toggle" style="display:flex; gap:8px; flex-wrap:wrap;">
          ${SITE_THEME_OPTIONS.map(o => `<button type="button" class="btn ${theme === o.id ? "btn-primary" : "btn-secondary"}" data-theme="${o.id}">${o.label}</button>`).join("")}
        </div>
      </div>
    </div>`;
}
function wireSiteThemePanel(root, currentTheme, tab) {
  root.querySelectorAll("#site-theme-toggle [data-theme]").forEach(btn => {
    btn.onclick = async () => {
      const theme = btn.dataset.theme;
      if (theme === currentTheme) return;
      try {
        await api("/theme", { method: "POST", body: { theme } }, btn);
        if (window.AppTheme) window.AppTheme.set(theme);
        toast(theme === "none" ? "Theme turned off." : "Theme applied.", "success");
        goTab(tab);
      } catch (e) { toast(e.message, "error"); }
    };
  });
}

async function renderAccounts(root) {
  const actionsEl = document.getElementById("topbar-actions");
  actionsEl.innerHTML = `<button class="btn btn-primary btn-sm" id="new-account-btn">+ New account</button>`;
  document.getElementById("new-account-btn").onclick = () => openAccountModal(null);

  const { users } = await api("/users");
  const modeRes = await api("/settings/mode");
  state.modeLocked = modeRes.can_change === false;
  const systemMode = modeRes.mode;
  const siteTheme = (await api("/theme")).theme;
  root.innerHTML = systemModePanelHtml(systemMode) + siteThemePanelHtml(siteTheme) + `<div class="panel">
    <div class="panel-body" style="display:flex; gap:10px; flex-wrap:wrap; padding-bottom:0;">
      <input id="ac-search" class="grow" type="text" placeholder="Search by name, username, role, branch/dept…" style="flex:1; min-width:200px;">
      <select id="ac-role-filter" style="min-width:160px;">
        <option value="">All roles</option>
        ${ACCOUNT_ROLES_FILTER.map(r => `<option value="${r}">${r}</option>`).join("")}
      </select>
    </div>
    <div class="panel-body table-wrap">
      <table>
        <tr><th>Name</th><th>Username</th><th>Role</th><th>Branch / Dept</th><th>Line of Business</th><th>Concerns</th><th></th></tr>
        <tbody id="ac-rows"></tbody>
      </table>
      <div id="ac-empty" class="muted hidden" style="padding:16px 0;">No accounts match your search.</div>
    </div>
  </div>`;

  wireSystemModePanel(root, systemMode, "accounts");
  wireSiteThemePanel(root, siteTheme, "accounts");

  const searchEl = document.getElementById("ac-search");
  const roleFilterEl = document.getElementById("ac-role-filter");
  const rowsEl = document.getElementById("ac-rows");
  const emptyEl = document.getElementById("ac-empty");

  // "Random words" search across every visible field, plus a role
  // dropdown - both narrow the same underlying list, so they combine (e.g.
  // typing "cruz" while "Branch Staff" is selected only matches Branch
  // Staff accounts with "cruz" somewhere in their fields).
  function accountMatchesSearch(u, query) {
    return matchesSearchWords(
      `${u.full_name} ${u.username} ${u.role} ${u.location || ""} ${u.specialties || ""} ${u.group_name || ""}`,
      query
    );
  }

  function renderFiltered() {
    const query = searchEl.value.trim();
    const roleFilter = roleFilterEl.value;
    const filtered = users.filter(u => (!roleFilter || u.role === roleFilter) && accountMatchesSearch(u, query));

    rowsEl.innerHTML = filtered.map(u => `
        <tr>
          <td>${escapeHtml(u.full_name)}</td>
          <td><code>${escapeHtml(u.username)}</code></td>
          <td>${escapeHtml(u.role)}</td>
          <td>${escapeHtml(u.location || "—")}</td>
          <td>${u.role === "IT Department" ? (u.group_name ? escapeHtml(u.group_name) : `<span class="muted">— none —</span>`) : `<span class="muted">—</span>`}</td>
          <td class="muted">${escapeHtml(u.specialties || "—")}</td>
          <td class="row-actions">
            <button class="btn btn-secondary btn-sm" data-edit="${u.id}">Edit</button>
            <button class="btn btn-danger btn-sm" data-del="${u.id}">Delete</button>
          </td>
        </tr>`).join("");
    emptyEl.classList.toggle("hidden", filtered.length > 0);

    rowsEl.querySelectorAll("[data-edit]").forEach(btn => {
      btn.onclick = () => openAccountModal(users.find(u => u.id == btn.dataset.edit));
    });
    rowsEl.querySelectorAll("[data-del]").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm("Delete this account? This can't be undone.")) return;
        try {
          await api(`/users/${btn.dataset.del}`, { method: "DELETE" }, btn);
          toast("Account deleted.", "success");
          goTab("accounts");
        } catch (e) { toast(e.message, "error"); }
      };
    });
  }

  searchEl.oninput = renderFiltered;
  roleFilterEl.onchange = renderFiltered;
  renderFiltered();
}

async function openAccountModal(user) {
  const isEdit = !!user;
  let lobGroups = [];
  try { lobGroups = (await api("/settings/groups")).staff_groups; } catch (e) { /* tags just won't be editable */ }
  const roles = ["Super Admin", "IT Department", "Head Office Employee", "Branch Staff"];
  openModal(`
    <div class="modal-header"><h2>${isEdit ? "Edit account" : "New account"}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
    <div class="modal-body">
      <div id="ac-error" class="form-error hidden"></div>
      <label>Username</label><input id="ac-username" type="text" value="${isEdit ? escapeHtml(user.username) : ""}">
      <label>Password ${isEdit ? "(leave blank to keep current)" : ""}</label><input id="ac-password" type="password">
      <label>Role</label>
      <select id="ac-role">${roles.map(r => `<option value="${r}" ${isEdit && user.role === r ? "selected" : ""}>${r}</option>`).join("")}</select>
      <div id="ac-fullname-wrap" class="hidden">
        <label>Full name</label>
        <input id="ac-fullname" type="text" placeholder="e.g. Juan Cruz" value="${isEdit ? escapeHtml(user.full_name || "") : ""}">
      </div>
      <label id="ac-branch-label">Branch</label>
      <select id="ac-branch"></select>
      <div id="ac-group-wrap" class="hidden">
        <label>Line of Business</label>
        <select id="ac-group">
          <option value="">— none —</option>
          ${lobGroups.map(g => `<option value="${escapeHtml(g)}" ${isEdit && user.group_name === g ? "selected" : ""}>${escapeHtml(g)}</option>`).join("")}
        </select>
      </div>
      <div id="ac-specialties-wrap" class="hidden">
        <label>Concerns handled</label>
        <div class="checkbox-grid">${state.categories.map(c => `<label><input type="checkbox" value="${c}"> ${c}</label>`).join("")}</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="ac-save">Save</button>
    </div>`);

  const roleSel = document.getElementById("ac-role");
  const toggleFields = async () => {
    const role = roleSel.value;
    document.getElementById("ac-specialties-wrap").classList.toggle("hidden", role !== "IT Department");
    document.getElementById("ac-group-wrap").classList.toggle("hidden", role !== "IT Department");
    document.getElementById("ac-branch-label").textContent = role === "Head Office Employee" ? "Department" : "Branch";
    const hideLocation = role === "Super Admin" || role === "IT Department";
    document.getElementById("ac-branch").style.display = hideLocation ? "none" : "";
    document.getElementById("ac-branch-label").style.display = hideLocation ? "none" : "";
    // Full name only applies to Super Admin / IT Department - Branch Staff
    // and Head Office Employee already display as their branch/department
    // (one shared account each), so there's no separate person's name to
    // collect for those two roles.
    document.getElementById("ac-fullname-wrap").classList.toggle("hidden", !hideLocation);
    // The dropdown's options depend on the role: Branch Staff picks from
    // state.branches, Head Office Employee from state.departments - each
    // managed separately by the Super Admin (Branches / Departments
    // panels). Rebuild it whenever the role changes so switching roles
    // never leaves a branch name sitting in a "Department" field or vice
    // versa.
    if (!hideLocation) {
      const options = role === "Head Office Employee" ? state.departments : state.branches;
      const branchSel = document.getElementById("ac-branch");
      branchSel.innerHTML = options.map(o => `<option value="${escapeHtml(o)}" ${isEdit && user.location === o ? "selected" : ""}>${escapeHtml(o)}</option>`).join("");
    }
    if (role === "IT Department" && isEdit) {
      const { specialties } = await api(`/it-staff/${user.id}/specialties`);
      document.querySelectorAll("#ac-specialties-wrap input").forEach(cb => { cb.checked = specialties.includes(cb.value); });
    }
  };
  roleSel.onchange = toggleFields;
  toggleFields();

  const acSaveBtn = document.getElementById("ac-save");
  const doSave = async (body) => {
    if (isEdit) {
      if (!body.password) delete body.password;
      return api(`/users/${user.id}`, { method: "PUT", body });
    }
    return api("/users", { method: "POST", body });
  };
  acSaveBtn.onclick = async () => {
    const role = roleSel.value;
    const needsFullName = role === "Super Admin" || role === "IT Department";
    const fullName = document.getElementById("ac-fullname").value.trim();
    const body = {
      username: document.getElementById("ac-username").value.trim(),
      password: document.getElementById("ac-password").value,
      role,
      branch: document.getElementById("ac-branch").value,
      specialties: Array.from(document.querySelectorAll("#ac-specialties-wrap input:checked")).map(cb => cb.value),
    };
    if (needsFullName) body.full_name = fullName;
    if (role === "IT Department") body.group = document.getElementById("ac-group").value || null;
    const errBox = document.getElementById("ac-error");
    errBox.classList.add("hidden");
    if (needsFullName && !fullName) {
      errBox.textContent = "Full name is required.";
      errBox.classList.remove("hidden");
      return;
    }
    if (!isEdit && !body.password) {
      errBox.textContent = "Password is required.";
      errBox.classList.remove("hidden");
      return;
    }
    setBtnLoading(acSaveBtn, true);
    try {
      try {
        await doSave(body);
      } catch (e) {
        // The branch/department already has an account - that's a
        // heads-up for the Super Admin, not a hard stop (e.g. a
        // deliberate backup login). Ask once; if they confirm, resubmit
        // the exact same save with force:true so the backend skips just
        // that one check.
        if (e.code === "duplicate_location_account" && confirm(`${e.message} Create another account for it anyway?`)) {
          await doSave({ ...body, force: true });
        } else {
          throw e;
        }
      }
      toast("Account saved.", "success");
      closeModal();
      goTab("accounts");
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
      setBtnLoading(acSaveBtn, false);
    }
  };
}

// ---------------------------------------------------------------- Branches (Super Admin)

// Shared "Line of Business" + "Corporation" fields for the New branch and
// Edit tag dialogs. The Corporation dropdown only appears once a Line of
// Business has been picked, and is cleared again if the line is cleared.
function branchTagFieldsHtml(idPrefix, groups, corporations, curGroup, curCorp, curGlobal = false) {
  const opts = (list, cur) => list.map(x =>
    `<option value="${escapeHtml(x)}" ${x === cur ? "selected" : ""}>${escapeHtml(x)}</option>`).join("");
  return `
    <label style="display:block;">Line of Business</label>
    <select id="${idPrefix}-lob" style="width:100%;">
      <option value="">— none —</option>${opts(groups, curGroup)}
    </select>
    <div id="${idPrefix}-corp-wrap" class="${curGroup ? "" : "hidden"}" style="margin-top:12px;">
      <label style="display:block;">Corporation</label>
      <select id="${idPrefix}-corp" style="width:100%;">
        <option value="">— none —</option>${opts(corporations, curCorp)}
      </select>
    </div>
    <div id="${idPrefix}-global-wrap" class="${curGroup && curCorp ? "" : "hidden"}" style="margin-top:12px;">
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
        <input type="checkbox" id="${idPrefix}-global" ${curGlobal ? "checked" : ""}>
        <span>Global — this corporation is in partnership with Global</span>
      </label>
    </div>`;
}
function wireBranchTagFields(idPrefix) {
  const lob = document.getElementById(`${idPrefix}-lob`);
  const corpWrap = document.getElementById(`${idPrefix}-corp-wrap`);
  const corp = document.getElementById(`${idPrefix}-corp`);
  const globalWrap = document.getElementById(`${idPrefix}-global-wrap`);
  const globalBox = document.getElementById(`${idPrefix}-global`);
  const sync = () => {
    const hasLob = !!lob.value;
    corpWrap.classList.toggle("hidden", !hasLob);
    if (!hasLob) corp.value = "";
    const hasCorp = hasLob && !!corp.value;
    globalWrap.classList.toggle("hidden", !hasCorp);
    if (!hasCorp) globalBox.checked = false;
  };
  lob.onchange = sync;
  corp.onchange = sync;
}
function readBranchTagFields(idPrefix) {
  const group = document.getElementById(`${idPrefix}-lob`).value || null;
  const corporation = group ? (document.getElementById(`${idPrefix}-corp`).value || null) : null;
  const is_global = !!(corporation && document.getElementById(`${idPrefix}-global`).checked);
  return { group, corporation, is_global };
}

async function renderBranches(root) {
  const actionsEl = document.getElementById("topbar-actions");
  actionsEl.innerHTML = `
    <button class="btn btn-secondary btn-sm" id="import-branches-btn">Import from file</button>
    <input type="file" id="import-branches-input" accept=".xlsx,.xls,.csv" class="hidden">
    <button class="btn btn-primary btn-sm" id="new-branch-btn">+ New branch</button>`;
  const newBranchBtn = document.getElementById("new-branch-btn");
  newBranchBtn.onclick = async () => {
    let groups = [], corporations = [];
    try { ({ groups, corporations } = await api("/settings/groups")); }
    catch (e) { toast(e.message, "error"); return; }
    openModal(`
      <div style="padding:20px; min-width:340px;">
        <h3 style="margin-top:0;">New branch</h3>
        <label>Branch name</label>
        <input id="new-branch-name" type="text" style="width:100%;" placeholder="e.g. SAMPLE BRANCH">
        <div style="margin-top:12px;">${branchTagFieldsHtml("new-branch", groups, corporations, "", "", false)}</div>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
          <button type="button" class="btn btn-secondary" id="new-branch-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="new-branch-save">Add branch</button>
        </div>
      </div>`);
    wireBranchTagFields("new-branch");
    document.getElementById("new-branch-name").focus();
    document.getElementById("new-branch-cancel").onclick = closeModal;
    const saveBtn = document.getElementById("new-branch-save");
    saveBtn.onclick = async () => {
      const name = document.getElementById("new-branch-name").value.trim();
      const { group, corporation, is_global } = readBranchTagFields("new-branch");
      if (!name) { toast("Branch name is required.", "error"); return; }
      try {
        await api("/branches/manage", { method: "POST", body: { name, group, corporation, is_global } }, saveBtn);
        closeModal();
        toast("Branch added.", "success");
        goTab("branches");
      } catch (e) { toast(e.message, "error"); }
    };
  };

  // Bulk import: upload a spreadsheet (.xlsx/.xls/.csv) with a list of
  // branch names - any column/row layout works, the backend just pulls out
  // every non-empty cell. Names that already exist as branches are skipped
  // rather than erroring, so re-uploading the same file is harmless.
  const importBtn = document.getElementById("import-branches-btn");
  const importInput = document.getElementById("import-branches-input");
  importBtn.onclick = () => importInput.click();
  importInput.onchange = async () => {
    const file = importInput.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    try {
      const result = await api("/branches/import", { method: "POST", formData: fd }, importBtn);
      const parts = [`${result.added} branch${result.added === 1 ? "" : "es"} added`];
      if (result.skipped) parts.push(`${result.skipped} already existed`);
      toast(parts.join(", ") + ".", "success");
      goTab("branches");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      importInput.value = "";
    }
  };

  const groupsRes = await api("/branches/groups"); // { branches: [{ name, group_name }], groups: [...] }
  const branches = groupsRes.branches;
  const bspGroups = groupsRes.groups;
  const corporations = groupsRes.corporations;
  root.innerHTML = `<div class="panel">
    <div class="panel-body" style="padding-bottom:0;">
      <input id="br-search" class="grow" type="text" placeholder="Search branches…" style="width:100%;">
    </div>
    <div class="panel-body table-wrap">
      <table>
        <tr><th>Branch</th><th>Line of Business</th><th>Corporation</th><th>Global</th><th></th></tr>
        <tbody id="br-rows"></tbody>
      </table>
      <div id="br-empty" class="muted hidden" style="padding:16px 0;">No branches match your search.</div>
    </div>
  </div>`;

  const searchEl = document.getElementById("br-search");
  const rowsEl = document.getElementById("br-rows");
  const emptyEl = document.getElementById("br-empty");

  function renderFiltered() {
    const query = searchEl.value.trim();
    const filtered = branches.filter(b => matchesSearchWords(`${b.name} ${b.group_name || ""} ${b.corporation || ""} ${b.is_global ? "global" : ""}`, query));

    rowsEl.innerHTML = filtered.map(b => `
        <tr><td>${escapeHtml(b.name)}</td>
          <td>${b.group_name ? escapeHtml(b.group_name) : `<span class="muted">— none —</span>`}</td>
          <td>${b.corporation ? escapeHtml(b.corporation) : `<span class="muted">—</span>`}</td>
          <td>${b.is_global ? `<span class="badge badge-resolved">✓ Global</span>` : `<span class="muted">—</span>`}</td>
          <td class="row-actions">
            <button class="btn btn-secondary btn-sm" data-tag="${escapeHtml(b.name)}">Edit tag</button>
            <button class="btn btn-secondary btn-sm" data-rename="${escapeHtml(b.name)}">Rename</button>
            <button class="btn btn-danger btn-sm" data-del="${escapeHtml(b.name)}">Delete</button>
          </td></tr>`).join("");
    emptyEl.classList.toggle("hidden", filtered.length > 0);
    wireRowActions();
  }

  function wireRowActions() {
    rowsEl.querySelectorAll("[data-tag]").forEach(btn => {
      btn.onclick = () => {
        const name = btn.dataset.tag;
        const cur = branches.find(x => x.name === name) || {};
        openModal(`
          <div style="padding:20px; min-width:340px;">
            <h3 style="margin-top:0;">Edit tag</h3>
            <p class="muted">${escapeHtml(name)}</p>
            ${branchTagFieldsHtml("branch-tag", bspGroups, corporations, cur.group_name || "", cur.corporation || "", !!cur.is_global)}
            <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
              <button type="button" class="btn btn-secondary" id="branch-tag-cancel">Cancel</button>
              <button type="button" class="btn btn-primary" id="branch-tag-save">Save</button>
            </div>
          </div>`);
        wireBranchTagFields("branch-tag");
        document.getElementById("branch-tag-cancel").onclick = closeModal;
        const saveBtn = document.getElementById("branch-tag-save");
        saveBtn.onclick = async () => {
          const { group, corporation, is_global } = readBranchTagFields("branch-tag");
          try {
            await api(`/branches/manage/${encodeURIComponent(name)}/group`, { method: "PUT", body: { group, corporation, is_global } }, saveBtn);
            const row = branches.find(x => x.name === name);
            if (row) { row.group_name = group; row.corporation = corporation; row.is_global = is_global; }
            closeModal();
            toast("Branch tag saved.", "success");
            renderFiltered();
          } catch (e) { toast(e.message, "error"); }
        };
      };
    });
    rowsEl.querySelectorAll("[data-rename]").forEach(btn => {
      btn.onclick = async () => {
        const newName = prompt("New name:", btn.dataset.rename);
        if (!newName || newName === btn.dataset.rename) return;
        try { await api(`/branches/manage/${encodeURIComponent(btn.dataset.rename)}`, { method: "PUT", body: { new_name: newName } }, btn); toast("Renamed.", "success"); goTab("branches"); }
        catch (e) { toast(e.message, "error"); }
      };
    });
    rowsEl.querySelectorAll("[data-del]").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(`Delete branch "${btn.dataset.del}"?`)) return;
        try { await api(`/branches/manage/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" }, btn); toast("Branch deleted.", "success"); goTab("branches"); }
        catch (e) { toast(e.message, "error"); }
      };
    });
  }

  searchEl.oninput = renderFiltered;
  renderFiltered();
}

// Mirrors renderBranches() above exactly, but for Head Office departments -
// this is what lets a Super Admin set a department up *before* anyone can
// register a Head Office Employee account against it.

async function renderDepartments(root) {
  const actionsEl = document.getElementById("topbar-actions");
  actionsEl.innerHTML = `<button class="btn btn-primary btn-sm" id="new-department-btn">+ New department</button>`;
  const newDeptBtn = document.getElementById("new-department-btn");
  newDeptBtn.onclick = async () => {
    const name = prompt("New department name:");
    if (!name) return;
    try { await api("/departments/manage", { method: "POST", body: { name } }, newDeptBtn); toast("Department added.", "success"); goTab("departments"); }
    catch (e) { toast(e.message, "error"); }
  };

  const { departments } = await api("/departments");
  root.innerHTML = `<div class="panel">
    <div class="panel-body" style="padding-bottom:0;">
      <input id="dept-search" class="grow" type="text" placeholder="Search departments…" style="width:100%;">
    </div>
    <div class="panel-body table-wrap">
      <table>
        <tr><th>Department</th><th></th></tr>
        <tbody id="dept-rows"></tbody>
      </table>
      <div id="dept-empty" class="muted hidden" style="padding:16px 0;">No departments match your search.</div>
    </div>
  </div>`;

  const searchEl = document.getElementById("dept-search");
  const rowsEl = document.getElementById("dept-rows");
  const emptyEl = document.getElementById("dept-empty");

  function renderFiltered() {
    const query = searchEl.value.trim();
    const filtered = departments.filter(d => matchesSearchWords(d, query));

    rowsEl.innerHTML = filtered.map(d => `
        <tr><td>${escapeHtml(d)}</td>
          <td class="row-actions">
            <button class="btn btn-secondary btn-sm" data-rename="${escapeHtml(d)}">Rename</button>
            <button class="btn btn-danger btn-sm" data-del="${escapeHtml(d)}">Delete</button>
          </td></tr>`).join("");
    emptyEl.classList.toggle("hidden", filtered.length > 0);
    wireRowActions();
  }

  function wireRowActions() {
    rowsEl.querySelectorAll("[data-rename]").forEach(btn => {
      btn.onclick = async () => {
        const newName = prompt("New name:", btn.dataset.rename);
        if (!newName || newName === btn.dataset.rename) return;
        try { await api(`/departments/manage/${encodeURIComponent(btn.dataset.rename)}`, { method: "PUT", body: { new_name: newName } }, btn); toast("Renamed.", "success"); goTab("departments"); }
        catch (e) { toast(e.message, "error"); }
      };
    });
    rowsEl.querySelectorAll("[data-del]").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm(`Delete department "${btn.dataset.del}"?`)) return;
        try { await api(`/departments/manage/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" }, btn); toast("Department deleted.", "success"); goTab("departments"); }
        catch (e) { toast(e.message, "error"); }
      };
    });
  }

  searchEl.oninput = renderFiltered;
  renderFiltered();
}

// ---------------------------------------------------------------- Categories (Super Admin)
// Mirrors renderBranches()/renderDepartments() above exactly, but for ticket
// categories - lets a Super Admin add/rename/remove the options on the New
// Ticket "Category" dropdown and the IT Staff specialties checkboxes.

async function renderCategories(root) {
  const actionsEl = document.getElementById("topbar-actions");
  actionsEl.innerHTML = `<button class="btn btn-primary btn-sm" id="new-category-btn">+ New category</button>`;
  const newCatBtn = document.getElementById("new-category-btn");
  newCatBtn.onclick = async () => {
    const name = prompt("New category name:");
    if (!name) return;
    try { await api("/categories/manage", { method: "POST", body: { name } }, newCatBtn); toast("Category added.", "success"); goTab("categories"); }
    catch (e) { toast(e.message, "error"); }
  };

  const { categories } = await api("/categories");
  root.innerHTML = `<div class="panel"><div class="panel-body table-wrap">
    <table><tr><th>Category</th><th></th></tr>
      ${categories.map((c, i) => `
        <tr><td>${escapeHtml(c)}</td>
          <td class="row-actions">
            <button class="btn btn-secondary btn-sm" data-move-up="${escapeHtml(c)}" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="btn btn-secondary btn-sm" data-move-down="${escapeHtml(c)}" title="Move down" ${i === categories.length - 1 ? "disabled" : ""}>↓</button>
            <button class="btn btn-secondary btn-sm" data-rename="${escapeHtml(c)}">Rename</button>
            <button class="btn btn-danger btn-sm" data-del="${escapeHtml(c)}">Delete</button>
          </td></tr>`).join("")}
    </table>
  </div></div>`;

  root.querySelectorAll("[data-move-up]").forEach(btn => {
    btn.onclick = async () => {
      try { await api(`/categories/manage/${encodeURIComponent(btn.dataset.moveUp)}/move`, { method: "POST", body: { direction: "up" } }, btn); goTab("categories"); }
      catch (e) { toast(e.message, "error"); }
    };
  });
  root.querySelectorAll("[data-move-down]").forEach(btn => {
    btn.onclick = async () => {
      try { await api(`/categories/manage/${encodeURIComponent(btn.dataset.moveDown)}/move`, { method: "POST", body: { direction: "down" } }, btn); goTab("categories"); }
      catch (e) { toast(e.message, "error"); }
    };
  });
  root.querySelectorAll("[data-rename]").forEach(btn => {
    btn.onclick = async () => {
      const newName = prompt("New name:", btn.dataset.rename);
      if (!newName || newName === btn.dataset.rename) return;
      try { await api(`/categories/manage/${encodeURIComponent(btn.dataset.rename)}`, { method: "PUT", body: { new_name: newName } }, btn); toast("Renamed.", "success"); goTab("categories"); }
      catch (e) { toast(e.message, "error"); }
    };
  });
  root.querySelectorAll("[data-del]").forEach(btn => {
    btn.onclick = async () => {
      if (!confirm(`Delete category "${btn.dataset.del}"?`)) return;
      try { await api(`/categories/manage/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" }, btn); toast("Category deleted.", "success"); goTab("categories"); }
      catch (e) { toast(e.message, "error"); }
    };
  });
}

// ---------------------------------------------------------------- Team Workspace

async function renderTeamWorkspace(root) {
  const isSuperAdmin = state.user.role === "Super Admin";
  const { workload, absent_today, upcoming_absences, team_stats, pending_void_requests, pending_reopen_requests, pending_device_requests, pending_borrow_requests } =
    await api("/team-workspace");
  // Login-time / device attendance is Super Admin-only (see server's
  // /api/attendance*) - IT Department never reaches this function at all
  // any more (removed from their nav, and /api/team-workspace itself is now
  // Super Admin-only), but this check is kept as a harmless second guard.
  const todayAttendance = isSuperAdmin ? (await api("/attendance/today")).rows : [];

  const cards = [
    ["Open", team_stats.open, "open"],
    ["In Progress", team_stats.in_progress, "inprogress"],
    ["Resolved today", team_stats.resolved_today, "resolved"],
    ["Out today", absent_today.length, ""],
  ];
  if (isSuperAdmin) cards.push(["Void requests", pending_void_requests, ""]);
  if (isSuperAdmin) cards.push(["Reopen requests", pending_reopen_requests, ""]);
  if (isSuperAdmin) cards.push(["Borrow requests", pending_borrow_requests, ""]);

  // Group the next 7 days' absences by date so the schedule strip reads
  // like a calendar rather than a flat table.
  const byDate = {};
  upcoming_absences.forEach(a => { (byDate[a.absence_date] = byDate[a.absence_date] || []).push(a); });
  const dates = Object.keys(byDate).sort();

  // Workload (open/in-progress/resolved-today counts) and today's
  // attendance (first login, device, login count) both list the exact
  // same set of IT staff, so for Super Admin they're merged into one row
  // per person instead of two separate tables listing the same names.
  const attendanceByUser = {};
  todayAttendance.forEach(a => { attendanceByUser[a.user_id] = a; });

  root.innerHTML = `
    <div class="stat-grid">
      ${cards.map(([label, val, cls]) => `
        <div class="stat-card ${cls}">
          <div class="label">${label}</div>
          <div class="value">${val}</div>
        </div>`).join("")}
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Team workload right now</h3></div>
      <div class="panel-body table-wrap">
        <table><tr><th>Name</th><th>Status</th><th>Open</th><th>In Progress</th><th>Resolved today</th>${isSuperAdmin ? `<th>First login today</th><th>Device</th><th>Logins today</th>` : ""}</tr>
          ${workload.map(w => {
            const a = attendanceByUser[w.user_id];
            const today = new Date().toISOString().slice(0, 10);
            const lockScheduled = w.is_available === false && w.unavailable_from && w.unavailable_from > today;
            const lockActive = w.is_available === false && !lockScheduled;
            return `<tr>
            <td>${escapeHtml(w.full_name)} ${w.role === "Super Admin" ? `<span class="muted">(Super Admin)</span>` : ""}</td>
            <td>${
              w.absent_today ? `<span class="badge badge-critical">Absent${w.absence_reason ? " — " + escapeHtml(w.absence_reason) : ""}</span>`
              : lockActive ? `<span class="badge badge-critical">Locked</span>`
              : lockScheduled ? `<span class="badge badge-resolved">On duty <span class="muted">(locked from ${fmtDate(w.unavailable_from)})</span></span>`
              : `<span class="badge badge-resolved">On duty</span>`
            }</td>
            <td>${w.open}</td>
            <td>${w.in_progress}</td>
            <td>${w.resolved_today}</td>
            ${isSuperAdmin ? `
            <td>${a && a.logged_in_today
              ? `<span class="badge badge-resolved">${fmtDateTime(a.first_login_at)}</span>`
              : `<span class="badge badge-critical">Not logged in yet</span>`}</td>
            <td>${escapeHtml((a && a.device_label) || "—")}</td>
            <td>${a ? a.login_count : 0}</td>` : ""}
          </tr>`;
          }).join("") || `<tr><td colspan="${isSuperAdmin ? 8 : 5}" class="muted">No IT staff yet.</td></tr>`}
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Next 7 days</h3></div>
      <div class="panel-body">
        ${dates.length ? dates.map(d => `
          <div style="margin-bottom:10px;">
            <div style="font-weight:600; font-size:13px; margin-bottom:4px;">${fmtDate(d)}</div>
            ${byDate[d].map(a => `<div class="muted" style="padding:2px 0;">${escapeHtml(a.full_name)}${a.reason ? " — " + escapeHtml(a.reason) : ""}</div>`).join("")}
          </div>`).join("") : `<div class="muted">Nobody scheduled off in the next 7 days.</div>`}
      </div>
    </div>

    ${isSuperAdmin ? `
    <div class="panel">
      <div class="panel-header"><h3>IT Staff Attendance — history</h3>
        <button class="btn btn-primary btn-sm" id="at-export">Download .xlsx</button>
      </div>
      <div class="panel-body">
        ${dateFilterToolbarHtml("at")}
        <div id="at-results" class="table-wrap" style="margin-top:14px;">
          <div class="empty-state">Choose a period and click Filter (defaults to today).</div>
        </div>
      </div>
    </div>` : ""}`;

  if (isSuperAdmin) wireAttendanceHistory(root);
}

// Wires the "IT Staff Attendance — history" panel's date filter and .xlsx
// export button. Kept separate from renderTeamWorkspace so the Overview
// page's main render stays readable - see dateFilterToolbarHtml/
// wireDateFilterToolbar for the shared date-range control this reuses
// (same one Reporting and the absence/lock history panels use).
function wireAttendanceHistory(root) {
  const buildParams = wireDateFilterToolbar("at");
  // Attendance defaults to "today" rather than "All history" (unlike the
  // absence/lock history panels) - a login log grows one row per sign-in,
  // so an unbounded query isn't a sensible default.
  document.getElementById("at-mode").value = "single";
  document.getElementById("at-mode").dispatchEvent(new Event("change"));

  const runFilter = async () => {
    const params = buildParams();
    const resEl = document.getElementById("at-results");
    resEl.innerHTML = `<div class="empty-state">Loading…</div>`;
    const { rows } = await api(`/attendance${params.toString() ? "?" + params.toString() : ""}`);
    resEl.innerHTML = `
      <table><tr><th>Name</th><th>Role</th><th>Login time</th><th>Device</th></tr>
        ${rows.map(r => `<tr>
          <td>${escapeHtml(r.full_name)}</td>
          <td>${escapeHtml(r.role)}</td>
          <td>${fmtDateTime(r.logged_in_at)}</td>
          <td>${escapeHtml(r.device_label || "—")}</td>
        </tr>`).join("") || `<tr><td colspan="4" class="muted">No logins in this period.</td></tr>`}
      </table>`;
  };

  document.getElementById("at-run").onclick = runFilter;
  document.getElementById("at-export").onclick = () => {
    const params = buildParams();
    window.open(`/api/attendance/export${params.toString() ? "?" + params.toString() : ""}`, "_blank");
  };

  runFilter().catch((err) => {
    document.getElementById("at-results").innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
  });
}

// "Shared Files" sub-page under the Team Workspace nav group.
async function renderWorkspaceFilesPage(root) {
  const isSuperAdmin = state.user.role === "Super Admin";
  root.innerHTML = `
    <div class="panel" id="workspace-files-panel">
      <div class="panel-header"><h3>Shared files</h3>
        ${isSuperAdmin ? `<button class="btn btn-primary btn-sm" id="wf-upload-btn">+ Add link</button>` : ""}
      </div>
      <div class="panel-body table-wrap">
        <table><tr><th>Link</th><th>Added by</th><th>Last updated</th><th>Version</th><th></th></tr>
          <tbody id="wf-rows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>`;
  wireWorkspaceFiles(root, isSuperAdmin);
}

// "Memos" sub-page under the Team Workspace nav group.
async function renderWorkspaceMemosPage(root) {
  const isSuperAdmin = state.user.role === "Super Admin";
  root.innerHTML = `
    <div class="panel" id="workspace-memos-panel">
      <div class="panel-header"><h3>Memos &amp; announcements</h3>
        ${isSuperAdmin ? `<button class="btn btn-primary btn-sm" id="wm-post-btn">+ Post memo</button>` : ""}
      </div>
      <div class="panel-body">
        <div class="toolbar" style="display:flex; gap:8px; margin-bottom:14px;">
          <input id="wm-search" type="text" placeholder="Search memos…" style="flex:1;">
          <select id="wm-type-filter">
            <option value="">All types</option>
            ${MEMO_TYPES.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("")}
          </select>
        </div>
        <div id="wm-list"><div class="muted">Loading…</div></div>
      </div>
    </div>`;
  wireWorkspaceMemos(root, isSuperAdmin);
}

// "Shared files" rows are external links (not uploads), so there's no real
// extension to key off of - a single link icon for every row.
function workspaceFileIcon() {
  return "🔗";
}

async function wireWorkspaceFiles(root, isSuperAdmin) {
  const rowsEl = document.getElementById("wf-rows");
  let files = [];
  try {
    ({ files } = await api("/workspace/files"));
  } catch (e) {
    if (rowsEl) rowsEl.innerHTML = `<tr><td colspan="5" class="form-error">${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  if (!rowsEl) return; // user navigated away while this was loading

  rowsEl.innerHTML = files.length ? files.map(f => `
    <tr>
      <td>${workspaceFileIcon()} <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">${escapeHtml(f.filename)}</a>
        ${f.description ? `<div class="muted" style="font-size:12px;">${escapeHtml(f.description)}</div>` : ""}
      </td>
      <td class="muted">${escapeHtml(f.uploaded_by_name)}</td>
      <td class="muted">${f.updated_at ? `${fmtDateTime(f.updated_at)}${f.updated_by_name ? " — " + escapeHtml(f.updated_by_name) : ""}` : `${fmtDateTime(f.created_at)} <span class="muted">(original)</span>`}</td>
      <td class="muted">v${f.version}</td>
      <td>
        ${isSuperAdmin ? `<button class="btn btn-secondary btn-sm" data-wf-update="${f.id}">Edit</button>` : ""}
        <button class="btn btn-secondary btn-sm" data-wf-history="${f.id}">History</button>
        ${isSuperAdmin ? `<button class="btn btn-danger btn-sm" data-wf-delete="${f.id}">Delete</button>` : ""}
      </td>
    </tr>`).join("") : `<tr><td colspan="5" class="muted">No shared links yet.</td></tr>`;

  // Shared shape for both the "Add link" and "Edit" modals - only the
  // title/submit label/initial values and what happens on save differ.
  function openLinkModal({ title, submitLabel, initial = {}, onSave }) {
    openModal(`
      <div class="modal-header"><h2>${escapeHtml(title)}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <label>Name</label><input id="wf-form-name" type="text" placeholder="e.g. Branch inventory template" value="${escapeHtml(initial.name || "")}">
        <label>Link (URL)</label><input id="wf-form-url" type="url" placeholder="https://…" value="${escapeHtml(initial.url || "")}">
        ${initial.showDescription !== false ? `<label>Description (optional)</label><input id="wf-form-desc" type="text" placeholder="What is this link?" value="${escapeHtml(initial.description || "")}">` : ""}
        <div id="wf-form-error" class="form-error hidden"></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="wf-form-save">${escapeHtml(submitLabel)}</button></div>`);
    const wfFormSaveBtn = document.getElementById("wf-form-save");
    wfFormSaveBtn.onclick = async () => {
      const name = document.getElementById("wf-form-name").value.trim();
      const url = document.getElementById("wf-form-url").value.trim();
      const descEl = document.getElementById("wf-form-desc");
      const errEl = document.getElementById("wf-form-error");
      errEl.classList.add("hidden");
      if (!name) { errEl.textContent = "Give the link a name."; errEl.classList.remove("hidden"); return; }
      if (!/^https?:\/\//i.test(url)) { errEl.textContent = "Enter a valid link (starting with http:// or https://)."; errEl.classList.remove("hidden"); return; }
      setBtnLoading(wfFormSaveBtn, true);
      try {
        await onSave({ name, url, description: descEl ? descEl.value.trim() : undefined });
      } catch (e) { errEl.textContent = e.message; errEl.classList.remove("hidden"); setBtnLoading(wfFormSaveBtn, false); }
    };
  }

  if (isSuperAdmin) {
    document.getElementById("wf-upload-btn").onclick = () => {
      openLinkModal({
        title: "Add link",
        submitLabel: "Add link",
        onSave: async ({ name, url, description }) => {
          await api("/workspace/files", { method: "POST", body: { name, url, description } });
          toast("Link added.", "success");
          closeModal();
          goTab("workspace");
        },
      });
    };
  }

  if (isSuperAdmin) {
    root.querySelectorAll("[data-wf-update]").forEach(btn => {
      btn.onclick = () => {
        const f = files.find(x => x.id === Number(btn.dataset.wfUpdate));
        if (!f) return;
        openLinkModal({
          title: "Edit link",
          submitLabel: "Save",
          initial: { name: f.filename, url: f.url, showDescription: false },
          onSave: async ({ name, url }) => {
            await api(`/workspace/files/${f.id}/update`, { method: "POST", body: { name, url } });
            toast("Link updated.", "success");
            closeModal();
            goTab("workspace");
          },
        });
      };
    });
  }
  root.querySelectorAll("[data-wf-history]").forEach(btn => {
    btn.onclick = async () => {
      let versions = [];
      try { ({ versions } = await api(`/workspace/files/${btn.dataset.wfHistory}/versions`, {}, btn)); }
      catch (e) { toast(e.message, "error"); return; }
      openModal(`
        <div class="modal-header"><h2>Version history</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="modal-body">
          ${versions.length ? versions.map(v => `
            <div style="padding:8px 0; border-bottom:1px solid var(--line);">
              <div>${workspaceFileIcon()} <a href="${escapeHtml(v.blob_url)}" target="_blank" rel="noopener">${escapeHtml(v.original_filename)}</a> <span class="muted">v${v.version}</span></div>
              <div class="muted" style="font-size:12px;">${escapeHtml(v.changed_by_name)} · ${fmtDateTime(v.changed_at)}</div>
            </div>`).join("") : `<div class="muted">No earlier versions - this link has only ever had its original name/URL.</div>`}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Close</button></div>`);
    };
  });
  if (isSuperAdmin) {
    root.querySelectorAll("[data-wf-delete]").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm("Delete this link for everyone? This can't be undone.")) return;
        try {
          await api(`/workspace/files/${btn.dataset.wfDelete}`, { method: "DELETE" }, btn);
          toast("Link deleted.", "success");
          goTab("workspace");
        } catch (e) { toast(e.message, "error"); }
      };
    });
  }
}

const MEMO_TYPES = ["Branch Opening", "Branch Closed", "Memorandum", "Other Announcement"];

const MEMO_TYPE_BADGE = {
  "Branch Opening": "badge-resolved",
  "Branch Closed": "badge-critical",
  "Memorandum": "badge-requested",
  "Other Announcement": "",
};

/** Generic "search random words" matcher for the app's search bars: splits
 * the query into words and requires every word to appear somewhere in the
 * given haystack, so word order doesn't matter and a match isn't limited to
 * the start of a field - typing any word from any part of any searchable
 * field finds the row. */
function matchesSearchWords(haystack, query) {
  if (!query) return true;
  const h = haystack.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => h.includes(w));
}

/** Does this memo match the search query? Splits the query into words and
 * requires every word to appear somewhere in the memo's title/body/type/
 * author - so word order doesn't matter and any word (not just the first)
 * can be searched on. */
function memoMatchesSearch(m, query) {
  return matchesSearchWords(`${m.title} ${m.body || ""} ${m.memo_type} ${m.posted_by_name}`, query);
}

function memoRowHtml(m, isSuperAdmin) {
  return `
    <div style="padding:10px 0; border-bottom:1px solid var(--line);">
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="badge ${MEMO_TYPE_BADGE[m.memo_type] || ""}">${escapeHtml(m.memo_type)}</span>
        <strong>${escapeHtml(m.title)}</strong>
        ${isSuperAdmin ? `<button class="btn btn-danger btn-sm" data-wm-delete="${m.id}" style="margin-left:auto;">Delete</button>` : ""}
      </div>
      ${m.body ? `<div style="margin-top:6px; white-space:pre-wrap;">${escapeHtml(m.body)}</div>` : ""}
      ${m.image_url ? `<div style="margin-top:8px;"><button class="btn btn-secondary btn-sm" data-wm-view-image="${escapeHtml(m.image_url)}">🖼️ View</button></div>` : ""}
      <div class="muted" style="font-size:12px; margin-top:6px;">${escapeHtml(m.posted_by_name)} · ${fmtDateTime(m.created_at)}</div>
    </div>`;
}

async function wireWorkspaceMemos(root, isSuperAdmin) {
  const listEl = document.getElementById("wm-list");
  const searchEl = document.getElementById("wm-search");
  const typeFilterEl = document.getElementById("wm-type-filter");
  let memos = [];
  try {
    ({ memos } = await api("/workspace/memos"));
  } catch (e) {
    if (listEl) listEl.innerHTML = `<div class="form-error">${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!listEl) return; // user navigated away while this was loading

  // Renders whichever memos currently match the search box + type filter,
  // and (re)wires the per-row buttons - called on first load and again
  // every time either filter control changes.
  function renderFiltered() {
    const query = (searchEl && searchEl.value || "").trim();
    const typeFilter = (typeFilterEl && typeFilterEl.value) || "";
    const filtered = memos.filter((m) =>
      (!typeFilter || m.memo_type === typeFilter) && memoMatchesSearch(m, query)
    );

    listEl.innerHTML = filtered.length
      ? filtered.map((m) => memoRowHtml(m, isSuperAdmin)).join("")
      : `<div class="muted">${memos.length ? "No memos match your search." : "No memos posted yet."}</div>`;

    listEl.querySelectorAll("[data-wm-view-image]").forEach((btn) => {
      btn.onclick = () => {
        openModal(`
          <div class="modal-header"><h2>Memo image</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
          <div class="modal-body"><img src="${btn.dataset.wmViewImage}" alt="" style="max-width:100%; border-radius:8px; display:block; margin:0 auto;"></div>
          <div class="modal-footer"><a class="btn btn-secondary" href="${btn.dataset.wmViewImage}" target="_blank" rel="noopener">Open full size</a><button class="btn btn-primary" onclick="closeModal()">Close</button></div>`);
      };
    });

    if (isSuperAdmin) {
      listEl.querySelectorAll("[data-wm-delete]").forEach((btn) => {
        btn.onclick = async () => {
          if (!confirm("Delete this memo?")) return;
          try {
            await api(`/workspace/memos/${btn.dataset.wmDelete}`, { method: "DELETE" }, btn);
            toast("Memo deleted.", "success");
            goTab("workspace-memos");
          } catch (e) { toast(e.message, "error"); }
        };
      });
    }
  }

  renderFiltered();
  if (searchEl) searchEl.oninput = renderFiltered;
  if (typeFilterEl) typeFilterEl.onchange = renderFiltered;

  if (isSuperAdmin) {
    document.getElementById("wm-post-btn").onclick = () => {
      openModal(`
        <div class="modal-header"><h2>Post a memo</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="modal-body">
          <label>Type</label>
          <select id="wm-type">${MEMO_TYPES.map(t => `<option value="${t}">${t}</option>`).join("")}</select>
          <label>Title</label><input id="wm-title" type="text" placeholder="e.g. Branch A closed for renovation">
          <label>Details (optional)</label><textarea id="wm-body" rows="4"></textarea>
          <label>Image (optional)</label><input id="wm-image" type="file" accept="image/*">
          <div id="wm-error" class="form-error hidden"></div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="wm-save">Post</button></div>`);
      const wmSaveBtn = document.getElementById("wm-save");
      wmSaveBtn.onclick = async () => {
        const errEl = document.getElementById("wm-error");
        errEl.classList.add("hidden");
        const title = document.getElementById("wm-title").value.trim();
        if (!title) { errEl.textContent = "Title is required."; errEl.classList.remove("hidden"); return; }
        const fd = new FormData();
        fd.append("memo_type", document.getElementById("wm-type").value);
        fd.append("title", title);
        fd.append("body", document.getElementById("wm-body").value.trim());
        const imageFile = document.getElementById("wm-image").files[0];
        if (imageFile) fd.append("image", imageFile);
        setBtnLoading(wmSaveBtn, true);
        try {
          await api("/workspace/memos", { method: "POST", formData: fd });
          toast("Memo posted.", "success");
          closeModal();
          goTab("workspace-memos");
        } catch (e) { errEl.textContent = e.message; errEl.classList.remove("hidden"); setBtnLoading(wmSaveBtn, false); }
      };
    };
  }
}

// ---------------------------------------------------------------- Team Workspace: IT Request

// "IT Request" sub-page under the Team Workspace nav group - any IT
// Department (or Super Admin) account can log a request they're raising
// (date, one or more branches and/or departments, description, optional
// photo) - not every request is branch-specific, so departments (e.g. Head
// Office) are selectable too, alongside branches. Everyone with access to
// Team Workspace can see the shared log, search it, filter it by a single
// day/month/date range (or leave it as "All history"), and download the
// currently-filtered list as .xlsx (the attached image, if any, is never
// included in that download). A request can only be deleted by whoever
// raised it, or by a Super Admin.
async function renderITRequestsPage(root) {
  root.innerHTML = `
    <div class="panel" id="workspace-itrequest-panel">
      <div class="panel-header"><h3>IT Request</h3>
        <button class="btn btn-primary btn-sm" id="itr-new-btn">+ New request</button>
      </div>
      <div class="panel-body">
        ${dateFilterToolbarHtml("itr")}
        <div class="toolbar" style="margin-top:10px;">
          <input id="itr-search" type="text" placeholder="Search requests…" style="flex:1;">
          <select id="itr-requester"><option value="All">All requesters</option></select>
        </div>
        <div class="table-wrap" style="margin-top:14px;">
          <table>
            <tr><th>Date of request</th><th>Branch(es) / Department(s)</th><th>Description</th><th>Image</th><th>Requested by</th><th></th></tr>
            <tbody id="itr-rows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
          </table>
        </div>
        <div id="itr-pagination" class="tk-pagination hidden"></div>
      </div>
    </div>`;
  wireITRequests(root);
}

/** Does this IT Request match the search query? Splits the query into
 * words and requires every word to appear somewhere in the request's
 * date/branches-or-departments/description/requester - same
 * any-word-any-order convention as matchesSearchWords() everywhere else in
 * the app. */
function itRequestMatchesSearch(r, query) {
  return matchesSearchWords(
    `${r.request_date} ${(r.branches || []).join(" ")} ${r.description} ${r.requested_by_name}`,
    query
  );
}

async function loadAndRenderITRequests(root, buildParams, searchEl, requesterEl) {
  const rowsEl = document.getElementById("itr-rows");
  let requests = [];
  try {
    const params = buildParams();
    const qs = params.toString();
    ({ requests } = await api(`/workspace/it-requests${qs ? `?${qs}` : ""}`));
  } catch (e) {
    if (rowsEl) rowsEl.innerHTML = `<tr><td colspan="6" class="form-error">${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  if (!rowsEl) return; // user navigated away while this was loading

  const canDelete = (r) => state.user.role === "Super Admin" || r.requested_by === state.user.id;

  // Populate "Requested by" from whoever actually has a request in the
  // currently-loaded date range (rather than the full IT staff roster, which
  // would include people with nothing to show) - preserves the current
  // selection across a date-range reload (e.g. switching "This month" to
  // "All history") as long as that name is still present in the new range;
  // otherwise it falls back to "All requesters" rather than silently
  // filtering by someone no longer in the list.
  if (requesterEl) {
    const names = [...new Set(requests.map(r => r.requested_by_name))].sort((a, b) => a.localeCompare(b));
    const prevValue = requesterEl.value || "All";
    requesterEl.innerHTML = `<option value="All">All requesters</option>${names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}`;
    requesterEl.value = names.includes(prevValue) ? prevValue : "All";
  }

  // Client-side pagination, 10 per page - the request list here is already
  // fully fetched for the selected date range (unlike Tickets, which is
  // server-paginated because it can run into the thousands), so paginating
  // is just a slice of the in-memory `requests`/`filtered` array. Matches
  // the Tickets tab's "Showing X to Y of Z entries" + Previous/Next
  // footer/behavior (see renderTkPagination) for a consistent feel across
  // both tables. Resets to page 1 whenever the search box or requester
  // filter changes (see the listeners below) so a new filter always starts
  // from its own top result instead of wherever the previous filter's
  // pages left off.
  const ITR_PAGE_SIZE = 10;
  let itrPage = 1;

  // Renders whichever requests currently match the search box + requester
  // filter (called on first load, and again on every keystroke/filter
  // change - the date range itself still goes through the server via
  // buildParams()/loadAndRenderITRequests, so only these two are
  // client-side).
  function renderFiltered() {
    const query = (searchEl && searchEl.value || "").trim();
    const requester = (requesterEl && requesterEl.value) || "All";
    const filtered = requests
      .filter((r) => requester === "All" || r.requested_by_name === requester)
      .filter((r) => itRequestMatchesSearch(r, query));
    const totalPages = Math.max(1, Math.ceil(filtered.length / ITR_PAGE_SIZE));
    if (itrPage > totalPages) itrPage = totalPages;
    const pageItems = filtered.slice((itrPage - 1) * ITR_PAGE_SIZE, itrPage * ITR_PAGE_SIZE);

    rowsEl.innerHTML = pageItems.length ? pageItems.map(r => `
      <tr>
        <td class="muted">${escapeHtml(r.request_date)}</td>
        <td>${escapeHtml((r.branches || []).join(", "))}</td>
        <td style="white-space:pre-wrap;">${escapeHtml(r.description)}</td>
        <td>${r.image_url ? `<button class="btn btn-secondary btn-sm" data-itr-view-image="${escapeHtml(r.image_url)}">🖼️ View</button>` : `<span class="muted">—</span>`}</td>
        <td class="muted">${escapeHtml(r.requested_by_name)}</td>
        <td>${canDelete(r) ? `<button class="btn btn-danger btn-sm" data-itr-delete="${r.id}">Delete</button>` : ""}</td>
      </tr>`).join("") : `<tr><td colspan="6" class="muted">${requests.length ? "No requests match your search." : "No IT requests match this period."}</td></tr>`;

    renderItrPagination(filtered.length, pageItems.length);

    rowsEl.querySelectorAll("[data-itr-view-image]").forEach((btn) => {
      btn.onclick = () => {
        openModal(`
          <div class="modal-header"><h2>Request image</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
          <div class="modal-body"><img src="${btn.dataset.itrViewImage}" alt="" style="max-width:100%; border-radius:8px; display:block; margin:0 auto;"></div>
          <div class="modal-footer"><a class="btn btn-secondary" href="${btn.dataset.itrViewImage}" target="_blank" rel="noopener">Open full size</a><button class="btn btn-primary" onclick="closeModal()">Close</button></div>`);
      };
    });

    rowsEl.querySelectorAll("[data-itr-delete]").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Delete this IT request?")) return;
        try {
          await api(`/workspace/it-requests/${btn.dataset.itrDelete}`, { method: "DELETE" }, btn);
          toast("Request deleted.", "success");
          goTab("workspace-itrequest");
        } catch (e) { toast(e.message, "error"); }
      };
    });
  }

  // "Showing X to Y of Z entries" + Previous/Next, same markup/behavior as
  // Tickets' renderTkPagination - hidden entirely once everything fits on
  // one page.
  const renderItrPagination = (total, shownCount) => {
    const pagEl = document.getElementById("itr-pagination");
    if (!pagEl) return;
    if (total <= ITR_PAGE_SIZE) {
      pagEl.classList.add("hidden");
      pagEl.innerHTML = "";
      return;
    }
    const totalPages = Math.max(1, Math.ceil(total / ITR_PAGE_SIZE));
    const from = shownCount === 0 ? 0 : (itrPage - 1) * ITR_PAGE_SIZE + 1;
    const to = (itrPage - 1) * ITR_PAGE_SIZE + shownCount;
    pagEl.classList.remove("hidden");
    pagEl.innerHTML = `
      <span class="tk-pagination-info">Showing ${from} to ${to} of ${total.toLocaleString()} entries</span>
      <div class="tk-pagination-controls">
        <button class="btn btn-secondary btn-sm" id="itr-prev" ${itrPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="tk-pagination-page">Page ${itrPage} of ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" id="itr-next" ${itrPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>`;
    const prevBtn = document.getElementById("itr-prev");
    const nextBtn = document.getElementById("itr-next");
    if (prevBtn) prevBtn.onclick = () => { itrPage -= 1; renderFiltered(); };
    if (nextBtn) nextBtn.onclick = () => { itrPage += 1; renderFiltered(); };
  };

  renderFiltered();
  if (searchEl) searchEl.oninput = () => { itrPage = 1; renderFiltered(); };
  if (requesterEl) requesterEl.onchange = () => { itrPage = 1; renderFiltered(); };
}

/** Builds the "Branch(es) / Department(s)" checkbox list for the New IT
 * Request modal from a fresh /branches + /departments fetch (rather than
 * the possibly-stale state.branches/state.departments cached at login), so
 * a branch or department an admin just added elsewhere shows up here
 * without needing a full page reload. */
async function itRequestOptionGroupsHtml() {
  const [{ branches }, { departments }] = await Promise.all([api("/branches"), api("/departments")]);
  // "Departments" here already includes head-office departments (whatever
  // /departments returns) alongside the branch list - both groups are
  // rendered the same way and both get filtered by the search box below,
  // so searching finds a head-office department just as easily as a branch.
  const group = (label, items) => items.length ? `
    <div class="cbg-header muted" style="grid-column:1/-1; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; margin-top:4px;">${escapeHtml(label)}</div>
    ${items.map(b => `<label class="cbg-item" data-search="${escapeHtml(b.toLowerCase())}"><input type="checkbox" value="${escapeHtml(b)}"> ${escapeHtml(b)}</label>`).join("")}
  ` : "";
  return group("Branches", branches) + group("Departments", departments);
}

/** Wires the search box above a checkbox-grid built by
 * itRequestOptionGroupsHtml(): filters .cbg-item labels by substring match
 * (a checked-but-now-hidden item stays checked, it's just not shown) and
 * hides a .cbg-header whose whole group has no visible items left, rather
 * than leaving a dangling "Branches" heading over nothing. */
function wireCheckboxGroupSearch(searchInputEl, gridEl) {
  searchInputEl.oninput = () => {
    const q = searchInputEl.value.trim().toLowerCase();
    let groupHeader = null, groupHasVisible = false;
    const applyToLastHeader = () => { if (groupHeader) groupHeader.style.display = groupHasVisible ? "" : "none"; };
    Array.from(gridEl.children).forEach(el => {
      if (el.classList.contains("cbg-header")) {
        applyToLastHeader();
        groupHeader = el; groupHasVisible = false;
        return;
      }
      if (el.classList.contains("cbg-item")) {
        const match = !q || el.dataset.search.includes(q);
        el.style.display = match ? "" : "none";
        if (match) groupHasVisible = true;
      }
    });
    applyToLastHeader();
  };
}

async function wireITRequests(root) {
  const buildParams = wireDateFilterToolbar("itr");
  const searchEl = document.getElementById("itr-search");
  const requesterEl = document.getElementById("itr-requester");
  await loadAndRenderITRequests(root, buildParams, searchEl, requesterEl);

  document.getElementById("itr-run").onclick = () => loadAndRenderITRequests(root, buildParams, searchEl, requesterEl);
  const downloadBtn = document.createElement("button");
  downloadBtn.className = "btn btn-secondary btn-sm";
  downloadBtn.textContent = "Download .xlsx";
  downloadBtn.onclick = () => {
    const params = buildParams();
    const qs = params.toString();
    window.open(`/api/workspace/it-requests/export${qs ? `?${qs}` : ""}`, "_blank");
  };
  document.getElementById("itr-run").insertAdjacentElement("afterend", downloadBtn);

  document.getElementById("itr-new-btn").onclick = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const optionsHtml = await itRequestOptionGroupsHtml();
    openModal(`
      <div class="modal-header"><h2>New IT request</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <label>Date of request</label><input id="itr-date" type="date" value="${today}">
        <label>Branch(es) / Department(s)</label>
        <input id="itr-branch-search" type="text" placeholder="Search branch or head office department…" style="margin-bottom:8px;">
        <div class="checkbox-grid" id="itr-branches" style="max-height:220px; overflow-y:auto; border:1px solid var(--line); border-radius:8px; padding:10px;">
          ${optionsHtml}
        </div>
        <label>Description</label><textarea id="itr-desc" rows="4" placeholder="What is this request about?"></textarea>
        <label>Upload image (optional)</label><input id="itr-image" type="file" accept="image/*">
        <div id="itr-error" class="form-error hidden"></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="itr-save">Submit</button></div>`);
    wireCheckboxGroupSearch(document.getElementById("itr-branch-search"), document.getElementById("itr-branches"));
    const itrSaveBtn = document.getElementById("itr-save");
    itrSaveBtn.onclick = async () => {
      const errEl = document.getElementById("itr-error");
      errEl.classList.add("hidden");
      const requestDate = document.getElementById("itr-date").value;
      const branches = Array.from(document.querySelectorAll("#itr-branches input:checked")).map(cb => cb.value);
      const description = document.getElementById("itr-desc").value.trim();
      if (!requestDate) { errEl.textContent = "Date of request is required."; errEl.classList.remove("hidden"); return; }
      if (!branches.length) { errEl.textContent = "Select at least one branch or department."; errEl.classList.remove("hidden"); return; }
      if (!description) { errEl.textContent = "Description is required."; errEl.classList.remove("hidden"); return; }
      const fd = new FormData();
      fd.append("request_date", requestDate);
      fd.append("branches", JSON.stringify(branches));
      fd.append("description", description);
      const imageFile = document.getElementById("itr-image").files[0];
      if (imageFile) fd.append("image", imageFile);
      setBtnLoading(itrSaveBtn, true);
      try {
        await api("/workspace/it-requests", { method: "POST", formData: fd });
        toast("Request submitted.", "success");
        closeModal();
        goTab("workspace-itrequest");
      } catch (e) { errEl.textContent = e.message; errEl.classList.remove("hidden"); setBtnLoading(itrSaveBtn, false); }
    };
  };
}

// ---------------------------------------------------------------- Team Workspace: Item Borrowing (Super Admin only)

// "Item Borrowing" sub-page under the Team Workspace nav group - lets a
// Super Admin maintain the lendable item catalog (add, edit, remove),
// decide pending borrow requests, and see the full cross-department
// borrow log, with the same date-filter/search/pagination conventions as
// the IT Request page above. IT Department is a borrower only (like Head
// Office Employee) and never sees this page - both get their own "Borrow
// Items" tab (see renderBorrowItemsPage) to actually borrow something and
// check their own department's history.
async function renderItemBorrowingPage(root) {
  root.innerHTML = `
    <div class="panel" id="bi-catalog-panel">
      <div class="panel-header"><h3>Item catalog</h3>
        <button class="btn btn-primary btn-sm" id="bi-new-item-btn">+ Add item</button>
      </div>
      <div class="panel-body table-wrap">
        <table><tr><th>Item</th><th>Description</th><th>Available / Total</th><th></th></tr>
          <tbody id="bi-item-rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="panel" id="bi-records-panel">
      <div class="panel-header"><h3>Borrow records</h3></div>
      <div class="panel-body">
        ${dateFilterToolbarHtml("bir")}
        <div class="toolbar" style="margin-top:10px;">
          <input id="bir-search" type="text" placeholder="Search item, department, or borrower…" style="flex:1;">
          <select id="bir-status">
            <option value="All">All statuses</option>
            <option value="Pending">Pending</option>
            <option value="Borrowed">Borrowed</option>
            <option value="Returned">Returned</option>
            <option value="Denied">Denied</option>
          </select>
        </div>
        <div class="table-wrap" style="margin-top:14px;">
          <table>
            <tr><th>Item</th><th>Qty</th><th>Department</th><th>Borrowed by</th><th>Notes</th><th>From</th><th>To</th><th>Status</th><th></th></tr>
            <tbody id="bir-rows"><tr><td colspan="9" class="muted">Loading…</td></tr></tbody>
          </table>
        </div>
        <div id="bir-pagination" class="tk-pagination hidden"></div>
      </div>
    </div>`;
  await loadAndRenderBorrowItemsCatalog(root);
  wireBorrowRecords(root);
}

/** Loads the catalog table and wires each row's Edit/Delete buttons, plus
 * the "+ Add item" button's modal. Re-invoked after every add/edit/delete
 * (via goTab) rather than patching the DOM in place, same as the rest of
 * the app's admin list pages (Branches/Departments/Categories). */
async function loadAndRenderBorrowItemsCatalog(root) {
  const rowsEl = document.getElementById("bi-item-rows");
  let items = [];
  try {
    ({ items } = await api("/borrow-items"));
  } catch (e) {
    if (rowsEl) rowsEl.innerHTML = `<tr><td colspan="4" class="form-error">${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  if (!rowsEl) return; // user navigated away while this was loading

  rowsEl.innerHTML = items.length ? items.map(it => `
    <tr>
      <td>${escapeHtml(it.name)}</td>
      <td class="muted">${escapeHtml(it.description || "—")}</td>
      <td>${it.available_quantity} / ${it.total_quantity}</td>
      <td class="row-actions">
        <button class="btn btn-secondary btn-sm" data-bi-edit="${it.id}">Edit</button>
        <button class="btn btn-danger btn-sm" data-bi-delete="${it.id}">Delete</button>
      </td>
    </tr>`).join("") : `<tr><td colspan="4" class="muted">No items in the catalog yet.</td></tr>`;

  const openItemModal = (existing = null) => {
    openModal(`
      <div class="modal-header"><h2>${existing ? "Edit item" : "Add item"}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
      <div class="modal-body">
        <label>Item name</label><input id="bi-name" type="text" value="${existing ? escapeHtml(existing.name) : ""}" placeholder="e.g. HDMI cable">
        <label>Description (optional)</label><textarea id="bi-desc" rows="3" placeholder="Notes IT staff should know about this item">${existing ? escapeHtml(existing.description || "") : ""}</textarea>
        <label>Total quantity</label><input id="bi-qty" type="number" min="1" value="${existing ? existing.total_quantity : 1}">
        <div id="bi-error" class="form-error hidden"></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="bi-save">${existing ? "Save" : "Add"}</button></div>`);
    const saveBtn = document.getElementById("bi-save");
    saveBtn.onclick = async () => {
      const errEl = document.getElementById("bi-error");
      errEl.classList.add("hidden");
      const name = document.getElementById("bi-name").value.trim();
      const description = document.getElementById("bi-desc").value.trim();
      const quantity = Number(document.getElementById("bi-qty").value);
      if (!name) { errEl.textContent = "Item name is required."; errEl.classList.remove("hidden"); return; }
      if (!Number.isInteger(quantity) || quantity < 1) { errEl.textContent = "Quantity must be a whole number of at least 1."; errEl.classList.remove("hidden"); return; }
      try {
        if (existing) {
          await api(`/borrow-items/${existing.id}`, { method: "PUT", body: { name, description, quantity } }, saveBtn);
          toast("Item updated.", "success");
        } else {
          await api("/borrow-items", { method: "POST", body: { name, description, quantity } }, saveBtn);
          toast("Item added.", "success");
        }
        closeModal();
        goTab("workspace-borrow");
      } catch (e) { errEl.textContent = e.message; errEl.classList.remove("hidden"); }
    };
  };

  document.getElementById("bi-new-item-btn").onclick = () => openItemModal(null);
  rowsEl.querySelectorAll("[data-bi-edit]").forEach((btn) => {
    btn.onclick = () => openItemModal(items.find(it => it.id === Number(btn.dataset.biEdit)));
  });
  rowsEl.querySelectorAll("[data-bi-delete]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("Remove this item from the catalog? Past borrow records are kept.")) return;
      try {
        await api(`/borrow-items/${btn.dataset.biDelete}`, { method: "DELETE" }, btn);
        toast("Item removed.", "success");
        goTab("workspace-borrow");
      } catch (e) { toast(e.message, "error"); }
    };
  });
}

/** Does this borrow record match the search query? Same any-word-any-order
 * convention as itRequestMatchesSearch above. */
function itemBorrowMatchesSearch(b, query) {
  return matchesSearchWords(
    `${b.item_name} ${b.department} ${b.borrower_name || ""} ${b.borrowed_by_name} ${b.notes || ""}`,
    query
  );
}

/** Status badge for one borrow record - shared between the admin "Item
 * Borrowing" records table and a Head Office Employee's own borrow
 * history, so both read the same way. 'Denied' surfaces the admin's
 * decision_note right in the badge's title tooltip (and the caller can
 * also show it inline - see loadAndRenderBorrowItems) so the reason for
 * the denial is never more than a hover away. */
function borrowStatusBadgeHtml(b) {
  if (b.status === "Returned") return `<span class="badge badge-resolved">Returned ${fmtDate(b.return_date)}</span>`;
  if (b.status === "Borrowed") return `<span class="badge badge-open">Borrowed</span>`;
  if (b.status === "Denied") {
    return `<span class="badge badge-critical" title="${escapeHtml(b.decision_note || "")}">Denied</span>`;
  }
  return `<span class="badge badge-requested">Pending</span>`;
}

function wireBorrowRecords(root) {
  const buildParams = wireDateFilterToolbar("bir");
  const searchEl = document.getElementById("bir-search");
  const statusEl = document.getElementById("bir-status");
  const rowsEl = document.getElementById("bir-rows");

  const BIR_PAGE_SIZE = 10;
  let birPage = 1;
  let borrows = [];

  const canDelete = (b) => state.user.role === "Super Admin";

  function renderFiltered() {
    const query = (searchEl.value || "").trim();
    const status = statusEl.value;
    const filtered = borrows
      .filter((b) => status === "All" || b.status === status)
      .filter((b) => itemBorrowMatchesSearch(b, query));
    const totalPages = Math.max(1, Math.ceil(filtered.length / BIR_PAGE_SIZE));
    if (birPage > totalPages) birPage = totalPages;
    const pageItems = filtered.slice((birPage - 1) * BIR_PAGE_SIZE, birPage * BIR_PAGE_SIZE);

    rowsEl.innerHTML = pageItems.length ? pageItems.map(b => `
      <tr>
        <td>${escapeHtml(b.item_name)}</td>
        <td>${b.quantity}</td>
        <td class="muted">${escapeHtml(b.department)}</td>
        <td class="muted">${escapeHtml(b.borrower_name || b.borrowed_by_name)}</td>
        <td class="muted" style="max-width:220px; white-space:pre-wrap;">${escapeHtml(b.notes || "—")}</td>
        <td class="muted">${fmtDate(b.borrow_date)}</td>
        <td class="muted">${fmtDate(b.expected_return_date)}</td>
        <td>${borrowStatusBadgeHtml(b)}${b.status === "Denied" && b.decision_note ? `<div class="muted" style="font-size:12px;margin-top:2px;">${escapeHtml(b.decision_note)}</div>` : ""}</td>
        <td class="row-actions">
          ${b.status === "Pending" ? `<button class="btn btn-primary btn-sm" data-bir-approve="${b.id}">Approve</button><button class="btn btn-danger btn-sm" data-bir-deny="${b.id}">Deny</button>` : ""}
          ${b.status === "Borrowed" ? `<button class="btn btn-secondary btn-sm" data-bir-return="${b.id}">Mark returned</button>` : ""}
          ${canDelete(b) ? `<button class="btn btn-danger btn-sm" data-bir-delete="${b.id}">Delete</button>` : ""}
        </td>
      </tr>`).join("") : `<tr><td colspan="9" class="muted">${borrows.length ? "No records match your search." : "No borrow records in this period."}</td></tr>`;

    renderBirPagination(filtered.length, pageItems.length);

    rowsEl.querySelectorAll("[data-bir-approve]").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Approve this borrow request?")) return;
        try {
          await api(`/item-borrows/${btn.dataset.birApprove}/decide`, { method: "POST", body: { approve: true } }, btn);
          toast("Borrow request approved.", "success");
          goTab("workspace-borrow");
        } catch (e) { toast(e.message, "error"); }
      };
    });
    rowsEl.querySelectorAll("[data-bir-deny]").forEach((btn) => {
      btn.onclick = async () => {
        const note = (prompt("Why is this borrow request being denied? (this is shown to the requester)") || "").trim();
        if (!note) { toast("Please explain why this borrow request is being denied.", "error"); return; }
        try {
          await api(`/item-borrows/${btn.dataset.birDeny}/decide`, { method: "POST", body: { approve: false, note } }, btn);
          toast("Borrow request denied.", "success");
          goTab("workspace-borrow");
        } catch (e) { toast(e.message, "error"); }
      };
    });
    rowsEl.querySelectorAll("[data-bir-return]").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Mark this item as returned?")) return;
        try {
          await api(`/workspace/item-borrows/${btn.dataset.birReturn}/return`, { method: "PUT" }, btn);
          toast("Marked returned.", "success");
          goTab("workspace-borrow");
        } catch (e) { toast(e.message, "error"); }
      };
    });
    rowsEl.querySelectorAll("[data-bir-delete]").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Delete this borrow record?")) return;
        try {
          await api(`/item-borrows/${btn.dataset.birDelete}`, { method: "DELETE" }, btn);
          toast("Record deleted.", "success");
          goTab("workspace-borrow");
        } catch (e) { toast(e.message, "error"); }
      };
    });
  }

  // Same "Showing X to Y of Z entries" + Previous/Next footer as the IT
  // Request page's renderItrPagination.
  const renderBirPagination = (total, shownCount) => {
    const pagEl = document.getElementById("bir-pagination");
    if (!pagEl) return;
    if (total <= BIR_PAGE_SIZE) {
      pagEl.classList.add("hidden");
      pagEl.innerHTML = "";
      return;
    }
    const totalPages = Math.max(1, Math.ceil(total / BIR_PAGE_SIZE));
    const from = shownCount === 0 ? 0 : (birPage - 1) * BIR_PAGE_SIZE + 1;
    const to = (birPage - 1) * BIR_PAGE_SIZE + shownCount;
    pagEl.classList.remove("hidden");
    pagEl.innerHTML = `
      <span class="tk-pagination-info">Showing ${from} to ${to} of ${total.toLocaleString()} entries</span>
      <div class="tk-pagination-controls">
        <button class="btn btn-secondary btn-sm" id="bir-prev" ${birPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="tk-pagination-page">Page ${birPage} of ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" id="bir-next" ${birPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>`;
    const prevBtn = document.getElementById("bir-prev");
    const nextBtn = document.getElementById("bir-next");
    if (prevBtn) prevBtn.onclick = () => { birPage -= 1; renderFiltered(); };
    if (nextBtn) nextBtn.onclick = () => { birPage += 1; renderFiltered(); };
  };

  const loadAndRender = async () => {
    rowsEl.innerHTML = `<tr><td colspan="9" class="muted">Loading…</td></tr>`;
    try {
      const params = buildParams();
      const qs = params.toString();
      ({ borrows } = await api(`/workspace/item-borrows${qs ? `?${qs}` : ""}`));
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="9" class="form-error">${escapeHtml(e.message)}</td></tr>`;
      return;
    }
    birPage = 1;
    renderFiltered();
  };

  document.getElementById("bir-run").onclick = loadAndRender;
  searchEl.oninput = () => { birPage = 1; renderFiltered(); };
  statusEl.onchange = () => { birPage = 1; renderFiltered(); };

  loadAndRender();
}

// ---------------------------------------------------------------- Borrow Items (Head Office Employee / IT Department)

// "Borrow Items" tab - a Head Office Employee's (or an IT Department
// account's, borrowing for itself) own view of the IT-managed item catalog
// (read-only, quantities only) plus a "Borrow" action, and their own
// department's borrow history below it. Only ever shows/affects their own
// department - never another department's records (see server's
// /api/item-borrows, scoped server-side to user.branch - "IT Department"
// for IT accounts).
async function renderBorrowItemsPage(root) {
  root.innerHTML = `
    <div class="panel" id="bo-items-panel">
      <div class="panel-header"><h3>Available items</h3></div>
      <div class="panel-body">
        <div class="toolbar toolbar-search">
          <input id="bo-item-search" class="grow" type="text" placeholder="Search item or description…">
        </div>
        <div class="table-wrap" style="margin-top:10px;">
          <table><tr><th>Item</th><th>Description</th><th>Available</th><th></th></tr>
            <tbody id="bo-item-rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
          </table>
        </div>
        <div id="bo-item-pagination" class="tk-pagination hidden"></div>
      </div>
    </div>

    <div class="panel" id="bo-history-panel">
      <div class="panel-header"><h3>${escapeHtml(state.user.branch)} — borrow history</h3></div>
      <div class="panel-body">
        <div class="toolbar toolbar-search">
          <input id="bo-history-search" class="grow" type="text" placeholder="Search item, borrower, or status…">
        </div>
        <div class="table-wrap" style="margin-top:10px;">
          <table><tr><th>Item</th><th>Qty</th><th>Borrowed by</th><th>From</th><th>To</th><th>Status</th><th></th></tr>
            <tbody id="bo-history-rows"><tr><td colspan="7" class="muted">Loading…</td></tr></tbody>
          </table>
        </div>
        <div id="bo-history-pagination" class="tk-pagination hidden"></div>
      </div>
    </div>`;
  await loadAndRenderBorrowItems(root);
}

// Both tables on this page are loaded in full up front (items and borrows are
// small per-department lists), then filtered/paginated client-side - same
// "Showing X to Y of Z entries" + Previous/Next footer used elsewhere (see
// wireBorrowRecords' renderBirPagination), just two independent instances
// of it on one page.
const BO_PAGE_SIZE = 10;

async function loadAndRenderBorrowItems(root) {
  const itemRowsEl = document.getElementById("bo-item-rows");
  const historyRowsEl = document.getElementById("bo-history-rows");
  const itemSearchEl = document.getElementById("bo-item-search");
  const historySearchEl = document.getElementById("bo-history-search");
  let items = [], borrows = [];
  try {
    [{ items }, { borrows }] = await Promise.all([api("/borrow-items"), api("/item-borrows")]);
  } catch (e) {
    if (itemRowsEl) itemRowsEl.innerHTML = `<tr><td colspan="4" class="form-error">${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  if (!itemRowsEl) return; // user navigated away while this was loading

  let itemPage = 1;
  let historyPage = 1;

  function wireBorrowButtons() {
    itemRowsEl.querySelectorAll("[data-bo-borrow]").forEach((btn) => {
      btn.onclick = () => {
        const item = items.find(it => it.id === Number(btn.dataset.boBorrow));
        const today = new Date().toISOString().slice(0, 10);
        openModal(`
          <div class="modal-header"><h2>Borrow ${escapeHtml(item.name)}</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
          <div class="modal-body">
            <label>Quantity (${item.available_quantity} available)</label>
            <input id="bo-qty" type="number" min="1" max="${item.available_quantity}" value="1">
            <label>Staff borrower</label>
            <input id="bo-borrower" type="text" placeholder="Name of the staff member using it" maxlength="150">
            <label>From</label><input id="bo-from-date" type="date" value="${today}" min="${today}">
            <label>To</label><input id="bo-to-date" type="date" value="${today}" min="${today}">
            <label>Notes (optional)</label><textarea id="bo-notes" rows="3" placeholder="What this is for, who's using it, etc."></textarea>
            <div id="bo-error" class="form-error hidden"></div>
          </div>
          <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="bo-save">Borrow</button></div>`);
        // Advancing "From" past the current "To" (or vice versa) keeps the
        // range valid without the person having to notice and fix it
        // themselves - same "just keep it sane" touch as elsewhere in the app.
        const fromEl = document.getElementById("bo-from-date");
        const toEl = document.getElementById("bo-to-date");
        fromEl.onchange = () => { toEl.min = fromEl.value; if (toEl.value < fromEl.value) toEl.value = fromEl.value; };
        const saveBtn = document.getElementById("bo-save");
        saveBtn.onclick = async () => {
          const errEl = document.getElementById("bo-error");
          errEl.classList.add("hidden");
          const quantity = Number(document.getElementById("bo-qty").value);
          const borrowerName = document.getElementById("bo-borrower").value.trim();
          const fromDate = fromEl.value;
          const toDate = toEl.value;
          const notes = document.getElementById("bo-notes").value.trim();
          if (!Number.isInteger(quantity) || quantity < 1) { errEl.textContent = "Quantity must be a whole number of at least 1."; errEl.classList.remove("hidden"); return; }
          if (!borrowerName) { errEl.textContent = "Enter the name of the staff member borrowing this."; errEl.classList.remove("hidden"); return; }
          if (!fromDate || !toDate) { errEl.textContent = "Both 'From' and 'To' dates are required."; errEl.classList.remove("hidden"); return; }
          if (toDate < fromDate) { errEl.textContent = "'To' date can't be before 'From' date."; errEl.classList.remove("hidden"); return; }
          try {
            await api("/item-borrows", { method: "POST", body: { item_id: item.id, quantity, borrower_name: borrowerName, from_date: fromDate, to_date: toDate, notes } }, saveBtn);
            toast("Borrow request sent for approval.", "success");
            closeModal();
            goTab("borrow-items");
          } catch (e) { errEl.textContent = e.message; errEl.classList.remove("hidden"); }
        };
      };
    });
  }

  function wireCancelButtons() {
    historyRowsEl.querySelectorAll("[data-bo-cancel]").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm("Cancel this borrow request?")) return;
        try {
          await api(`/item-borrows/${btn.dataset.boCancel}`, { method: "DELETE" }, btn);
          toast("Request cancelled.", "success");
          goTab("borrow-items");
        } catch (e) { toast(e.message, "error"); }
      };
    });
  }

  function renderItemPagination(total, shownCount) {
    const pagEl = document.getElementById("bo-item-pagination");
    if (!pagEl) return;
    if (total <= BO_PAGE_SIZE) { pagEl.classList.add("hidden"); pagEl.innerHTML = ""; return; }
    const totalPages = Math.max(1, Math.ceil(total / BO_PAGE_SIZE));
    const from = shownCount === 0 ? 0 : (itemPage - 1) * BO_PAGE_SIZE + 1;
    const to = (itemPage - 1) * BO_PAGE_SIZE + shownCount;
    pagEl.classList.remove("hidden");
    pagEl.innerHTML = `
      <span class="tk-pagination-info">Showing ${from} to ${to} of ${total.toLocaleString()} entries</span>
      <div class="tk-pagination-controls">
        <button class="btn btn-secondary btn-sm" id="bo-item-prev" ${itemPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="tk-pagination-page">Page ${itemPage} of ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" id="bo-item-next" ${itemPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>`;
    const prevBtn = document.getElementById("bo-item-prev");
    const nextBtn = document.getElementById("bo-item-next");
    if (prevBtn) prevBtn.onclick = () => { itemPage -= 1; renderItemsFiltered(); };
    if (nextBtn) nextBtn.onclick = () => { itemPage += 1; renderItemsFiltered(); };
  }

  function renderHistoryPagination(total, shownCount) {
    const pagEl = document.getElementById("bo-history-pagination");
    if (!pagEl) return;
    if (total <= BO_PAGE_SIZE) { pagEl.classList.add("hidden"); pagEl.innerHTML = ""; return; }
    const totalPages = Math.max(1, Math.ceil(total / BO_PAGE_SIZE));
    const from = shownCount === 0 ? 0 : (historyPage - 1) * BO_PAGE_SIZE + 1;
    const to = (historyPage - 1) * BO_PAGE_SIZE + shownCount;
    pagEl.classList.remove("hidden");
    pagEl.innerHTML = `
      <span class="tk-pagination-info">Showing ${from} to ${to} of ${total.toLocaleString()} entries</span>
      <div class="tk-pagination-controls">
        <button class="btn btn-secondary btn-sm" id="bo-history-prev" ${historyPage <= 1 ? "disabled" : ""}>Previous</button>
        <span class="tk-pagination-page">Page ${historyPage} of ${totalPages}</span>
        <button class="btn btn-secondary btn-sm" id="bo-history-next" ${historyPage >= totalPages ? "disabled" : ""}>Next</button>
      </div>`;
    const prevBtn = document.getElementById("bo-history-prev");
    const nextBtn = document.getElementById("bo-history-next");
    if (prevBtn) prevBtn.onclick = () => { historyPage -= 1; renderHistoryFiltered(); };
    if (nextBtn) nextBtn.onclick = () => { historyPage += 1; renderHistoryFiltered(); };
  }

  function renderItemsFiltered() {
    const query = (itemSearchEl.value || "").trim();
    const filtered = items.filter(it => matchesSearchWords(`${it.name} ${it.description || ""}`, query));
    const totalPages = Math.max(1, Math.ceil(filtered.length / BO_PAGE_SIZE));
    if (itemPage > totalPages) itemPage = totalPages;
    const pageItems = filtered.slice((itemPage - 1) * BO_PAGE_SIZE, itemPage * BO_PAGE_SIZE);

    itemRowsEl.innerHTML = pageItems.length ? pageItems.map(it => `
      <tr>
        <td>${escapeHtml(it.name)}</td>
        <td class="muted">${escapeHtml(it.description || "—")}</td>
        <td>${it.available_quantity}</td>
        <td>${it.available_quantity > 0
          ? `<button class="btn btn-primary btn-sm" data-bo-borrow="${it.id}">Borrow</button>`
          : `<span class="muted">Unavailable</span>`}</td>
      </tr>`).join("") : `<tr><td colspan="4" class="muted">${items.length ? "No items match your search." : "IT hasn't added any items yet."}</td></tr>`;

    renderItemPagination(filtered.length, pageItems.length);
    wireBorrowButtons();
  }

  function renderHistoryFiltered() {
    const query = (historySearchEl.value || "").trim();
    const filtered = borrows.filter(b => matchesSearchWords(
      `${b.item_name} ${b.borrowed_by_name} ${b.borrower_name || ""} ${b.status}`,
      query
    ));
    const totalPages = Math.max(1, Math.ceil(filtered.length / BO_PAGE_SIZE));
    if (historyPage > totalPages) historyPage = totalPages;
    const pageItems = filtered.slice((historyPage - 1) * BO_PAGE_SIZE, historyPage * BO_PAGE_SIZE);

    historyRowsEl.innerHTML = pageItems.length ? pageItems.map(b => `
      <tr>
        <td>${escapeHtml(b.item_name)}</td>
        <td>${b.quantity}</td>
        <td class="muted">${escapeHtml(b.borrower_name || b.borrowed_by_name)}</td>
        <td class="muted">${fmtDate(b.borrow_date)}</td>
        <td class="muted">${fmtDate(b.expected_return_date)}</td>
        <td>${borrowStatusBadgeHtml(b)}${b.status === "Denied" && b.decision_note ? `<div class="muted" style="font-size:12px;margin-top:2px;">${escapeHtml(b.decision_note)}</div>` : ""}</td>
        <td class="row-actions">
          ${b.status === "Pending" ? `<button class="btn btn-danger btn-sm" data-bo-cancel="${b.id}">Cancel</button>` : ""}
        </td>
      </tr>`).join("") : `<tr><td colspan="7" class="muted">${borrows.length ? "No records match your search." : "Your department hasn't borrowed anything yet."}</td></tr>`;

    renderHistoryPagination(filtered.length, pageItems.length);
    wireCancelButtons();
  }

  itemSearchEl.oninput = () => { itemPage = 1; renderItemsFiltered(); };
  historySearchEl.oninput = () => { historyPage = 1; renderHistoryFiltered(); };

  renderItemsFiltered();
  renderHistoryFiltered();
}


// ---------------------------------------------------------------- IT Staff & Availability

async function renderItStaff(root) {
  const isSuperAdmin = state.user.role === "Super Admin";
  const { staff } = await api("/it-staff");
  const staffGroups = isSuperAdmin ? (await api("/settings/groups")).staff_groups : [];
  const modeRes = isSuperAdmin ? await api("/settings/mode") : { mode: "normal" };
  state.modeLocked = modeRes.can_change === false;
  const systemMode = modeRes.mode;
  const { absences } = await api("/absences");
  const pendingRequests = isSuperAdmin ? (await api("/availability/requests")).requests : [];
  const { request: myRequest } = await api("/availability/my-request");
  state.itStaff = staff;
  const me = staff.find(s => s.id === state.user.id);
  const today = new Date().toISOString().slice(0, 10);
  const iAmLocked = me && me.is_available === false && (!me.unavailable_from || me.unavailable_from <= today);

  root.innerHTML = `
    <div class="panel">
      <div class="panel-header"><h3>My availability</h3></div>
      <div class="panel-body">
        ${iAmLocked
          ? `<p class="muted">You're currently marked unavailable${me.unavailable_until ? ` until ${fmtDate(me.unavailable_until)}` : ""}. A Super Admin needs to restore your access.</p>`
          : myRequest
          ? `<p class="muted">${myRequest.kind === "field"
              ? `Your request to be marked unavailable${myRequest.unavailable_from ? ` from ${fmtDate(myRequest.unavailable_from)}${myRequest.unavailable_until ? ` to ${fmtDate(myRequest.unavailable_until)}` : ""}` : ""} is pending Super Admin approval.`
              : "You have a request pending Super Admin approval."}</p>`
          : `<p class="muted">Heading out on a site visit or otherwise going to be unreachable? Send a request so a Super Admin can mark you unavailable and cover your open tickets.</p>
             <button class="btn btn-danger btn-sm" id="request-field-btn">Request to be marked unavailable</button>`}
      </div>
    </div>

    ${isSuperAdmin ? `
    ${systemModePanelHtml(systemMode)}

    <div class="panel">
      <div class="panel-header"><h3>Pending availability requests</h3></div>
      <div class="panel-body table-wrap">
        <table><tr><th>Staff</th><th>Blocked by</th><th>Requested</th><th></th></tr>
          ${pendingRequests.length ? pendingRequests.map(r => `<tr>
            <td>${escapeHtml(r.full_name)}</td>
            <td>${r.kind === "absence"
              ? `<span class="badge badge-requested">📅 Marked absent</span>`
              : r.kind === "field"
              ? `<span class="badge badge-requested">🚗 Requesting field/unavailable${r.unavailable_from ? ` — from ${fmtDate(r.unavailable_from)}${r.unavailable_until ? ` to ${fmtDate(r.unavailable_until)}` : ""}` : ""}${r.reason ? ` — ${escapeHtml(r.reason)}` : ""}</span>`
              : `<span class="badge badge-critical">🔒 Account locked</span>`}</td>
            <td class="muted">${fmtDateTime(r.requested_at)}</td>
            <td>
              <button class="btn btn-primary btn-sm" data-approve-avail="${r.id}">Approve</button>
              <button class="btn btn-danger btn-sm" data-deny-avail="${r.id}">Deny</button>
            </td>
          </tr>`).join("") : `<tr><td colspan="4" class="muted">No pending requests.</td></tr>`}
        </table>
      </div>
    </div>` : ""}

    <div class="panel"><div class="panel-header"><h3>IT Department roster</h3></div>
      <div class="panel-body table-wrap">
        <table><tr><th>Name</th><th>Line of Business</th><th>Concerns handled</th><th>Availability</th>${isSuperAdmin ? "<th></th>" : ""}</tr>
          ${staff.map(s => {
            const today = new Date().toISOString().slice(0, 10);
            const lockScheduled = s.is_available === false && s.unavailable_from && s.unavailable_from > today;
            const lockActive = s.is_available === false && !lockScheduled;
            return `<tr>
            <td>${escapeHtml(s.full_name)}</td>
            <td>${isSuperAdmin
              ? `<select data-staff-group="${s.id}">
                   <option value="">— none —</option>
                   ${staffGroups.map(g => `<option value="${escapeHtml(g)}" ${g === s.group_name ? "selected" : ""}>${escapeHtml(g)}</option>`).join("")}
                 </select>`
              : (s.group_name ? escapeHtml(s.group_name) : `<span class="muted">— none —</span>`)}</td>
            <td id="spec-${s.id}" class="muted">…</td>
            <td>${lockActive
              ? `<span class="badge badge-critical">Unavailable${s.unavailable_until ? ` (until ${fmtDate(s.unavailable_until)})` : ""}</span>`
              : lockScheduled
              ? `<span class="badge badge-requested">Scheduled — from ${fmtDate(s.unavailable_from)}${s.unavailable_until ? ` to ${fmtDate(s.unavailable_until)}` : ""}</span>`
              : `<span class="badge badge-resolved">Available</span>`}</td>
            ${isSuperAdmin ? `<td>
                <button class="btn btn-secondary btn-sm" data-edit-spec="${s.id}">Edit concerns</button>
                ${s.is_available === false
                  ? `<button class="btn btn-primary btn-sm" data-mark-available="${s.id}" ${lockScheduled ? `data-was-scheduled="1"` : ""}>${lockScheduled ? "Cancel" : "Mark available"}</button>`
                  : (s.id === state.user.id ? "" : `<button class="btn btn-danger btn-sm" data-mark-unavailable="${s.id}">Mark unavailable</button>`)}
              </td>` : ""}
          </tr>`;
          }).join("")}
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Absences / on-field</h3>
        ${isSuperAdmin ? `<button class="btn btn-primary btn-sm" id="mark-absent-btn">+ Mark absent</button>` : ""}
      </div>
      <div class="panel-body table-wrap">
        <table><tr><th>Staff</th><th>Date</th><th>Reason</th>${isSuperAdmin ? "<th></th>" : ""}</tr>
          ${absences.length ? absences.map(a => `<tr>
            <td>${escapeHtml(a.full_name)}</td><td>${fmtDate(a.absence_date)}</td><td class="muted">${escapeHtml(a.reason || "—")}</td>
            ${isSuperAdmin ? `<td><button class="btn btn-danger btn-sm" data-unmark="${a.id}">Remove</button></td>` : ""}
          </tr>`).join("") : `<tr><td colspan="${isSuperAdmin ? 4 : 3}" class="muted">No upcoming absences.</td></tr>`}
        </table>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Absence history</h3>
        <button class="btn btn-secondary btn-sm" id="toggle-absence-history">Show</button>
      </div>
      <div class="panel-body hidden" id="absence-history-body">
        ${dateFilterToolbarHtml("abh")}
        <div class="table-wrap">
          <table><tr><th>Staff</th><th>Date</th><th>Reason</th><th>Marked by</th></tr>
            <tbody id="absence-history-rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><h3>Unavailable history</h3>
        <button class="btn btn-secondary btn-sm" id="toggle-availability-history">Show</button>
      </div>
      <div class="panel-body hidden" id="availability-history-body">
        ${dateFilterToolbarHtml("avh")}
        <div class="table-wrap">
          <table><tr><th>Staff</th><th>Change</th><th>Reason</th><th>By</th><th>When</th></tr>
            <tbody id="availability-history-rows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>`;

  wireSystemModePanel(root, systemMode, "itstaff");

  root.querySelectorAll("[data-staff-group]").forEach(sel => {
    sel.onchange = async () => {
      try {
        await api(`/users/${sel.dataset.staffGroup}/group`, { method: "PUT", body: { group: sel.value || null } });
        toast("Staff group saved.", "success");
      } catch (e) { toast(e.message, "error"); }
    };
  });

  const requestFieldBtn = document.getElementById("request-field-btn");
  if (requestFieldBtn) {
    requestFieldBtn.onclick = () => {
      const today = new Date().toISOString().slice(0, 10);
      openModal(`
        <div class="modal-header"><h2>Request to be marked unavailable</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="modal-body">
          <p class="muted">A Super Admin will review this before you're actually blocked from signing in.</p>
          <label>From</label><input id="field-req-from" type="date" value="${today}">
          <label>Until <span class="muted">(optional — leave blank if you don't know yet)</span></label><input id="field-req-until" type="date">
          <label>Reason (optional)</label><input id="field-req-reason" type="text" placeholder="e.g. Site visit at Branch X">
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-danger" id="field-req-save">Send request</button></div>`);
      document.getElementById("field-req-save").onclick = async () => {
        const saveBtn = document.getElementById("field-req-save");
        const from = document.getElementById("field-req-from").value;
        const until = document.getElementById("field-req-until").value;
        if (until && from && until < from) {
          toast("The 'until' date can't be before the 'from' date.", "error");
          return;
        }
        setBtnLoading(saveBtn, true);
        try {
          const result = await api("/availability/field-request", { method: "POST", body: {
            reason: document.getElementById("field-req-reason").value.trim() || null,
            unavailable_from: from || null,
            unavailable_until: until || null,
          }});
          toast(result.message, "success");
          closeModal(); goTab("itstaff");
        } catch (e) { toast(e.message, "error"); setBtnLoading(saveBtn, false); }
      };
    };
  }

  root.querySelectorAll("[data-approve-avail]").forEach(btn => {
    btn.onclick = async () => {
      try {
        await api(`/availability/requests/${btn.dataset.approveAvail}/approve`, { method: "POST" }, btn);
        toast("Request approved.", "success");
        refreshApprovalBells();
        goTab("itstaff");
      } catch (e) { toast(e.message, "error"); }
    };
  });
  root.querySelectorAll("[data-deny-avail]").forEach(btn => {
    btn.onclick = async () => {
      try {
        await api(`/availability/requests/${btn.dataset.denyAvail}/deny`, { method: "POST" }, btn);
        toast("Request denied.", "success");
        refreshApprovalBells();
        goTab("itstaff");
      } catch (e) { toast(e.message, "error"); }
    };
  });
  root.querySelectorAll("[data-mark-unavailable]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.markUnavailable;
      const today = new Date().toISOString().slice(0, 10);
      openModal(`
        <div class="modal-header"><h2>Mark unavailable</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="modal-body">
          <p class="muted">They'll be blocked from signing in until a Super Admin restores access.</p>
          <label>From</label><input id="unavail-from" type="date" value="${today}">
          <label>Until <span class="muted">(optional — leave blank if you don't know yet)</span></label><input id="unavail-until" type="date">
          <label>Reason (optional, saved to history)</label><input id="unavail-reason" type="text">
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-danger" id="unavail-save">Mark unavailable</button></div>`);
      document.getElementById("unavail-save").onclick = async () => {
        const unavailSaveBtn = document.getElementById("unavail-save");
        const from = document.getElementById("unavail-from").value;
        const until = document.getElementById("unavail-until").value;
        if (until && from && until < from) {
          toast("The 'until' date can't be before the 'from' date.", "error");
          return;
        }
        setBtnLoading(unavailSaveBtn, true);
        try {
          await api(`/it-staff/${id}/availability`, { method: "POST", body: {
            available: false,
            reason: document.getElementById("unavail-reason").value.trim() || null,
            unavailable_from: from || null,
            unavailable_until: until || null,
          }});
          const todayStr = new Date().toISOString().slice(0, 10);
          const isScheduledForLater = from && from > todayStr;
          toast(
            isScheduledForLater
              ? `Scheduled — they'll be locked out starting ${from}, and can sign in normally until then.`
              : "Marked unavailable — they'll need Super Admin approval to sign in again.",
            "success"
          );
          closeModal(); goTab("itstaff");
        } catch (e) { toast(e.message, "error"); setBtnLoading(unavailSaveBtn, false); }
      };
    };
  });
  root.querySelectorAll("[data-mark-available]").forEach(btn => {
    btn.onclick = async () => {
      try {
        await api(`/it-staff/${btn.dataset.markAvailable}/availability`, { method: "POST", body: { available: true } }, btn);
        toast(btn.dataset.wasScheduled ? "Scheduled unavailability cancelled." : "Marked available.", "success");
        refreshApprovalBells();
        goTab("itstaff");
      } catch (e) { toast(e.message, "error"); }
    };
  });

  staff.forEach(async s => {
    try {
      const { specialties } = await api(`/it-staff/${s.id}/specialties`);
      const cell = document.getElementById(`spec-${s.id}`);
      if (cell) cell.textContent = specialties.length ? specialties.join(", ") : "—";
    } catch (e) {}
  });

  root.querySelectorAll("[data-edit-spec]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.editSpec;
      const { specialties } = await api(`/it-staff/${id}/specialties`);
      openModal(`
        <div class="modal-header"><h2>Concerns handled</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="modal-body">
          <div class="checkbox-grid">${state.categories.map(c => `<label><input type="checkbox" value="${c}" ${specialties.includes(c) ? "checked" : ""}> ${c}</label>`).join("")}</div>
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="spec-save">Save</button></div>`);
      document.getElementById("spec-save").onclick = async () => {
        const specSaveBtn = document.getElementById("spec-save");
        const categories = Array.from(document.querySelectorAll(".checkbox-grid input:checked")).map(cb => cb.value);
        try { await api(`/it-staff/${id}/specialties`, { method: "POST", body: { categories } }, specSaveBtn); toast("Saved.", "success"); closeModal(); goTab("itstaff"); }
        catch (e) { toast(e.message, "error"); }
      };
    };
  });

  root.querySelectorAll("[data-unmark]").forEach(btn => {
    btn.onclick = async () => {
      try { await api(`/absences/${btn.dataset.unmark}`, { method: "DELETE" }, btn); toast("Removed.", "success"); goTab("itstaff"); }
      catch (e) { toast(e.message, "error"); }
    };
  });

  // History panels are loaded lazily (only on first "Show" click) since
  // most visits to this tab just need the current roster/absences, not the
  // full history. Each panel has its own date-filter toolbar (All / single
  // day / monthly / range) wired via wireDateFilterToolbar.
  const absHistBtn = document.getElementById("toggle-absence-history");
  const absHistBody = document.getElementById("absence-history-body");
  const getAbsHistParams = wireDateFilterToolbar("abh");
  let absHistWired = false;
  const loadAbsHistory = async () => {
    const rowsEl = document.getElementById("absence-history-rows");
    rowsEl.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
    try {
      const params = getAbsHistParams();
      const { absences: history } = await api(`/absences/history${params.toString() ? "?" + params.toString() : ""}`);
      rowsEl.innerHTML = history.length
        ? history.map(a => `<tr>
            <td>${escapeHtml(a.full_name)}</td>
            <td>${fmtDate(a.absence_date)}</td>
            <td class="muted">${escapeHtml(a.reason || "—")}</td>
            <td class="muted">${escapeHtml(a.marked_by_name || "—")}</td>
          </tr>`).join("")
        : `<tr><td colspan="4" class="muted">No absences for this period.</td></tr>`;
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(e.message)}</td></tr>`;
    }
  };
  absHistBtn.onclick = () => {
    const showing = !absHistBody.classList.contains("hidden");
    if (showing) {
      absHistBody.classList.add("hidden");
      absHistBtn.textContent = "Show";
      return;
    }
    absHistBody.classList.remove("hidden");
    absHistBtn.textContent = "Hide";
    if (!absHistWired) {
      document.getElementById("abh-run").onclick = loadAbsHistory;
      absHistWired = true;
      loadAbsHistory();
    }
  };

  const availHistBtn = document.getElementById("toggle-availability-history");
  const availHistBody = document.getElementById("availability-history-body");
  const getAvailHistParams = wireDateFilterToolbar("avh");
  let availHistWired = false;
  const loadAvailHistory = async () => {
    const rowsEl = document.getElementById("availability-history-rows");
    rowsEl.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;
    try {
      const params = getAvailHistParams();
      const { log } = await api(`/availability/log${params.toString() ? "?" + params.toString() : ""}`);
      rowsEl.innerHTML = log.length
        ? log.map(l => `<tr>
            <td>${escapeHtml(l.full_name)}</td>
            <td>${l.is_available ? `<span class="badge badge-resolved">Marked available</span>` : `<span class="badge badge-critical">Marked unavailable</span>`}</td>
            <td class="muted">${escapeHtml(l.reason || "—")}${!l.is_available && l.unavailable_from ? `<br><span style="font-size:12px;">${fmtDate(l.unavailable_from)} – ${l.unavailable_until ? fmtDate(l.unavailable_until) : "until restored"}</span>` : ""}</td>
            <td class="muted">${escapeHtml(l.changed_by_name || "—")}</td>
            <td class="muted">${fmtDateTime(l.changed_at)}</td>
          </tr>`).join("")
        : `<tr><td colspan="5" class="muted">No changes for this period.</td></tr>`;
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="5" class="muted">${escapeHtml(e.message)}</td></tr>`;
    }
  };
  availHistBtn.onclick = () => {
    const showing = !availHistBody.classList.contains("hidden");
    if (showing) {
      availHistBody.classList.add("hidden");
      availHistBtn.textContent = "Show";
      return;
    }
    availHistBody.classList.remove("hidden");
    availHistBtn.textContent = "Hide";
    if (!availHistWired) {
      document.getElementById("avh-run").onclick = loadAvailHistory;
      availHistWired = true;
      loadAvailHistory();
    }
  };

  const markAbsentBtn = document.getElementById("mark-absent-btn");
  if (markAbsentBtn) {
    markAbsentBtn.onclick = () => {
      openModal(`
        <div class="modal-header"><h2>Mark absent</h2><button class="modal-close" onclick="closeModal()">✕</button></div>
        <div class="modal-body">
          <label>Staff member</label>
          <select id="ab-user">${staff.map(s => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`).join("")}</select>
          <div class="form-row">
            <div><label>Start date</label><input id="ab-start" type="date"></div>
            <div><label>Number of days</label><input id="ab-days" type="number" value="1" min="1"></div>
          </div>
          <label>Reason (optional)</label><input id="ab-reason" type="text">
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="ab-save">Save</button></div>`);
      document.getElementById("ab-start").value = new Date().toISOString().slice(0, 10);
      const abSaveBtn = document.getElementById("ab-save");
      abSaveBtn.onclick = async () => {
        setBtnLoading(abSaveBtn, true);
        try {
          await api("/absences", { method: "POST", body: {
            user_id: Number(document.getElementById("ab-user").value),
            start_date: document.getElementById("ab-start").value,
            num_days: Number(document.getElementById("ab-days").value || 1),
            reason: document.getElementById("ab-reason").value.trim() || null,
          }});
          toast("Marked absent.", "success");
          closeModal(); goTab("itstaff");
        } catch (e) { toast(e.message, "error"); setBtnLoading(abSaveBtn, false); }
      };
    };
  }
}

// ---------------------------------------------------------------- Reporting (Super Admin)

/** Ranks a getPerformanceReport() list by RESOLVED ticket count, most first
 * - standard competition ranking (1, 2, 2, 4: a tie doesn't skip anyone
 * into 3rd, but the next distinct count picks up where the tie count left
 * off). Staff with zero resolved tickets aren't meaningfully "ranked" (there's
 * nothing to compare - could be a new hire, someone out all period, or a
 * Super Admin account that doesn't work tickets day-to-day), so their rank
 * is left null and they sort to the bottom, alphabetically among themselves
 * so the list stays stable rather than reshuffling on every reload. */
function rankByResolved(rows) {
  const ranked = rows.filter(r => r.resolved > 0).sort((a, b) => b.resolved - a.resolved);
  const unranked = rows.filter(r => !(r.resolved > 0)).sort((a, b) => a.full_name.localeCompare(b.full_name));

  let rank = 0;
  let lastResolved = null;
  let seen = 0;
  const rankedWithNumbers = ranked.map(r => {
    seen += 1;
    if (r.resolved !== lastResolved) {
      rank = seen;
      lastResolved = r.resolved;
    }
    return { ...r, rank };
  });

  return [...rankedWithNumbers, ...unranked.map(r => ({ ...r, rank: null }))];
}

function rankBadge(rank) {
  if (rank == null) return `<span class="muted">—</span>`;
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;
  return medal ? `${medal} <span class="muted">${rank}</span>` : `${rank}`;
}

async function renderReporting(root) {
  const today = new Date();
  root.innerHTML = `
    <div class="panel"><div class="panel-body">
      <div class="toolbar">
        <select id="rp-mode">
          <option value="monthly">Monthly</option>
          <option value="single">Single day</option>
          <option value="annual">Annual</option>
          <option value="range">Date range</option>
        </select>
        <input id="rp-month" type="number" min="1" max="12" value="${today.getMonth() + 1}" style="width:70px;" title="Month">
        <input id="rp-year" type="number" value="${today.getFullYear()}" style="width:90px;" title="Year">
        <input id="rp-day" type="date" class="hidden">
        <input id="rp-start" type="date" class="hidden">
        <input id="rp-end" type="date" class="hidden">
        <select id="rp-branch"><option value="">All branches</option>${state.branches.map(b => `<option>${b}</option>`).join("")}</select>
        <button class="btn btn-secondary btn-sm" id="rp-run">Run report</button>
        <button class="btn btn-primary btn-sm" id="rp-export">Download .xlsx</button>
      </div>
      <div id="rp-results"><div class="empty-state">Choose a period and run the report.</div></div>
    </div></div>`;

  const modeEl = document.getElementById("rp-mode");
  const updateModeFields = () => {
    const mode = modeEl.value;
    document.getElementById("rp-month").classList.toggle("hidden", mode !== "monthly");
    document.getElementById("rp-year").classList.toggle("hidden", !(mode === "monthly" || mode === "annual"));
    document.getElementById("rp-day").classList.toggle("hidden", mode !== "single");
    document.getElementById("rp-start").classList.toggle("hidden", mode !== "range");
    document.getElementById("rp-end").classList.toggle("hidden", mode !== "range");
  };
  modeEl.onchange = updateModeFields;
  updateModeFields();
  document.getElementById("rp-day").value = today.toISOString().slice(0, 10);
  document.getElementById("rp-start").value = today.toISOString().slice(0, 10);
  document.getElementById("rp-end").value = today.toISOString().slice(0, 10);

  const buildParams = () => {
    const mode = modeEl.value;
    const params = new URLSearchParams({ mode });
    if (mode === "monthly") { params.set("month", document.getElementById("rp-month").value); params.set("year", document.getElementById("rp-year").value); }
    if (mode === "single") { params.set("day", document.getElementById("rp-day").value); }
    if (mode === "annual") { params.set("year", document.getElementById("rp-year").value); }
    if (mode === "range") { params.set("start", document.getElementById("rp-start").value); params.set("end", document.getElementById("rp-end").value); }
    const branch = document.getElementById("rp-branch").value;
    if (branch) params.set("branch", branch);
    return params;
  };

  const rpRunBtn = document.getElementById("rp-run");
  rpRunBtn.onclick = async () => {
    const params = buildParams();
    const resEl = document.getElementById("rp-results");
    resEl.innerHTML = `<div class="empty-state">Loading…</div>`;
    const data = await api(`/reports/performance?${params.toString()}`, {}, rpRunBtn);
    const s = data.summary;
    resEl.innerHTML = `
      <div class="stat-grid" style="margin:18px 0;">
        <div class="stat-card"><div class="label">Assigned</div><div class="value">${s.total_assigned ?? s.assigned ?? "—"}</div></div>
        <div class="stat-card resolved"><div class="label">Resolved</div><div class="value">${s.total_resolved ?? s.resolved ?? "—"}</div></div>
        <div class="stat-card open"><div class="label">Still open</div><div class="value">${s.total_open ?? "—"}</div></div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Tickets created vs. resolved per day</h3></div>
        <div class="panel-body">
          <div class="chart-frame">${(data.daily && data.daily.length)
            ? buildDailyHistogramSvg([
                { name: "Created", color: "var(--accent)", data: data.daily },
                { name: "Resolved", color: "var(--resolved)", data: data.daily_resolved || [] },
              ])
            : `<div class="empty-state">No data for this period.</div>`}</div>
        </div>
      </div>
      <div class="table-wrap"><table>
        <tr><th>Rank</th><th>Staff</th><th>Assigned</th><th>Resolved</th><th>Open</th><th>In progress</th><th>Resolution rate</th><th>Avg. resolution (hrs)</th></tr>
        ${rankByResolved(data.report).map(r => `<tr class="${r.rank && r.rank <= 3 ? "rank-top-" + r.rank : ""}">
          <td class="rank-cell">${rankBadge(r.rank)}</td>
          <td>${escapeHtml(r.full_name)}</td><td>${r.assigned}</td><td>${r.resolved}</td><td>${r.open}</td><td>${r.in_progress}</td>
          <td>${r.resolution_rate != null ? r.resolution_rate + "%" : "—"}</td>
          <td>${r.avg_resolution_hours != null ? Number(r.avg_resolution_hours).toFixed(1) : "—"}</td>
        </tr>`).join("")}
      </table></div>`;
  };

  document.getElementById("rp-export").onclick = () => {
    const params = buildParams();
    window.open(`/api/reports/export?${params.toString()}`, "_blank");
  };
}

// ---------------------------------------------------------------------
// Corporation Reports (Super Admin): one row per corporation (the tag on
// each branch) with ticket totals; click a row to see which IT staff / admin
// handled that corporation's tickets and how its branches did. Data comes
// from reporting.getCorporationReport via /api/reports/corporation.
// ---------------------------------------------------------------------
async function renderCorporationReport(root) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  let corporations = [];
  try { ({ corporations } = await api("/settings/groups")); } catch (e) { corporations = []; }

  root.innerHTML = `
    <div class="panel"><div class="panel-body">
      <div class="toolbar">
        <select id="cr-mode">
          <option value="monthly">Monthly</option>
          <option value="single">Single day</option>
          <option value="annual">Annual</option>
          <option value="range">Date range</option>
        </select>
        <input id="cr-month" type="number" min="1" max="12" value="${today.getMonth() + 1}" style="width:70px;" title="Month">
        <input id="cr-year" type="number" value="${today.getFullYear()}" style="width:90px;" title="Year">
        <input id="cr-day" type="date" class="hidden">
        <input id="cr-start" type="date" class="hidden">
        <input id="cr-end" type="date" class="hidden">
        <select id="cr-corp">
          <option value="">All corporations</option>
          ${corporations.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
          <option value="(No corporation)">(No corporation)</option>
        </select>
        <button class="btn btn-secondary btn-sm" id="cr-run">Run report</button>
        <button class="btn btn-primary btn-sm" id="cr-export">Download .xlsx</button>
      </div>
      <div id="cr-results"><div class="empty-state">Choose a period and run the report.</div></div>
    </div></div>`;

  const modeEl = document.getElementById("cr-mode");
  const updateModeFields = () => {
    const mode = modeEl.value;
    document.getElementById("cr-month").classList.toggle("hidden", mode !== "monthly");
    document.getElementById("cr-year").classList.toggle("hidden", !(mode === "monthly" || mode === "annual"));
    document.getElementById("cr-day").classList.toggle("hidden", mode !== "single");
    document.getElementById("cr-start").classList.toggle("hidden", mode !== "range");
    document.getElementById("cr-end").classList.toggle("hidden", mode !== "range");
  };
  modeEl.onchange = updateModeFields;
  updateModeFields();
  document.getElementById("cr-day").value = todayStr;
  document.getElementById("cr-start").value = todayStr;
  document.getElementById("cr-end").value = todayStr;

  const buildParams = () => {
    const mode = modeEl.value;
    const params = new URLSearchParams({ mode });
    if (mode === "monthly") { params.set("month", document.getElementById("cr-month").value); params.set("year", document.getElementById("cr-year").value); }
    if (mode === "single") { params.set("day", document.getElementById("cr-day").value); }
    if (mode === "annual") { params.set("year", document.getElementById("cr-year").value); }
    if (mode === "range") { params.set("start", document.getElementById("cr-start").value); params.set("end", document.getElementById("cr-end").value); }
    const corp = document.getElementById("cr-corp").value;
    if (corp) params.set("corporation", corp);
    return params;
  };

  const fmtHrs = (h) => (h != null ? Number(h).toFixed(1) : "—");
  const staffTable = (staff) => staff.length ? `
    <div class="table-wrap"><table>
      <tr><th>IT staff / admin</th><th>Role</th><th>Assigned</th><th>Resolved</th><th>Open</th><th>In progress</th><th>Resolution rate</th><th>Avg. resolution (hrs)</th></tr>
      ${staff.map(x => `<tr>
        <td>${escapeHtml(x.full_name)}</td><td class="muted">${escapeHtml(x.role)}</td>
        <td>${x.assigned}</td><td>${x.resolved}</td><td>${x.open}</td><td>${x.in_progress}</td>
        <td>${x.resolution_rate}%</td><td>${fmtHrs(x.avg_resolution_hours)}</td>
      </tr>`).join("")}
    </table></div>` : `<div class="muted">No IT staff handled tickets for this corporation in this period.</div>`;
  const branchTable = (branches) => branches.length ? `
    <div class="table-wrap"><table>
      <tr><th>Branch</th><th>Total</th><th>Resolved</th><th>Open</th><th>In progress</th><th>Resolution rate</th><th>Avg. resolution (hrs)</th></tr>
      ${branches.map(b => `<tr>
        <td>${escapeHtml(b.branch)}</td><td>${b.total}</td><td>${b.resolved}</td><td>${b.open}</td><td>${b.in_progress}</td>
        <td>${b.resolution_rate}%</td><td>${fmtHrs(b.avg_resolution_hours)}</td>
      </tr>`).join("")}
    </table></div>` : "";

  const runBtn = document.getElementById("cr-run");
  runBtn.onclick = async () => {
    const resEl = document.getElementById("cr-results");
    resEl.innerHTML = `<div class="empty-state">Loading…</div>`;
    let data;
    try {
      data = await api(`/reports/corporation?${buildParams().toString()}`, {}, runBtn);
    } catch (e) {
      resEl.innerHTML = `<div class="empty-state">${escapeHtml(e.message)}</div>`;
      return;
    }
    const s = data.summary;
    const rows = data.corporations;
    resEl.innerHTML = `
      <div class="stat-grid" style="margin:18px 0;">
        <div class="stat-card"><div class="label">Corporations with tickets</div><div class="value">${s.corporations_with_tickets} <span class="muted" style="font-size:16px;">/ ${s.corporations_total}</span></div></div>
        <div class="stat-card"><div class="label">Total tickets</div><div class="value">${s.total_tickets}</div></div>
        <div class="stat-card resolved"><div class="label">Resolved</div><div class="value">${s.total_resolved}</div></div>
        <div class="stat-card open"><div class="label">Still open</div><div class="value">${s.total_open}</div></div>
      </div>
      <p class="muted" style="margin:0 0 10px;">Click a corporation to see the IT staff / admin who handled its tickets and its branches. A ticket with collaborators counts for each collaborator.</p>
      <div class="table-wrap"><table id="cr-table">
        <tr><th>Corporation</th><th>Branches</th><th>Tickets</th><th>Resolved</th><th>Open</th><th>In progress</th><th>Resolution rate</th><th>Avg. resolution (hrs)</th></tr>
        ${rows.map((c, i) => `
          <tr class="${c.total ? "cr-row" : "muted"}" data-i="${i}" style="${c.total ? "cursor:pointer;" : ""}">
            <td>${c.total ? "▸ " : ""}${escapeHtml(c.corporation)}</td>
            <td>${c.branch_count}</td><td>${c.total}</td><td>${c.resolved}</td><td>${c.open}</td><td>${c.in_progress}</td>
            <td>${c.total ? c.resolution_rate + "%" : "—"}</td><td>${fmtHrs(c.avg_resolution_hours)}</td>
          </tr>
          ${c.total ? `<tr class="cr-detail hidden" data-i="${i}"><td colspan="8">
            <h4 style="margin:6px 0;">IT staff &amp; admin</h4>${staffTable(c.staff)}
            <h4 style="margin:14px 0 6px;">Branches</h4>${branchTable(c.branches)}
          </td></tr>` : ""}`).join("")}
      </table></div>`;

    document.getElementById("cr-table").onclick = (ev) => {
      const tr = ev.target.closest("tr.cr-row");
      if (!tr) return;
      const detail = document.querySelector(`#cr-table tr.cr-detail[data-i="${tr.dataset.i}"]`);
      if (!detail) return;
      const open = detail.classList.toggle("hidden") === false;
      const cell = tr.firstElementChild;
      cell.textContent = (open ? "▾ " : "▸ ") + cell.textContent.slice(2);
    };
  };

  document.getElementById("cr-export").onclick = () => {
    window.open(`/api/reports/export/corporation?${buildParams().toString()}`, "_blank");
  };
}

// ---------------------------------------------------------------------
// Per-staff report ("My Report" for IT Department, "Staff Reports" for
// Super Admin, who can pick any IT staff member). What's counted follows
// the system mode, decided server-side (reporting.getScopedStaffReport):
//   - Normal Mode: every ticket the staff member received
//   - BSP Mode:    only tickets from branches in their own Line of
//                  Business (or Global-partnered branches for Global staff)
// The banner under the toolbar always says which of the two applied.
// ---------------------------------------------------------------------
async function renderStaffReport(root) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const isAdmin = state.user.role === "Super Admin";
  let staffList = [];
  if (isAdmin) {
    const res = await api("/it-staff");
    staffList = res.staff || [];
  }

  root.innerHTML = `
    <div class="panel"><div class="panel-body">
      <div class="toolbar">
        ${isAdmin ? `<select id="sr-staff">${staffList.length
          ? staffList.map(s => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`).join("")
          : `<option value="">No IT staff</option>`}</select>` : ""}
        <select id="sr-mode">
          <option value="monthly">Monthly</option>
          <option value="single">Single day</option>
          <option value="annual">Annual</option>
          <option value="range">Date range</option>
        </select>
        <input id="sr-month" type="number" min="1" max="12" value="${today.getMonth() + 1}" style="width:70px;" title="Month">
        <input id="sr-year" type="number" value="${today.getFullYear()}" style="width:90px;" title="Year">
        <input id="sr-day" type="date" class="hidden" value="${todayStr}">
        <input id="sr-start" type="date" class="hidden" value="${todayStr}">
        <input id="sr-end" type="date" class="hidden" value="${todayStr}">
        <button class="btn btn-secondary btn-sm" id="sr-run">Generate report</button>
        <button class="btn btn-primary btn-sm" id="sr-export">Download .xlsx</button>
      </div>
      <div id="sr-results"><div class="empty-state">Choose a period and generate the report.</div></div>
    </div></div>`;

  const modeEl = document.getElementById("sr-mode");
  const updateFields = () => {
    const mode = modeEl.value;
    document.getElementById("sr-month").classList.toggle("hidden", mode !== "monthly");
    document.getElementById("sr-year").classList.toggle("hidden", !(mode === "monthly" || mode === "annual"));
    document.getElementById("sr-day").classList.toggle("hidden", mode !== "single");
    document.getElementById("sr-start").classList.toggle("hidden", mode !== "range");
    document.getElementById("sr-end").classList.toggle("hidden", mode !== "range");
  };
  modeEl.onchange = updateFields;
  updateFields();

  const staffId = () => isAdmin
    ? document.getElementById("sr-staff").value
    : state.user.id;

  const buildParams = () => {
    const mode = modeEl.value;
    const params = new URLSearchParams({ mode });
    if (mode === "monthly") { params.set("month", document.getElementById("sr-month").value); params.set("year", document.getElementById("sr-year").value); }
    if (mode === "single") params.set("day", document.getElementById("sr-day").value);
    if (mode === "annual") params.set("year", document.getElementById("sr-year").value);
    if (mode === "range") { params.set("start", document.getElementById("sr-start").value); params.set("end", document.getElementById("sr-end").value); }
    return params;
  };

  const runBtn = document.getElementById("sr-run");
  const run = async () => {
    const id = staffId();
    const resEl = document.getElementById("sr-results");
    if (!id) { resEl.innerHTML = `<div class="empty-state">No IT staff to report on.</div>`; return; }
    resEl.innerHTML = `<div class="empty-state">Loading…</div>`;
    let data;
    try {
      data = await api(`/reports/staff/${id}?${buildParams().toString()}`, {}, runBtn);
    } catch (err) {
      resEl.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
      return;
    }
    const p = data.perf, sc = data.scope || {};
    const scopeNote = sc.restricted
      ? `${escapeHtml(sc.label)}${sc.branches && sc.branches.length ? ` (${sc.branches.length} branch${sc.branches.length === 1 ? "" : "es"} in scope)` : " — no branches are tagged to this group yet"}`
      : escapeHtml(sc.label || "All tickets received");
    const fmtDate = (v) => v ? new Date(v).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
    resEl.innerHTML = `
      <div class="notice-item" style="margin:14px 0;">
        <strong>${escapeHtml(p.full_name)}</strong> · ${escapeHtml(data.start)} to ${escapeHtml(data.end)}<br>
        <span class="muted">${scopeNote}</span>
      </div>
      <div class="stat-grid" style="margin:18px 0;">
        <div class="stat-card"><div class="label">Received</div><div class="value">${p.assigned}</div></div>
        <div class="stat-card resolved"><div class="label">Resolved</div><div class="value">${p.resolved}</div></div>
        <div class="stat-card open"><div class="label">Still open</div><div class="value">${p.open}</div></div>
        <div class="stat-card"><div class="label">In progress</div><div class="value">${p.in_progress}</div></div>
        <div class="stat-card"><div class="label">Resolution rate</div><div class="value">${p.resolution_rate}%</div></div>
        <div class="stat-card"><div class="label">Avg. resolution (hrs)</div><div class="value">${p.avg_resolution_hours != null ? Number(p.avg_resolution_hours).toFixed(1) : "—"}</div></div>
      </div>
      <div class="panel">
        <div class="panel-header"><h3>Tickets received vs. resolved per day</h3></div>
        <div class="panel-body"><div class="chart-frame">${(data.daily && data.daily.length)
          ? buildDailyHistogramSvg([
              { name: "Received", color: "var(--accent)", data: data.daily.map(d => ({ day: d.day, count: d.assigned })) },
              { name: "Resolved", color: "var(--resolved)", data: data.daily.map(d => ({ day: d.day, count: d.resolved })) },
            ])
          : `<div class="empty-state">No data for this period.</div>`}</div></div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <div class="panel-header"><h3>Branches assisted</h3></div>
        <div class="table-wrap"><table>
          <tr><th>Branch</th><th>Total</th><th>Resolved</th><th>Open</th><th>In progress</th></tr>
          ${data.branches.length
            ? data.branches.map(b => `<tr><td>${escapeHtml(b.branch)}</td><td>${b.total}</td><td>${b.resolved}</td><td>${b.open}</td><td>${b.in_progress}</td></tr>`).join("")
            : `<tr><td colspan="5" class="muted">No tickets in this period.</td></tr>`}
        </table></div>
      </div>
      <div class="panel" style="margin-top:16px;">
        <div class="panel-header"><h3>Tickets (${data.tickets.length})</h3></div>
        <div class="table-wrap"><table>
          <tr><th>Ticket</th><th>Title</th><th>Branch</th><th>Category</th><th>Priority</th><th>Status</th><th>Created</th></tr>
          ${data.tickets.length
            ? data.tickets.map(t => `<tr>
                <td>#T-${String(t.id).padStart(5, "0")}</td><td>${escapeHtml(t.title)}</td><td>${escapeHtml(t.branch)}</td>
                <td>${escapeHtml(t.category)}</td><td>${escapeHtml(t.priority)}</td><td>${escapeHtml(t.status)}</td><td>${fmtDate(t.created_at)}</td>
              </tr>`).join("")
            : `<tr><td colspan="7" class="muted">No tickets in this period.</td></tr>`}
        </table></div>
      </div>`;
  };
  runBtn.onclick = run;

  document.getElementById("sr-export").onclick = () => {
    const id = staffId();
    if (!id) return;
    window.open(`/api/reports/export/staff/${id}?${buildParams().toString()}`, "_blank");
  };

  run();
}