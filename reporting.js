/**
 * reporting.js
 * Reporting & analytics for the IT Ticket System - powers the Super Admin's
 * "Reporting" tab. Aggregates ticket data per IT staff member (tickets
 * assigned, resolved, still open, average resolution time, etc.) over a
 * single day, a whole month, or an arbitrary date range, plus overall
 * summary totals for that period.
 *
 * Kept as its own module, separate from data.js, since it's a distinct
 * concern (read-only analytics/aggregation) rather than everyday CRUD - but
 * it talks to the database the exact same way, via db.getConnection().
 */

const { getConnection } = require("./db");
const data = require("./data");

// ---------- Date range helpers ----------
// Dates are handled as plain "YYYY-MM-DD" strings throughout (db.js's pg
// type parser for the DATE oid keeps them as strings), mirroring Python's
// date objects.

function toDate(s) {
  return new Date(s + "T00:00:00Z");
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = toDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return fmt(d);
}

/** First and last calendar day of the given month, as "YYYY-MM-DD" strings. */
function monthBounds(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-based here
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return [start, end];
}

/** First and last calendar day of the given year, as "YYYY-MM-DD" strings. */
function yearBounds(year) {
  return [`${year}-01-01`, `${year}-12-31`];
}

/** Turn a UI selection into a concrete [startDate, endDate] pair (both
 * inclusive, "YYYY-MM-DD" strings):
 *   mode='single'  -> opts.day
 *   mode='monthly' -> opts.year, opts.month
 *   mode='annual'  -> opts.year
 *   mode='range'   -> opts.start, opts.end
 */
function resolveDateRange(mode, opts = {}) {
  if (mode === "single") {
    return [opts.day, opts.day];
  }
  if (mode === "monthly") {
    return monthBounds(opts.year, opts.month);
  }
  if (mode === "annual") {
    return yearBounds(opts.year);
  }
  if (mode === "range") {
    let { start, end } = opts;
    if (start > end) [start, end] = [end, start];
    return [start, end];
  }
  if (mode === "weekly") {
    // Trailing 7-day window ending today (inclusive), rather than a fixed
    // Mon-Sun calendar week - keeps "weekly" meaningful no matter what day
    // someone opens the dashboard.
    const today = fmt(new Date());
    return [addDays(today, -6), today];
  }
  throw new Error(`Unknown report mode: ${mode}`);
}

// ---------- Per-staff performance ----------

/** Per-IT-staff performance for tickets ASSIGNED to them and CREATED within
 * [startDate, endDate] (inclusive, by calendar day). Every IT Department /
 * Super Admin account is included, even ones with zero tickets in the
 * period (an all-zero row). `branch`, if given, scopes the counted tickets
 * to that one branch only. */
async function getPerformanceReport(startDate, endDate, branch = null, scope = null) {
  const pool = getConnection();
  // is_province tickets (flagged as needing an actual site visit - see
  // db.js's tickets table) are excluded entirely from every performance
  // query below, not just averaged differently, so travel time to a
  // branch never counts for or against an IT staff member's numbers.
  let joinClause = "(t.assigned_to = u.id OR EXISTS (SELECT 1 FROM ticket_collaborators tc WHERE tc.ticket_id = t.id AND tc.user_id = u.id)) " +
    "AND t.created_at::date BETWEEN ? AND ? AND t.is_province = FALSE";
  const params = [startDate, endDate];
  if (branch) {
    joinClause += " AND t.branch = ?";
    params.push(branch);
  }
  // BSP MODE: an IT viewer's team-wide numbers only count tickets from
  // branches under their own Line of Business (see data.getItBranchScope).
  if (scope) {
    joinClause += scope.clause("t.branch");
    params.push(...scope.params);
  }
  const [rows] = await pool.query(
    `SELECT
        u.id AS user_id,
        u.full_name,
        u.role,
        COUNT(t.id) AS assigned,
        SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
        AVG(CASE WHEN t.status = 'Resolved' AND t.resolved_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60 END) AS avg_resolution_minutes
    FROM users u
    LEFT JOIN tickets t
           ON ${joinClause}
    WHERE u.role IN ('IT Department', 'Super Admin')
    GROUP BY u.id, u.full_name, u.role
    ORDER BY resolved DESC, assigned DESC, u.full_name`,
    params
  );

  return rows.map((r) => {
    const assigned = r.assigned || 0;
    const resolved = r.resolved || 0;
    const avgMin = r.avg_resolution_minutes;
    return {
      user_id: r.user_id,
      full_name: r.full_name,
      role: r.role,
      assigned,
      resolved,
      open: r.open_count || 0,
      in_progress: r.in_progress || 0,
      resolution_rate: assigned ? Math.round((resolved / assigned) * 1000) / 10 : 0.0,
      avg_resolution_hours: avgMin !== null ? Math.round((avgMin / 60) * 10) / 10 : null,
    };
  });
}

/** Same aggregation as getPerformanceReport(), scoped to a single IT staff
 * member - powers the self-service "My Performance" report. Returns null if
 * userId doesn't match an IT Department / Super Admin account. */
async function getStaffPerformanceReport(userId, startDate, endDate) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT
        u.id AS user_id,
        u.full_name,
        u.role,
        COUNT(t.id) AS assigned,
        SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
        AVG(CASE WHEN t.status = 'Resolved' AND t.resolved_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60 END) AS avg_resolution_minutes
    FROM users u
    LEFT JOIN tickets t
           ON (t.assigned_to = u.id OR EXISTS (SELECT 1 FROM ticket_collaborators tc WHERE tc.ticket_id = t.id AND tc.user_id = u.id))
          AND t.created_at::date BETWEEN ? AND ?
          AND t.is_province = FALSE
    WHERE u.id = ? AND u.role IN ('IT Department', 'Super Admin')
    GROUP BY u.id, u.full_name, u.role`,
    [startDate, endDate, userId]
  );
  const r = rows[0];
  if (!r) return null;
  const assigned = r.assigned || 0;
  const resolved = r.resolved || 0;
  const avgMin = r.avg_resolution_minutes;
  return {
    user_id: r.user_id,
    full_name: r.full_name,
    role: r.role,
    assigned,
    resolved,
    open: r.open_count || 0,
    in_progress: r.in_progress || 0,
    resolution_rate: assigned ? Math.round((resolved / assigned) * 1000) / 10 : 0.0,
    avg_resolution_hours: avgMin !== null ? Math.round((avgMin / 60) * 10) / 10 : null,
  };
}

/** Same aggregation as getStaffPerformanceReport(), scoped to a single
 * branch instead of a single staff member - powers the Super Admin's
 * "Branch History" report. */
async function getBranchPerformanceSummary(branch, startDate, endDate) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
        AVG(CASE WHEN t.status = 'Resolved' AND t.resolved_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60 END) AS avg_resolution_minutes
    FROM tickets t
    WHERE t.branch = ?
      AND t.created_at::date BETWEEN ? AND ?
      AND t.is_province = FALSE`,
    [branch, startDate, endDate]
  );
  const r = rows[0];
  const total = r.total || 0;
  const resolved = r.resolved || 0;
  const avgMin = r.avg_resolution_minutes;
  return {
    branch,
    total,
    resolved,
    open: r.open_count || 0,
    in_progress: r.in_progress || 0,
    resolution_rate: total ? Math.round((resolved / total) * 1000) / 10 : 0.0,
    avg_resolution_hours: avgMin !== null ? Math.round((avgMin / 60) * 10) / 10 : null,
  };
}

// ---------- Per-staff report (mode-aware) ----------

/** Work out which tickets count toward a staff member's personal report.
 *  - Normal Mode (or any non-IT / untagged account): EVERY ticket they
 *    received (assigned to them, or they collaborate on) - no branch filter.
 *  - BSP Mode, IT Department account tagged into a group: only tickets from
 *    the branches that group covers (same rule as data.getTickets: a Line
 *    covers its own branches that are NOT Global-partnered; Global covers
 *    every Global-partnered branch).
 * Returns null if the user doesn't exist. `sql`/`params` are a ready-made
 * " AND t.branch IN (...)" fragment (empty when unrestricted). */
async function getStaffReportScope(userId) {
  const pool = getConnection();
  const [urows] = await pool.query("SELECT role, group_name FROM users WHERE id = ?", [userId]);
  const u = urows[0];
  if (!u) return null;
  const mode = await data.getSystemMode();
  const GLOBAL = data.GLOBAL_GROUP || "Global";
  const scope = {
    mode,
    group: u.group_name || null,
    restricted: false,
    label: mode === "bsp"
      ? "BSP Mode — not tagged to a Line of Business, so all tickets received"
      : "Normal Mode — all tickets received",
    branches: null,
    sql: "",
    params: [],
  };
  if (mode === "bsp" && u.role === "IT Department" && u.group_name) {
    scope.restricted = true;
    let branchSql, branchParams;
    if (u.group_name === GLOBAL) {
      branchSql = "SELECT name FROM branches WHERE is_global = TRUE";
      branchParams = [];
      scope.label = "BSP Mode — Global-partnered branches only";
    } else {
      branchSql = "SELECT name FROM branches WHERE group_name = ? AND is_global = FALSE";
      branchParams = [u.group_name];
      scope.label = `BSP Mode — ${u.group_name} branches only`;
    }
    const [brows] = await pool.query(branchSql + " ORDER BY name", branchParams);
    scope.branches = brows.map((r) => r.name);
    scope.sql = ` AND t.branch IN (${branchSql})`;
    scope.params = branchParams;
  }
  return scope;
}

/** Full personal report for ONE IT staff member over [startDate, endDate]:
 * summary numbers, branch breakdown, per-day received/resolved, and the
 * ticket list itself - all limited by getStaffReportScope (Normal Mode =
 * everything they received; BSP Mode = only their group's branches).
 * Province/site-visit tickets stay excluded, same as every other
 * performance query. Returns null if userId isn't an IT Department /
 * Super Admin account. */
async function getScopedStaffReport(userId, startDate, endDate) {
  const pool = getConnection();
  const [urows] = await pool.query(
    "SELECT id, full_name, role FROM users WHERE id = ? AND role IN ('IT Department', 'Super Admin')",
    [userId]
  );
  const user = urows[0];
  if (!user) return null;
  const scope = await getStaffReportScope(userId);

  const own = "(t.assigned_to = ? OR EXISTS (SELECT 1 FROM ticket_collaborators tc WHERE tc.ticket_id = t.id AND tc.user_id = ?))";
  const where = `${own} AND t.created_at::date BETWEEN ? AND ? AND t.is_province = FALSE${scope.sql}`;
  const whereParams = [userId, userId, startDate, endDate, ...scope.params];

  const [sumRows] = await pool.query(
    `SELECT
        COUNT(*) AS assigned,
        SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
        AVG(CASE WHEN t.status = 'Resolved' AND t.resolved_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60 END) AS avg_resolution_minutes
     FROM tickets t WHERE ${where}`,
    whereParams
  );
  const r = sumRows[0] || {};
  const assigned = Number(r.assigned) || 0;
  const resolved = Number(r.resolved) || 0;
  const avgMin = r.avg_resolution_minutes;
  const perf = {
    user_id: user.id,
    full_name: user.full_name,
    role: user.role,
    assigned,
    resolved,
    open: Number(r.open_count) || 0,
    in_progress: Number(r.in_progress) || 0,
    resolution_rate: assigned ? Math.round((resolved / assigned) * 1000) / 10 : 0.0,
    avg_resolution_hours: avgMin !== null && avgMin !== undefined ? Math.round((Number(avgMin) / 60) * 10) / 10 : null,
  };

  const [branchRows] = await pool.query(
    `SELECT t.branch, COUNT(*) AS total,
        SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress
     FROM tickets t WHERE ${where}
     GROUP BY t.branch ORDER BY total DESC, t.branch`,
    whereParams
  );
  const branches = branchRows.map((b) => ({
    branch: b.branch,
    total: Number(b.total) || 0,
    resolved: Number(b.resolved) || 0,
    open: Number(b.open_count) || 0,
    in_progress: Number(b.in_progress) || 0,
  }));

  // Received per day (by created date) and resolved per day (by resolved
  // date), both under the same ownership + branch scope.
  const [recvRows] = await pool.query(
    `SELECT t.created_at::date AS day, COUNT(*) AS count FROM tickets t
     WHERE ${where} GROUP BY t.created_at::date`,
    whereParams
  );
  const [resRows] = await pool.query(
    `SELECT t.resolved_at::date AS day, COUNT(*) AS count FROM tickets t
     WHERE ${own} AND t.status = 'Resolved' AND t.resolved_at IS NOT NULL
       AND t.resolved_at::date BETWEEN ? AND ? AND t.is_province = FALSE${scope.sql}
     GROUP BY t.resolved_at::date`,
    whereParams
  );
  const recv = {}; for (const x of recvRows) recv[x.day] = Number(x.count) || 0;
  const resv = {}; for (const x of resRows) resv[x.day] = Number(x.count) || 0;
  const daily = [];
  let day = startDate;
  while (day <= endDate) {
    daily.push({ day, assigned: recv[day] || 0, resolved: resv[day] || 0 });
    day = addDays(day, 1);
  }

  const [ticketRows] = await pool.query(
    `SELECT t.id, t.title, t.category, t.priority, t.status, t.branch, t.created_at, t.resolved_at
     FROM tickets t WHERE ${where}
     ORDER BY t.created_at DESC, t.id DESC LIMIT 5000`,
    whereParams
  );
  const tickets = ticketRows.map((t) => ({
    id: t.id,
    title: t.title,
    category: t.category,
    priority: t.priority,
    status: t.status,
    branch: t.branch,
    created_at: t.created_at,
    resolved_at: t.resolved_at,
  }));

  return {
    scope: {
      mode: scope.mode,
      group: scope.group,
      restricted: scope.restricted,
      label: scope.label,
      branches: scope.branches,
    },
    perf, daily, branches, tickets,
  };
}

/** Which branches a single IT staff member has actually been assisting -
 * one row per branch they had tickets ASSIGNED to them from, CREATED within
 * [startDate, endDate] (inclusive), busiest branch first. There's no fixed
 * "you cover this branch" assignment in this system, so this is derived
 * straight from their ticket history for the period. */
async function getStaffBranchBreakdown(userId, startDate, endDate) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT
        t.branch,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress
    FROM tickets t
    WHERE (t.assigned_to = ? OR EXISTS (SELECT 1 FROM ticket_collaborators tc WHERE tc.ticket_id = t.id AND tc.user_id = ?))
      AND t.created_at::date BETWEEN ? AND ?
      AND t.is_province = FALSE
    GROUP BY t.branch
    ORDER BY total DESC, t.branch`,
    [userId, userId, startDate, endDate]
  );
  return rows.map((r) => ({
    branch: r.branch,
    total: r.total,
    resolved: r.resolved || 0,
    open: r.open_count || 0,
    in_progress: r.in_progress || 0,
  }));
}

/** Roll a getPerformanceReport() list up into overall totals for the period
 * - feeds the small stat cards above the chart/table. */
function getReportSummary(rows) {
  const totalAssigned = rows.reduce((s, r) => s + r.assigned, 0);
  const totalResolved = rows.reduce((s, r) => s + r.resolved, 0);
  const totalOpen = rows.reduce((s, r) => s + r.open, 0);
  const totalProgress = rows.reduce((s, r) => s + r.in_progress, 0);
  const resolvedHours = rows
    .filter((r) => r.avg_resolution_hours !== null && r.resolved > 0)
    .map((r) => r.avg_resolution_hours);
  return {
    total_assigned: totalAssigned,
    total_resolved: totalResolved,
    total_open: totalOpen,
    total_in_progress: totalProgress,
    overall_resolution_rate: totalAssigned ? Math.round((totalResolved / totalAssigned) * 1000) / 10 : 0.0,
    avg_resolution_hours: resolvedHours.length
      ? Math.round((resolvedHours.reduce((a, b) => a + b, 0) / resolvedHours.length) * 10) / 10
      : null,
  };
}

// ---------- Trend data (optional, for a daily breakdown / line chart) ----------

/** Tickets CREATED per calendar day in the range (optionally scoped to one
 * staff member's assignments and/or one branch). Returns a list of
 * {day, count} in date order, including days with zero tickets. */
async function getDailyBreakdown(startDate, endDate, { userId = null, branch = null, scope = null } = {}) {
  const pool = getConnection();
  let query = `
    SELECT t.created_at::date AS day, COUNT(*) AS count
    FROM tickets t
    WHERE t.created_at::date BETWEEN ? AND ?
      AND t.is_province = FALSE
  `;
  const params = [startDate, endDate];
  if (userId !== null && userId !== undefined) {
    query += " AND (t.assigned_to = ? OR EXISTS (SELECT 1 FROM ticket_collaborators tc WHERE tc.ticket_id = t.id AND tc.user_id = ?))";
    params.push(userId, userId);
  }
  if (branch !== null && branch !== undefined) {
    query += " AND t.branch = ?";
    params.push(branch);
  }
  if (scope) { query += scope.clause("t.branch"); params.push(...scope.params); }
  query += " GROUP BY t.created_at::date";
  const [rows] = await pool.query(query, params);
  const counts = {};
  for (const r of rows) counts[r.day] = r.count;

  const result = [];
  let day = startDate;
  while (day <= endDate) {
    result.push({ day, count: counts[day] || 0 });
    day = addDays(day, 1);
  }
  return result;
}

/** Tickets RESOLVED per calendar day (by resolved_at date) in the range -
 * the resolved-side counterpart to getDailyBreakdown()'s created-per-day
 * counts. Includes zero-count days so the chart doesn't have gaps. */
async function getDailyResolvedBreakdown(startDate, endDate, { userId = null, branch = null, scope = null } = {}) {
  const pool = getConnection();
  let query = `
    SELECT t.resolved_at::date AS day, COUNT(*) AS count
    FROM tickets t
    WHERE t.status = 'Resolved' AND t.resolved_at IS NOT NULL
      AND t.resolved_at::date BETWEEN ? AND ?
      AND t.is_province = FALSE
  `;
  const params = [startDate, endDate];
  if (userId !== null && userId !== undefined) {
    query += " AND (t.assigned_to = ? OR EXISTS (SELECT 1 FROM ticket_collaborators tc WHERE tc.ticket_id = t.id AND tc.user_id = ?))";
    params.push(userId, userId);
  }
  if (branch !== null && branch !== undefined) {
    query += " AND t.branch = ?";
    params.push(branch);
  }
  if (scope) { query += scope.clause("t.branch"); params.push(...scope.params); }
  query += " GROUP BY t.resolved_at::date";
  const [rows] = await pool.query(query, params);
  const counts = {};
  for (const r of rows) counts[r.day] = r.count;

  const result = [];
  let day = startDate;
  while (day <= endDate) {
    result.push({ day, count: counts[day] || 0 });
    day = addDays(day, 1);
  }
  return result;
}

// ---------- Branch concerns ----------

/** Per-branch ticket volume broken down by category for tickets CREATED
 * within [startDate, endDate] (inclusive). One row per branch+category
 * combination that actually had tickets in the period. `branch`, if given,
 * scopes this to that single branch's categories only. */
async function getBranchConcernsReport(startDate, endDate, branch = null) {
  const pool = getConnection();
  let query = `
    SELECT
        t.branch,
        t.category,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress
    FROM tickets t
    WHERE t.created_at::date BETWEEN ? AND ?
  `;
  const params = [startDate, endDate];
  if (branch) {
    query += " AND t.branch = ?";
    params.push(branch);
  }
  query += " GROUP BY t.branch, t.category ORDER BY t.branch, total DESC, t.category";
  const [rows] = await pool.query(query, params);

  return rows.map((r) => ({
    branch: r.branch,
    category: r.category,
    total: r.total,
    resolved: r.resolved || 0,
    open: r.open_count || 0,
    in_progress: r.in_progress || 0,
  }));
}

/** Roll getBranchConcernsReport() up into one row per branch - total
 * tickets plus its single most common category (the branch's "top
 * concern") - sorted busiest branch first. */
function getBranchSummary(branchRows) {
  const byBranch = {};
  for (const r of branchRows) {
    if (!byBranch[r.branch]) {
      byBranch[r.branch] = {
        branch: r.branch,
        total: 0,
        resolved: 0,
        open: 0,
        in_progress: 0,
        top_category: null,
        top_category_count: 0,
      };
    }
    const b = byBranch[r.branch];
    b.total += r.total;
    b.resolved += r.resolved;
    b.open += r.open;
    b.in_progress += r.in_progress;
    if (r.total > b.top_category_count) {
      b.top_category = r.category;
      b.top_category_count = r.total;
    }
  }
  return Object.values(byBranch).sort((a, b) => b.total - a.total);
}

// ---------- Per-corporation report ----------

const NO_CORPORATION = "(No corporation)";

function _pct(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : 0.0;
}
function _hrs(avgMinutes) {
  return avgMinutes !== null && avgMinutes !== undefined
    ? Math.round((Number(avgMinutes) / 60) * 10) / 10
    : null;
}

/** Ticket activity per CORPORATION (the tag on each branch - see
 * data.CORPORATIONS), for tickets CREATED within [startDate, endDate]
 * (inclusive). For every corporation it returns:
 *   - overall ticket totals (each ticket counted once),
 *   - which IT Department / Super Admin staff handled its tickets (assigned
 *     to them or collaborated on) with the same per-staff numbers used by
 *     the other performance reports,
 *   - a per-branch breakdown of the branches under it.
 * Corporations with no tickets in the period still appear as an all-zero
 * row. Branches with no corporation tag are grouped under "(No corporation)"
 * (only shown when they actually have tickets). Province / site-visit
 * tickets are excluded, same as every other performance query.
 * `corporation`, if given, limits the report to that one corporation.
 * `scope` (data.getItBranchScope, BSP Mode IT viewers) limits everything to
 * the viewer's own Line of Business branches.
 *
 * Note: because a ticket can have collaborators, the staff rows inside a
 * corporation can add up to MORE than that corporation's ticket total. */
async function getCorporationReport(startDate, endDate, corporation = null, scope = null) {
  const pool = getConnection();
  const corpExpr = `COALESCE(b.corporation, '${NO_CORPORATION}')`;

  let filter = "";
  const filterParams = [];
  if (corporation) {
    if (corporation === NO_CORPORATION) {
      filter = " AND b.corporation IS NULL";
    } else {
      filter = " AND b.corporation = ?";
      filterParams.push(corporation);
    }
  }
  let baseWhere = `t.created_at::date BETWEEN ? AND ? AND t.is_province = FALSE${filter}`;
  const baseParams = [startDate, endDate, ...filterParams];
  if (scope) { baseWhere += scope.clause("t.branch"); baseParams.push(...scope.params); }

  const STATUS_COLS = `
        COUNT(*) AS total,
        SUM(CASE WHEN t.status = 'Resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
        AVG(CASE WHEN t.status = 'Resolved' AND t.resolved_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60 END) AS avg_resolution_minutes`;

  // 1) Corporation totals (each ticket once)
  const [totalRows] = await pool.query(
    `SELECT ${corpExpr} AS corporation, ${STATUS_COLS}
     FROM tickets t LEFT JOIN branches b ON b.name = t.branch
     WHERE ${baseWhere}
     GROUP BY ${corpExpr}`,
    baseParams
  );

  // 2) IT staff / admin per corporation
  const [staffRows] = await pool.query(
    `SELECT ${corpExpr} AS corporation, u.id AS user_id, u.full_name, u.role, ${STATUS_COLS}
     FROM tickets t
     LEFT JOIN branches b ON b.name = t.branch
     JOIN users u
       ON u.role IN ('IT Department', 'Super Admin')
      AND (t.assigned_to = u.id OR EXISTS (
            SELECT 1 FROM ticket_collaborators tc WHERE tc.ticket_id = t.id AND tc.user_id = u.id))
     WHERE ${baseWhere}
     GROUP BY ${corpExpr}, u.id, u.full_name, u.role`,
    baseParams
  );

  // 3) Branch breakdown per corporation
  const [branchRows] = await pool.query(
    `SELECT ${corpExpr} AS corporation, t.branch, ${STATUS_COLS}
     FROM tickets t LEFT JOIN branches b ON b.name = t.branch
     WHERE ${baseWhere}
     GROUP BY ${corpExpr}, t.branch`,
    baseParams
  );

  // 4) How many branches each corporation has (whether or not they had tickets)
  const [countRows] = await pool.query(
    `SELECT COALESCE(corporation, '${NO_CORPORATION}') AS corporation, COUNT(*) AS branch_count
     FROM branches WHERE TRUE${scope ? scope.clause("name") : ""}
     GROUP BY COALESCE(corporation, '${NO_CORPORATION}')`,
    scope ? [...scope.params] : []
  );
  const branchCounts = {};
  for (const r of countRows) branchCounts[r.corporation] = Number(r.branch_count) || 0;

  const totalsBy0 = {}; for (const r of totalRows) totalsBy0[r.corporation] = true;
  // Which corporations to list: every known one (so zero-ticket corporations
  // show up), plus anything found in the data, "(No corporation)" last.
  let names = new Set([...(data.CORPORATIONS || []), ...Object.keys(branchCounts), ...totalRows.map((r) => r.corporation)]);
  names.delete(NO_CORPORATION);
  // A scoped (BSP) viewer only sees corporations that have branches in scope
  // or tickets in the period, not every corporation as a zero row.
  if (scope) names = new Set([...names].filter((n) => branchCounts[n] || totalsBy0[n]));
  names = [...names].sort((a, b) => a.localeCompare(b));
  if (totalRows.some((r) => r.corporation === NO_CORPORATION)) names.push(NO_CORPORATION);
  if (corporation) names = names.filter((n) => n === corporation);

  const totalsBy = {}; for (const r of totalRows) totalsBy[r.corporation] = r;
  const staffBy = {}; for (const r of staffRows) (staffBy[r.corporation] = staffBy[r.corporation] || []).push(r);
  const branchBy = {}; for (const r of branchRows) (branchBy[r.corporation] = branchBy[r.corporation] || []).push(r);

  const corporations = names.map((name) => {
    const t = totalsBy[name] || {};
    const total = Number(t.total) || 0;
    const resolved = Number(t.resolved) || 0;

    const staff = (staffBy[name] || []).map((s) => {
      const assigned = Number(s.total) || 0;
      const res = Number(s.resolved) || 0;
      return {
        user_id: s.user_id,
        full_name: s.full_name,
        role: s.role,
        assigned,
        resolved: res,
        open: Number(s.open_count) || 0,
        in_progress: Number(s.in_progress) || 0,
        resolution_rate: _pct(res, assigned),
        avg_resolution_hours: _hrs(s.avg_resolution_minutes),
      };
    }).sort((a, b) => b.resolved - a.resolved || b.assigned - a.assigned || a.full_name.localeCompare(b.full_name));

    const branches = (branchBy[name] || []).map((b) => {
      const bt = Number(b.total) || 0;
      const br = Number(b.resolved) || 0;
      return {
        branch: b.branch,
        total: bt,
        resolved: br,
        open: Number(b.open_count) || 0,
        in_progress: Number(b.in_progress) || 0,
        resolution_rate: _pct(br, bt),
        avg_resolution_hours: _hrs(b.avg_resolution_minutes),
      };
    }).sort((a, b) => b.total - a.total || a.branch.localeCompare(b.branch));

    return {
      corporation: name,
      branch_count: branchCounts[name] || 0,
      total,
      resolved,
      open: Number(t.open_count) || 0,
      in_progress: Number(t.in_progress) || 0,
      resolution_rate: _pct(resolved, total),
      avg_resolution_hours: _hrs(t.avg_resolution_minutes),
      staff,
      branches,
    };
  });

  const sum = (k) => corporations.reduce((s, c) => s + c[k], 0);
  const totalTickets = sum("total");
  const totalResolved = sum("resolved");
  const summary = {
    corporations_total: corporations.filter((c) => c.corporation !== NO_CORPORATION).length,
    corporations_with_tickets: corporations.filter((c) => c.total > 0).length,
    total_tickets: totalTickets,
    total_resolved: totalResolved,
    total_open: sum("open"),
    total_in_progress: sum("in_progress"),
    overall_resolution_rate: _pct(totalResolved, totalTickets),
  };

  return { corporations, summary };
}

// ---------- Response records (Super Admin "Response Records" tab) ----------

/** One row per ticket created in [startDate, endDate]: how long it took IT to
 * first act on it (tickets.first_response_at - created_at, stamped by
 * data.markFirstResponse), who did, and how long it took to resolve. Tickets
 * nobody has touched yet come back with response_minutes = null and
 * waiting_minutes = how long they've been sitting untouched. Optional filters:
 * branch, staffId (the assignee OR the first responder). Void-approved
 * tickets are left out. */
async function getResponseRecords(startDate, endDate, { branch = null, staffId = null } = {}) {
  const pool = getConnection();
  let where = "t.created_at::date BETWEEN ? AND ? AND t.void_status <> 'Voided'";
  const params = [startDate, endDate];
  if (branch) { where += " AND t.branch = ?"; params.push(branch); }
  if (staffId) {
    where += " AND (t.assigned_to = ? OR t.first_response_by = ?)";
    params.push(staffId, staffId);
  }
  const [rows] = await pool.query(
    `SELECT t.id, t.title, t.branch, t.priority, t.status, t.is_province,
            t.created_at, t.first_response_at, t.resolved_at,
            t.assigned_to, a.full_name AS assignee_name,
            t.first_response_by, r.full_name AS responder_name,
            CASE WHEN t.first_response_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)) / 60 END AS response_minutes,
            CASE WHEN t.first_response_at IS NULL
                 THEN EXTRACT(EPOCH FROM (NOW() - t.created_at)) / 60 END AS waiting_minutes,
            CASE WHEN t.resolved_at IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60 END AS resolution_minutes
       FROM tickets t
       LEFT JOIN users a ON a.id = t.assigned_to
       LEFT JOIN users r ON r.id = t.first_response_by
      WHERE ${where}
      ORDER BY t.created_at DESC, t.id DESC`,
    params
  );
  const num = (v) => (v === null || v === undefined ? null : Math.max(0, Number(v)));
  const records = rows.map((t) => ({
    id: t.id,
    title: t.title,
    branch: t.branch,
    priority: t.priority,
    status: t.status,
    is_province: !!t.is_province,
    created_at: t.created_at,
    first_response_at: t.first_response_at,
    resolved_at: t.resolved_at,
    assignee_id: t.assigned_to,
    assignee_name: t.assignee_name,
    responder_id: t.first_response_by,
    responder_name: t.responder_name,
    response_minutes: num(t.response_minutes),
    waiting_minutes: num(t.waiting_minutes),
    resolution_minutes: num(t.resolution_minutes),
  }));

  // Summary + per-responder averages (computed here so the UI stays dumb).
  const responded = records.filter((x) => x.response_minutes !== null);
  const sorted = responded.map((x) => x.response_minutes).sort((p, q) => p - q);
  const avg = sorted.length ? sorted.reduce((p, q) => p + q, 0) / sorted.length : null;
  const median = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : null;
  const byStaff = new Map();
  for (const x of responded) {
    if (!x.responder_id) continue;
    const s = byStaff.get(x.responder_id) || { user_id: x.responder_id, full_name: x.responder_name, count: 0, total: 0, fastest: Infinity, slowest: 0 };
    s.count++; s.total += x.response_minutes;
    s.fastest = Math.min(s.fastest, x.response_minutes);
    s.slowest = Math.max(s.slowest, x.response_minutes);
    byStaff.set(x.responder_id, s);
  }
  const staff = [...byStaff.values()]
    .map((s) => ({ user_id: s.user_id, full_name: s.full_name, count: s.count, avg_minutes: s.total / s.count, fastest_minutes: s.fastest, slowest_minutes: s.slowest }))
    .sort((p, q) => p.avg_minutes - q.avg_minutes);

  return {
    records,
    staff,
    summary: {
      total: records.length,
      responded: responded.length,
      waiting: records.length - responded.length,
      avg_response_minutes: avg,
      median_response_minutes: median,
      slowest_response_minutes: sorted.length ? sorted[sorted.length - 1] : null,
    },
  };
}

module.exports = {
  NO_CORPORATION,
  getCorporationReport,
  monthBounds,
  yearBounds,
  resolveDateRange,
  getPerformanceReport,
  getResponseRecords,
  getStaffPerformanceReport,
  getStaffReportScope,
  getScopedStaffReport,
  getBranchPerformanceSummary,
  getStaffBranchBreakdown,
  getReportSummary,
  getDailyBreakdown,
  getDailyResolvedBreakdown,
  getBranchConcernsReport,
  getBranchSummary,
};