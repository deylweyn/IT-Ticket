/**
 * server.js
 * Plain Node.js (http/fs/crypto only - no Express or other web framework)
 * backend for the IT Ticket System. Reuses db.js / data.js / reporting.js /
 * report_export.js unchanged - this file just exposes them over HTTP (JSON
 * API) and serves the frontend (static/index.html, app.js, styles.css), so
 * the whole app runs in a browser at http://127.0.0.1:5000.
 *
 * Run with: node server.js
 * Requires: a Neon (Postgres) connection string in config.js / DATABASE_URL.
 *
 * The only non-built-in dependencies are 'pg' (a Postgres driver - Node
 * has no built-in Postgres client) and 'exceljs' (xlsx generation, used only
 * inside report_export.js). Routing, sessions, JSON/multipart parsing, and
 * static file serving below are all hand-written against node:http.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const { put } = require("@vercel/blob");

const db = require("./db");
const data = require("./data");
const reporting = require("./reporting");
const reportExport = require("./report_export");
const push = require("./push");
const ExcelJS = require("exceljs");

const BASE_DIR = __dirname;
const STATIC_DIR = path.join(BASE_DIR, "static");
// Ticket attachments live in Vercel Blob now (see the /attachments routes
// below) - Vercel's function filesystem is read-only at runtime, so there's
// no local ATTACHMENTS_DIR to create here anymore.

const ALLOWED_IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp"]);
const MAX_WORKSPACE_FILE_BYTES = 20 * 1024 * 1024; // 20 MB - still used by memo image uploads.
const PRIORITIES = ["Low", "Medium", "High", "Critical"];
const STATUSES = ["Open", "In Progress", "Resolved"];
const ALL_ROLES = ["Super Admin", "IT Department", "Head Office Employee", "Branch Staff"];

const PORT = 5000;
// "0.0.0.0" listens on every network interface on this machine (not just
// localhost), so other devices on the same LAN/Wi-Fi can reach it at
// http://<this-machine's-LAN-IP>:5000 - not just 127.0.0.1 on this PC.
const HOST = "0.0.0.0";

// ---------------------------------------------------------------- sessions
// In-memory session store keyed by a random cookie value. Good enough for a
// single-process local/XAMPP-style deployment (mirrors Flask's session
// dict, just stored server-side instead of in a signed cookie).

// Sessions are stored in Postgres (see db.js's `sessions` table), not in an
// in-memory Map - a serverless function has no shared memory between
// invocations, so an in-memory store would log people out on every request.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

async function currentUser(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid) return null;
  const pool = db.getConnection();
  const [rows] = await pool.query(
    "SELECT user_data FROM sessions WHERE sid = ? AND expires_at > NOW()",
    [sid]
  );
  return rows[0] ? rows[0].user_data : null;
}

async function startSession(res, user) {
  const sid = crypto.randomBytes(24).toString("hex");
  const pool = db.getConnection();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    "INSERT INTO sessions (sid, user_data, expires_at) VALUES (?, ?, ?)",
    [sid, JSON.stringify(user), expiresAt]
  );
  res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`);
  return sid;
}

async function endSession(req, res) {
  const cookies = parseCookies(req);
  if (cookies.sid) {
    const pool = db.getConnection();
    await pool.query("DELETE FROM sessions WHERE sid = ?", [cookies.sid]);
  }
  res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0");
}

// ---------------------------------------------------------------- errors / helpers

class HttpError extends Error {
  constructor(code, message, errCode = null) {
    super(message);
    this.code = code;
    this.errCode = errCode;
  }
}

async function requireLogin(req) {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, "Not logged in");
  // The session's user_data is a snapshot taken at login time, so an
  // account marked unavailable AFTER someone's already signed in (whether
  // by a Super Admin's direct action or by approving one of their own
  // 'field' requests - see data.decideAvailabilityRequest) wouldn't
  // otherwise be noticed until their 7-day session naturally expired or
  // they tried to log in again (see /api/login's own is_available check).
  // Re-checking the LIVE row here instead, on every authenticated request,
  // means the very next thing they do (including the background
  // notification poll - see app.js's refreshNotifications) ends their
  // session and signs them out immediately, the same way an idle timeout
  // does. `errCode` lets the frontend show a specific message instead of a
  // generic "Not logged in".
  const pool = db.getConnection();
  const [rows] = await pool.query(
    "SELECT is_available, unavailable_from FROM users WHERE id = ?",
    [user.id]
  );
  const live = rows[0];
  if (live) {
    const today = new Date().toISOString().slice(0, 10);
    const lockHasStarted = !live.unavailable_from || live.unavailable_from <= today;
    if (live.is_available === false && lockHasStarted) {
      const cookies = parseCookies(req);
      if (cookies.sid) {
        await pool.query("DELETE FROM sessions WHERE sid = ?", [cookies.sid]);
      }
      throw new HttpError(
        401,
        "Your account has been marked unavailable. Sign in again once a Super Admin restores access.",
        "account_unavailable"
      );
    }
  }
  return user;
}

async function requireRole(req, ...roles) {
  const user = await requireLogin(req);
  if (!roles.includes(user.role)) throw new HttpError(403, "Not allowed for your role");
  return user;
}

/** Restricted admin portal: is this Super Admin blocked from changing the
 * Normal/BSP system mode? Checked against the LIVE users row (not the
 * session snapshot) so it can't go stale. */
async function isModeLocked(userId) {
  const pool = db.getConnection();
  const [rows] = await pool.query("SELECT can_change_mode FROM users WHERE id = ?", [userId]);
  return !!rows[0] && rows[0].can_change_mode === false;
}

/** A restricted admin may not edit/delete an UNRESTRICTED Super Admin
 * account (that would be a way around the restriction, e.g. resetting the
 * main Super Admin's password). Returns true if the request was blocked. */
async function blockIfTouchingFullAdmin(actor, targetUserId, res) {
  if (!(await isModeLocked(actor.id))) return false;
  const pool = db.getConnection();
  const [rows] = await pool.query("SELECT role, can_change_mode FROM users WHERE id = ?", [targetUserId]);
  const t = rows[0];
  if (t && t.role === "Super Admin" && t.can_change_mode !== false) {
    jsonError(res, "Only a full Super Admin can change or delete this account.", 403);
    return true;
  }
  return false;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function jsonError(res, message, code = 400, errCode = null) {
  sendJson(res, code, errCode ? { error: message, code: errCode } : { error: message });
}

function parseDate(s) {
  // Expects "YYYY-MM-DD"; returns the same string (our date helpers work on
  // strings throughout - mirrors Python's datetime.strptime(...).date()
  // just enough for this app's purposes), or null.
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("Invalid date");
  return s;
}

function secureFilename(name) {
  // Minimal equivalent of werkzeug.utils.secure_filename: strip path
  // separators and anything that isn't a safe filename character.
  return (name || "")
    .replace(/[\\/]/g, "_")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 255) || "file";
}

/** True if `str` parses as an absolute http(s) URL - used to validate
 * Shared Files links (see /api/workspace/files*) before storing them. */
function isHttpUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- body parsing

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf-8"));
  } catch (e) {
    return {};
  }
}

/** Minimal multipart/form-data parser - handles the single-file upload form
 * used by the attachment upload endpoint. Returns { fields: {name: value},
 * files: {name: {filename, contentType, data: Buffer}} }. */
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const result = { fields: {}, files: {} };

  let start = buffer.indexOf(boundaryBuf);
  if (start === -1) return result;
  start += boundaryBuf.length;

  while (true) {
    // Skip the CRLF right after the boundary marker.
    if (buffer.slice(start, start + 2).toString("latin1") === "--") break; // final boundary
    if (buffer.slice(start, start + 2).toString("latin1") === "\r\n") start += 2;

    const end = buffer.indexOf(boundaryBuf, start);
    if (end === -1) break;

    let partBuf = buffer.slice(start, end);
    if (partBuf.slice(-2).toString("latin1") === "\r\n") partBuf = partBuf.slice(0, -2);

    const headerEnd = partBuf.indexOf("\r\n\r\n");
    if (headerEnd !== -1) {
      const headerStr = partBuf.slice(0, headerEnd).toString("utf-8");
      const body = partBuf.slice(headerEnd + 4);
      const dispMatch = headerStr.match(/Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i);
      const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);
      if (dispMatch) {
        const fieldName = dispMatch[1];
        const filename = dispMatch[2];
        if (filename !== undefined) {
          result.files[fieldName] = {
            filename,
            contentType: ctMatch ? ctMatch[1].trim() : "application/octet-stream",
            data: body,
          };
        } else {
          result.fields[fieldName] = body.toString("utf-8");
        }
      }
    }

    start = end + boundaryBuf.length;
  }

  return result;
}

// ---------------------------------------------------------------- static files

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function serveFile(res, filePath, { download = false, downloadName = null } = {}) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      jsonError(res, "Not found", 404);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" };
    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${downloadName || path.basename(filePath)}"`;
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}

function serveIndexHtml(res) {
  serveFile(res, path.join(STATIC_DIR, "index.html"));
}

// ---------------------------------------------------------------- route table
// Supports ":param" (one path segment) and "*rest" (rest of the path,
// including slashes - mirrors Flask's <path:...> converter).

function compileRoute(routePath) {
  const paramNames = [];
  const regexStr = routePath
    .replace(/\/\*([a-zA-Z_]+)/g, (_, name) => {
      paramNames.push(name);
      return "/(.+)";
    })
    .replace(/:([a-zA-Z_]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

const routes = []; // { method, ...compileRoute, handler }

function route(method, routePath, handler) {
  routes.push({ method, handler, ...compileRoute(routePath) });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1]);
    });
    return { handler: r.handler, params };
  }
  return null;
}

// ---------------------------------------------------------------- frontend

route("GET", "/", async (req, res) => {
  serveIndexHtml(res);
});

// ---------------------------------------------------------------- auth

route("POST", "/api/login", async (req, res, params, query, body) => {
  const username = (body.username || "").trim();
  const password = body.password || "";
  // device_id is a per-browser random token the frontend generates once and
  // keeps in localStorage (see app.js's getDeviceId()) - it's how we
  // recognize "this same device" across logins. device_label is just a
  // human-readable description (browser/OS/phone-or-desktop) for the
  // approval screen, not used for any security decision itself.
  const deviceId = (body.device_id || "").trim();
  const deviceLabel = (body.device_label || "").trim().slice(0, 150) || null;
  // "Desktop" / "Phone" / "Tablet" - parsed client-side from the user-agent
  // by app.js's getDeviceLabel() and sent alongside device_label. Used only
  // for the Super Admin-only Attendance panel (see data.recordLogin below);
  // carries no security weight, same as device_label.
  const deviceKind = (body.device_kind || "").trim().slice(0, 20) || null;

  const user = await data.authenticate(username, password);
  if (!user) return jsonError(res, "Invalid username or password.", 401);
  if (user.is_available === false) {
    // A lock with an "unavailable until" date that has already passed
    // auto-restores right here instead of blocking the login - see
    // data.restoreExpiredAvailability. Re-check is_available afterwards
    // since it may have just flipped back to true.
    if (user.unavailable_until && new Date(user.unavailable_until) < new Date(new Date().toDateString())) {
      await data.restoreExpiredAvailability();
      user.is_available = true;
    }
  }
  // A lock scheduled for a future "unavailable_from" date hasn't started
  // yet - is_available was flipped to FALSE the moment it was scheduled
  // (see data.setAvailability), but the account should keep working
  // normally until that start date actually arrives, not the instant a
  // Super Admin sets it up.
  const today = new Date().toISOString().slice(0, 10);
  const lockHasStarted = !user.unavailable_from || user.unavailable_from <= today;
  if (user.is_available === false && lockHasStarted) {
    // A Super Admin has marked this account unavailable (see
    // /api/it-staff/:id/availability). Credentials are correct, so we don't
    // treat this as "invalid username or password" - instead the frontend
    // shows a "request approval" action, backed by /api/availability/request.
    return sendJson(res, 403, {
      error: "Your account has been marked unavailable. Request approval from a Super Admin to sign back in.",
      account_unavailable: true,
    });
  }
  // A Super Admin has marked this account absent for today (see
  // /api/absences) - same login block as is_available above. Unlike
  // is_available, this isn't a standing lock - it clears itself once
  // today's date passes, or a Super Admin can delete the absence record
  // early (DELETE /api/absences/:id) - but the blocked staffer can also
  // file a request the same way a locked account does (see
  // /api/availability/request, which detects "absent" vs "locked" and
  // tags the request accordingly); approving one just clears today's
  // absence entry instead of touching is_available.
  if (await data.isAbsentToday(user.id)) {
    return sendJson(res, 403, {
      error: "You're marked absent today. You can request approval from a Super Admin to sign in anyway.",
      account_absent: true,
    });
  }

  await startSession(res, user);
  // Attendance logging (see data.recordLogin) is a nice-to-have for the
  // Super Admin Attendance panel, not part of the login flow itself - a
  // failure here should never block someone from actually signing in.
  data.recordLogin(user.id, deviceId || null, deviceLabel, deviceKind)
    .catch((err) => console.error("attendance: recordLogin failed for user", user.id, err));
  sendJson(res, 200, { user });
});

route("POST", "/api/availability/request", async (req, res, params, query, body) => {
  // No session exists yet for a blocked account (login was refused), so
  // this re-checks the username/password itself rather than relying on
  // requireLogin - anyone filing a request still has to prove they own the
  // account.
  const username = (body.username || "").trim();
  const password = body.password || "";
  const user = await data.authenticate(username, password);
  if (!user) return jsonError(res, "Invalid username or password.", 401);
  // Figure out WHY this account can't log in right now and file the
  // matching kind of request - the account could be locked (is_available
  // = false), marked absent today, or (in the odd case a Super Admin
  // cleared one but not the other) both; either way one request covers
  // whichever is checked first. If neither applies, there's nothing to
  // request approval for.
  let kind;
  const today = new Date().toISOString().slice(0, 10);
  const lockHasStarted = !user.unavailable_from || user.unavailable_from <= today;
  if (user.is_available === false && lockHasStarted) kind = "lock";
  else if (await data.isAbsentToday(user.id)) kind = "absence";
  else return jsonError(res, "This account isn't currently blocked from logging in.");
  const { created } = await data.requestAvailability(user.id, kind);
  sendJson(res, 200, {
    ok: true,
    already_pending: !created,
    message: created
      ? "Request sent to the Super Admin team."
      : "A request is already pending Super Admin review.",
  });
});

route("POST", "/api/logout", async (req, res) => {
  await endSession(req, res);
  sendJson(res, 200, { ok: true });
});

route("GET", "/api/me", async (req, res) => {
  const user = await currentUser(req);
  sendJson(res, 200, { user: user || null });
});

// Public self-registration has been removed - Branch Staff and Head Office
// Employee accounts are now created the same way as everyone else, by a
// Super Admin via /api/users (see the "New account" modal). This route is
// kept only to return a clear error for any stale client still pointing at
// it, rather than a raw 404.
route("POST", "/api/register", async (req, res) => {
  return jsonError(res, "Self-registration is no longer available. Ask a Super Admin to create your account.", 410);
});

// ---------------------------------------------------------------- lookups

// No requireLogin: the public self-registration screen needs the real
// branch/department lists before the person has an account to log in
// with. Names only - nothing sensitive here.
route("GET", "/api/branches", async (req, res) => {
  sendJson(res, 200, { branches: await data.getBranches() });
});

route("GET", "/api/departments", async (req, res) => {
  sendJson(res, 200, { departments: await data.getDepartments() });
});

route("GET", "/api/categories", async (req, res) => {
  await requireLogin(req);
  sendJson(res, 200, { categories: await data.getCategories(), priorities: PRIORITIES, statuses: STATUSES });
});

// ---------------------------------------------------------------- tickets

// A Branch Staff/Head Office account shouldn't see WHO on IT a ticket is
// assigned to until that person has actually started on it - while a
// ticket is still sitting at 'Open' (whether truly unassigned, or handed
// to someone who hasn't touched it yet), the assignee's name is withheld
// so a requester can't tell "assigned but untouched" from "not picked up
// yet" - both just read as "not started". The moment IT moves the status
// off 'Open' (In Progress, Resolved, etc.), the name reappears. Only
// applies to those two requester roles - IT Department/Super Admin always
// see the real assignee. Done server-side (not just left to the frontend)
// for the same reason comments are withheld server-side below: the
// frontend shouldn't be the only thing standing between a requester and
// data they're not meant to see yet.
function maskAssigneeIfHidden(ticket, role) {
  if (["Branch Staff", "Head Office Employee"].includes(role) && ticket.status === "Open") {
    return { ...ticket, assignee_name: null, collaborator_names: [], collaborator_ids: [] };
  }
  return ticket;
}

route("GET", "/api/tickets", async (req, res, params, query) => {
  const user = await requireLogin(req);
  // assigned_to lets IT Department/Super Admin deep-link from the "N
  // tickets need assistance" dashboard notification straight to one absent
  // colleague's pending tickets. Requesters (Head Office/Branch Staff)
  // ignore it - getTickets already scopes them to their own tickets only.
  const assignedTo = query.get("assigned_to");
  if (assignedTo && !["Super Admin", "IT Department"].includes(user.role)) {
    return jsonError(res, "Not allowed.", 403);
  }
  // Pagination: defaults to page 1 / 10 per page (matches the "Showing 1 to
  // 10 of N entries" footer in the Tickets list), capped at 100/page so a
  // crafted page_size can't force one query to pull the whole table.
  const page = Math.max(1, Number(query.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.get("page_size")) || 10));
  const { rows, total } = await data.getTickets({
    role: user.role,
    userId: user.id,
    statusFilter: query.get("status"),
    priorityFilter: query.get("priority"),
    branchFilter: query.get("branch"),
    searchText: query.get("q"),
    assignedToFilter: assignedTo ? Number(assignedTo) : null,
    // Void filtering is only meaningful for a Super Admin (they're the only
    // role that decides void requests) - anyone else's value is ignored.
    voidStatusFilter: user.role === "Super Admin" ? query.get("void_status") : null,
    // Reopen filtering is the same "Super Admin only" scoping as void_status
    // just above, for the same reason: they're the only role that decides
    // reopen requests.
    reopenStatusFilter: user.role === "Super Admin" ? query.get("reopen_status") : null,
    // Site-visit filtering is an IT-side concern (both IT Department and
    // Super Admin) - a Branch Staff/Head Office requester's value is
    // ignored the same way void_status is.
    provinceFilter: ["Super Admin", "IT Department"].includes(user.role) ? query.get("province") : null,
    // "Received on this day" - open to every role, since it's just an
    // extra narrowing on whatever set of tickets that role can already see
    // (their own branch/department, their own queue, or everything for
    // Super Admin) rather than a new visibility grant.
    dateFilter: query.get("date"),
    page,
    pageSize,
  });
  const ticketsOut = rows.map(t => maskAssigneeIfHidden(t, user.role));
  sendJson(res, 200, { tickets: ticketsOut, total, page, page_size: pageSize });
});

route("GET", "/api/tickets/:id", async (req, res, params) => {
  const user = await requireLogin(req);
  const ticketId = Number(params.id);
  const ticket = await data.getTicketById(ticketId);
  if (!ticket) return jsonError(res, "Ticket not found.", 404);
  if (!["Super Admin", "IT Department"].includes(user.role) && ticket.created_by !== user.id) {
    return jsonError(res, "Not allowed to view this ticket.", 403);
  }
  // BSP MODE: an IT staffer can only open tickets from branches under their
  // own Line of Business (also covers deep links / push notification URLs).
  if (user.role === "IT Department") {
    const itScope = await data.getItBranchScope(user.role, user.id);
    if (itScope && !(await data.isBranchInItScope(ticket.branch, itScope))) {
      return jsonError(res, "This ticket belongs to a branch outside your Line of Business.", 403);
    }
  }
  // Opening a ticket's detail counts as having seen whatever follow-up
  // "poke" flag was on it - clears the notification bell badge for the
  // assignee (poked_own) the moment they land here, whether that's via the
  // desktop push notification, the bell dropdown row, or just clicking into
  // the ticket directly. A poke only ever targets the assignee (see the
  // /poke route above - no team broadcast), so this only needs to fire for
  // them. Scoped to IT Department only (NOT Super Admin): a Super Admin
  // never gets a poked bell row for their own poke in the first place (see
  // /api/stats - "Super Admin already knows what they just poked"), so
  // there's nothing for their own view to clear. Worse, app.js's poke
  // button calls openTicketDetail() right after poking to refresh the
  // "Follow-up requested" banner - if Super Admin were included here, that
  // immediate re-fetch would wipe poked_at before the assignee ever saw a
  // bell badge for it at all. Deliberately leaves the `ticket` object
  // returned below untouched (still shows poked_at/poked_by_name) - this
  // response is what renders the "Follow-up requested" banner and 🔔 badge
  // in the modal the person just opened, so it should still explain *why*
  // they were sent here; only the NEXT /api/stats poll (and next open)
  // should reflect it being cleared.
  if (user.role === "IT Department" && ticket.poked_at) {
    await data.clearPokeFlag(ticketId);
  }
  // Comments are the IT Department/Super Admin's internal back-and-forth on
  // a ticket - a Branch Staff/Head Office account never sees this thread,
  // the same way they never get pushed a notification for it (see
  // /api/tickets/:id/comments below and /api/tickets/:id/status, which is
  // the only thing that DOES notify them). Just omit it rather than
  // trusting the frontend alone to hide it.
  ticket.comments = ["Super Admin", "IT Department"].includes(user.role)
    ? await data.getComments(ticketId)
    : [];
  ticket.attachments = await data.getTicketAttachments(ticketId);
  ticket.assists = await data.getTicketAssists(ticketId);
  sendJson(res, 200, { ticket: maskAssigneeIfHidden(ticket, user.role) });
});

route("POST", "/api/tickets", async (req, res, params, query, body) => {
  const user = await requireLogin(req);
  const title = (body.title || "").trim();
  const description = (body.description || "").trim();
  const category = body.category;
  const priority = body.priority;
  const branch = body.branch || user.branch;
  const concernName = (body.concern_name || "").trim();
  // Optional extras a Branch Staff member can attach for IT's convenience -
  // see data.createTicket. Free text, capped defensively, never validated.
  const anydeskNumber = (body.anydesk_number || "").trim().slice(0, 50) || null;
  const branchNumber = (body.branch_number || "").trim().slice(0, 50) || null;
  const isProvince = !!body.is_province;

  if (!title || !description) return jsonError(res, "Title and description are required.");
  if (!concernName || concernName.split(/\s+/).filter(Boolean).length < 2) {
    return jsonError(res, "First and last name of the person this concern is for are required.");
  }
  if (!(await data.getCategories()).includes(category)) return jsonError(res, "Invalid category.");
  if (!PRIORITIES.includes(priority)) return jsonError(res, "Invalid priority.");
  if (!branch) return jsonError(res, "Branch is required.");

  let assignedToOverride = null;
  let collaboratorIds = [];
  if (user.role === "Super Admin") {
    const staffIds = new Set((await data.getItDepartmentUsers()).map((s) => s.id));
    if (body.assigned_to) {
      const candidate = Number(body.assigned_to);
      if (!staffIds.has(candidate)) return jsonError(res, "Invalid assignee.");
      assignedToOverride = candidate;
    }
    if (Array.isArray(body.collaborator_ids)) {
      collaboratorIds = body.collaborator_ids.map(Number).filter((id) => staffIds.has(id));
    }
  }

  const { id: ticketId, assignedTo } = await data.createTicket(
    title, description, category, priority, branch, user.id, user.role, concernName, anydeskNumber, branchNumber, isProvince, assignedToOverride
  );
  if (collaboratorIds.length) {
    await data.setTicketCollaborators(ticketId, collaboratorIds, user.id);
  }
  if (assignedTo) {
    console.log(`ticket ${ticketId} auto-assigned to user ${assignedTo}, notifying...`);
    // Awaited (not fire-and-forget): on Vercel the function is frozen the
    // moment the response goes out, so a send we don't wait for can get
    // killed mid-flight and never actually reach the push service.
    try {
      await push.notifyUser(assignedTo, {
        title: "New ticket assigned to you",
        body: `${title} · ${branch} · ${priority}`,
        url: `/?ticket=${ticketId}`,
      });
    } catch (err) {
      console.error("push notify (new ticket) failed:", err);
    }
    // Anyone picked as a collaborator at creation time gets the same
    // "you're on this ticket" heads-up the /collaborators route sends when
    // someone's added later.
    await Promise.all(collaboratorIds.map((userId) =>
      push.notifyUser(userId, {
        title: "Added to a ticket",
        body: `${title} · ${branch} · ${priority} - you're now working on this with the team`,
        url: `/?ticket=${ticketId}`,
      }).catch((err) => console.error("push notify (collaborator added) failed:", err))
    ));
  } else {
    console.log(`ticket ${ticketId} was NOT auto-assigned to anyone (no IT staff covers this category, or none exist)`);
  }
  sendJson(res, 200, { ok: true, ticket_id: ticketId });
});

route("POST", "/api/tickets/:id/status", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  const status = body.status;
  if (!STATUSES.includes(status)) return jsonError(res, "Invalid status.");
  const ticketId = Number(params.id);
  // An IT Department account may only change the status of a ticket
  // actually assigned to them (or unassigned) - a colleague's active
  // ticket is view-only until they "Take over" it (see /assign below),
  // which is also how a Super Admin's "poke" notification stays a nudge
  // rather than letting anyone else touch the ticket out from under the
  // assignee.
  if (user.role === "IT Department") {
    const existing = await data.getTicketById(ticketId);
    if (!existing) return jsonError(res, "Ticket not found.", 404);
    if (existing.assigned_to && !data.isTicketAssignee(existing, user.id)) {
      return jsonError(res, "This ticket is assigned to someone else - take it over first, or ask a Super Admin.", 403);
    }
  }
  await data.updateTicketStatus(ticketId, status);

  // Let the branch that filed this ticket know its status changed - this is
  // the ONLY thing the branch gets pushed here, regardless of how many IT
  // Department/Super Admin staff touched the ticket. It deliberately does
  // NOT fire for comments (/api/tickets/:id/comments) or reassignment
  // (/api/tickets/:id/assign) - those are IT-side conversation/routing, not
  // something the branch needs a notification for.
  try {
    const ticket = await data.getTicketById(ticketId);
    if (ticket && ticket.created_by) {
      await push.notifyUser(ticket.created_by, {
        title: "Ticket status updated",
        body: `${ticket.title} · now ${status}`,
        url: `/?ticket=${ticketId}`,
      });
    }
  } catch (err) {
    console.error("push notify (status update, branch) failed:", err);
  }

  sendJson(res, 200, { ok: true });
});

// Marks/unmarks a ticket as a province/on-site-visit case - IT Department
// or Super Admin only, since it's an internal reporting note rather than
// anything the requesting branch needs to know about. See
// data.updateTicketProvince / reporting.js for how this is excluded from
// performance stats.
route("POST", "/api/tickets/:id/province", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  const ticketId = Number(params.id);
  if (user.role === "IT Department") {
    const existing = await data.getTicketById(ticketId);
    if (!existing) return jsonError(res, "Ticket not found.", 404);
    if (existing.assigned_to && !data.isTicketAssignee(existing, user.id)) {
      return jsonError(res, "This ticket is assigned to someone else - take it over first, or ask a Super Admin.", 403);
    }
  }
  await data.updateTicketProvince(ticketId, !!body.is_province);
  sendJson(res, 200, { ok: true });
});

route("POST", "/api/tickets/:id/void/request", async (req, res, params, query, body) => {
  // Filing a void request is an IT Department action - a Super Admin
  // doesn't need to "request" anything since they already have full
  // control over a ticket's status.
  const user = await requireRole(req, "IT Department");
  const reason = (body.reason || "").trim();
  if (!reason) return jsonError(res, "Please explain why this ticket should be voided.");

  const ticketId = Number(params.id);
  const ticket = await data.getTicketById(ticketId);
  if (!ticket) return jsonError(res, "Ticket not found.", 404);
  if (ticket.assigned_to && !data.isTicketAssignee(ticket, user.id)) {
    return jsonError(res, "This ticket is assigned to someone else - take it over first, or ask a Super Admin.", 403);
  }

  try {
    await data.requestVoidTicket(ticketId, user.id, reason);
  } catch (err) {
    return jsonError(res, err.message, 400);
  }

  try {
    const admins = await data.getSuperAdminUsers();
    await Promise.all(admins.map((admin) =>
      push.notifyUser(admin.id, {
        title: "Void request needs review",
        body: `${ticket.title} · ${ticket.branch} · requested by ${user.full_name}`,
        url: `/?ticket=${ticketId}`,
      }).catch((err) => console.error("push notify (void request) failed:", err))
    ));
  } catch (err) {
    console.error("void request: notifying super admins failed:", err);
  }

  sendJson(res, 200, { ok: true });
});

route("POST", "/api/tickets/:id/void/decide", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin");
  const approve = !!body.approve;
  const note = (body.note || "").trim() || null;
  const ticketId = Number(params.id);

  let decided;
  try {
    decided = await data.decideVoidTicket(ticketId, user.id, approve, note);
  } catch (err) {
    return jsonError(res, err.message, 400);
  }

  if (decided.requestedBy) {
    try {
      await push.notifyUser(decided.requestedBy, {
        title: approve ? "Void request approved" : "Void request declined",
        body: `${decided.title}${note ? " — " + note : ""}`,
        url: `/?ticket=${ticketId}`,
      });
    } catch (err) {
      console.error("push notify (void decide) failed:", err);
    }
  }

  sendJson(res, 200, { ok: true });
});

route("GET", "/api/void-requests", async (req, res) => {
  await requireRole(req, "Super Admin");
  sendJson(res, 200, { requests: await data.getVoidRequests() });
});

// Reopen requests - the mirror image of void/request+decide above: a
// *Resolved* ticket gets requested back into active work because the same
// issue has come back. The ticket's own assigned IT staffer decides it
// (they'll be the one picking the work back up), with a Super Admin as a
// fallback/override. Two kinds of requester are allowed: the IT Department
// account who owns the ticket (the original case), OR the branch/requester
// who created it - the latter is what gives a branch with a recurring
// issue an actual "this came back" action, instead of filing a brand-new
// ticket every time (see app.js's canRequestReopen, which mirrors this
// same check client-side).
route("POST", "/api/tickets/:id/reopen/request", async (req, res, params, query, body) => {
  const user = await requireLogin(req);
  const reason = (body.reason || "").trim();
  if (!reason) return jsonError(res, "Please explain what's recurring so IT has context.");

  const ticketId = Number(params.id);
  const ticket = await data.getTicketById(ticketId);
  if (!ticket) return jsonError(res, "Ticket not found.", 404);
  if (ticket.status !== "Resolved") return jsonError(res, "Only a Resolved ticket can be requested for reopening.");
  if (!data.isWithinReopenWindow(ticket)) {
    return jsonError(res, `A reopen can only be requested within ${data.REOPEN_WINDOW_HOURS} hours of the ticket being marked Resolved. Please submit a new ticket instead.`);
  }

  const isCreator = ticket.created_by === user.id;
  const isOwningItDept = user.role === "IT Department" && (!ticket.assigned_to || data.isTicketAssignee(ticket, user.id));
  if (!isCreator && !isOwningItDept) {
    return jsonError(res, "Only the ticket's creator or its assignee can request a reopen.", 403);
  }

  try {
    await data.requestReopenTicket(ticketId, user.id, reason);
  } catch (err) {
    return jsonError(res, err.message, 400);
  }

  try {
    const notifyTargets = [];
    // The assigned IT staffer gets the clear, primary notification - it's
    // their ticket coming back to them for a decision.
    if (ticket.assigned_to) {
      notifyTargets.push(
        push.notifyUser(ticket.assigned_to, {
          title: "Reopen request awaiting your approval",
          body: `${ticket.title} · ${ticket.branch} · requested by ${user.full_name}`,
          url: `/?ticket=${ticketId}`,
        }).catch((err) => console.error("push notify (reopen request, assignee) failed:", err))
      );
    }
    // Super Admins also get it as a fallback/oversight channel - they can
    // decide it too (e.g. if the assignee is unavailable), same as void
    // requests.
    const admins = await data.getSuperAdminUsers();
    notifyTargets.push(...admins.map((admin) =>
      push.notifyUser(admin.id, {
        title: "Reopen request needs review",
        body: `${ticket.title} · ${ticket.branch} · requested by ${user.full_name}`,
        url: `/?ticket=${ticketId}`,
      }).catch((err) => console.error("push notify (reopen request) failed:", err))
    ));
    await Promise.all(notifyTargets);
  } catch (err) {
    console.error("reopen request: notifying reviewers failed:", err);
  }

  sendJson(res, 200, { ok: true });
});

route("POST", "/api/tickets/:id/reopen/decide", async (req, res, params, query, body) => {
  const user = await requireLogin(req);
  const ticketId = Number(params.id);
  const ticket = await data.getTicketById(ticketId);
  if (!ticket) return jsonError(res, "Ticket not found.", 404);
  // The ticket's own assignee decides it themselves (it's their work coming
  // back); a Super Admin can always decide it too, e.g. if the assignee's
  // unavailable - same fallback pattern as void decisions.
  const isOwningItDept = user.role === "IT Department" && data.isTicketAssignee(ticket, user.id);
  if (user.role !== "Super Admin" && !isOwningItDept) {
    return jsonError(res, "Not allowed for your role", 403);
  }
  const approve = !!body.approve;
  const note = (body.note || "").trim() || null;

  let decided;
  try {
    decided = await data.decideReopenTicket(ticketId, user.id, approve, note);
  } catch (err) {
    return jsonError(res, err.message, 400);
  }

  if (decided.requestedBy) {
    try {
      await push.notifyUser(decided.requestedBy, {
        title: approve ? "Reopen request approved" : "Reopen request declined",
        body: `${decided.title}${note ? " — " + note : ""}`,
        url: `/?ticket=${ticketId}`,
      });
    } catch (err) {
      console.error("push notify (reopen decide) failed:", err);
    }
  }

  // Approving actually changes the ticket's status (back to 'In Progress'),
  // so the branch that raised it gets the same "your ticket's status
  // changed" push everyone else's status changes trigger (see
  // /api/tickets/:id/status above) - a decline leaves status untouched, so
  // there's nothing for the branch to be notified about there.
  if (approve && decided.createdBy) {
    try {
      await push.notifyUser(decided.createdBy, {
        title: "Ticket status updated",
        body: `${decided.title} · now In Progress`,
        url: `/?ticket=${ticketId}`,
      });
    } catch (err) {
      console.error("push notify (reopen approve, branch) failed:", err);
    }
  }

  sendJson(res, 200, { ok: true });
});

route("GET", "/api/reopen-requests", async (req, res) => {
  await requireRole(req, "Super Admin");
  sendJson(res, 200, { requests: await data.getReopenRequests() });
});

route("POST", "/api/tickets/:id/assign", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  const assigneeId = body.assignee_id;
  const ticketId = Number(params.id);
  // Only Super Admin may hand a ticket to an arbitrary staff member. An IT
  // Department account may only assign a ticket TO THEMSELVES - that's the
  // "Take over (assist)" flow for covering an absent colleague's pending
  // ticket, not general reassignment.
  if (user.role !== "Super Admin" && Number(assigneeId) !== user.id) {
    return jsonError(res, "Only a Super Admin can reassign tickets to other staff.", 403);
  }
  // And even taking over one's own way in requires the current assignee to
  // actually be unavailable today - otherwise this would be a backdoor
  // around the "view only" restriction on /status, /province, and the void/
  // reopen request routes above, letting anyone reassign a colleague's
  // active ticket to themselves just to get write access to it.
  if (user.role === "IT Department") {
    const existing = await data.getTicketById(ticketId);
    if (existing && existing.assigned_to && existing.assigned_to !== user.id) {
      const unavailable = await data.isUserUnavailableToday(existing.assigned_to);
      if (!unavailable) {
        return jsonError(res, "This ticket's assignee is still available today - only a Super Admin can reassign it.", 403);
      }
    }
    // BSP MODE: taking over a colleague's ticket is still bounded by
    // group - an IT Department account may only "assist" a ticket from a
    // branch tagged into their OWN group (mirrors the read-side restriction
    // in data.getTickets). Untagged staff, or a mode of "normal", skip this
    // check entirely.
    if (existing && (await data.getSystemMode()) === "bsp") {
      const [myGroup, branchGroup] = await Promise.all([
        data.getUserGroup(user.id),
        data.getBranchStaffGroup(existing.branch),
      ]);
      if (myGroup && branchGroup && myGroup !== branchGroup) {
        return jsonError(res, `This ticket is from a ${branchGroup} branch - only ${branchGroup} staff can assist it.`, 403);
      }
    }
  }
  await data.assignTicket(ticketId, assigneeId);
  if (body.record_assist) {
    await data.recordAssist(ticketId, user.id, body.note);
  }
  if (Number(assigneeId) !== user.id) {
    // Only notify when someone else did the assigning - a person taking
    // over their own colleague's ticket already knows they did it.
    const ticket = await data.getTicketById(ticketId);
    if (ticket) {
      try {
        await push.notifyUser(Number(assigneeId), {
          title: "Ticket assigned to you",
          body: `${ticket.title} · ${ticket.branch} · ${ticket.priority}`,
          url: `/?ticket=${ticket.id}`,
        });
      } catch (err) {
        console.error("push notify (assign) failed:", err);
      }
    }
  }
  sendJson(res, 200, { ok: true });
});

// Multi-staff "work together" assignment - lets a Super Admin add (or
// remove) one or more additional IT Department staff onto a ticket
// alongside its primary assigned_to owner. Every listed collaborator gets
// identical rights to the primary assignee (see data.isTicketAssignee and
// every permission gate above that now calls it), identical queue
// visibility (data.getTickets), and identical notifications going forward
// (comments, pokes) - see db.js's ticket_collaborators table for the full
// rationale. Super Admin only, same as reassigning the primary owner via
// /assign above - this is a routing/staffing decision, not something IT
// staff hand out to each other.
route("POST", "/api/tickets/:id/collaborators", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin");
  const ticketId = Number(params.id);
  const ticket = await data.getTicketById(ticketId);
  if (!ticket) return jsonError(res, "Ticket not found.", 404);

  const userIds = Array.isArray(body.user_ids) ? body.user_ids.map(Number).filter(Number.isFinite) : [];
  const { added } = await data.setTicketCollaborators(ticketId, userIds, user.id);

  await Promise.all(added.map((userId) =>
    push.notifyUser(userId, {
      title: "Added to a ticket",
      body: `${ticket.title} · ${ticket.branch} · ${ticket.priority} - you're now working on this with ${ticket.assignee_name || "the team"}`,
      url: `/?ticket=${ticketId}`,
    }).catch((err) => console.error("push notify (collaborator added) failed:", err))
  ));

  sendJson(res, 200, { ok: true });
});

route("POST", "/api/tickets/:id/poke", async (req, res, params) => {
  // A lightweight "please follow up on this" nudge - only a Super Admin can
  // send one, since it's meant to prod IT/an individual staffer, not
  // something staff should be sending each other or themselves.
  const user = await requireRole(req, "Super Admin");
  const ticket = await data.pokeTicket(Number(params.id), user.id);
  if (!ticket) return jsonError(res, "Ticket not found.", 404);
  const url = `/?ticket=${ticket.id}`;
  // Every assigned staffer gets notified (push + bell), not just the
  // primary assignee - a multi-assigned ticket is worked on together, so a
  // follow-up nudge should reach everyone on the hook for it, not just
  // whoever happens to be tickets.assigned_to. See data.getPokedOwnTicketIds
  // / app.js's "poked" bell row for the other half of this.
  const collaboratorIds = await data.getTicketCollaboratorIds(ticket.id);
  const recipients = [...new Set([ticket.assigned_to, ...collaboratorIds].filter(Boolean))];
  await Promise.all(recipients.map((recipientId) =>
    push.notifyUser(recipientId, {
      title: "Follow-up needed on a ticket",
      body: `${ticket.title} · ${ticket.branch} · ${ticket.priority}`,
      url,
    }).catch((err) => console.error("push notify (poke, assignee) failed:", err))
  ));
  sendJson(res, 200, { ok: true });
});

route("POST", "/api/tickets/:id/comments", async (req, res, params, query, body) => {
  // Comments are IT Department/Super Admin's internal thread on a ticket -
  // Branch Staff/Head Office accounts don't get a comment box at all now
  // (see the GET route above, which also withholds the thread from them),
  // so posting is restricted the same way rather than just hidden in the UI.
  const user = await requireRole(req, "IT Department", "Super Admin");
  const comment = (body.comment || "").trim();
  if (!comment) return jsonError(res, "Comment can't be empty.");
  const ticketId = Number(params.id);
  if (user.role === "IT Department") {
    const itScope = await data.getItBranchScope(user.role, user.id);
    if (itScope) {
      const tk = await data.getTicketById(ticketId);
      if (tk && !(await data.isBranchInItScope(tk.branch, itScope))) {
        return jsonError(res, "This ticket belongs to a branch outside your Line of Business.", 403);
      }
    }
  }
  await data.addComment(ticketId, user.id, comment);

  // Let every OTHER assigned staffer (primary assignee + any collaborators)
  // know when someone ELSE on the IT/Super Admin side responds - covers
  // both directions the same way (a Super Admin replying notifies the
  // assigned IT staffer(s), and an IT staffer replying on a ticket assigned
  // to someone else notifies them back), and now reaches every collaborator
  // equally rather than just tickets.assigned_to, matching how they share
  // full rights on the ticket. No notification fires for whoever actually
  // commented (they already know), and none fires for the branch/Head
  // Office side here - a branch only gets pushed a ticket's status change
  // (see /api/tickets/:id/status), never the internal back-and-forth.
  if (["IT Department", "Super Admin"].includes(user.role)) {
    try {
      const ticket = await data.getTicketById(ticketId);
      if (ticket) {
        const recipients = [ticket.assigned_to, ...(ticket.collaborator_ids || [])]
          .filter((id) => id && Number(id) !== Number(user.id));
        await Promise.all([...new Set(recipients)].map((recipientId) =>
          push.notifyUser(recipientId, {
            title: "New response on a ticket",
            body: `${ticket.title} · ${user.full_name}: ${comment.slice(0, 80)}`,
            url: `/?ticket=${ticketId}`,
          }).catch((err) => console.error("push notify (comment) failed:", err))
        ));
      }
    } catch (err) {
      console.error("push notify (comment) failed:", err);
    }
  }

  sendJson(res, 200, { ok: true });
});

route("POST", "/api/tickets/:id/attachments", async (req, res, params, query, body, rawParts) => {
  const user = await requireLogin(req);
  const ticketId = params.id;
  // Uploading is limited to whoever raised the ticket - IT staff (IT
  // Department / Super Admin) can view attachments to understand the issue
  // but shouldn't add their own, so this mirrors the restriction the UI
  // already enforces by hiding the "Add image" control for them.
  const existingTicket = await data.getTicketById(Number(ticketId));
  if (!existingTicket) return jsonError(res, "Ticket not found.", 404);
  if (existingTicket.created_by !== user.id) {
    return jsonError(res, "Only the person who submitted this ticket can attach images.", 403);
  }
  const file = rawParts && rawParts.files && rawParts.files.file;
  if (!file) return jsonError(res, "No file uploaded.");
  if (!file.filename) return jsonError(res, "No file selected.");

  const dotIdx = file.filename.lastIndexOf(".");
  const ext = dotIdx !== -1 ? file.filename.slice(dotIdx + 1).toLowerCase() : "";
  if (!ALLOWED_IMAGE_EXT.has(ext)) {
    return jsonError(res, "Only image files are allowed (jpg, png, gif, bmp, webp).");
  }

  // Vercel's filesystem is read-only at runtime (aside from an ephemeral
  // /tmp that doesn't survive between requests), so attachments are stored
  // in Vercel Blob instead of on local disk. `relPath` (the DB column that
  // used to hold a local path) now holds the blob's public URL.
  const safeName = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
  const blobPath = `ticket-attachments/${ticketId}/${safeName}`;
  const blob = await put(blobPath, file.data, {
    access: "public",
    contentType: file.contentType || undefined,
  });

  await data.addTicketAttachment(Number(ticketId), blob.url, secureFilename(file.filename));
  sendJson(res, 200, { ok: true });
});

route("GET", "/api/attachments/*relpath", async (req, res, params) => {
  await requireLogin(req);
  // Older rows may still hold a bare relative path from before the Blob
  // migration; new rows hold a full blob URL. Either way, redirect the
  // browser straight to it rather than proxying bytes through the function.
  const target = params.relpath.startsWith("http")
    ? params.relpath
    : `/api/attachments/${params.relpath}`; // legacy path with no blob backing it anymore
  res.writeHead(302, { Location: target });
  res.end();
});

route("POST", "/api/tickets/:id/assists", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  await data.recordAssist(Number(params.id), user.id, (body || {}).note);
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- push notifications

route("GET", "/api/push/public-key", async (req, res) => {
  await requireLogin(req);
  sendJson(res, 200, { public_key: push.publicKey });
});

route("POST", "/api/push/subscribe", async (req, res, params, query, body) => {
  const user = await requireLogin(req);
  try {
    await push.saveSubscription(user.id, body.subscription);
  } catch (err) {
    return jsonError(res, err.message || "Invalid subscription.");
  }
  sendJson(res, 200, { ok: true });
});

route("POST", "/api/push/unsubscribe", async (req, res, params, query, body) => {
  await requireLogin(req);
  if (body.endpoint) await push.removeSubscription(body.endpoint);
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- dashboard

/** Combine data.getAbsentToday() and data.getLockedStaff() into one
 * "who can't work a ticket right now, and do they have pending work"
 * list, deduped by user id (a staffer can be both marked absent AND
 * account-locked at once - rare, but shows once with kind "absent_locked"
 * rather than twice). pending_tickets is the same count either way (it's
 * just "how many Open/In Progress tickets does this user have"), so on a
 * dedupe we simply keep it; reason prefers the absence reason when both
 * exist since that's usually the more human-readable one, falling back to
 * the lock reason. Sorted busiest-first like both source lists already
 * are. */
function mergeUnavailableStaff(absentRows, lockedRows) {
  const byId = new Map();
  for (const a of absentRows) {
    byId.set(a.id, {
      id: a.id,
      full_name: a.full_name,
      reason: a.reason,
      pending_tickets: a.pending_tickets,
      kind: "absent",
    });
  }
  for (const l of lockedRows) {
    const existing = byId.get(l.id);
    if (existing) {
      existing.kind = "absent_locked";
      if (!existing.reason) existing.reason = l.reason;
    } else {
      byId.set(l.id, {
        id: l.id,
        full_name: l.full_name,
        reason: l.reason,
        pending_tickets: l.pending_tickets,
        kind: "locked",
      });
    }
  }
  return Array.from(byId.values()).sort(
    (a, b) => b.pending_tickets - a.pending_tickets || a.full_name.localeCompare(b.full_name)
  );
}

// ---------------------------------------------------------------- stale-open-ticket auto-escalation
// There's no persistent background process here (this runs as a Vercel
// serverless function, frozen between invocations - vercel.json has no
// "crons" entry, and the Hobby-tier cron schedule is once/day anyway, far
// too coarse for a 10-minute check), so instead of a real cron this
// piggybacks on the /api/stats poll every logged-in user's client already
// hits every 5 seconds (see app.js's NOTIF_POLL_MS). Whichever request
// happens to land next after ESCALATION_SWEEP_MS has elapsed runs the
// sweep: any ticket still 'Open' 10+ minutes after becoming its assignee's
// gets pushed a notification, paced so the same ticket isn't re-pushed
// again for another 10 minutes (see data.getTicketsNeedingEscalationPush /
// data.markEscalated). This only requires SOME staff member's tab to be
// open somewhere in the last ESCALATION_SWEEP_MS - if literally nobody is
// logged in, nothing triggers it, same limitation the existing notif-poll
// system already has.
//
// The in-app "massive" banner (app.js) does NOT depend on this sweep at
// all - it's recomputed fresh from assigned_at on every single /api/stats
// call via data.getStaleOpenTicketIds, so it's always accurate to the
// second regardless of whether/when the push sweep last ran.
const ESCALATION_SWEEP_MS = 60 * 1000;
let lastEscalationSweep = 0;

async function runEscalationSweep() {
  const now = Date.now();
  if (now - lastEscalationSweep < ESCALATION_SWEEP_MS) return;
  lastEscalationSweep = now;
  let tickets;
  try {
    tickets = await data.getTicketsNeedingEscalationPush();
  } catch (err) {
    console.error("escalation sweep: failed to load due tickets:", err);
    return;
  }
  for (const t of tickets) {
    // BSP MODE: don't nag someone about a ticket from outside their Line.
    let outOfScope = false;
    try {
      const sc = await data.getItBranchScope("IT Department", t.assigned_to);
      outOfScope = !!sc && !(await data.isBranchInItScope(t.branch, sc));
    } catch (err) { /* fall through - treat as in scope */ }
    try {
      if (!outOfScope) await push.notifyUser(t.assigned_to, {
        title: "Ticket still open",
        body: `${t.title} · ${t.branch} · ${t.priority} - still Open 10+ min after being assigned to you`,
        url: `/?ticket=${t.id}`,
      });
    } catch (err) {
      console.error(`push notify (auto-escalation, ticket ${t.id}) failed:`, err);
    }
    // Stamp escalated_at even if the push above failed - a dead/expired
    // subscription shouldn't make the sweep hammer the same ticket every
    // minute; it'll still show up in the in-app banner/bell regardless.
    try {
      await data.markEscalated(t.id);
    } catch (err) {
      console.error(`markEscalated failed for ticket ${t.id}:`, err);
    }
  }
}

route("GET", "/api/stats", async (req, res) => {
  const user = await requireLogin(req);
  await runEscalationSweep();
  // BSP MODE: null unless this is a tagged IT account in BSP mode - every
  // ticket-derived number below is limited to their Line of Business.
  const itScope = await data.getItBranchScope(user.role, user.id);
  const keepIds = async (ids) => (itScope ? await data.filterTicketIdsInScope(ids, itScope) : ids);
  const keepRows = async (rows) => {
    if (!itScope) return rows;
    const ok = new Set((await data.filterTicketIdsInScope(rows.map((r) => r.id), itScope)).map(Number));
    return rows.filter((r) => ok.has(Number(r.id)));
  };
  const stats = await data.getTicketStats(user.role, user.id, itScope);
  const absentToday = ["IT Department", "Super Admin"].includes(user.role)
    ? await data.getAbsentToday(null, itScope)
    : [];
  // Account-locked staff (is_available = false) need the same "someone
  // needs to cover their pending tickets" treatment as an absent colleague
  // - a locked account can't log in at all, so their open/in-progress
  // tickets are just as stuck as an absent person's. Merged with
  // absentToday below into one combined list rather than shown separately,
  // since from a "who can't work right now" standpoint they're the same
  // situation to a Super Admin or IT Department viewer.
  const lockedToday = ["IT Department", "Super Admin"].includes(user.role)
    ? await data.getLockedStaff(itScope)
    : [];
  const unavailableToday = mergeUnavailableStaff(absentToday, lockedToday);
  // Only a Super Admin acts on void requests, so only they need the count
  // (drives the "Tickets" nav dot the same way absent-with-pending-work
  // does for IT Department/Super Admin). Kept as the full row list (not
  // just .length) so the notification bell can deep-link straight to the
  // one ticket when there's exactly one pending void request.
  const voidRequestRows = user.role === "Super Admin" ? await data.getVoidRequests() : [];
  const pendingVoidRequests = voidRequestRows.length;
  // Only a Super Admin decides reopen requests too, so only they need the
  // count - same pattern as pendingVoidRequests just above.
  const reopenRequestRows = user.role === "Super Admin" ? await data.getReopenRequests() : [];
  const pendingReopenRequests = reopenRequestRows.length;
  // An IT Department account's own "awaiting your decision" queue - reopen
  // requests on tickets actually assigned to them, now that the assignee
  // (not just Super Admin) decides these. Separate from
  // pendingReopenRequests above, which is Super Admin's system-wide view.
  const reopenAssignedRows = await keepRows(user.role === "IT Department"
    ? await data.getReopenRequestsForAssignee(user.id)
    : []);
  const pendingReopenAssigned = reopenAssignedRows.length;
  // Only a Super Admin decides availability requests, so only they need the
  // count - drives the sidebar bell in app.js.
  const pendingAvailabilityRequests = user.role === "Super Admin"
    ? (await data.getPendingAvailabilityRequests()).length
    : 0;
  // Device sign-in approval is Super Admin-only, so only they need the
  // count - drives the sidebar "Device approvals" bell.
  const pendingDeviceRequests = user.role === "Super Admin"
    ? (await data.getDeviceRequests(user.role, user.id)).filter((r) => r.status === "Pending").length
    : 0;
  // Item Borrowing requests awaiting a decision - Super Admin-only now
  // decides these (IT Department is a borrower only, like Head Office
  // Employee, and does not manage the catalog or decide requests). Kept
  // as the full row list (not just .length) so the notification bell can
  // deep-link straight to Item Borrowing.
  const pendingBorrowRows = user.role === "Super Admin"
    ? await data.getPendingItemBorrows()
    : [];
  const pendingBorrowRequests = pendingBorrowRows.length;
  // Unread Team Workspace files/memos since this user last opened each
  // section - drives the "Shared Files" / "Memos" nav dots individually,
  // the same way the counts above drive their own dots.
  const workspaceUnread = ["Super Admin", "IT Department"].includes(user.role)
    ? await data.getWorkspaceUnreadCount(user.id)
    : { files: 0, memos: 0 };
  // New tickets assigned to *this* user since they last opened Tickets -
  // per-user like everything else here, so one IT staffer's count never
  // reflects a colleague's assignments (see data.getNewAssignedTicketIds).
  // Kept as the id list (not just a count) so the bell can deep-link
  // straight to the ticket when there's exactly one.
  const newAssignedTicketIds = await keepIds(["Super Admin", "IT Department"].includes(user.role)
    ? await data.getNewAssignedTicketIds(user.id)
    : []);
  const newAssignedTickets = newAssignedTicketIds.length;
  // Branch Staff's own submitted tickets that have been updated since they
  // last opened Tickets - the Branch-side counterpart to the IT/Admin count
  // above (see data.getBranchTicketUpdateIds). Head Office Employee
  // accounts submit tickets the exact same way, so they get this too.
  const branchTicketUpdateIds = ["Branch Staff", "Head Office Employee"].includes(user.role)
    ? await data.getBranchTicketUpdateIds(user.id)
    : [];
  const branchTicketUpdates = branchTicketUpdateIds.length;
  // Void requests THIS IT Department account filed that a Super Admin has
  // since decided (approved/declined) - previously an IT staffer had no way
  // to learn a void request of theirs was decided short of opening the
  // ticket themselves (see data.getVoidDecisionIds).
  const voidDecisionIds = await keepIds(user.role === "IT Department"
    ? await data.getVoidDecisionIds(user.id)
    : []);
  const voidDecisions = voidDecisionIds.length;
  // Reopen requests THIS user filed that got decided since they last saw -
  // the reopen counterpart to voidDecisions above. Covers IT Department
  // (their own tickets) AND Branch Staff/Head Office (the branch that
  // originally raised the ticket and asked for it back), since either can
  // now request a reopen.
  const reopenDecisionIds = await keepIds(["IT Department", "Branch Staff", "Head Office Employee"].includes(user.role)
    ? await data.getReopenDecisionIds(user.id)
    : []);
  const reopenDecisions = reopenDecisionIds.length;
  // This user's own availability_requests (e.g. a 'field' request they
  // filed to be marked unavailable) that a Super Admin has since decided -
  // the availability-request counterpart to voidDecisions/reopenDecisions
  // above. Both IT Department and Super Admin accounts can file these, so
  // both get the notification (unlike void/reopen, which only IT
  // Department files).
  const availabilityDecisions = ["Super Admin", "IT Department"].includes(user.role)
    ? await data.getAvailabilityDecisionsCount(user.id)
    : 0;
  // This user's own borrow requests that a Super Admin has since decided
  // (approved/denied) - the Item Borrowing counterpart to
  // voidDecisions/reopenDecisions above, for the requester's side of the
  // approve/deny workflow. Both Head Office Employee and IT Department
  // accounts can file a borrow request (IT Department borrowing for
  // itself, decided by a Super Admin either way), so both get this
  // notification.
  const borrowDecisionIds = ["Head Office Employee", "IT Department"].includes(user.role)
    ? await data.getBorrowDecisionIds(user.id)
    : [];
  const borrowDecisions = borrowDecisionIds.length;
  // Tickets a Super Admin has "poked" for follow-up (see data.pokeTicket) -
  // this user's own assigned tickets currently flagged (IT Department only
  // - a Super Admin is never an assignee, and already knows what they just
  // poked, so they don't need a notification about their own action). A
  // poke is a nudge to the specific assignee only, not broadcast to the
  // rest of the team - see the /poke route above.
  const pokedOwnTicketIds = await keepIds(user.role === "IT Department"
    ? await data.getPokedOwnTicketIds(user.id)
    : []);
  const pokedOwnCount = pokedOwnTicketIds.length;
  // This user's own assigned tickets that have sat 'Open' 10+ minutes since
  // becoming theirs, with nobody moving them to In Progress - the automatic
  // counterpart to the manual poke just above (see
  // data.getStaleOpenTicketIds). Drives both a bell row and app.js's
  // top-of-app escalation banner; the repeating push notification for the
  // same condition is handled separately by runEscalationSweep() above.
  const staleOpenOwnTicketIds = await keepIds(user.role === "IT Department"
    ? await data.getStaleOpenTicketIds(user.id)
    : []);
  const staleOpenOwnCount = staleOpenOwnTicketIds.length;
  // This user's last-acknowledged value for each "live pending count" bell
  // category (availability/device/void/assist) - persisted server-side
  // (notification_reads) so app.js's bell can restore exactly what was
  // already seen after a page refresh, instead of the badge count coming
  // back the way it did when "seen" only lived in an in-memory JS variable.
  const notifSeenCounts = await data.getNotificationSeenCounts(user.id);
  sendJson(res, 200, {
    stats,
    absent_today: absentToday,
    // Absent-today + account-locked staff merged into one list, each row
    // tagged with `kind` ("absent" | "locked", or "absent_locked" if both
    // apply) so the dashboard's "Unavailable today" panel and the
    // notification bell's assist-needed count reflect BOTH reasons a
    // colleague might be unable to work a ticket right now - not just
    // marked-absent (see data.getLockedStaff for why a locked account
    // needs the same treatment).
    unavailable_today: unavailableToday,
    pending_void_requests: pendingVoidRequests,
    pending_void_ticket_ids: voidRequestRows.map((r) => r.id),
    pending_reopen_requests: pendingReopenRequests,
    pending_reopen_ticket_ids: reopenRequestRows.map((r) => r.id),
    pending_reopen_assigned: pendingReopenAssigned,
    pending_reopen_assigned_ids: reopenAssignedRows.map((r) => r.id),
    pending_availability_requests: pendingAvailabilityRequests,
    pending_device_requests: pendingDeviceRequests,
    pending_borrow_requests: pendingBorrowRequests,
    pending_borrow_ids: pendingBorrowRows.map((r) => r.id),
    workspace_unread_files: workspaceUnread.files,
    workspace_unread_memos: workspaceUnread.memos,
    // Combined total kept for anything still relying on the old single
    // count (e.g. the "Team Workspace" group dot lights up if either is > 0).
    workspace_unread: workspaceUnread.files + workspaceUnread.memos,
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
    poked_own: pokedOwnCount,
    poked_own_ticket_ids: pokedOwnTicketIds,
    stale_open_own: staleOpenOwnCount,
    stale_open_own_ticket_ids: staleOpenOwnTicketIds,
    notif_seen_counts: notifSeenCounts,
  });
});

// ---------------------------------------------------------------- team workspace (IT Department / Super Admin)

// A live snapshot dashboard for IT: current workload, who's on duty right
// now, and the next week's absence schedule - distinct from Reporting
// (historical/date-ranged) and IT Staff & Availability (roster management).
route("GET", "/api/team-workspace", async (req, res) => {
  // Overview (workload snapshot + the Attendance panel below) is Super
  // Admin-only - IT Department accounts still get "Shared Files" and
  // "Memos" under the Team Workspace nav group, just not this page. See
  // app.js's NAV_BY_ROLE, which no longer gives IT Department a link here.
  const user = await requireRole(req, "Super Admin");
  const [workload, absentToday, upcomingAbsences, teamStats, voidRequests, reopenRequests, deviceRequests, borrowRequests] = await Promise.all([
    data.getTeamWorkload(),
    data.getAbsentToday(),
    data.getUpcomingAbsences(7),
    data.getTeamStats(),
    data.getVoidRequests(),
    data.getReopenRequests(),
    data.getDeviceRequests(user.role, user.id),
    data.getPendingItemBorrows(),
  ]);
  sendJson(res, 200, {
    workload,
    absent_today: absentToday,
    upcoming_absences: upcomingAbsences,
    team_stats: teamStats,
    pending_void_requests: voidRequests.length,
    pending_reopen_requests: reopenRequests.length,
    pending_device_requests: deviceRequests.filter((r) => r.status === "Pending").length,
    pending_borrow_requests: borrowRequests.length,
  });
});

// ---------------------------------------------------------------- IT staff attendance (Super Admin only)
//
// Login-time / device monitoring for IT Department & Super Admin accounts -
// deliberately not exposed to IT Department at all (every route below is
// requireRole(req, "Super Admin") only). Backed by login_log, written on
// every successful /api/login (see data.recordLogin above). Reuses the same
// mode=single|monthly|annual|range query-param convention as /api/reports/*
// (see resolveRangeFromQuery below).

route("GET", "/api/attendance/today", async (req, res) => {
  await requireRole(req, "Super Admin");
  const rows = await data.getTodayAttendance();
  sendJson(res, 200, { rows });
});

route("GET", "/api/attendance", async (req, res, params, query) => {
  await requireRole(req, "Super Admin");
  const userIdParam = query.get("user_id");
  const userId = userIdParam ? Number(userIdParam) : null;
  let startDate = null, endDate = null;
  if (query.get("mode")) {
    try {
      [startDate, endDate] = resolveRangeFromQuery(query);
    } catch (e) {
      return jsonError(res, "Invalid date filter.");
    }
  }
  const rows = await data.getAttendanceLog(startDate, endDate, { userId });
  sendJson(res, 200, { start: startDate, end: endDate, rows });
});

route("GET", "/api/attendance/export", async (req, res, params, query) => {
  await requireRole(req, "Super Admin");
  const userIdParam = query.get("user_id");
  const userId = userIdParam ? Number(userIdParam) : null;
  let startDate = null, endDate = null;
  if (query.get("mode")) {
    try {
      [startDate, endDate] = resolveRangeFromQuery(query);
    } catch (e) {
      return jsonError(res, "Invalid date filter.");
    }
  }
  const rows = await data.getAttendanceLog(startDate, endDate, { userId, limit: 5000 });
  const periodLabel = startDate && endDate ? `${startDate} to ${endDate}` : "All history";
  const wb = reportExport.buildAttendanceReportWorkbook(rows, periodLabel);
  const buf = await wb.xlsx.writeBuffer();
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="attendance_${startDate || "all"}_${endDate || "history"}.xlsx"`,
  });
  res.end(Buffer.from(buf));
});

// ---------------------------------------------------------------- team workspace: shared files
//
// "Shared files" is a link library, not a file host: a Super Admin (or IT
// Department, for edits) pastes a URL - e.g. a Google Drive/SharePoint link
// - with a display name, and clicking the row's name takes you straight to
// that link (see the /download route below, which 302-redirects to it).
// Nothing is uploaded or stored in Blob storage for this feature.

function serializeWorkspaceFile(f) {
  return {
    id: f.id,
    filename: f.original_filename,
    url: f.blob_url,
    description: f.description,
    uploaded_by: f.uploaded_by,
    uploaded_by_name: f.uploaded_by_name,
    created_at: f.created_at,
    updated_by_name: f.updated_by_name || null,
    updated_at: f.updated_at || null,
    version: f.version,
  };
}

route("GET", "/api/workspace/files", async (req, res) => {
  await requireRole(req, "Super Admin", "IT Department");
  const files = await data.listWorkspaceFiles();
  sendJson(res, 200, { files: files.map(serializeWorkspaceFile) });
});

// Only a Super Admin can add a brand-new link to the shared library.
route("POST", "/api/workspace/files", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin");
  const name = (body.name || "").trim();
  const url = (body.url || "").trim();
  if (!name) return jsonError(res, "Give the link a name.");
  if (!isHttpUrl(url)) return jsonError(res, "Enter a valid link (starting with http:// or https://).");
  const description = (body.description || "").trim() || null;
  const fileId = await data.createWorkspaceFile(user.id, name.slice(0, 255), url, null, null, description);

  const recipients = (await data.getItDepartmentUsers()).filter((u) => u.id !== user.id);
  await Promise.all(recipients.map((r) =>
    push.notifyUser(r.id, {
      title: "New link in Team Workspace",
      body: name,
      url: "/?tab=workspace",
    }).catch((err) => console.error("push notify (new workspace file) failed:", err))
  ));

  sendJson(res, 200, { ok: true, file_id: fileId });
});

// Editing an existing link (name and/or URL) is Super Admin-only - IT
// Department has view-only access to Shared Files/Memos. Snapshots the
// previous name/URL into version history, the same as the old "replace the
// file" flow did.
route("POST", "/api/workspace/files/:id/update", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin");
  const fileId = Number(params.id);
  const existing = await data.getWorkspaceFileById(fileId);
  if (!existing) return jsonError(res, "File not found.", 404);

  const name = (body.name || "").trim();
  const url = (body.url || "").trim();
  if (!name) return jsonError(res, "Give the link a name.");
  if (!isHttpUrl(url)) return jsonError(res, "Enter a valid link (starting with http:// or https://).");

  await data.updateWorkspaceFileContent(fileId, user.id, name.slice(0, 255), url, null, null);

  const recipients = (await data.getItDepartmentUsers()).filter((u) => u.id !== user.id);
  await Promise.all(recipients.map((r) =>
    push.notifyUser(r.id, {
      title: "Link updated in Team Workspace",
      body: name,
      url: "/?tab=workspace",
    }).catch((err) => console.error("push notify (workspace file update) failed:", err))
  ));

  sendJson(res, 200, { ok: true });
});

route("GET", "/api/workspace/files/:id/versions", async (req, res, params) => {
  await requireRole(req, "Super Admin", "IT Department");
  const versions = await data.getWorkspaceFileVersions(Number(params.id));
  sendJson(res, 200, { versions });
});

// Convenience redirect straight to the stored link - lets a row's "name"
// be linked either directly (client already has the URL) or through this
// route (e.g. from a push notification), landing in the same place either way.
route("GET", "/api/workspace/files/:id/download", async (req, res, params) => {
  await requireRole(req, "Super Admin", "IT Department");
  const file = await data.getWorkspaceFileById(Number(params.id));
  if (!file) return jsonError(res, "File not found.", 404);
  res.writeHead(302, { Location: file.blob_url });
  res.end();
});

route("DELETE", "/api/workspace/files/:id", async (req, res, params) => {
  await requireRole(req, "Super Admin");
  await data.deleteWorkspaceFile(Number(params.id));
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- team workspace: memos

const MEMO_TYPES = ["Branch Opening", "Branch Closed", "Memorandum", "Other Announcement"];

route("GET", "/api/workspace/memos", async (req, res) => {
  await requireRole(req, "Super Admin", "IT Department");
  sendJson(res, 200, { memos: await data.listWorkspaceMemos() });
});

// Posting a memo is Super Admin-only. The image is optional - sent as
// multipart/form-data (like workspace file uploads) so a memo can include a
// photo (e.g. of the branch being opened) alongside its text.
route("POST", "/api/workspace/memos", async (req, res, params, query, body, rawParts) => {
  const user = await requireRole(req, "Super Admin");
  const memoType = body.memo_type;
  const title = (body.title || "").trim();
  const memoBody = (body.body || "").trim();
  if (!MEMO_TYPES.includes(memoType)) return jsonError(res, "Invalid memo type.");
  if (!title) return jsonError(res, "Title is required.");

  let imageUrl = null;
  const image = rawParts && rawParts.files && rawParts.files.image;
  if (image && image.filename) {
    const dotIdx = image.filename.lastIndexOf(".");
    const ext = dotIdx !== -1 ? image.filename.slice(dotIdx + 1).toLowerCase() : "";
    if (!ALLOWED_IMAGE_EXT.has(ext)) {
      return jsonError(res, "Only image files are allowed (jpg, png, gif, bmp, webp).");
    }
    if (image.data.length > MAX_WORKSPACE_FILE_BYTES) {
      return jsonError(res, "Image is too large (20 MB max).");
    }
    const safeName = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
    const blob = await put(`workspace-memos/${safeName}`, image.data, {
      access: "public",
      contentType: image.contentType || undefined,
    });
    imageUrl = blob.url;
  }

  const memoId = await data.createWorkspaceMemo(user.id, memoType, title, memoBody, imageUrl);

  const recipients = (await data.getItDepartmentUsers()).filter((u) => u.id !== user.id);
  await Promise.all(recipients.map((r) =>
    push.notifyUser(r.id, {
      title: `${memoType}: ${title}`,
      body: memoBody.slice(0, 140),
      url: "/?tab=workspace",
    }).catch((err) => console.error("push notify (new memo) failed:", err))
  ));

  sendJson(res, 200, { ok: true, memo_id: memoId });
});

route("DELETE", "/api/workspace/memos/:id", async (req, res, params) => {
  await requireRole(req, "Super Admin");
  await data.deleteWorkspaceMemo(Number(params.id));
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- team workspace: IT Request

// Viewable by both roles - IT Department sees the whole shared log, not
// just requests they personally raised, same as Shared Files/Memos.
// Accepts the same optional mode=single|monthly|range date-filter query
// params as /api/reports/* (see resolveItRequestRangeFromQuery below);
// omit `mode` entirely for the full unfiltered log.
route("GET", "/api/workspace/it-requests", async (req, res, params, query) => {
  await requireRole(req, "Super Admin", "IT Department");
  const [start, end] = resolveItRequestRangeFromQuery(query);
  sendJson(res, 200, { requests: await data.listITRequests(start, end) });
});

// Any IT Department (or Super Admin) account can log a request for
// themselves - requested_by is always the logged-in user, never
// caller-supplied. `branches` can name more than one branch AND/OR
// department a single request concerns (sent as a JSON array, or a single
// string for one) - not every request is branch-specific, e.g. a Head
// Office department may raise one too. The image is optional - sent as
// multipart/form-data (like workspace file/memo uploads) so a request can
// include a photo of the issue alongside its description.
route("POST", "/api/workspace/it-requests", async (req, res, params, query, body, rawParts) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  const requestDate = (body.request_date || "").trim();
  const description = (body.description || "").trim();
  let branches = body.branches;
  if (typeof branches === "string") {
    try { branches = JSON.parse(branches); } catch (e) { branches = [branches]; }
  }
  branches = Array.isArray(branches) ? branches.map((b) => String(b).trim()).filter(Boolean) : [];
  branches = [...new Set(branches)];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestDate)) return jsonError(res, "A valid date of request is required.");
  if (!branches.length) return jsonError(res, "Select at least one branch or department.");
  if (!description) return jsonError(res, "Description is required.");
  const validBranches = await data.getBranches();
  const validDepartments = await data.getDepartments();
  const validOptions = [...validBranches, ...validDepartments];
  if (branches.some((b) => !validOptions.includes(b))) return jsonError(res, "Unknown branch or department.");

  let imageUrl = null;
  const image = rawParts && rawParts.files && rawParts.files.image;
  if (image && image.filename) {
    const dotIdx = image.filename.lastIndexOf(".");
    const ext = dotIdx !== -1 ? image.filename.slice(dotIdx + 1).toLowerCase() : "";
    if (!ALLOWED_IMAGE_EXT.has(ext)) {
      return jsonError(res, "Only image files are allowed (jpg, png, gif, bmp, webp).");
    }
    if (image.data.length > MAX_WORKSPACE_FILE_BYTES) {
      return jsonError(res, "Image is too large (20 MB max).");
    }
    const safeName = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
    const blob = await put(`it-requests/${safeName}`, image.data, {
      access: "public",
      contentType: image.contentType || undefined,
    });
    imageUrl = blob.url;
  }

  const requestId = await data.createITRequest(user.id, requestDate, branches, description, imageUrl);

  // Let Super Admins know a new IT Request came in, mirroring the memo
  // notification pattern above.
  const admins = (await data.getSuperAdminUsers()).filter((u) => u.id !== user.id);
  await Promise.all(admins.map((a) =>
    push.notifyUser(a.id, {
      title: `New IT Request — ${branches.join(", ")}`,
      body: description.slice(0, 140),
      url: "/?tab=workspace-itrequest",
    }).catch((err) => console.error("push notify (new IT request) failed:", err))
  ));

  sendJson(res, 200, { ok: true, request_id: requestId });
});

// Deletable by whoever raised the request, or by a Super Admin.
route("DELETE", "/api/workspace/it-requests/:id", async (req, res, params) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  const existing = await data.getITRequestById(Number(params.id));
  if (!existing) return jsonError(res, "Request not found.", 404);
  if (user.role !== "Super Admin" && existing.requested_by !== user.id) {
    return jsonError(res, "You can only delete a request you raised yourself.", 403);
  }
  await data.deleteITRequest(Number(params.id));
  sendJson(res, 200, { ok: true });
});

// mode=single|monthly|range, same convention as resolveRangeFromQuery
// further down (mode=single -> day, mode=monthly -> month+year, mode=range
// -> start+end) - kept separate because an IT Request log has a sensible
// unfiltered default ("All history", mode omitted) the way the ticket
// Reporting tab's mode-required toolbar doesn't.
function resolveItRequestRangeFromQuery(query) {
  const mode = query.get("mode");
  if (!mode) return [null, null];
  if (mode === "single") {
    const day = parseDate(query.get("day"));
    return reporting.resolveDateRange("single", { day });
  }
  if (mode === "range") {
    const start = parseDate(query.get("start"));
    const end = parseDate(query.get("end"));
    return reporting.resolveDateRange("range", { start, end });
  }
  const today = new Date();
  const year = parseInt(query.get("year") || today.getFullYear(), 10);
  const month = parseInt(query.get("month") || today.getMonth() + 1, 10);
  return reporting.resolveDateRange("monthly", { year, month });
}

// Downloadable .xlsx of the (optionally date-filtered) IT Request log -
// same field set as the on-page table, minus the attached image (a Blob
// URL/binary isn't meaningful in a spreadsheet cell, and the file itself
// isn't included in the download).
route("GET", "/api/workspace/it-requests/export", async (req, res, params, query) => {
  await requireRole(req, "Super Admin", "IT Department");
  const [start, end] = resolveItRequestRangeFromQuery(query);
  const rows = await data.listITRequests(start, end);
  const periodLabel = start && end ? `${start} to ${end}` : "All history";
  const wb = reportExport.buildITRequestsWorkbook(rows, periodLabel);
  const buf = await wb.xlsx.writeBuffer();
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="it_requests_${start || "all"}_${end || "history"}.xlsx"`,
  });
  res.end(Buffer.from(buf));
});

// ---------------------------------------------------------------- team workspace: Item Borrowing

// The item catalog itself. Readable by Super Admin (to manage it) and
// Head Office Employee/IT Department (to pick something to borrow) -
// nobody else has a reason to see it.
route("GET", "/api/borrow-items", async (req, res) => {
  await requireRole(req, "Super Admin", "IT Department", "Head Office Employee");
  sendJson(res, 200, { items: await data.listBorrowItems() });
});

// Add a new item to the catalog. Super Admin-only manages the catalog
// itself - IT Department and Head Office Employee accounts can only
// borrow from it, never add/edit/remove items.
route("POST", "/api/borrow-items", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin");
  const name = (body.name || "").trim();
  const description = (body.description || "").trim();
  const quantity = Number(body.quantity);
  if (!name) return jsonError(res, "Item name is required.");
  if (!Number.isInteger(quantity) || quantity < 1) return jsonError(res, "Quantity must be a whole number of at least 1.");
  const id = await data.createBorrowItem(name, description, quantity, user.id);
  sendJson(res, 200, { ok: true, id });
});

route("PUT", "/api/borrow-items/:id", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin");
  const name = (body.name || "").trim();
  const description = (body.description || "").trim();
  const quantity = Number(body.quantity);
  if (!name) return jsonError(res, "Item name is required.");
  if (!Number.isInteger(quantity) || quantity < 1) return jsonError(res, "Quantity must be a whole number of at least 1.");
  try {
    await data.updateBorrowItem(Number(params.id), name, description, quantity, user.id);
  } catch (err) {
    return jsonError(res, err.message);
  }
  sendJson(res, 200, { ok: true });
});

route("DELETE", "/api/borrow-items/:id", async (req, res, params) => {
  await requireRole(req, "Super Admin");
  await data.deleteBorrowItem(Number(params.id));
  sendJson(res, 200, { ok: true });
});

// A Head Office Employee (or an IT Department account, borrowing for
// itself) requesting an item for their own department, for a From/To date
// range (advance bookings are fine - `from_date` doesn't have to be
// today). `department`/`borrowed_by` always come from the logged-in
// account (user.branch holds the department name for this role - see
// data.registerUser; for IT Department it's the literal "IT Department")
// rather than anything the client sends, the same way ticket creation
// never trusts a caller-supplied requester identity.
route("POST", "/api/item-borrows", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Head Office Employee", "IT Department");
  const itemId = Number(body.item_id);
  const quantity = Number(body.quantity);
  const borrowerName = (body.borrower_name || "").trim().slice(0, 150);
  const fromDate = (body.from_date || "").trim();
  const toDate = (body.to_date || "").trim();
  const notes = (body.notes || "").trim().slice(0, 255) || null;
  if (!Number.isInteger(itemId)) return jsonError(res, "Choose an item to borrow.");
  if (!Number.isInteger(quantity) || quantity < 1) return jsonError(res, "Quantity must be a whole number of at least 1.");
  if (!borrowerName) return jsonError(res, "The staff borrower's name is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return jsonError(res, "A valid 'From' date is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return jsonError(res, "A valid 'To' date is required.");
  if (toDate < fromDate) return jsonError(res, "'To' date can't be before 'From' date.");
  const today = new Date().toISOString().slice(0, 10);
  if (fromDate < today) return jsonError(res, "'From' date can't be in the past.");
  let id;
  try {
    id = await data.createItemBorrow(itemId, quantity, user.branch, user.id, borrowerName, fromDate, toDate, notes);
  } catch (err) {
    return jsonError(res, err.message);
  }

  const admins = await data.getSuperAdminUsers();
  await Promise.all(admins.map((a) =>
    push.notifyUser(a.id, {
      title: "Borrow request needs review",
      body: `${user.branch} (${borrowerName}) wants to borrow ${quantity}x — check Item Borrowing records`,
      url: "/?tab=workspace-borrow",
    }).catch((err) => console.error("push notify (borrow request) failed:", err))
  ));

  sendJson(res, 200, { ok: true, id });
});

// A Super Admin approves or denies a pending borrow request - the
// item-borrow counterpart to /api/tickets/:id/void/decide. IT Department
// is a borrower only (like Head Office Employee) and does not decide
// requests, including its own. Denying requires a `note` explaining why
// (enforced here and again in data.decideItemBorrow as a safety net) so
// the department that requested it knows what to fix or ask about next
// time; approving's note is optional.
route("POST", "/api/item-borrows/:id/decide", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin");
  const approve = !!body.approve;
  const note = (body.note || "").trim() || null;
  if (!approve && !note) return jsonError(res, "Please explain why this borrow request is being denied.");

  let decided;
  try {
    decided = await data.decideItemBorrow(Number(params.id), user.id, approve, note);
  } catch (err) {
    return jsonError(res, err.message, 400);
  }

  if (decided.requestedBy) {
    try {
      await push.notifyUser(decided.requestedBy, {
        title: approve ? "Borrow request approved" : "Borrow request denied",
        body: `${decided.quantity}x ${decided.itemName}${note ? " — " + note : ""}`,
        url: "/?tab=borrow-items",
      });
    } catch (err) {
      console.error("push notify (borrow decide) failed:", err);
    }
  }

  sendJson(res, 200, { ok: true });
});

// A Head Office Employee's (or an IT Department account's) own borrow
// history, scoped to their own department (user.branch - "IT Department"
// for IT accounts); Super Admin should use /api/workspace/item-borrows
// instead to see every department's records.
route("GET", "/api/item-borrows", async (req, res) => {
  const user = await requireRole(req, "Head Office Employee", "IT Department");
  sendJson(res, 200, { borrows: await data.listItemBorrows(null, null, user.branch) });
});

// Deletable by whoever borrowed it, or by a Super Admin - same permission
// shape as IT Request's delete above. Restocks the item first if it hadn't
// been marked returned yet (see data.deleteItemBorrow).
route("DELETE", "/api/item-borrows/:id", async (req, res, params) => {
  const user = await requireRole(req, "Super Admin", "Head Office Employee", "IT Department");
  const existing = await data.getItemBorrowById(Number(params.id));
  if (!existing) return jsonError(res, "Borrow record not found.", 404);
  if (user.role !== "Super Admin" && existing.borrowed_by !== user.id) {
    return jsonError(res, "You can only delete a borrow record you raised yourself.", 403);
  }
  await data.deleteItemBorrow(Number(params.id));
  sendJson(res, 200, { ok: true });
});

// Marking a borrow returned is Super Admin-only (see
// /api/workspace/item-borrows/:id/return below) - a department (including
// IT Department, when it's the borrower) can request and cancel its own
// borrow, but only Super Admin can close out an actual return, since
// that's also the point the item physically comes back.

// The full cross-department borrow log for Super Admin's "records" table -
// same optional mode=single|monthly|range date filter as
// /api/workspace/it-requests (see resolveItRequestRangeFromQuery); omit
// `mode` entirely for the full unfiltered log.
route("GET", "/api/workspace/item-borrows", async (req, res, params, query) => {
  await requireRole(req, "Super Admin");
  const [start, end] = resolveItRequestRangeFromQuery(query);
  sendJson(res, 200, { borrows: await data.listItemBorrows(start, end) });
});

// Mark a borrow returned - restocks the item's available_quantity in the
// same transaction (see data.markItemBorrowReturned).
route("PUT", "/api/workspace/item-borrows/:id/return", async (req, res, params) => {
  await requireRole(req, "Super Admin");
  try {
    await data.markItemBorrowReturned(Number(params.id));
  } catch (err) {
    return jsonError(res, err.message);
  }
  sendJson(res, 200, { ok: true });
});

// Called when a Super Admin/IT Department user opens "Shared Files" or
// "Memos" - resets that section's unread count only (see
// data.getWorkspaceUnreadCount, surfaced via /api/stats as
// workspace_unread_files / workspace_unread_memos). Body: { section:
// "files" | "memos" }; defaults to "files" if omitted/unrecognized.
route("POST", "/api/workspace/mark-seen", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  const section = body.section === "memos" ? "memos" : "files";
  await data.markWorkspaceSeen(user.id, section);
  sendJson(res, 200, { ok: true });
});

// Called when the user opens/dismisses one of the bell's "live pending
// count" rows (availability, device, void, assist) - see app.js's
// markNotifSeen. Persists the exact count they just acknowledged
// (notification_reads) so that category's badge contribution stays cleared
// across a refresh, and only reappears once the live count actually
// changes again. Body: { category: "availability"|"device"|"void"|"assist",
// count: <the live count being acknowledged> }.
route("POST", "/api/notifications/mark-seen", async (req, res, params, query, body) => {
  const user = await requireLogin(req);
  const category = body.category;
  const count = Number(body.count);
  if (!["availability", "device", "void", "assist", "reopen"].includes(category) || !Number.isFinite(count)) {
    return jsonError(res, "Invalid notification category or count.");
  }
  await data.markCountNotifSeen(user.id, category, count);
  sendJson(res, 200, { ok: true });
});

// Called when an IT Department/Super Admin user opens "Tickets" - clears
// their own "N new tickets assigned to you" bell notification only (see
// data.getNewAssignedTicketsCount / markTicketsNotifSeen), the same
// per-section pattern as /api/workspace/mark-seen for Shared Files/Memos.
route("POST", "/api/notifications/tickets-seen", async (req, res) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  await data.markTicketsNotifSeen(user.id);
  sendJson(res, 200, { ok: true });
});

route("POST", "/api/notifications/branch-tickets-seen", async (req, res) => {
  const user = await requireRole(req, "Branch Staff", "Head Office Employee");
  await data.markBranchTicketUpdatesSeen(user.id);
  sendJson(res, 200, { ok: true });
});

// Clears an IT Department account's "N of your void requests were decided"
// bell notification - called when they open the Tickets tab, mirroring
// tickets-seen/branch-tickets-seen above.
route("POST", "/api/notifications/void-decisions-seen", async (req, res) => {
  const user = await requireRole(req, "IT Department");
  await data.markVoidDecisionsSeen(user.id);
  sendJson(res, 200, { ok: true });
});

// Clears a requester's "N of your reopen requests were decided" bell
// notification - mirrors void-decisions-seen above. Now covers whoever can
// file a reopen request (IT Department, or the branch/requester who
// created the ticket), not just IT Department.
route("POST", "/api/notifications/reopen-decisions-seen", async (req, res) => {
  const user = await requireRole(req, "IT Department", "Branch Staff", "Head Office Employee");
  await data.markReopenDecisionsSeen(user.id);
  sendJson(res, 200, { ok: true });
});

// Clears this user's "N of your availability requests were decided" bell
// notification - called when they open the IT Staff & Availability tab,
// mirroring void/reopen-decisions-seen above. Both roles can file a 'field'
// request, so both roles can clear this (unlike void/reopen, IT
// Department-only).
route("POST", "/api/notifications/availability-decisions-seen", async (req, res) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  await data.markAvailabilityDecisionsSeen(user.id);
  sendJson(res, 200, { ok: true });
});

// Clears this account's "N of your borrow requests were decided" bell
// notification - called when they open the Borrow Items tab, mirroring
// void/reopen/availability-decisions-seen above. Both Head Office Employee
// and IT Department accounts can file a borrow request, so both can clear
// this.
route("POST", "/api/notifications/borrow-decisions-seen", async (req, res) => {
  const user = await requireRole(req, "Head Office Employee", "IT Department");
  await data.markBorrowDecisionsSeen(user.id);
  sendJson(res, 200, { ok: true });
});

// TEMPORARY DIAGNOSTIC - remove once the "notifications reappear" bug is
// confirmed fixed. Dumps exactly what's persisted for this user's
// notification "seen" state, plus the live counts computed from it, in one
// shot - so this can be checked from the Network tab / a plain browser
// visit without needing Vercel function log access. Read-only, requires
// login (not public), touches no other reads/writes.
route("GET", "/api/notifications/debug", async (req, res) => {
  const user = await requireLogin(req);
  const pool = db.getConnection();
  const [nowRows] = await pool.query("SELECT NOW() AS now");
  const [workspaceRows] = await pool.query(
    "SELECT * FROM workspace_reads WHERE user_id = ?", [user.id]
  );
  const [notifRows] = await pool.query(
    "SELECT * FROM notification_reads WHERE user_id = ?", [user.id]
  );
  const workspaceUnread = await data.getWorkspaceUnreadCount(user.id);
  const newAssignedTickets = await data.getNewAssignedTicketsCount(user.id);
  const notifSeenCounts = await data.getNotificationSeenCounts(user.id);
  sendJson(res, 200, {
    user_id: user.id,
    role: user.role,
    server_now: nowRows[0].now,
    workspace_reads_row: workspaceRows[0] || null,
    notification_reads_row: notifRows[0] || null,
    live_workspace_unread: workspaceUnread,
    live_new_assigned_tickets: newAssignedTickets,
    live_notif_seen_counts: notifSeenCounts,
  });
});

// ---------------------------------------------------------------- device sign-in approvals

// Visibility mirrors ticket assignment: an IT Department staffer sees
// requests assigned to them, unassigned ones, or a colleague's while that
// colleague is absent (see data.getDeviceRequests); a Super Admin sees
// everything Pending or Declined, so they can review or override a decline.
route("GET", "/api/device-requests", async (req, res) => {
  const user = await requireRole(req, "Super Admin");
  sendJson(res, 200, { requests: await data.getDeviceRequests(user.role, user.id) });
});

route("POST", "/api/device-requests/:id/approve", async (req, res, params, query, body) => {
  // Device sign-in approval is Super Admin-only.
  const admin = await requireRole(req, "Super Admin");
  const note = ((body && body.note) || "").trim() || null;
  const result = await data.decideDeviceRequest(Number(params.id), true, admin.id, note);
  if (!result) return jsonError(res, "This request was already decided.", 400);
  sendJson(res, 200, { ok: true });
});

route("POST", "/api/device-requests/:id/decline", async (req, res, params, query, body) => {
  const admin = await requireRole(req, "Super Admin");
  const note = ((body && body.note) || "").trim() || null;
  const result = await data.decideDeviceRequest(Number(params.id), false, admin.id, note);
  if (!result) return jsonError(res, "This request was already decided.", 400);

  try {
    const admins = await data.getSuperAdminUsers();
    await Promise.all(admins.map((sa) =>
      push.notifyUser(sa.id, {
        title: "Device sign-in declined",
        body: `${result.deviceLabel || "A device"} was declined for a branch account — review if this needs an override.`,
        url: "/?tab=device-approvals",
      }).catch((err) => console.error("push notify (device decline) failed:", err))
    ));
  } catch (err) {
    console.error("device decline: notifying super admins failed:", err);
  }

  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- IT staff / specialties / absences

route("GET", "/api/it-staff", async (req, res) => {
  await requireRole(req, "Super Admin", "IT Department");
  sendJson(res, 200, { staff: await data.getItDepartmentUsers() });
});

route("GET", "/api/it-staff/:id/specialties", async (req, res, params) => {
  await requireRole(req, "Super Admin", "IT Department");
  sendJson(res, 200, { specialties: await data.getItSpecialties(Number(params.id)) });
});

route("POST", "/api/it-staff/:id/specialties", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin", "IT Department");
  const validCategories = await data.getCategories();
  const categories = (body.categories || []).filter((c) => validCategories.includes(c));
  await data.setItSpecialties(Number(params.id), categories);
  sendJson(res, 200, { ok: true });
});

route("GET", "/api/absences", async (req, res, params, query) => {
  // Both Super Admin and IT Department may VIEW who is unavailable.
  await requireRole(req, "Super Admin", "IT Department");
  const upcomingOnly = query.get("upcoming_only") !== "false";
  sendJson(res, 200, { absences: await data.getAbsences(upcomingOnly) });
});

route("POST", "/api/absences", async (req, res, params, query, body) => {
  // Only Super Admin may mark someone's availability/absence.
  const user = await requireRole(req, "Super Admin");
  body = body || {};
  const targetUserId = body.user_id;
  const startDateStr = body.start_date;
  if (!targetUserId) return jsonError(res, "Choose a staff member.");
  if (!startDateStr) return jsonError(res, "Choose a start date.");
  let start;
  try {
    start = parseDate(startDateStr);
  } catch (e) {
    return jsonError(res, "Invalid start date.");
  }
  let numDays;
  try {
    numDays = Math.max(1, parseInt(body.num_days || 1, 10));
    if (Number.isNaN(numDays)) throw new Error("bad");
  } catch (e) {
    return jsonError(res, "Number of days must be a whole number.");
  }
  const reason = body.reason;
  let dates;
  try {
    dates = await data.markAbsentRange(Number(targetUserId), start, numDays, user.id, reason);
  } catch (err) {
    return jsonError(res, `Could not save the absence: ${err.message}`);
  }
  sendJson(res, 200, { ok: true, dates });
});

route("DELETE", "/api/absences/:id", async (req, res, params) => {
  // Only Super Admin may un-mark an absence (i.e. change availability).
  await requireRole(req, "Super Admin");
  await data.unmarkAbsent(Number(params.id));
  sendJson(res, 200, { ok: true });
});

// Past absences (absence_date < today) - the history counterpart to
// GET /api/absences?upcoming_only=true. Same viewers as /api/absences.
// Accepts the same date-filter query params as /api/reports/* (mode=single
// |monthly|annual|range, plus day/year/month/start/end as needed) to
// narrow to one day, one month, or an arbitrary range instead of "all past
// absences". No mode param -> unfiltered (every past absence).
route("GET", "/api/absences/history", async (req, res, params, query) => {
  await requireRole(req, "Super Admin", "IT Department");
  const userId = query.get("user_id");
  let startDate = null, endDate = null;
  if (query.get("mode")) {
    try {
      [startDate, endDate] = resolveRangeFromQuery(query);
    } catch (e) {
      return jsonError(res, "Invalid date filter.");
    }
  }
  sendJson(res, 200, {
    absences: await data.getAbsenceHistory(userId ? Number(userId) : null, startDate, endDate),
  });
});

// Direct Super Admin toggle: block/restore an IT staff account's ability to
// log in at all (distinct from a dated it_absences entry, which only skips
// auto-assignment for one day). Marking someone unavailable here does not
// automatically decide any availability_requests row they may already have.
// Every call is appended to availability_log (see data.setAvailability), so
// this is also the source of the "Unavailable history" panel.
route("POST", "/api/it-staff/:id/availability", async (req, res, params, query, body) => {
  const admin = await requireRole(req, "Super Admin");
  body = body || {};
  const available = !!body.available;
  const reason = (body.reason || "").trim() || null;
  const unavailableFrom = (body.unavailable_from || "").trim() || null;
  const unavailableUntil = (body.unavailable_until || "").trim() || null;
  if (!available && Number(params.id) === admin.id) {
    return jsonError(res, "You can't mark your own account unavailable.");
  }
  if (!available && unavailableFrom && unavailableUntil && unavailableFrom > unavailableUntil) {
    return jsonError(res, "The 'until' date can't be before the 'from' date.");
  }
  await data.setAvailability(Number(params.id), available, admin.id, reason, unavailableFrom, unavailableUntil);
  sendJson(res, 200, { ok: true });
});

// Lock/unlock history (who was marked available/unavailable, by whom, and
// when). Same viewers as /api/absences - Super Admin manages it, IT
// Department can see it. Accepts the same date-filter query params as
// /api/absences/history above; no mode param -> unfiltered (most recent
// 200 changes).
route("GET", "/api/availability/log", async (req, res, params, query) => {
  await requireRole(req, "Super Admin", "IT Department");
  const userId = query.get("user_id");
  let startDate = null, endDate = null;
  if (query.get("mode")) {
    try {
      [startDate, endDate] = resolveRangeFromQuery(query);
    } catch (e) {
      return jsonError(res, "Invalid date filter.");
    }
  }
  sendJson(res, 200, {
    log: await data.getAvailabilityLog(userId ? Number(userId) : null, startDate, endDate),
  });
});

route("GET", "/api/availability/requests", async (req, res) => {
  await requireRole(req, "Super Admin");
  sendJson(res, 200, { requests: await data.getPendingAvailabilityRequests() });
});

// Self-service counterpart to the Super Admin-driven /api/it-staff/:id/
// availability above: a currently-logged-in IT Department/Super Admin
// account (e.g. about to head out on a site visit) asks a Super Admin to
// mark THEM unavailable, instead of the Super Admin having to notice and
// do it. Goes through the same Pending/Approve/Deny flow as the
// restore-access requests, just running the opposite direction (see
// data.decideAvailabilityRequest).
route("GET", "/api/availability/my-request", async (req, res) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  sendJson(res, 200, { request: await data.getOwnPendingAvailabilityRequest(user.id) });
});

route("POST", "/api/availability/field-request", async (req, res, params, query, body) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  body = body || {};
  if (user.is_available === false) {
    return jsonError(res, "Your account is already marked unavailable.");
  }
  const reason = (body.reason || "").trim() || null;
  const unavailableFrom = (body.unavailable_from || "").trim() || null;
  const unavailableUntil = (body.unavailable_until || "").trim() || null;
  if (unavailableFrom && unavailableUntil && unavailableFrom > unavailableUntil) {
    return jsonError(res, "The 'until' date can't be before the 'from' date.");
  }
  const { created } = await data.requestFieldUnavailability(user.id, reason, unavailableFrom, unavailableUntil);
  sendJson(res, 200, {
    ok: true,
    already_pending: !created,
    message: created
      ? "Request sent to the Super Admin team."
      : "A request is already pending Super Admin review.",
  });
});

route("POST", "/api/availability/requests/:id/approve", async (req, res, params) => {
  const admin = await requireRole(req, "Super Admin");
  const ok = await data.decideAvailabilityRequest(Number(params.id), true, admin.id);
  if (!ok) return jsonError(res, "That request was already decided.");
  sendJson(res, 200, { ok: true });
});

route("POST", "/api/availability/requests/:id/deny", async (req, res, params) => {
  const admin = await requireRole(req, "Super Admin");
  const ok = await data.decideAvailabilityRequest(Number(params.id), false, admin.id);
  if (!ok) return jsonError(res, "That request was already decided.");
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- accounts (Super Admin)

route("GET", "/api/users", async (req, res) => {
  await requireRole(req, "Super Admin");
  sendJson(res, 200, { users: await data.getAllUsers() });
});

route("POST", "/api/users", async (req, res, params, query, body) => {
  const actor = await requireRole(req, "Super Admin");
  const username = (body.username || "").trim();
  const password = body.password || "";
  const role = body.role;
  const branch = body.branch;
  const specialties = body.specialties || [];
  const fullNameInput = (body.full_name || "").trim();

  if (!ALL_ROLES.includes(role)) return jsonError(res, "Invalid role.");
  if (!username || !password) {
    return jsonError(res, "Username and password are required.");
  }
  if (await data.usernameExists(username)) return jsonError(res, "That username is already taken.");
  // 'force' lets a Super Admin acknowledge the "this branch/department
  // already has an account" warning and create a second one anyway (e.g.
  // a genuine need for a backup login) - everything else on this route
  // stays a hard block (bad role, missing password, taken username), only
  // this one check is skippable, and only when explicitly confirmed.
  const force = !!body.force;
  if (role === "Branch Staff") {
    if (!branch) return jsonError(res, "Branch is required for Branch Staff.");
    if (!force && (await data.branchAccountExists(branch))) {
      return jsonError(res, `'${branch}' already has a Branch Staff account.`, 409, "duplicate_location_account");
    }
  }
  if (role === "Head Office Employee") {
    if (!branch) return jsonError(res, "Department is required for Head Office Employee.");
    if (!force && (await data.departmentAccountExists(branch))) {
      return jsonError(res, `'${branch}' already has a Head Office Employee account.`, 409, "duplicate_location_account");
    }
  }
  if ((role === "Super Admin" || role === "IT Department") && !fullNameInput) {
    return jsonError(res, "Full name is required.");
  }

  // Branch Staff / Head Office Employee display as their branch/department
  // - one account each, so that name is unambiguous. Super Admin / IT
  // Department are individual people (the ones actually assisting other
  // users), so they get an explicit full name from the form instead.
  const fullName = ["Branch Staff", "Head Office Employee"].includes(role) ? branch : fullNameInput;

  const userId = await data.registerUser(username, password, fullName, role, branch);
  // A restricted admin can only create restricted Super Admins.
  if (role === "Super Admin" && (await isModeLocked(actor.id))) {
    await db.getConnection().query("UPDATE users SET can_change_mode = FALSE WHERE id = ?", [userId]);
  }
  if (role === "IT Department") {
    const validCategories = await data.getCategories();
    await data.setItSpecialties(userId, specialties.filter((c) => validCategories.includes(c)));
    if ("group" in body) {
      const group = body.group || null;
      if (group && !data.STAFF_GROUPS.includes(group)) return jsonError(res, "Invalid Line of Business.");
      await data.updateUserGroup(userId, group);
    }
  }
  sendJson(res, 200, { ok: true, user_id: userId });
});

route("PUT", "/api/users/:id", async (req, res, params, query, body) => {
  const actor = await requireRole(req, "Super Admin");
  const userId = Number(params.id);
  if (await blockIfTouchingFullAdmin(actor, userId, res)) return;
  const username = (body.username || "").trim();
  const role = body.role;
  const branch = body.branch;
  const password = body.password || null;
  const specialties = body.specialties || [];
  const fullNameInput = (body.full_name || "").trim();

  if (!ALL_ROLES.includes(role)) return jsonError(res, "Invalid role.");
  if (await data.usernameExists(username, userId)) return jsonError(res, "That username is already taken.");
  const force = !!body.force;
  if (role === "Branch Staff" && !force && (await data.branchAccountExists(branch, userId))) {
    return jsonError(res, `'${branch}' already has a Branch Staff account.`, 409, "duplicate_location_account");
  }
  if (role === "Head Office Employee" && !force && (await data.departmentAccountExists(branch, userId))) {
    return jsonError(res, `'${branch}' already has a Head Office Employee account.`, 409, "duplicate_location_account");
  }
  if ((role === "Super Admin" || role === "IT Department") && !fullNameInput) {
    return jsonError(res, "Full name is required.");
  }

  const fullName = ["Branch Staff", "Head Office Employee"].includes(role) ? branch : fullNameInput;

  await data.updateUser(userId, username, fullName, role, branch, password);
  // Promoting someone to Super Admin as a restricted admin yields a restricted one.
  if (role === "Super Admin" && (await isModeLocked(actor.id))) {
    await db.getConnection().query("UPDATE users SET can_change_mode = FALSE WHERE id = ?", [userId]);
  }
  if (role === "IT Department") {
    const validCategories = await data.getCategories();
    await data.setItSpecialties(userId, specialties.filter((c) => validCategories.includes(c)));
    if ("group" in body) {
      const group = body.group || null;
      if (group && !data.STAFF_GROUPS.includes(group)) return jsonError(res, "Invalid Line of Business.");
      await data.updateUserGroup(userId, group);
    }
  } else {
    await data.setItSpecialties(userId, []);
    await data.updateUserGroup(userId, null); // only IT Department accounts carry a Line of Business
  }
  sendJson(res, 200, { ok: true });
});

route("DELETE", "/api/users/:id", async (req, res, params) => {
  const actor = await requireRole(req, "Super Admin");
  if (await blockIfTouchingFullAdmin(actor, Number(params.id), res)) return;
  try {
    await data.deleteUser(Number(params.id));
  } catch (err) {
    return jsonError(res, "Couldn't delete this account - it may still own tickets or other records.", 400);
  }
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- BSP MODE (Super Admin manages; anyone logged in may read the mode)

// Current system mode - any logged-in user may read it; only a Super Admin
// can change it. "normal": tags are ignored. "bsp": IT staff only receive/
// assist tickets from branches in their own Line of Business.
route("GET", "/api/settings/mode", async (req, res) => {
  const user = await requireLogin(req);
  // can_change comes from the LIVE users row so the UI hides the switch for
  // restricted admins even if their session snapshot is stale.
  sendJson(res, 200, { mode: await data.getSystemMode(), can_change: !(await isModeLocked(user.id)) });
});

route("POST", "/api/settings/mode", async (req, res, params, query, body) => {
  const actor = await requireRole(req, "Super Admin");
  if (await isModeLocked(actor.id)) {
    return jsonError(res, "Your account isn't allowed to change the system mode.", 403);
  }
  const mode = body.mode;
  if (mode !== "normal" && mode !== "bsp") return jsonError(res, "Invalid mode.");
  await data.setSystemMode(mode);
  sendJson(res, 200, { ok: true, mode });
});

// ---------------------------------------------------------------- Site theme (seasonal look)

// Public on purpose: the sign-in screen is themed too, so it has to be
// readable before anyone is logged in. It only reveals a harmless label.
route("GET", "/api/theme", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  sendJson(res, 200, { theme: await data.getSiteTheme() });
});

// Only a Super Admin can switch the theme on/off or pick which one.
route("POST", "/api/theme", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const theme = body && body.theme;
  if (!["none", "halloween", "christmas", "newyear", "valentines"].includes(theme)) return jsonError(res, "Invalid theme.");
  await data.setSiteTheme(theme);
  sendJson(res, 200, { ok: true, theme });
});

route("GET", "/api/settings/groups", async (req, res) => {
  await requireLogin(req);
  sendJson(res, 200, { groups: data.BSP_GROUPS, staff_groups: data.STAFF_GROUPS, corporations: data.CORPORATIONS });
});

route("GET", "/api/branches/groups", async (req, res) => {
  await requireRole(req, "Super Admin");
  sendJson(res, 200, { branches: await data.getBranchGroups(), groups: data.BSP_GROUPS, corporations: data.CORPORATIONS });
});

route("PUT", "/api/branches/manage/*name/group", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const group = body.group || null;
  if (group && !data.BSP_GROUPS.includes(group)) return jsonError(res, "Invalid Line of Business.");
  const corporation = group ? (body.corporation || null) : null;
  if (corporation && !data.CORPORATIONS.includes(corporation)) return jsonError(res, "Invalid corporation.");
  await data.updateBranchGroup(params.name, group, corporation, body.is_global === true);
  sendJson(res, 200, { ok: true });
});

route("PUT", "/api/users/:id/group", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const group = body.group || null;
  if (group && !data.STAFF_GROUPS.includes(group)) return jsonError(res, "Invalid group.");
  const staffIds = new Set((await data.getItDepartmentUsers()).map((s) => s.id));
  if (!staffIds.has(Number(params.id))) return jsonError(res, "Only IT Department accounts can be tagged into a BSP group.");
  await data.updateUserGroup(Number(params.id), group);
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- branches (Super Admin)

route("POST", "/api/branches/manage", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const name = (body.name || "").trim();
  if (!name) return jsonError(res, "Branch name is required.");
  const group = body.group || null;
  if (group && !data.BSP_GROUPS.includes(group)) return jsonError(res, "Invalid Line of Business.");
  const corporation = group ? (body.corporation || null) : null;
  if (corporation && !data.CORPORATIONS.includes(corporation)) return jsonError(res, "Invalid corporation.");
  try {
    await data.addBranch(name, group, corporation, body.is_global === true);
  } catch (err) {
    return jsonError(res, "That branch already exists.");
  }
  sendJson(res, 200, { ok: true });
});

route("PUT", "/api/branches/manage/*name", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const newName = (body.new_name || "").trim();
  if (!newName) return jsonError(res, "New branch name is required.");
  try {
    await data.updateBranch(params.name, newName);
  } catch (err) {
    return jsonError(res, "Couldn't rename branch - the new name may already exist.");
  }
  sendJson(res, 200, { ok: true });
});

route("DELETE", "/api/branches/manage/*name", async (req, res, params) => {
  await requireRole(req, "Super Admin");
  await data.deleteBranch(params.name);
  sendJson(res, 200, { ok: true });
});

// Words that are treated as a header/label rather than an actual branch
// name, so an uploaded sheet with a "Branch" header row (or a stray "Name"
// column) doesn't get imported as a branch itself.
const BRANCH_IMPORT_HEADER_WORDS = new Set(["branch", "branch name", "branches", "name"]);

/** Pull every plausible branch name out of an uploaded .xlsx/.xls/.csv file
 * (Buffer + original filename). Reads every cell of every row/column (not
 * just column A) so it doesn't matter which column the list is in, trims
 * whitespace, drops blanks and obvious header labels, and de-dupes while
 * preserving first-seen order. Throws a friendly Error if the file type
 * isn't recognized or contains no usable names. */
async function parseBranchNamesFromFile(fileBuffer, filename) {
  const ext = (filename || "").split(".").pop().toLowerCase();
  const raw = [];

  if (ext === "xlsx" || ext === "xls") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(fileBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("The spreadsheet has no sheets.");
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = (cell.text || "").trim();
        if (text) raw.push(text);
      });
    });
  } else if (ext === "csv") {
    const text = fileBuffer.toString("utf-8");
    for (const line of text.split(/\r?\n/)) {
      for (const cell of line.split(",")) {
        const trimmed = cell.trim().replace(/^"|"$/g, "");
        if (trimmed) raw.push(trimmed);
      }
    }
  } else {
    throw new Error("Please upload a .xlsx or .csv file.");
  }

  const seen = new Set();
  const names = [];
  for (const value of raw) {
    if (BRANCH_IMPORT_HEADER_WORDS.has(value.toLowerCase())) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    names.push(value);
  }

  if (!names.length) throw new Error("No branch names were found in that file.");
  return names;
}

route("POST", "/api/branches/import", async (req, res, params, query, body, rawParts) => {
  await requireRole(req, "Super Admin");
  const file = rawParts && rawParts.files && rawParts.files.file;
  if (!file) return jsonError(res, "No file uploaded.");
  if (!file.filename) return jsonError(res, "No file selected.");

  let names;
  try {
    names = await parseBranchNamesFromFile(file.data, file.filename);
  } catch (err) {
    return jsonError(res, err.message);
  }

  const { added, skipped } = await data.addBranchesBulk(names);
  sendJson(res, 200, { ok: true, added, skipped, total: names.length });
});

// ---------------------------------------------------------------- departments (Super Admin)
// Mirrors the branches block above exactly, but for Head Office
// departments - lets a Super Admin set up a department before anyone can
// register an account against it.

route("POST", "/api/departments/manage", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const name = (body.name || "").trim();
  if (!name) return jsonError(res, "Department name is required.");
  try {
    await data.addDepartment(name);
  } catch (err) {
    return jsonError(res, "That department already exists.");
  }
  sendJson(res, 200, { ok: true });
});

route("PUT", "/api/departments/manage/*name", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const newName = (body.new_name || "").trim();
  if (!newName) return jsonError(res, "New department name is required.");
  try {
    await data.updateDepartment(params.name, newName);
  } catch (err) {
    return jsonError(res, "Couldn't rename department - the new name may already exist.");
  }
  sendJson(res, 200, { ok: true });
});

route("DELETE", "/api/departments/manage/*name", async (req, res, params) => {
  await requireRole(req, "Super Admin");
  await data.deleteDepartment(params.name);
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- categories (Super Admin)
// Mirrors the branches block above exactly, but for ticket categories -
// lets a Super Admin add/rename/remove the options on the New Ticket
// "Category" dropdown and the IT Staff specialties checkboxes.

route("POST", "/api/categories/manage", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const name = (body.name || "").trim();
  if (!name) return jsonError(res, "Category name is required.");
  try {
    await data.addCategory(name);
  } catch (err) {
    return jsonError(res, "That category already exists.");
  }
  sendJson(res, 200, { ok: true });
});

route("PUT", "/api/categories/manage/*name", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const newName = (body.new_name || "").trim();
  if (!newName) return jsonError(res, "New category name is required.");
  try {
    await data.updateCategory(params.name, newName);
  } catch (err) {
    return jsonError(res, "Couldn't rename category - the new name may already exist.");
  }
  sendJson(res, 200, { ok: true });
});

route("DELETE", "/api/categories/manage/*name", async (req, res, params) => {
  await requireRole(req, "Super Admin");
  await data.deleteCategory(params.name);
  sendJson(res, 200, { ok: true });
});

// Reorder a category one place earlier/later in the Manage Categories
// panel's list - a no-op if it's already first/last. Display order only;
// doesn't touch tickets or specialties.
route("POST", "/api/categories/manage/*name/move", async (req, res, params, query, body) => {
  await requireRole(req, "Super Admin");
  const direction = body.direction;
  if (direction === "up") await data.moveCategoryUp(params.name);
  else if (direction === "down") await data.moveCategoryDown(params.name);
  else return jsonError(res, "Invalid direction.");
  sendJson(res, 200, { ok: true });
});

// ---------------------------------------------------------------- reporting

function resolveRangeFromQuery(query) {
  const mode = query.get("mode") || "monthly";
  const today = new Date();
  if (mode === "single") {
    const day = parseDate(query.get("day"));
    return reporting.resolveDateRange("single", { day });
  }
  if (mode === "range") {
    const start = parseDate(query.get("start"));
    const end = parseDate(query.get("end"));
    return reporting.resolveDateRange("range", { start, end });
  }
  if (mode === "annual") {
    const year = parseInt(query.get("year") || today.getFullYear(), 10);
    return reporting.resolveDateRange("annual", { year });
  }
  const year = parseInt(query.get("year") || today.getFullYear(), 10);
  const month = parseInt(query.get("month") || today.getMonth() + 1, 10);
  return reporting.resolveDateRange("monthly", { year, month });
}

route("GET", "/api/reports/performance", async (req, res, params, query) => {
  // Team-wide performance is Super Admin's original view; IT Department
  // staff can now see it too (read-only) so they can compare against
  // teammates from their own Dashboard, not just their own numbers.
  const user = await requireRole(req, "Super Admin", "IT Department");
  const [start, end] = resolveRangeFromQuery(query);
  const branch = query.get("branch") || null;
  // BSP MODE: an IT viewer's team-wide numbers only count their own Line of
  // Business's branches (null for Super Admin / Normal Mode / untagged).
  const itScope = await data.getItBranchScope(user.role, user.id);
  const report = await reporting.getPerformanceReport(start, end, branch, itScope);
  const summary = reporting.getReportSummary(report);
  const daily = await reporting.getDailyBreakdown(start, end, { branch, scope: itScope });
  // Resolved-per-day alongside created-per-day, same range/branch scope, so
  // the chart can show both series instead of just tickets created.
  const dailyResolved = await reporting.getDailyResolvedBreakdown(start, end, { branch, scope: itScope });
  sendJson(res, 200, { start, end, report, summary, daily, daily_resolved: dailyResolved });
});

route("GET", "/api/reports/staff/:id", async (req, res, params, query) => {
  // A Super Admin may pull any IT staff member's report; an IT Department
  // account may only pull their OWN. What's counted follows the system
  // mode - see reporting.getStaffReportScope (Normal = every ticket they
  // received, BSP = only their group's branches).
  const user = await requireLogin(req);
  const userId = Number(params.id);
  if (!["Super Admin", "IT Department"].includes(user.role) || (user.role !== "Super Admin" && user.id !== userId)) {
    return jsonError(res, "Not allowed.", 403);
  }
  const [start, end] = resolveRangeFromQuery(query);
  const report = await reporting.getScopedStaffReport(userId, start, end);
  if (!report) return jsonError(res, "Staff member not found.", 404);
  sendJson(res, 200, { start, end, ...report });
});

// Per-corporation report: for each corporation (the tag on its branches),
// ticket totals + which IT staff / admin handled them + a branch breakdown.
// Super Admin sees every corporation; IT Department sees the same report,
// limited to their own Line of Business's branches in BSP Mode.
function readCorporationParam(query, res) {
  const corporation = query.get("corporation") || null;
  if (corporation && corporation !== reporting.NO_CORPORATION && !data.CORPORATIONS.includes(corporation)) {
    jsonError(res, "Invalid corporation.");
    return undefined; // signals "response already sent"
  }
  return corporation;
}

route("GET", "/api/reports/corporation", async (req, res, params, query) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  const itScope = await data.getItBranchScope(user.role, user.id);
  const [start, end] = resolveRangeFromQuery(query);
  const corporation = readCorporationParam(query, res);
  if (corporation === undefined) return;
  const report = await reporting.getCorporationReport(start, end, corporation, itScope);
  sendJson(res, 200, { start, end, ...report });
});

route("GET", "/api/reports/export/corporation", async (req, res, params, query) => {
  const user = await requireRole(req, "Super Admin", "IT Department");
  const itScope = await data.getItBranchScope(user.role, user.id);
  const [start, end] = resolveRangeFromQuery(query);
  const corporation = readCorporationParam(query, res);
  if (corporation === undefined) return;
  const report = await reporting.getCorporationReport(start, end, corporation, itScope);
  const wb = reportExport.buildCorporationReportWorkbook(report, `${start} to ${end}`);
  const buf = await wb.xlsx.writeBuffer();
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="corporation_report_${start}_${end}.xlsx"`,
  });
  res.end(Buffer.from(buf));
});

route("GET", "/api/reports/branch/*branch", async (req, res, params, query) => {
  await requireRole(req, "Super Admin");
  const branch = params.branch;
  const [start, end] = resolveRangeFromQuery(query);
  const perf = await reporting.getBranchPerformanceSummary(branch, start, end);
  const daily = await reporting.getDailyBreakdown(start, end, { branch });
  const categories = await reporting.getBranchConcernsReport(start, end, branch);
  sendJson(res, 200, { start, end, perf, daily, categories });
});

route("GET", "/api/reports/export", async (req, res, params, query) => {
  await requireRole(req, "Super Admin");
  const [start, end] = resolveRangeFromQuery(query);
  const branch = query.get("branch") || null;
  const rows = await reporting.getPerformanceReport(start, end, branch);
  const summary = reporting.getReportSummary(rows);
  const branchRows = await reporting.getBranchConcernsReport(start, end, branch);
  const branchSummary = reporting.getBranchSummary(branchRows);
  const periodLabel = `${start} to ${end}`;
  const wb = reportExport.buildReportWorkbook(
    { rows, summary, branch_rows: branchRows, branch_summary: branchSummary },
    periodLabel
  );
  const buf = await wb.xlsx.writeBuffer();
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="report_${start}_${end}.xlsx"`,
  });
  res.end(Buffer.from(buf));
});

route("GET", "/api/reports/export/staff/:id", async (req, res, params, query) => {
  // Same access rule as /api/reports/staff/:id - Super Admin for anyone,
  // IT Department for themselves only.
  const user = await requireLogin(req);
  const userId = Number(params.id);
  if (!["Super Admin", "IT Department"].includes(user.role) || (user.role !== "Super Admin" && user.id !== userId)) {
    return jsonError(res, "Not allowed.", 403);
  }
  const [start, end] = resolveRangeFromQuery(query);
  const report = await reporting.getScopedStaffReport(userId, start, end);
  if (!report) return jsonError(res, "Staff member not found.", 404);
  const periodLabel = `${start} to ${end}`;
  const wb = reportExport.buildStaffReportWorkbook(report, periodLabel);
  const buf = await wb.xlsx.writeBuffer();
  const safeName = String(report.perf.full_name || userId).replace(/[^A-Za-z0-9_-]+/g, "_");
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="staff_report_${safeName}_${start}_${end}.xlsx"`,
  });
  res.end(Buffer.from(buf));
});

route("GET", "/api/reports/export/branch/*branch", async (req, res, params, query) => {
  await requireRole(req, "Super Admin");
  const branch = params.branch;
  const [start, end] = resolveRangeFromQuery(query);
  const perf = await reporting.getBranchPerformanceSummary(branch, start, end);
  const daily = await reporting.getDailyBreakdown(start, end, { branch });
  const categories = await reporting.getBranchConcernsReport(start, end, branch);
  const periodLabel = `${start} to ${end}`;
  const wb = reportExport.buildBranchReportWorkbook(perf, daily, categories, periodLabel);
  const buf = await wb.xlsx.writeBuffer();
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="branch_report_${branch}.xlsx"`,
  });
  res.end(Buffer.from(buf));
});

// ---------------------------------------------------------------- request dispatch

// In the original local/XAMPP-style setup, db.initDb() ran once at process
// startup inside main(). A serverless function has no such startup hook, so
// it's run lazily here instead - cached per warm instance so it only
// actually hits the DB once, not on every request. If it fails (e.g. a
// transient Neon connection blip), the failed promise is discarded rather
// than cached, so the next request gets a fresh attempt instead of every
// request on this warm instance failing forever with a bare "Server error".
let initPromise = null;
function ensureInit() {
  if (!initPromise) {
    initPromise = db.initDb().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function handleRequest(req, res) {
  await ensureInit();
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Route matching uses the still-encoded path; matchRoute() decodes each
  // captured param exactly once. Decoding here as well made branch names
  // containing "%" get decoded twice and throw "URI malformed".
  const rawPathname = url.pathname;
  let pathname;
  try { pathname = decodeURIComponent(rawPathname); }
  catch (e) { return jsonError(res, "Bad request path.", 400); }
  const method = req.method;

  let match;
  try { match = matchRoute(method, rawPathname); }
  catch (e) { return jsonError(res, "Bad request path.", 400); }

  if (!match) {
    // Static files (app.js, styles.css, images, etc.) live under /static on
    // disk but are served at the site root, mirroring Flask's
    // static_url_path="".
    if (method === "GET" && !pathname.startsWith("/api/")) {
      const candidate = path.join(STATIC_DIR, pathname);
      if (candidate.startsWith(STATIC_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return serveFile(res, candidate);
      }
      // SPA-style fallback: unmatched non-API GET routes get index.html.
      return serveIndexHtml(res);
    }
    return jsonError(res, "Not found", 404);
  }

  try {
    const url2 = url.searchParams;
    let body = {};
    let rawParts = null;

    if (["POST", "PUT", "DELETE"].includes(method)) {
      const contentType = req.headers["content-type"] || "";
      if (contentType.startsWith("multipart/form-data")) {
        const boundaryMatch = contentType.match(/boundary=(.+)$/);
        const raw = await readRawBody(req);
        if (boundaryMatch) {
          rawParts = parseMultipart(raw, boundaryMatch[1].replace(/^"|"$/g, ""));
          body = rawParts.fields;
        }
      } else {
        body = await readJsonBody(req);
      }
    }

    await match.handler(req, res, match.params, url2, body, rawParts);
  } catch (err) {
    if (err instanceof HttpError) {
      return jsonError(res, err.message, err.code, err.errCode);
    }
    console.error(`Unhandled error on ${method} ${pathname}:`, err);
    if (pathname.startsWith("/api/")) {
      return jsonError(res, `Server error: ${err.message}`, 500);
    }
    res.writeHead(500);
    res.end("Server error");
  }
}

// ---------------------------------------------------------------- startup

async function main() {
  try {
    await db.initDb();
  } catch (err) {
    console.error(
      `\nCould not initialize the database: ${err.message}\n` +
      "Make sure your Neon connection string in config.js / DATABASE_URL is correct " +
      "and your Neon project is active.\n"
    );
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("Fatal request error:", err);
      try {
        res.writeHead(500);
        res.end("Server error");
      } catch (e) { /* response already sent */ }
    });
  });

  server.listen(PORT, HOST, () => {
    console.log("\nIT Ticket System is running.");
    console.log(`On this PC:      http://127.0.0.1:${PORT}`);
    const lanIps = require("os").networkInterfaces();
    for (const ifaceList of Object.values(lanIps)) {
      for (const iface of ifaceList) {
        if (iface.family === "IPv4" && !iface.internal) {
          console.log(`From other PCs:  http://${iface.address}:${PORT}`);
        }
      }
    }
    console.log("");
  });
}

if (require.main === module) {
  main();
}

module.exports = { handleRequest };