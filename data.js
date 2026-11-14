/**
 * data.js
 * All data-access functions (auth, tickets, comments, users) used by the API.
 * Talks to the Neon (Postgres) database via db.getConnection() (a pool).
 */

const { getConnection } = require("./db");

// ---------- BSP MODE (Super Admin managed) ----------
// A Super Admin can flip the whole system between two setups:
//  - "normal" (the original behavior): every IT Department staffer is a
//    candidate for every ticket, regardless of branch.
//  - "bsp": branches and IT staff are each tagged into one of the 4 fixed
//    groups below, and staff only auto-assign/assist tickets from branches
//    in their OWN group (see _pickBalancedItStaff and getTickets).
// The mode itself, plus each branch's/staffer's group tag, live in the DB
// (app_settings / branches.group_name / users.group_name) rather than in
// memory, so they survive across serverless invocations and take effect
// for every request immediately - no restart, no re-login required.
const BSP_GROUPS = ["Line 1", "Line 2", "Line 3"]; // shown in the UI as "Line of Business"
// What an IT staffer can be tagged with: one of the Lines, or "Global" (they
// then handle every branch flagged as partnered with Global - see
// getBranchStaffGroup below).
const GLOBAL_GROUP = "Global";
const STAFF_GROUPS = [...BSP_GROUPS, GLOBAL_GROUP];

// Corporation tag - picked after a branch has a Line of Business.
const CORPORATIONS = [
  "ALLEXITE JEWELRY PAWNSHOP INC.",
  "ASIAPHILSTAR PAWNSHOP INC.",
  "ATLANTIC STARGEM PAWNSHOP INC.",
  "GALLIUM GRANITE PAWNSHOP INC.",
  "GOLDBARS PAWNSHOP INC.",
  "GOLDSTAR ATLANTIC PAWNSHOP INC.",
  "GOOD QUALITY ASSURANCE PAWNSHOP INC.",
  "GREEN AMBER JEWELRY AND PAWNSHOP INC.",
  "HOMENEEDS PAWNSHOP INC.",
  "INTER WORLD GEM PAWNSHOP INC.",
  "KING-ASIA GROUP PAWNSHOP INC.",
  "KRISTAL CLEAR DIAMOND & GOLD PAWNSHOP INC.",
  "KRYPTON KNIGHT PAWNSHOP INC.",
  "MAJOREVIM PAWNSHOP INC.",
  "MAXI-WEALTH PAWNSHOP INC.",
  "MEGAWORLD DOMESTIC PAWNSHOP INC.",
  "METROGOLD STAR PAWNSHOP INC.",
  "MONEYMAX PAWNSHOP INC.",
  "MULTIGAINED PAWNSHOP INC.",
  "NORTHERN SUNSTAR PAWNSHOP INC.",
  "NORTH-WESTERN PACIFIC PAWNSHOP INC.",
  "PACIFIC METROSTAR PAWNSHOP INC.",
  "PRIMARY MAX PAWNSHOP INC.",
  "PRINCESS CUT JEWELRY AND PAWNSHOP INC.",
  "PUREGOLD KARAT PAWNSHOP INC.",
  "SAFELOCK PAWNSHOP INC.",
  "SAINT BARBARA PRIME PAWNSHOP INC.",
  "SAN RAMON PLATINUM PAWNSHOP INC.",
  "SAN SEBASTIAN SILVER PAWNSHOP INC.",
  "SILVERSTAR JEWELRY AND PAWNSHOP INC.",
  "SUREPLEDGE PAWNSHOP INC.",
  "UNIWORLD-ASIA PAWNSHOP INC.",
  "WORLDCREST PAWNSHOP INC.",
  "WORLDGEM PAWNSHOP INC.",
  "YELLOW ENDURANCE PAWNSHOP INC.",
];

// ---------- small date helpers (db.js's pg type parser keeps DATE columns
// as plain "YYYY-MM-DD" strings, matching Python's date objects closely
// enough for these purposes) ----------

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------- BSP MODE settings/tagging ----------

/** Generic single-value read from app_settings, e.g. getAppSetting("system_mode", "normal"). */
async function getAppSetting(key, fallback = null) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT value FROM app_settings WHERE key = ?", [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setAppSetting(key, value) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) " +
    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [key, value]
  );
}

/** "normal" (default) or "bsp". In BSP mode, IT staff only receive (auto-
 * assignment) and "assist" tickets from branches tagged with their own Line
 * of Business. In Normal mode the tags are stored but ignored. */
async function getSystemMode() {
  return (await getAppSetting("system_mode", "normal")) || "normal";
}

async function setSystemMode(mode) {
  if (mode !== "normal" && mode !== "bsp") throw new Error("Invalid mode.");
  await setAppSetting("system_mode", mode);
}

/** Site-wide seasonal theme: "none" (default), "halloween", "christmas", "newyear" or "valentines".
 * Only a Super Admin can change it (see POST /api/theme in server.js). */
const SITE_THEMES = ["none", "halloween", "christmas", "newyear", "valentines"];
async function getSiteTheme() {
  const v = await getAppSetting("site_theme", "none");
  return SITE_THEMES.includes(v) ? v : "none";
}
async function setSiteTheme(theme) {
  if (!SITE_THEMES.includes(theme)) throw new Error("Invalid theme.");
  await setAppSetting("site_theme", theme);
}

/** Every branch with its current BSP group tag (or null if untagged). */
async function getBranchGroups() {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT name, group_name, corporation, is_global FROM branches ORDER BY name");
  return rows;
}

/** The BSP group a single branch is tagged into, or null if untagged/unknown. */
async function getBranchGroup(name) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT group_name FROM branches WHERE name = ?", [name]);
  return rows[0] ? rows[0].group_name : null;
}

/** Which staff group serves a branch's tickets in BSP mode: "Global" if the
 * branch is flagged as partnered with Global (those branches are handled by
 * Global-tagged staff), otherwise the branch's own Line of Business (or null
 * if it isn't tagged). */
async function getBranchStaffGroup(name) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT group_name, is_global FROM branches WHERE name = ?", [name]);
  if (!rows[0]) return null;
  return rows[0].is_global ? GLOBAL_GROUP : rows[0].group_name;
}

/** Tag (or clear, with groupName = null) a branch's BSP group. Caller
 * validates groupName is one of BSP_GROUPS (or null) first. */
async function updateBranchGroup(name, groupName, corporation = null, isGlobal = false) {
  const pool = getConnection();
  // A corporation only makes sense under a Line of Business, and the Global
  // partnership flag only under a corporation - clearing a level clears
  // everything below it.
  const corp = groupName ? (corporation || null) : null;
  await pool.query(
    "UPDATE branches SET group_name = ?, corporation = ?, is_global = ? WHERE name = ?",
    [groupName || null, corp, corp ? !!isGlobal : false, name]
  );
}

/** The BSP group a single IT Department account is tagged into, or null. */
async function getUserGroup(userId) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT group_name FROM users WHERE id = ?", [userId]);
  return rows[0] ? rows[0].group_name : null;
}

/** Tag (or clear, with groupName = null) a staff account's BSP group.
 * Caller validates groupName is one of BSP_GROUPS (or null) first. */
async function updateUserGroup(userId, groupName) {
  const pool = getConnection();
  await pool.query("UPDATE users SET group_name = ? WHERE id = ?", [groupName, userId]);
}

/** BSP MODE - strict visibility scope for an IT Department account.
 * Returns null when no restriction applies (Normal Mode, any other role, or
 * an IT account that isn't tagged into a group). Otherwise returns the
 * branch sub-select that defines "my Line of Business" - same rule used
 * everywhere: a Line covers its own branches that are NOT Global-partnered,
 * Global covers every Global-partnered branch - plus clause(col) to bolt
 * " AND col IN (<those branches>)" onto a query (params in scope.params). */
async function getItBranchScope(role, userId) {
  if (role !== "IT Department") return null;
  if ((await getSystemMode()) !== "bsp") return null;
  const group = await getUserGroup(userId);
  if (!group) return null;
  const isGlobal = group === GLOBAL_GROUP;
  const sql = isGlobal
    ? "SELECT name FROM branches WHERE is_global = TRUE"
    : "SELECT name FROM branches WHERE group_name = ? AND is_global = FALSE";
  const params = isGlobal ? [] : [group];
  return { group, sql, params, clause: (col = "t.branch") => ` AND ${col} IN (${sql})` };
}

/** Is this branch inside the given scope (from getItBranchScope)? */
async function isBranchInItScope(branch, scope) {
  if (!scope) return true;
  const pool = getConnection();
  const [rows] = await pool.query(`SELECT 1 FROM branches WHERE name = ? AND name IN (${scope.sql})`, [branch, ...scope.params]);
  return rows.length > 0;
}

/** Keep only the ticket ids whose branch is inside the scope (no scope = all). */
async function filterTicketIdsInScope(ids, scope) {
  if (!scope || !ids || ids.length === 0) return ids || [];
  const pool = getConnection();
  const ph = ids.map(() => "?").join(",");
  const [rows] = await pool.query(
    `SELECT t.id FROM tickets t WHERE t.id IN (${ph})${scope.clause("t.branch")}`,
    [...ids, ...scope.params]
  );
  const ok = new Set(rows.map((r) => Number(r.id)));
  return ids.filter((id) => ok.has(Number(id)));
}

// ---------- Auth ----------

async function authenticate(username, password) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE username = ? AND password = ?",
    [username, password]
  );
  return rows[0] || null;
}

async function usernameExists(username, excludeUserId = null) {
  const pool = getConnection();
  let rows;
  if (excludeUserId !== null && excludeUserId !== undefined) {
    [rows] = await pool.query(
      "SELECT 1 FROM users WHERE username = ? AND id != ?",
      [username, excludeUserId]
    );
  } else {
    [rows] = await pool.query("SELECT 1 FROM users WHERE username = ?", [username]);
  }
  return rows.length > 0;
}

async function branchAccountExists(branch, excludeUserId = null) {
  const pool = getConnection();
  let rows;
  if (excludeUserId !== null && excludeUserId !== undefined) {
    [rows] = await pool.query(
      "SELECT 1 FROM branch_staff WHERE branch_name = ? AND user_id != ?",
      [branch, excludeUserId]
    );
  } else {
    [rows] = await pool.query("SELECT 1 FROM branch_staff WHERE branch_name = ?", [branch]);
  }
  return rows.length > 0;
}

/** Mirrors branchAccountExists(), but for Head Office Employee accounts -
 * one account per department, keyed on head_office_employees.department. */
async function departmentAccountExists(department, excludeUserId = null) {
  const pool = getConnection();
  let rows;
  if (excludeUserId !== null && excludeUserId !== undefined) {
    [rows] = await pool.query(
      "SELECT 1 FROM head_office_employees WHERE department = ? AND user_id != ?",
      [department, excludeUserId]
    );
  } else {
    [rows] = await pool.query("SELECT 1 FROM head_office_employees WHERE department = ?", [department]);
  }
  return rows.length > 0;
}

const ROLE_TABLES = {
  "Super Admin": "super_admins",
  "IT Department": "it_department",
  "Head Office Employee": "head_office_employees",
  "Branch Staff": "branch_staff",
};

/** Insert this account's row into its role-specific table.
 * 'location' is the department name (Head Office Employee) or branch name
 * (Branch Staff); ignored for Super Admin / IT Department, which have no
 * extra fields. */
async function _writeRoleTable(conn, userId, role, location) {
  const table = ROLE_TABLES[role];
  if (role === "Head Office Employee") {
    await conn.query(
      "INSERT INTO head_office_employees (user_id, department) VALUES (?, ?)",
      [userId, location]
    );
  } else if (role === "Branch Staff") {
    await conn.query(
      "INSERT INTO branch_staff (user_id, branch_name) VALUES (?, ?)",
      [userId, location]
    );
  } else {
    await conn.query(`INSERT INTO ${table} (user_id) VALUES (?)`, [userId]);
  }
}

/** Create an account. Writes to the shared 'users' table AND to that role's
 * own table (super_admins / it_department / head_office_employees /
 * branch_staff) so each role's details live in its own storage. */
async function registerUser(username, password, fullName, role, branch, deviceId = null, deviceLabel = null) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "INSERT INTO users (username, password, full_name, role, branch, created_at) " +
    "VALUES (?, ?, ?, ?, ?, NOW()) RETURNING id",
    [username, password, fullName, role, branch]
  );
  const userId = rows[0].id;
  await _writeRoleTable(pool, userId, role, branch);
  // The computer used to create a Branch Staff account is implicitly the
  // branch's "registered computer" - trust it immediately (approvedBy null,
  // since this is self-registration rather than an IT/Super Admin
  // decision) so the account isn't locked out of the very device it was
  // just created on. Any other device later needs IT approval - see
  // isTrustedDevice / createDeviceLoginRequest and server's /api/login.
  if (role === "Branch Staff" && deviceId) {
    await trustDevice(userId, deviceId, deviceLabel, null);
  }
  return userId;
}

/** Update an existing account. Updates the shared 'users' row, then
 * rebuilds this account's row in its role-specific table (clearing any
 * stale row from a previous role first, in case the role changed). */
async function updateUser(userId, username, fullName, role, branch, password = null) {
  const pool = getConnection();
  if (password) {
    await pool.query(
      "UPDATE users SET username = ?, full_name = ?, role = ?, " +
      "branch = ?, password = ? WHERE id = ?",
      [username, fullName, role, branch, password, userId]
    );
  } else {
    await pool.query(
      "UPDATE users SET username = ?, full_name = ?, role = ?, " +
      "branch = ? WHERE id = ?",
      [username, fullName, role, branch, userId]
    );
  }
  for (const table of Object.values(ROLE_TABLES)) {
    await pool.query(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
  }
  await _writeRoleTable(pool, userId, role, branch);
}

/** Return the list of concerns (categories) this IT Department account is
 * set up to handle. */
async function getItSpecialties(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT category FROM it_specialties WHERE user_id = ? ORDER BY category",
    [userId]
  );
  return rows.map((r) => r.category);
}

/** Replace this account's set of concerns with exactly the ones given
 * (clears everything first, so passing an empty list removes them all -
 * used when an account's role changes away from IT Department). */
async function setItSpecialties(userId, categories) {
  const pool = getConnection();
  await pool.query("DELETE FROM it_specialties WHERE user_id = ?", [userId]);
  for (const category of categories) {
    await pool.query(
      "INSERT INTO it_specialties (user_id, category) VALUES (?, ?)",
      [userId, category]
    );
  }
}

async function getItDepartmentUsers() {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE role IN ('IT Department', 'Super Admin') ORDER BY full_name"
  );
  return rows;
}

/** Every Super Admin account - used to notify all of them at once when an
 * IT Department account files a void request (see server's
 * /api/tickets/:id/void/request). */
async function getSuperAdminUsers() {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE role = 'Super Admin' ORDER BY full_name"
  );
  return rows;
}

/** Every IT Department account - used to notify the whole team at once
 * (e.g. a Super Admin's "poke" on a ticket, see server's
 * /api/tickets/:id/poke), not just whoever it's assigned to. */
async function getItDepartmentUsers() {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT * FROM users WHERE role = 'IT Department' ORDER BY full_name"
  );
  return rows;
}

// ---------- IT Absences (Super Admin managed) ----------

/** Mark an IT Department staff member absent/on-field for a specific date,
 * so auto-assignment skips them that day (see _pickBalancedItStaff) and
 * other IT staff see a heads-up on their dashboard (see getAbsentToday).
 * Marking the same person absent again for the same date just updates the
 * reason instead of erroring. */
async function markAbsent(userId, absenceDate, markedBy, reason = null) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO it_absences (user_id, absence_date, reason, marked_by, created_at) " +
    "VALUES (?, ?, ?, ?, NOW()) " +
    "ON CONFLICT (user_id, absence_date) DO UPDATE " +
    "SET reason = EXCLUDED.reason, marked_by = EXCLUDED.marked_by",
    [userId, absenceDate, reason, markedBy]
  );
}

/** Mark an IT Department staff member absent/on-field for numDays
 * CONSECUTIVE calendar days starting at startDate (inclusive) - e.g. a week
 * of leave in one action instead of one date at a time. Returns the list of
 * dates that got marked. */
async function markAbsentRange(userId, startDate, numDays, markedBy, reason = null) {
  const pool = getConnection();
  const n = Math.max(1, numDays);
  const dates = [];
  for (let i = 0; i < n; i++) dates.push(addDays(startDate, i));
  for (const d of dates) {
    await pool.query(
      "INSERT INTO it_absences (user_id, absence_date, reason, marked_by, created_at) " +
      "VALUES (?, ?, ?, ?, NOW()) " +
      "ON CONFLICT (user_id, absence_date) DO UPDATE " +
      "SET reason = EXCLUDED.reason, marked_by = EXCLUDED.marked_by",
      [userId, d, reason, markedBy]
    );
  }
  return dates;
}

/** Remove an absence record (e.g. it was marked by mistake, or the staff
 * member came back early). */
async function unmarkAbsent(absenceId) {
  const pool = getConnection();
  await pool.query("DELETE FROM it_absences WHERE id = ?", [absenceId]);
}

/** List absence records (id, user_id, full_name, absence_date, reason,
 * marked_by_name) for the Super Admin's 'IT Availability' panel, soonest
 * first. */
async function getAbsences(upcomingOnly = true) {
  const pool = getConnection();
  let query =
    "SELECT a.id, a.user_id, u.full_name, a.absence_date, a.reason, a.created_at, " +
    "  m.full_name AS marked_by_name " +
    "FROM it_absences a JOIN users u ON u.id = a.user_id " +
    "LEFT JOIN users m ON m.id = a.marked_by ";
  if (upcomingOnly) query += "WHERE a.absence_date >= CURRENT_DATE ";
  query += "ORDER BY a.absence_date, u.full_name";
  const [rows] = await pool.query(query);
  return rows;
}

/** Past absence records only (absence_date < today by default, most recent
 * first) - the "history" counterpart to getAbsences(true)'s upcoming-only
 * view. Pass startDate/endDate (inclusive "YYYY-MM-DD" strings) to instead
 * filter to a specific single day, month, or arbitrary range - see
 * reporting.resolveDateRange, which server.js uses to turn a UI selection
 * into that pair. Optionally further scoped to a single staff member. */
async function getAbsenceHistory(userId = null, startDate = null, endDate = null) {
  const pool = getConnection();
  let query =
    "SELECT a.id, a.user_id, u.full_name, a.absence_date, a.reason, a.created_at, " +
    "  m.full_name AS marked_by_name " +
    "FROM it_absences a JOIN users u ON u.id = a.user_id " +
    "LEFT JOIN users m ON m.id = a.marked_by " +
    "WHERE ";
  const params = [];
  if (startDate && endDate) {
    query += "a.absence_date BETWEEN ? AND ? ";
    params.push(startDate, endDate);
  } else {
    query += "a.absence_date < CURRENT_DATE ";
  }
  if (userId !== null && userId !== undefined) {
    query += "AND a.user_id = ? ";
    params.push(userId);
  }
  query += "ORDER BY a.absence_date DESC, u.full_name";
  const [rows] = await pool.query(query, params);
  return rows;
}

/** IT staff marked absent for the given date (defaults to today) - id,
 * full_name, reason, plus how many of their tickets are still Open or In
 * Progress (pending_tickets). Used to show the 'not present today' banner
 * and drive the "N tickets need assistance" dashboard notification -
 * pending_tickets > 0 is what tells the UI there's something to act on. */
async function getAbsentToday(forDate = null, scope = null) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT a.user_id AS id, u.full_name, a.reason, " +
    "  COALESCE(( " +
    "    SELECT COUNT(*) FROM tickets t " +
    "    WHERE t.assigned_to = a.user_id AND t.status IN ('Open', 'In Progress') " + (scope ? scope.clause("t.branch") : "") +
    "  ), 0) AS pending_tickets " +
    "FROM it_absences a JOIN users u ON u.id = a.user_id " +
    "WHERE a.absence_date = COALESCE(?, CURRENT_DATE) " +
    "ORDER BY pending_tickets DESC, u.full_name",
    [...(scope ? scope.params : []), forDate]
  );
  return rows;
}

async function isAbsentToday(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT 1 FROM it_absences WHERE user_id = ? AND absence_date = CURRENT_DATE",
    [userId]
  );
  return rows.length > 0;
}

/** IT staff whose account is currently locked (is_available = false AND
 * their lock has actually started - see unavailable_from below) - the
 * account-lock counterpart to getAbsentToday(). A locked account can't log
 * in at all until a Super Admin re-approves it (see server.js's /login and
 * /availability-requests), so any tickets already assigned to them need a
 * colleague's attention the same way an absent colleague's do. Same shape
 * as getAbsentToday() (id, full_name, reason, pending_tickets) so callers
 * can merge the two lists for a single "who needs covering" view. `reason`
 * is the most recent availability_log entry that locked this account (may
 * be null - a request-based unlock/relock can leave no reason on file).
 *
 * A lock scheduled with a future "unavailable_from" date is deliberately
 * excluded here even though is_available is already FALSE for it (see
 * setAvailability) - it hasn't started yet, so nobody needs to cover for
 * them and they shouldn't show up as "needs assistance" before their start
 * date. */
async function getLockedStaff(scope = null) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT u.id, u.full_name, " +
    "  (SELECT l.reason FROM availability_log l " +
    "     WHERE l.user_id = u.id AND l.is_available = FALSE " +
    "     ORDER BY l.changed_at DESC LIMIT 1) AS reason, " +
    "  COALESCE(( " +
    "    SELECT COUNT(*) FROM tickets t " +
    "    WHERE t.assigned_to = u.id AND t.status IN ('Open', 'In Progress') " + (scope ? scope.clause("t.branch") : "") +
    "  ), 0) AS pending_tickets " +
    "FROM users u " +
    "WHERE u.role IN ('IT Department', 'Super Admin') AND u.is_available = FALSE " +
    "  AND (u.unavailable_from IS NULL OR u.unavailable_from <= CURRENT_DATE) " +
    "ORDER BY pending_tickets DESC, u.full_name",
    scope ? scope.params : []
  );
  return rows;
}

// ---------- Account availability (Super Admin managed login lock) ----------

/** Super Admin directly flips whether this account may log in. Marking
 * someone unavailable does NOT touch any pending availability_requests row
 * they might have - a Super Admin who un-blocks then re-blocks the same
 * person is expected to also decide any request explicitly. Every change
 * is appended to availability_log (changedBy/reason optional - reason is
 * only ever set by the Super Admin's direct action; an approved request
 * logs with no reason since the staffer's own request text isn't part of
 * this trail) so there's a permanent history of lock/unlock events,
 * independent of the point-in-time is_available flag on 'users'. */
async function setAvailability(userId, isAvailable, changedBy = null, reason = null, unavailableFrom = null, unavailableUntil = null) {
  const pool = getConnection();
  if (isAvailable) {
    // Restoring access always clears any date range from the last lock -
    // there's nothing left to auto-expire once it's manually restored.
    await pool.query(
      "UPDATE users SET is_available = TRUE, unavailable_from = NULL, unavailable_until = NULL WHERE id = ?",
      [userId]
    );
  } else {
    await pool.query(
      "UPDATE users SET is_available = FALSE, unavailable_from = ?, unavailable_until = ? WHERE id = ?",
      [unavailableFrom, unavailableUntil, userId]
    );
  }
  await pool.query(
    "INSERT INTO availability_log (user_id, is_available, changed_by, reason, unavailable_from, unavailable_until, changed_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, NOW())",
    [userId, isAvailable, changedBy, reason, isAvailable ? null : unavailableFrom, isAvailable ? null : unavailableUntil]
  );
}

/** Auto-restore access for anyone whose unavailable_until date has already
 * passed - called from the login flow (see server.js) so a staff member
 * marked unavailable through, say, end of the week doesn't need a Super
 * Admin to manually flip them back on the morning after. Logs the
 * restoration the same way a manual "Mark available" does, just with no
 * changedBy (system-triggered) and a fixed reason for the history trail. */
async function restoreExpiredAvailability() {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT id FROM users WHERE is_available = FALSE AND unavailable_until IS NOT NULL AND unavailable_until < CURRENT_DATE"
  );
  for (const row of rows) {
    await setAvailability(row.id, true, null, "Unavailable-until date passed (auto-restored)");
  }
}

/** Availability lock/unlock history - every time an account's is_available
 * flag changed, most recent first. Pass startDate/endDate (inclusive
 * "YYYY-MM-DD" strings, matched against changed_at's calendar day) to
 * filter to a single day, month, or arbitrary range instead of the default
 * unfiltered log. Optionally further scoped to a single staff member.
 * Powers the "Unavailable history" panel. */
async function getAvailabilityLog(userId = null, startDate = null, endDate = null, limit = 200) {
  const pool = getConnection();
  let query =
    "SELECT l.id, l.user_id, u.full_name, l.is_available, l.reason, " +
    "  l.unavailable_from, l.unavailable_until, l.changed_at, " +
    "  c.full_name AS changed_by_name " +
    "FROM availability_log l JOIN users u ON u.id = l.user_id " +
    "LEFT JOIN users c ON c.id = l.changed_by ";
  const params = [];
  const clauses = [];
  if (startDate && endDate) {
    clauses.push("l.changed_at::date BETWEEN ? AND ?");
    params.push(startDate, endDate);
  }
  if (userId !== null && userId !== undefined) {
    clauses.push("l.user_id = ?");
    params.push(userId);
  }
  if (clauses.length) query += "WHERE " + clauses.join(" AND ") + " ";
  query += "ORDER BY l.changed_at DESC LIMIT ?";
  params.push(limit);
  const [rows] = await pool.query(query, params);
  return rows;
}

/** File (or reuse) a request for a Super Admin to restore this account's
 * ability to log in. `kind` is 'lock' (default - is_available=false was
 * flipped by a Super Admin) or 'absence' (blocked by today's it_absences
 * entry instead - see server.js's /api/login and /api/availability/request,
 * which auto-detects which one actually applies before calling this).
 * Returns { created: true } for a fresh request, or { created: false } if
 * one was already Pending - either way the caller just needs to know a
 * Pending request now exists. */
async function requestAvailability(userId, kind = "lock") {
  const pool = getConnection();
  const [existing] = await pool.query(
    "SELECT id FROM availability_requests WHERE user_id = ? AND status = 'Pending'",
    [userId]
  );
  if (existing.length) return { created: false, id: existing[0].id };
  const [rows] = await pool.query(
    "INSERT INTO availability_requests (user_id, status, kind, requested_at) VALUES (?, 'Pending', ?, NOW()) RETURNING id",
    [userId, kind]
  );
  return { created: true, id: rows[0].id };
}

/** The opposite direction from requestAvailability above: a currently-
 * available IT Department/Super Admin account asks a Super Admin to mark
 * THEM unavailable (e.g. "I'm heading out on a site visit"), rather than
 * waiting for a Super Admin to notice and do it. Stores the reason/date
 * range the staffer typed in so decideAvailabilityRequest can apply it
 * later if approved. Same "one Pending request at a time" rule as
 * requestAvailability - filing again while one's already pending just
 * reuses it. */
async function requestFieldUnavailability(userId, reason = null, unavailableFrom = null, unavailableUntil = null) {
  const pool = getConnection();
  const [existing] = await pool.query(
    "SELECT id FROM availability_requests WHERE user_id = ? AND status = 'Pending'",
    [userId]
  );
  if (existing.length) return { created: false, id: existing[0].id };
  const [rows] = await pool.query(
    "INSERT INTO availability_requests (user_id, status, kind, reason, unavailable_from, unavailable_until, requested_at) " +
    "VALUES (?, 'Pending', 'field', ?, ?, ?, NOW()) RETURNING id",
    [userId, reason, unavailableFrom, unavailableUntil]
  );
  return { created: true, id: rows[0].id };
}

/** Whether this user currently has a Pending availability_requests row of
 * any kind - powers the "My availability" card on the IT Staff page so a
 * staffer sees "request pending" instead of the request button again, and
 * lets the field-request endpoint below give a friendly message instead of
 * silently reusing an existing 'lock'/'absence' request under the hood. */
async function getOwnPendingAvailabilityRequest(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT id, kind, reason, unavailable_from, unavailable_until, requested_at " +
    "FROM availability_requests WHERE user_id = ? AND status = 'Pending'",
    [userId]
  );
  return rows[0] || null;
}

/** Pending requests, oldest first - powers the Super Admin sidebar bell and
 * the "Pending availability requests" panel on the IT Staff tab. Each row's
 * `kind` ('lock' | 'absence' | 'field') tells the UI which situation is
 * being appealed; reason/unavailable_from/unavailable_until are only set
 * for 'field' requests (what the staffer typed in). */
async function getPendingAvailabilityRequests() {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT r.id, r.user_id, u.full_name, r.kind, r.reason, " +
    "  r.unavailable_from, r.unavailable_until, r.requested_at " +
    "FROM availability_requests r JOIN users u ON u.id = r.user_id " +
    "WHERE r.status = 'Pending' ORDER BY r.requested_at",
    []
  );
  return rows;
}

/** Remove today's absence record for this user, if any - the 'absence'-kind
 * counterpart to setAvailability(userId, true, ...) for the 'lock' kind.
 * Only clears TODAY's entry; any future-dated absences already scheduled
 * for this person are left alone (approving "let me log in today" isn't
 * the same as cancelling a whole week already booked off). */
async function clearTodaysAbsence(userId) {
  const pool = getConnection();
  await pool.query(
    "DELETE FROM it_absences WHERE user_id = ? AND absence_date = CURRENT_DATE",
    [userId]
  );
}

/** Approve or deny a pending request. Approving restores the account's
 * ability to log in - for a 'lock' request that means flipping
 * is_available back to true; for an 'absence' request it means clearing
 * today's it_absences entry instead (see clearTodaysAbsence). A 'field'
 * request runs the other way: approving it marks the requester
 * unavailable (using the reason/date range they filed it with), same as a
 * Super Admin using setAvailability directly. Denying leaves the account
 * as it was either way (they can file another request later). Returns
 * false if the request doesn't exist or was already decided. */
async function decideAvailabilityRequest(requestId, approve, decidedBy) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT user_id, status, kind, reason, unavailable_from, unavailable_until FROM availability_requests WHERE id = ?",
    [requestId]
  );
  const req = rows[0];
  if (!req || req.status !== "Pending") return false;
  await pool.query(
    "UPDATE availability_requests SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ?",
    [approve ? "Approved" : "Denied", decidedBy, requestId]
  );
  if (approve) {
    if (req.kind === "absence") {
      await clearTodaysAbsence(req.user_id);
    } else if (req.kind === "field") {
      await setAvailability(req.user_id, false, decidedBy, req.reason, req.unavailable_from, req.unavailable_until);
    } else {
      await setAvailability(req.user_id, true, decidedBy);
    }
  }
  return true;
}

// ---------- Device approval (Branch Staff login lock) ----------
// A Branch Staff account may only sign in from a device already in
// trusted_devices - either the one it self-registered from (see
// registerUser) or one an IT/Super Admin approved here. Any other device
// gets held as a Pending device_login_requests row instead (see server's
// /api/login), auto-assigned to a balanced on-duty IT staffer the same way
// a ticket gets auto-assigned to one who covers its category.

/** Whether this device_id is already trusted for this user. */
async function isTrustedDevice(userId, deviceId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT 1 FROM trusted_devices WHERE user_id = ? AND device_id = ?",
    [userId, deviceId]
  );
  return rows.length > 0;
}

/** Keep last_login_at current on an already-trusted device - called right
 * after isTrustedDevice() confirms this login doesn't need approval. */
async function touchTrustedDevice(userId, deviceId) {
  const pool = getConnection();
  await pool.query(
    "UPDATE trusted_devices SET last_login_at = NOW() WHERE user_id = ? AND device_id = ?",
    [userId, deviceId]
  );
}

/** Mark a device trusted for this user. approvedBy is null for the
 * self-registration case (registerUser) or the deciding staffer's id for
 * an approved device_login_requests row (decideDeviceRequest below).
 * Re-trusting an already-trusted device_id just refreshes its
 * label/approver rather than erroring. */
async function trustDevice(userId, deviceId, deviceLabel, approvedBy = null) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO trusted_devices (user_id, device_id, device_label, approved_by, approved_at, last_login_at) " +
    "VALUES (?, ?, ?, ?, NOW(), NOW()) " +
    "ON CONFLICT (user_id, device_id) DO UPDATE " +
    "SET device_label = EXCLUDED.device_label, approved_by = EXCLUDED.approved_by, last_login_at = NOW()",
    [userId, deviceId, deviceLabel, approvedBy]
  );
}

/** Pick an on-duty IT Department staff id to review a device approval
 * request - the device-approval counterpart to _pickBalancedItStaff for
 * tickets. Not scoped to a category (any IT staffer can vet a sign-in);
 * skips anyone marked absent today or whose account-lock (is_available =
 * false) has actually started (a lock scheduled for a future date doesn't
 * count yet - see setAvailability), unless literally everyone is
 * unavailable, then balances by how many device requests they already have
 * pending. Returns null if there are no IT Department accounts at all. */
async function _pickOnDutyItStaff(conn) {
  const [staffRows] = await conn.query(
    "SELECT id, is_available, unavailable_from FROM users WHERE role = 'IT Department'"
  );
  if (staffRows.length === 0) return null;
  const staffIds = staffRows.map((r) => r.id);
  const today = new Date().toISOString().slice(0, 10);
  const lockedIds = new Set(
    staffRows
      .filter((r) => r.is_available === false && (!r.unavailable_from || r.unavailable_from <= today))
      .map((r) => r.id)
  );

  const absentIds = await _absentUserIds(conn);
  let availableIds = staffIds.filter((sid) => !lockedIds.has(sid) && !absentIds.has(sid));
  if (availableIds.length === 0) availableIds = staffIds;

  const [loadRows] = await conn.query(
    "SELECT assigned_to, COUNT(*) AS cnt FROM device_login_requests " +
    "WHERE status = 'Pending' AND assigned_to IS NOT NULL GROUP BY assigned_to"
  );
  const load = {};
  for (const row of loadRows) load[row.assigned_to] = row.cnt;

  const minCount = Math.min(...availableIds.map((sid) => load[sid] || 0));
  const leastLoaded = availableIds.filter((sid) => (load[sid] || 0) === minCount);
  return randomChoice(leastLoaded);
}

/** File (or reuse) a device approval request for userId/deviceId. If the
 * most recent request for this exact user+device is still Pending, that
 * same row is reused (created:false) so a branch tab polling /api/login
 * every few seconds doesn't spam IT with duplicates. If it was Declined,
 * that's also returned as-is without filing a new one - a decline is
 * terminal until a Super Admin overrides it (see decideDeviceRequest), not
 * something a bare retry should re-trigger. Only once there's no existing
 * request (or the last one was Approved, which isTrustedDevice's caller
 * should already have short-circuited on) does this create a fresh Pending
 * row, auto-assigned via _pickOnDutyItStaff. assignedTo is null when no IT
 * Department account exists yet - the caller should fall back to notifying
 * Super Admins directly so the request isn't stranded. */
async function createDeviceLoginRequest(userId, deviceId, deviceLabel) {
  const pool = getConnection();
  const [existing] = await pool.query(
    "SELECT id, status, assigned_to FROM device_login_requests " +
    "WHERE user_id = ? AND device_id = ? ORDER BY requested_at DESC LIMIT 1",
    [userId, deviceId]
  );
  if (existing.length && existing[0].status !== "Approved") {
    return { created: false, id: existing[0].id, status: existing[0].status, assignedTo: existing[0].assigned_to };
  }
  const assignedTo = await _pickOnDutyItStaff(pool);
  const [rows] = await pool.query(
    "INSERT INTO device_login_requests (user_id, device_id, device_label, status, assigned_to, requested_at) " +
    "VALUES (?, ?, ?, 'Pending', ?, NOW()) RETURNING id",
    [userId, deviceId, deviceLabel, assignedTo]
  );
  return { created: true, id: rows[0].id, status: "Pending", assignedTo };
}

/** Requests a viewer can currently act on for the "Device sign-in
 * approvals" panel. A Super Admin sees every Pending request plus recently
 * Declined ones (so they can override a decline), regardless of who it's
 * assigned to. An IT Department staffer sees only Pending ones: assigned to
 * them, unassigned (no IT staff existed when it was filed), or assigned to
 * a colleague who's absent today - mirrors how an absent colleague's
 * tickets stay actionable by whoever's covering (see getTickets). */
async function getDeviceRequests(viewerRole, viewerId) {
  const pool = getConnection();
  if (viewerRole === "Super Admin") {
    const [rows] = await pool.query(
      `SELECT r.*, u.full_name, u.username, u.branch, a.full_name AS assigned_to_name
       FROM device_login_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users a ON a.id = r.assigned_to
       WHERE r.status IN ('Pending', 'Declined')
       ORDER BY (r.status = 'Pending') DESC, r.requested_at DESC`
    );
    return rows;
  }
  const [rows] = await pool.query(
    `SELECT r.*, u.full_name, u.username, u.branch, a.full_name AS assigned_to_name
     FROM device_login_requests r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN users a ON a.id = r.assigned_to
     WHERE r.status = 'Pending' AND (
       r.assigned_to = ?
       OR r.assigned_to IS NULL
       OR r.assigned_to IN (SELECT user_id FROM it_absences WHERE absence_date = CURRENT_DATE)
     )
     ORDER BY r.requested_at`,
    [viewerId]
  );
  return rows;
}

/** Approve or decline a Pending device request; a Declined one may also be
 * later Approved (a Super Admin overriding a decline) - an already-Approved
 * request is final. Approving trusts the device for that user going
 * forward (see trustDevice). Declining flags superadmin_notified so the
 * caller (server's /api/device-requests/:id/decline) knows to push-notify
 * every Super Admin. Returns null if the request doesn't exist or isn't in
 * a decidable state. */
async function decideDeviceRequest(requestId, approve, decidedBy, note = null) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT user_id, device_id, device_label, status FROM device_login_requests WHERE id = ?",
    [requestId]
  );
  const req = rows[0];
  if (!req) return null;
  if (req.status === "Approved") return null;
  if (req.status === "Declined" && !approve) return null;

  if (approve) {
    await pool.query(
      "UPDATE device_login_requests SET status = 'Approved', decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?",
      [decidedBy, note, requestId]
    );
    await trustDevice(req.user_id, req.device_id, req.device_label, decidedBy);
  } else {
    await pool.query(
      "UPDATE device_login_requests SET status = 'Declined', decided_by = ?, decided_at = NOW(), " +
      "decision_note = ?, superadmin_notified = TRUE WHERE id = ?",
      [decidedBy, note, requestId]
    );
  }
  return { userId: req.user_id, deviceId: req.device_id, deviceLabel: req.device_label, approved: approve };
}

// ---------- Team workspace (IT Department / Super Admin live snapshot) ----------
// Powers the "Team Workspace" tab - a glance dashboard distinct from
// Reporting (historical, date-ranged) and IT Staff & Availability (roster
// management): current workload per staff member, who's on duty right now,
// and the next few days' absence schedule.

/** Live per-staff snapshot: how many tickets they currently have
 * Open/In Progress, how many they've resolved today, and whether they're
 * on duty right now (not absent today, not locked via is_available).
 * Busiest (open+in_progress) first. */
async function getTeamWorkload() {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT
        u.id AS user_id, u.full_name, u.role, u.is_available, u.unavailable_from,
        COALESCE(SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END), 0) AS open_count,
        COALESCE(SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END), 0) AS in_progress,
        COALESCE(SUM(CASE WHEN t.status = 'Resolved' AND t.resolved_at::date = CURRENT_DATE THEN 1 ELSE 0 END), 0) AS resolved_today,
        (SELECT reason FROM it_absences WHERE user_id = u.id AND absence_date = CURRENT_DATE) AS absence_reason
    FROM users u
    LEFT JOIN tickets t ON t.assigned_to = u.id AND t.void_status != 'Voided'
    WHERE u.role IN ('IT Department', 'Super Admin')
    GROUP BY u.id, u.full_name, u.role, u.is_available, u.unavailable_from
    ORDER BY (COALESCE(SUM(CASE WHEN t.status = 'Open' THEN 1 ELSE 0 END), 0)
              + COALESCE(SUM(CASE WHEN t.status = 'In Progress' THEN 1 ELSE 0 END), 0)) DESC,
             u.full_name`
  );
  return rows.map((r) => ({
    user_id: r.user_id,
    full_name: r.full_name,
    role: r.role,
    is_available: r.is_available,
    unavailable_from: r.unavailable_from,
    open: r.open_count,
    in_progress: r.in_progress,
    resolved_today: r.resolved_today,
    absent_today: r.absence_reason !== null,
    absence_reason: r.absence_reason,
  }));
}

/** Team-wide ticket counts for right now (excluding voided tickets) - the
 * headline numbers on the Team Workspace tab. */
async function getTeamStats() {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT
        SUM(CASE WHEN status = 'Open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'Resolved' AND resolved_at::date = CURRENT_DATE THEN 1 ELSE 0 END) AS resolved_today
     FROM tickets WHERE void_status != 'Voided'`
  );
  const r = rows[0] || {};
  return {
    open: r.open_count || 0,
    in_progress: r.in_progress || 0,
    resolved_today: r.resolved_today || 0,
  };
}

/** Absences over the next `days` calendar days (today included) - the
 * "schedule at a glance" strip on Team Workspace, distinct from
 * getAbsences(true)'s unbounded upcoming list used on IT Staff &
 * Availability. */
async function getUpcomingAbsences(days = 7) {
  const pool = getConnection();
  const [todayRows] = await pool.query("SELECT CURRENT_DATE AS today");
  const today = todayRows[0].today;
  const end = addDays(today, Math.max(1, days) - 1);
  const [rows] = await pool.query(
    `SELECT a.id, a.user_id, u.full_name, a.absence_date, a.reason
     FROM it_absences a JOIN users u ON u.id = a.user_id
     WHERE a.absence_date BETWEEN ? AND ?
     ORDER BY a.absence_date, u.full_name`,
    [today, end]
  );
  return rows;
}

// ---------- Attendance / login log ----------
// Super Admin-only visibility into when IT Department / Super Admin
// accounts actually signed in, and whether it was from a desktop or a
// phone - see server's /api/attendance* routes (every one of them gated
// with requireRole(req, "Super Admin")) and app.js's Attendance panel on
// Team Workspace -> Overview. IT Department accounts never see any of
// this - it's written on every login (see server's /api/login) but only
// ever read back by a Super Admin.

/** Record one successful sign-in. Called right after startSession() in
 * server's /api/login for every role, but only IT Department / Super Admin
 * rows are ever surfaced by getAttendanceLog()/getTodayAttendance() below -
 * keeping the write unconditional means nothing has to change here if a
 * future role ever needs the same visibility. */
async function recordLogin(userId, deviceId = null, deviceLabel = null, deviceKind = null) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO login_log (user_id, device_id, device_label, device_kind, logged_in_at) " +
    "VALUES (?, ?, ?, ?, NOW())",
    [userId, deviceId || null, deviceLabel || null, deviceKind || null]
  );
}

/** Login history for IT Department / Super Admin accounts, most recent
 * first. `startDate`/`endDate`, if both given, scope this to [startDate,
 * endDate] inclusive (by calendar day) - omit both for unfiltered history
 * (capped at `limit`), matching getAbsenceHistory()/getAvailabilityLog()'s
 * convention. `userId`, if given, scopes this to one staff member (their
 * own "My Attendance" history, or a Super Admin drilling into one person) -
 * otherwise every IT staff member's logins are included. Powers both the
 * Attendance panel's table and its .xlsx export. */
async function getAttendanceLog(startDate = null, endDate = null, { userId = null, limit = 500 } = {}) {
  const pool = getConnection();
  let query =
    "SELECT l.id, l.user_id, u.full_name, u.role, l.device_label, l.device_kind, l.logged_in_at " +
    "FROM login_log l JOIN users u ON u.id = l.user_id " +
    "WHERE u.role IN ('IT Department', 'Super Admin') ";
  const params = [];
  if (startDate && endDate) {
    query += "AND l.logged_in_at::date BETWEEN ? AND ? ";
    params.push(startDate, endDate);
  }
  if (userId !== null && userId !== undefined) {
    query += "AND l.user_id = ? ";
    params.push(userId);
  }
  query += "ORDER BY l.logged_in_at DESC LIMIT ?";
  params.push(limit);
  const [rows] = await pool.query(query, params);
  return rows;
}

/** Every IT Department / Super Admin account's FIRST login today (their
 * "time in" for attendance purposes), plus how many times they've signed
 * in today in total - one row per staff member, including ones who
 * haven't logged in at all today. Powers the "Today's attendance" quick
 * view at the top of the Attendance panel. */
async function getTodayAttendance() {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT
        u.id AS user_id, u.full_name, u.role,
        MIN(l.logged_in_at) AS first_login_at,
        MAX(l.logged_in_at) AS last_login_at,
        COUNT(l.id) AS login_count,
        (ARRAY_AGG(l.device_label ORDER BY l.logged_in_at))[1] AS first_device_label,
        (ARRAY_AGG(l.device_kind ORDER BY l.logged_in_at))[1] AS first_device_kind
     FROM users u
     LEFT JOIN login_log l ON l.user_id = u.id AND l.logged_in_at::date = CURRENT_DATE
     WHERE u.role IN ('IT Department', 'Super Admin')
     GROUP BY u.id, u.full_name, u.role
     ORDER BY (MIN(l.logged_in_at) IS NULL), MIN(l.logged_in_at), u.full_name`
  );
  return rows.map((r) => ({
    user_id: r.user_id,
    full_name: r.full_name,
    role: r.role,
    first_login_at: r.first_login_at,
    last_login_at: r.last_login_at,
    login_count: r.login_count || 0,
    device_label: r.first_device_label,
    device_kind: r.first_device_kind,
    logged_in_today: r.first_login_at !== null,
  }));
}

// ---------- Ticket assists (covering for an absent IT staff member) ----------

/** Log that assistedBy (an IT Department/Super Admin account) stepped in to
 * help on this ticket - typically because the ticket's original assignee is
 * marked absent that day. Captures who the ticket was assigned to at the
 * moment of the assist, so there's a permanent record of who actually
 * covered the work even if the ticket gets reassigned again later. */
async function recordAssist(ticketId, assistedBy, note = null) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT assigned_to FROM tickets WHERE id = ?", [ticketId]);
  const originalAssignee = rows[0] ? rows[0].assigned_to : null;
  await pool.query(
    "INSERT INTO ticket_assists (ticket_id, original_assignee, assisted_by, note, assisted_at) " +
    "VALUES (?, ?, ?, ?, NOW())",
    [ticketId, originalAssignee, assistedBy, note]
  );
}

/** Assist history for one ticket (who helped, standing in for whom, and
 * when), most recent last. */
async function getTicketAssists(ticketId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT ta.*, u.full_name AS assisted_by_name, o.full_name AS original_assignee_name
     FROM ticket_assists ta
     JOIN users u ON u.id = ta.assisted_by
     LEFT JOIN users o ON o.id = ta.original_assignee
     WHERE ta.ticket_id = ?
     ORDER BY ta.assisted_at`,
    [ticketId]
  );
  return rows;
}

// ---------- Ticket collaborators (multi-staff "work together" assignment) ----------
// A ticket's primary owner stays tickets.assigned_to (auto-assignment,
// reporting's "who does this ticket belong to" fallback, etc all still key
// off that column unchanged). This table only ever ADDS people on top -
// every collaborator gets identical rights to assigned_to (see
// server.js's isAssigneeOfTicket), identical queue visibility (see
// getTickets()'s IT-Department scoping below), identical notifications,
// and counts toward their own performance stats the same as if they were
// the primary assignee (see reporting.js).

/** Current collaborator user ids for a ticket, oldest-added first. */
async function getTicketCollaboratorIds(ticketId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT user_id FROM ticket_collaborators WHERE ticket_id = ? ORDER BY added_at",
    [ticketId]
  );
  return rows.map((r) => r.user_id);
}

/** Replace the full collaborator set for a ticket with exactly `userIds`
 * (dedup'd, and with the primary assignee filtered out - they already have
 * full rights via assigned_to, so listing them again here would just be
 * noise). Returns { added, removed } (arrays of user ids) so the caller
 * (server.js) knows exactly who to push-notify about being newly added -
 * removing someone doesn't get a notification, matching how unassigning
 * assigned_to today doesn't notify anyone either. */
async function setTicketCollaborators(ticketId, userIds, addedBy) {
  const pool = getConnection();
  const [ticketRows] = await pool.query("SELECT assigned_to FROM tickets WHERE id = ?", [ticketId]);
  const primaryAssignee = ticketRows[0] ? ticketRows[0].assigned_to : null;

  const desired = [...new Set((userIds || []).map(Number))].filter(
    (id) => Number.isFinite(id) && id !== Number(primaryAssignee)
  );
  const current = await getTicketCollaboratorIds(ticketId);

  const added = desired.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !desired.includes(id));

  if (removed.length) {
    await pool.query(
      `DELETE FROM ticket_collaborators WHERE ticket_id = ? AND user_id IN (${removed.map(() => "?").join(",")})`,
      [ticketId, ...removed]
    );
  }
  for (const userId of added) {
    await pool.query(
      "INSERT INTO ticket_collaborators (ticket_id, user_id, added_by, added_at) VALUES (?, ?, ?, NOW()) " +
      "ON CONFLICT (ticket_id, user_id) DO NOTHING",
      [ticketId, userId, addedBy]
    );
  }
  return { added, removed };
}

/** True if userId has full rights on this ticket - either the primary
 * assignee or one of its collaborators. `ticket` must include
 * collaborator_ids (see getTicketById/getTickets, which both attach it) -
 * this is a pure in-memory check, no query, so it's cheap to call from
 * every permission gate in server.js. */
function isTicketAssignee(ticket, userId) {
  if (!ticket || !userId) return false;
  const uid = Number(userId);
  if (Number(ticket.assigned_to) === uid) return true;
  return (ticket.collaborator_ids || []).map(Number).includes(uid);
}



/** Return every account, pulling each one's department/branch straight from
 * its role-specific table (not the shared users.branch column) so this
 * reflects the separated storage per role. IT Department accounts also get
 * their comma-separated list of concerns from it_specialties. */
async function getAllUsers() {
  const pool = getConnection();
  const [rows] = await pool.query(`
    SELECT
        u.id, u.username, u.full_name, u.role, u.created_at, u.group_name,
        COALESCE(h.department, b.branch_name,
                 CASE WHEN u.role = 'IT Department' THEN 'IT Department'
                      WHEN u.role = 'Super Admin' THEN 'Super Admin'
                      ELSE u.branch END) AS location,
        sp.specialties
    FROM users u
    LEFT JOIN head_office_employees h ON h.user_id = u.id
    LEFT JOIN branch_staff b ON b.user_id = u.id
    LEFT JOIN (
        SELECT user_id, STRING_AGG(category, ', ' ORDER BY category) AS specialties
        FROM it_specialties GROUP BY user_id
    ) sp ON sp.user_id = u.id
    ORDER BY CASE u.role
        WHEN 'Super Admin' THEN 1
        WHEN 'IT Department' THEN 2
        WHEN 'Head Office Employee' THEN 3
        WHEN 'Branch Staff' THEN 4
        ELSE 5
      END, u.full_name
  `);
  return rows;
}

/** Delete an account. Throws the underlying DB error (e.g. if the user
 * still owns tickets) so the caller can show a friendly message. */
async function deleteUser(userId) {
  const pool = getConnection();
  await pool.query("DELETE FROM users WHERE id = ?", [userId]);
}

// ---------- Tickets ----------

/** Set of IT staff user ids marked absent on forDate (defaults to today,
 * via CURDATE()). */
async function _absentUserIds(conn, forDate = null) {
  const [rows] = await conn.query(
    "SELECT user_id FROM it_absences WHERE absence_date = COALESCE(?, CURRENT_DATE)",
    [forDate]
  );
  return new Set(rows.map((r) => r.user_id));
}

/** How many tickets today someone can trail behind the least-loaded staffer
 * by and still be considered fair game for the next assignment (see
 * _pickBalancedItStaff). Kept above 0 so the pool of eligible staff isn't
 * just "whoever has the single lowest count" - with a gap, several people
 * are all in the running for each new ticket, which keeps everyone getting
 * a turn instead of the assignment ping-ponging strictly to +/-1 ticket. */
const BALANCE_GAP = 2;

/** Pick an IT Department staff id to auto-assign a new ticket to, preferring
 * staff set up to handle this ticket's category (see it_specialties). If
 * nobody covers this category (yet), falls back to the full pool of IT
 * Department staff instead of leaving the ticket unassigned - every new
 * ticket always gets a real assignee as long as at least one IT Department
 * account exists. The same full-pool fallback also applies whenever
 * 'openToAll' is true, regardless of whether specialists exist - currently
 * used for Head Office's "Internet/Network" tickets (see createTicket),
 * since those shouldn't be funneled to just the Internet/Network
 * specialist(s) when any IT Department staffer can help with them. Staff
 * marked absent today (see it_absences) OR whose account-lock
 * (is_available = false) has actually started (a lock scheduled for a
 * future date doesn't count yet - see setAvailability) are skipped so
 * tickets aren't handed to someone who isn't in - unless literally everyone
 * in the pool is out/unavailable, in which case we fall back to assigning
 * normally rather than leaving the ticket unassigned. Among the remaining
 * candidates, balances load by today's new-ticket count only (see doc
 * comment on the old backlog-based approach this replaced) - but rather
 * than requiring an exact tie at the lowest count, anyone within
 * BALANCE_GAP tickets of the least-loaded staffer is treated as equally
 * eligible. A hard "must be the exact minimum" rule meant one ticket
 * resolved elsewhere could instantly swing every subsequent assignment to a
 * single person; a small gap keeps several people in rotation at once so
 * everyone stays actively assisting rather than the queue narrowing down to
 * whoever happens to be lowest at any given instant. Ties/gap-group picks
 * are broken randomly so it's not always the same person. Returns null only
 * if there is no IT Department account at all. */
async function _pickBalancedItStaff(conn, category, openToAll = false, bspGroup = null) {
  // BSP MODE: when the ticket's branch is tagged into a group, narrow the
  // whole candidate pool to staff tagged into that SAME group before doing
  // anything else (specialty matching, availability, load-balancing all
  // still apply on top of this). bspGroup is null in Normal Mode, or when
  // the branch itself isn't tagged yet - either way, no narrowing happens
  // and behavior is unchanged from before BSP MODE existed.
  const groupClause = bspGroup ? " AND u.group_name = ?" : "";
  const groupParams = bspGroup ? [bspGroup] : [];

  let staffRows = [];
  if (!openToAll) {
    const [specialtyRows] = await conn.query(
      "SELECT u.id, u.is_available, u.unavailable_from FROM users u " +
      "JOIN it_specialties s ON s.user_id = u.id " +
      "WHERE u.role = 'IT Department' AND s.category = ?" + groupClause,
      [category, ...groupParams]
    );
    staffRows = specialtyRows;
  }
  if (staffRows.length === 0) {
    // Either nobody is set up for this category, or the caller asked to
    // open this one up to everyone regardless - either way, fall back to
    // every IT Department account (still narrowed to bspGroup, if any)
    // rather than restricting to specialists.
    const [allStaffRows] = await conn.query(
      "SELECT id, is_available, unavailable_from FROM users u WHERE role = 'IT Department'" + groupClause,
      groupParams
    );
    staffRows = allStaffRows;
  }
  if (staffRows.length === 0 && bspGroup) {
    // Nobody at all is tagged into this branch's group yet - rather than
    // leaving the ticket unassigned, fall back to the full IT Department
    // pool (unscoped) so it still gets a real assignee. A Super Admin can
    // reassign it by hand once staff are tagged.
    const [fallbackRows] = await conn.query(
      "SELECT id, is_available, unavailable_from FROM users WHERE role = 'IT Department'"
    );
    staffRows = fallbackRows;
  }
  const staffIds = staffRows.map((r) => r.id);
  if (staffIds.length === 0) return null;

  const today = new Date().toISOString().slice(0, 10);
  const lockedIds = new Set(
    staffRows
      .filter((r) => r.is_available === false && (!r.unavailable_from || r.unavailable_from <= today))
      .map((r) => r.id)
  );

  const absentIds = await _absentUserIds(conn);
  let availableIds = staffIds.filter((sid) => !lockedIds.has(sid) && !absentIds.has(sid));
  if (availableIds.length === 0) availableIds = staffIds;

  // Today's new-ticket count only (see doc comment above) - old open/
  // in-progress backlog from previous days no longer counts against
  // someone when deciding who gets the next ticket.
  const [loadRows] = await conn.query(
    "SELECT assigned_to, COUNT(*) AS cnt FROM tickets " +
    "WHERE assigned_to IS NOT NULL AND created_at::date = CURRENT_DATE " +
    "GROUP BY assigned_to"
  );
  const load = {};
  for (const row of loadRows) load[row.assigned_to] = row.cnt;

  const minCount = Math.min(...availableIds.map((sid) => load[sid] || 0));
  const eligible = availableIds.filter((sid) => (load[sid] || 0) <= minCount + BALANCE_GAP);
  return randomChoice(eligible);
}

/** Create a ticket and auto-assign it to an IT Department staff member,
 * balanced by current workload (see _pickBalancedItStaff). Normally only
 * staff who cover this category (see it_specialties) are eligible - except
 * a Head Office Employee's "Internet/Network" ticket, which is opened to
 * every IT Department staffer regardless of specialty, since network
 * issues raised from Head Office shouldn't be funneled to just the
 * Internet/Network specialist(s) when anyone on the team can help.
 * 'creatorRole' is createdBy's role, used only for that check. 'concernName'
 * is the full name of the person the issue was actually raised for (e.g.
 * the branch employee having the problem), which may be different from
 * 'createdBy' (the account submitting the ticket). 'anydeskNumber'/
 * 'branchNumber' are optional free-text extras (an AnyDesk remote-access
 * ID, and a branch number/code) a Branch Staff member can attach for IT's
 * convenience - neither is validated or used for routing. Returns { id,
 * assignedTo } - assignedTo is only null if there's no IT Department
 * account at all yet; otherwise the ticket always comes out auto-assigned
 * (falling back across categories/availability as needed - see
 * _pickBalancedItStaff). The caller uses assignedTo to push a "new ticket
 * assigned to you" desktop notification without a second lookup. */
async function createTicket(title, description, category, priority, branch, createdBy, creatorRole = null,
  concernName = null, anydeskNumber = null, branchNumber = null, isProvince = false, assignedToOverride = null) {
  const pool = getConnection();
  const openToAll = creatorRole === "Head Office Employee" && category === "Internet/Network";
  // BSP MODE: if it's on, look up this branch's group so auto-assignment
  // can be narrowed to staff tagged into the same group (see
  // _pickBalancedItStaff). In Normal Mode (the default), bspGroup stays
  // null and nothing changes from before BSP MODE existed.
  const bspGroup = (await getSystemMode()) === "bsp" ? await getBranchStaffGroup(branch) : null;
  // A Super Admin submitting the ticket themselves can hand-pick who
  // receives it instead of going through balanced auto-assignment (see
  // server.js's POST /api/tickets, which only honors this override for
  // that role and validates it's a real IT staff id first).
  const assigneeId = assignedToOverride || await _pickBalancedItStaff(pool, category, openToAll, bspGroup);
  const [rows] = await pool.query(
    "INSERT INTO tickets (title, description, category, priority, status, branch, " +
    "concern_name, anydesk_number, branch_number, is_province, created_by, assigned_to, created_at, updated_at, assigned_at) " +
    "VALUES (?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW()) RETURNING id",
    [title, description, category, priority, branch, concernName, anydeskNumber, branchNumber, isProvince, createdBy, assigneeId]
  );
  return { id: rows[0].id, assignedTo: assigneeId };
}

// ---------- Ticket attachments (optional images the requester uploads) ----------

/** Record one image file that's already been copied to disk (see
 * server.ATTACHMENTS_DIR) as belonging to this ticket. */
async function addTicketAttachment(ticketId, filePath, originalFilename) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO ticket_attachments (ticket_id, file_path, original_filename, uploaded_at) " +
    "VALUES (?, ?, ?, NOW())",
    [ticketId, filePath, originalFilename]
  );
}

/** Every image attached to this ticket, oldest first. */
async function getTicketAttachments(ticketId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY uploaded_at",
    [ticketId]
  );
  return rows;
}

/** Return tickets visible to the given role, with optional filters.
 * assignedToFilter narrows to one specific assignee - used by the
 * "N tickets need assistance" dashboard notification to deep-link straight
 * to an absent staff member's pending tickets. dateFilter narrows to
 * tickets RECEIVED (created) on one specific calendar day ("YYYY-MM-DD"),
 * so a viewer can check "what came in today/that day" regardless of what
 * its current status is. */
async function getTickets({ role, userId = null, statusFilter = null, priorityFilter = null,
  branchFilter = null, searchText = null, assignedToFilter = null, voidStatusFilter = null,
  reopenStatusFilter = null, provinceFilter = null, dateFilter = null, page = null, pageSize = null }) {
  const pool = getConnection();

  let query = `
    FROM tickets t
    JOIN users u ON u.id = t.created_by
    LEFT JOIN users a ON a.id = t.assigned_to
    LEFT JOIN LATERAL (
      SELECT array_agg(tc.user_id ORDER BY tc.added_at) AS collaborator_ids,
             array_agg(cu.full_name ORDER BY tc.added_at) AS collaborator_names
      FROM ticket_collaborators tc
      JOIN users cu ON cu.id = tc.user_id
      WHERE tc.ticket_id = t.id
    ) collab ON TRUE
    WHERE 1=1
  `;
  const params = [];

  // BSP MODE: fetched fresh on every call (not cached on the session) so a
  // Super Admin flipping the mode or retagging a branch/staffer takes
  // effect on this user's very next request. `scope` is null in Normal Mode
  // (and for untagged/non-IT accounts), so nothing below changes then.
  const scope = await getItBranchScope(role, userId);

  if (role === "IT Department") {
    // An IT Department account's default "My Queue" is just their own
    // tickets plus anything not yet assigned to anyone - a colleague's
    // tickets never merge into this everyday view automatically, even if
    // that colleague is absent or locked right now.
    //
    // The one exception is when assignedToFilter explicitly names someone
    // ELSE (not this user) - that only happens via the dashboard's "View &
    // manage tickets" button for a specific absent/locked colleague (see
    // renderDashboard's data-assist-user click handler in app.js), never
    // from browsing the Tickets tab itself. In that case, gate access on
    // that colleague still actually being absent today (it_absences) or
    // account-locked/unavailable (is_available = FALSE, lock already
    // started - same check as getLockedStaff()) at the moment of the
    // query - not just "any ticket assigned to anyone" - so the assist
    // flow can't be used as a backdoor into an active colleague's queue,
    // and so it stops working the instant that colleague comes back.
    if (assignedToFilter && Number(assignedToFilter) !== Number(userId)) {
      query += ` AND t.assigned_to IN (
        SELECT user_id FROM it_absences WHERE absence_date = CURRENT_DATE
        UNION
        SELECT id FROM users
        WHERE role IN ('IT Department', 'Super Admin')
          AND is_available = FALSE
          AND (unavailable_from IS NULL OR unavailable_from <= CURRENT_DATE)
      )`;
    } else if (scope) {
      // BSP MODE: no ownership filter at all - an IT staffer sees EVERY
      // ticket from branches under their Line of Business (any assignee,
      // any status including Resolved), so an auditor looking at their
      // dashboard sees that Line's complete history. Tickets from other
      // Lines are removed by the scope clause added after this block.
    } else {
      query += ` AND (t.assigned_to = ? OR t.assigned_to IS NULL
        OR EXISTS (SELECT 1 FROM ticket_collaborators tc WHERE tc.ticket_id = t.id AND tc.user_id = ?))`;
      params.push(userId, userId);
    }
  } else if (role !== "Super Admin") {
    // Both "Head Office Employee" and "Branch Staff" only see their own tickets
    query += " AND t.created_by = ?";
    params.push(userId);
  }


  // BSP MODE: hard boundary - nothing outside the staffer's Line of Business
  // ever comes back, whatever the queue/assist/filter combination above.
  if (scope) {
    query += scope.clause("t.branch");
    params.push(...scope.params);
  }

  if (statusFilter && statusFilter !== "All") {
    query += " AND t.status = ?";
    params.push(statusFilter);
  }

  if (priorityFilter && priorityFilter !== "All") {
    query += " AND t.priority = ?";
    params.push(priorityFilter);
  }

  if (branchFilter && branchFilter !== "All") {
    query += " AND t.branch = ?";
    params.push(branchFilter);
  }

  if (assignedToFilter) {
    query += " AND t.assigned_to = ?";
    params.push(assignedToFilter);
  }

  if (voidStatusFilter && voidStatusFilter !== "All") {
    query += " AND t.void_status = ?";
    params.push(voidStatusFilter);
  }

  if (reopenStatusFilter && reopenStatusFilter !== "All") {
    query += " AND t.reopen_status = ?";
    params.push(reopenStatusFilter);
  }

  // "Yes" -> only site-visit/province tickets; "No" -> everything else;
  // omitted/"All" -> no filtering by this at all.
  if (provinceFilter === "Yes") {
    query += " AND t.is_province = TRUE";
  } else if (provinceFilter === "No") {
    query += " AND t.is_province = FALSE";
  }

  if (dateFilter) {
    query += " AND t.created_at::date = ?";
    params.push(dateFilter);
  }

  if (searchText) {
    // Every word the user typed must be found SOMEWHERE (title, description,
    // category, priority, status, branch, creator's name, assignee's name,
    // or the ticket number itself) - not necessarily the same field. Lets
    // "critical printer branch a" find a Critical-priority Printer ticket
    // from Branch A even though no single field contains that whole phrase.
    for (const word of searchText.split(/\s+/).filter(Boolean)) {
      const like = `%${word}%`;
      const clauses = [
        "t.title ILIKE ?", "t.description ILIKE ?", "t.category ILIKE ?",
        "t.priority ILIKE ?", "t.status ILIKE ?", "t.branch ILIKE ?",
        "u.full_name ILIKE ?", "a.full_name ILIKE ?",
      ];
      const clauseParams = [like, like, like, like, like, like, like, like];

      // A word containing at least one digit is ALSO checked against the
      // ticket number (t.id) itself - both its raw form and zero-padded to
      // the same 5-digit "#T-00001" format shown throughout the UI (see
      // app.js's ticketCardHtml/openTicketDetail) - so "1", "00001",
      // "T-00001", and "#T-00001" all find ticket #1. Purely alphabetic
      // words (e.g. "printer") skip this: stripping digits from those
      // would leave an empty string, and an empty LIKE '%%' would match
      // every ticket's id, silently defeating the rest of the filter.
      const digits = word.replace(/\D/g, "");
      if (digits) {
        clauses.push("CAST(t.id AS TEXT) LIKE ?", "LPAD(CAST(t.id AS TEXT), 5, '0') LIKE ?");
        clauseParams.push(`%${digits}%`, `%${digits}%`);
      }

      query += ` AND (${clauses.join(" OR ")})`;
      params.push(...clauseParams);
    }
  }

  // Poked tickets jump to the front of the queue (freshest poke first) so a
  // Super Admin's follow-up nudge actually surfaces the ticket instead of
  // just sitting as a badge someone has to notice further down the list.
  // Opening the ticket clears poked_at (see clearPokeFlag), so it falls
  // back into normal newest-first order the moment it's been looked at -
  // this bump is only ever "still needs a look", never a permanent pin.
  //
  // Kept as its own variable rather than appended to `query` - `query` is
  // reused as-is for the paginated COUNT(*) below, and the collaborator
  // LATERAL subquery above already contains its own ORDER BY clauses
  // (inside the array_agg() calls), so any naive "strip the ORDER BY back
  // off `query`" string-surgery would risk matching one of those instead
  // of this one and truncating the count query.
  const orderBy = " ORDER BY t.poked_at DESC NULLS LAST, t.created_at DESC";

  // Pagination is opt-in: pass both page and pageSize to get back
  // { rows, total } (server.js's GET /api/tickets always does, for the
  // "Showing X to Y of Z entries" ticket list); omitting either returns
  // every matching row with total left null, which is what every other
  // caller (dashboard's "recent tickets", performance/report helpers,
  // etc.) still wants - unpaginated, since they either take a fixed slice
  // client-side already or need the whole set to aggregate over.
  if (page && pageSize) {
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total ${query}`, params);
    const total = countRows[0] ? Number(countRows[0].total) || 0 : 0;
    const offset = (Math.max(1, page) - 1) * pageSize;
    const [rows] = await pool.query(
      `SELECT t.*, u.full_name AS creator_name, a.full_name AS assignee_name,
              GREATEST(0, EXTRACT(EPOCH FROM (t.assigned_at + INTERVAL '${STALE_OPEN_MINUTES} minutes' - NOW())))::int AS escalate_in_seconds,
              COALESCE(collab.collaborator_ids, '{}') AS collaborator_ids,
              COALESCE(collab.collaborator_names, '{}') AS collaborator_names
       ${query}${orderBy} LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    return { rows, total };
  }

  const [rows] = await pool.query(
    `SELECT t.*, u.full_name AS creator_name, a.full_name AS assignee_name,
            GREATEST(0, EXTRACT(EPOCH FROM (t.assigned_at + INTERVAL '${STALE_OPEN_MINUTES} minutes' - NOW())))::int AS escalate_in_seconds,
            COALESCE(collab.collaborator_ids, '{}') AS collaborator_ids,
            COALESCE(collab.collaborator_names, '{}') AS collaborator_names
     ${query}${orderBy}`,
    params
  );
  return { rows, total: null };
}

/** True if this user is currently absent (see it_absences) or account-
 * locked (is_available = FALSE, and the lock has actually started - a lock
 * scheduled for a future date doesn't count yet) as of today. Mirrors the
 * absence/lock logic in _pickBalancedItStaff and getTickets' assist-filter
 * subquery, but for a single user - used to gate the "Take over (assist)"
 * action to genuinely-unavailable colleagues (see getTicketById /
 * server.js's assign route) rather than any ticket not one's own. */
async function isUserUnavailableToday(userId) {
  if (!userId) return false;
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT (
       EXISTS (SELECT 1 FROM it_absences WHERE user_id = ? AND absence_date = CURRENT_DATE)
       OR EXISTS (
         SELECT 1 FROM users
         WHERE id = ? AND is_available = FALSE
           AND (unavailable_from IS NULL OR unavailable_from <= CURRENT_DATE)
       )
     ) AS unavailable`,
    [userId, userId]
  );
  return !!(rows[0] && rows[0].unavailable);
}

async function getTicketById(ticketId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT t.*, u.full_name AS creator_name, a.full_name AS assignee_name,
            GREATEST(0, EXTRACT(EPOCH FROM (t.assigned_at + INTERVAL '${STALE_OPEN_MINUTES} minutes' - NOW())))::int AS escalate_in_seconds,
            v.full_name AS void_requested_by_name,
            ro.full_name AS reopen_requested_by_name,
            pk.full_name AS poked_by_name,
            COALESCE(collab.collaborator_ids, '{}') AS collaborator_ids,
            COALESCE(collab.collaborator_names, '{}') AS collaborator_names,
            br.corporation AS branch_corporation,
            EXISTS (
              SELECT 1 FROM it_absences WHERE user_id = t.assigned_to AND absence_date = CURRENT_DATE
              UNION
              SELECT 1 FROM users
              WHERE id = t.assigned_to AND is_available = FALSE
                AND (unavailable_from IS NULL OR unavailable_from <= CURRENT_DATE)
            ) AS assignee_unavailable_today
     FROM tickets t
     JOIN users u ON u.id = t.created_by
     LEFT JOIN users a ON a.id = t.assigned_to
     LEFT JOIN users v ON v.id = t.void_requested_by
     LEFT JOIN users ro ON ro.id = t.reopen_requested_by
     LEFT JOIN users pk ON pk.id = t.poked_by
     LEFT JOIN branches br ON br.name = t.branch
     LEFT JOIN LATERAL (
       SELECT array_agg(tc.user_id ORDER BY tc.added_at) AS collaborator_ids,
              array_agg(cu.full_name ORDER BY tc.added_at) AS collaborator_names
       FROM ticket_collaborators tc
       JOIN users cu ON cu.id = tc.user_id
       WHERE tc.ticket_id = t.id
     ) collab ON TRUE
     WHERE t.id = ?`,
    [ticketId]
  );
  return rows[0] || null;
}

/** Change a ticket's status. Also maintains resolved_at: stamped with NOW()
 * the moment a ticket becomes 'Resolved' (used by the Reporting tab to
 * measure resolution time), and cleared back to NULL if a ticket is ever
 * reopened out of 'Resolved' so a stale timestamp doesn't linger.
 * status_updated_at is stamped every time, independent of resolved_at -
 * it's what getBranchTicketUpdatesCount watches so a branch's "your ticket
 * was updated" notification fires ONLY for an actual status change, never
 * for a comment, reassignment, or void decision (which all still bump the
 * general-purpose updated_at, but not this column). */
async function updateTicketStatus(ticketId, status) {
  const pool = getConnection();
  // escalated_at clears on every status change here too (same reasoning as
  // poked_at right next to it) - moving the ticket off 'Open' (or back onto
  // it via a fresh Resolved->reopen cycle, which restarts the 10-minute
  // clock through assigned_at/status_updated_at) is exactly the "acted on
  // it" signal that should stop the auto-escalation from firing again. See
  // getTicketsNeedingEscalationPush / getStaleOpenTicketIds.
  if (status === "Resolved") {
    await pool.query(
      "UPDATE tickets SET status = ?, updated_at = NOW(), resolved_at = NOW(), status_updated_at = NOW(), " +
      "poked_at = NULL, poked_by = NULL, escalated_at = NULL WHERE id = ?",
      [status, ticketId]
    );
  } else {
    await pool.query(
      "UPDATE tickets SET status = ?, updated_at = NOW(), resolved_at = NULL, status_updated_at = NOW(), " +
      "poked_at = NULL, poked_by = NULL, escalated_at = NULL WHERE id = ?",
      [status, ticketId]
    );
  }
}

/** Flag (or unflag) a ticket as requiring an actual physical/on-site visit
 * (e.g. a province branch too far for remote support) - see the is_province
 * column comment on the tickets table. Purely a note for reporting: it
 * doesn't touch status, assignment, or anything else, and reporting.js
 * excludes flagged tickets from every performance report entirely. */
async function updateTicketProvince(ticketId, isProvince) {
  const pool = getConnection();
  await pool.query(
    "UPDATE tickets SET is_province = ?, updated_at = NOW() WHERE id = ?",
    [isProvince, ticketId]
  );
}

async function assignTicket(ticketId, assigneeId) {
  const pool = getConnection();
  // assigned_at also bumps here (not just on the original auto-assignment
  // in createTicket) so a manual reassignment shows up as a fresh "new
  // ticket assigned to you" notification for the new assignee too - see
  // getNewAssignedTicketsCount.
  // escalated_at also clears here: a reassignment resets the clock via
  // assigned_at (the new assignee gets a fresh 10-minute grace period), so
  // any pacing timestamp from the previous assignee's escalations shouldn't
  // carry over - see getTicketsNeedingEscalationPush.
  await pool.query(
    "UPDATE tickets SET assigned_to = ?, updated_at = NOW(), assigned_at = NOW(), escalated_at = NULL WHERE id = ?",
    [assigneeId, ticketId]
  );
}

/** A Super Admin "poke" - a lightweight nudge for a ticket that's stalled
 * and needs the assignee to actually do something, without changing its
 * status or reassigning it. Stamps poked_at/poked_by so the ticket shows a
 * "flagged for follow-up" banner (see getTicketById's callers in app.js),
 * and the caller (server.js) uses the returned row's assigned_to/title/
 * branch/priority to push the assignee a notification without a second
 * lookup. The flag is cleared automatically the moment the assignee (or
 * anyone) changes the ticket's status or adds a comment - see
 * updateTicketStatus/addComment - so it never lingers past the point it's
 * actually acted on. Returns the updated ticket row, or null if it doesn't
 * exist. */
async function pokeTicket(ticketId, pokedBy) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "UPDATE tickets SET poked_at = NOW(), poked_by = ?, updated_at = NOW() WHERE id = ? RETURNING *",
    [pokedBy, ticketId]
  );
  return rows[0] || null;
}

/** Clear a ticket's poke flag because someone actually opened it (from the
 * follow-up notification, the bell dropdown, or the push notification
 * landing) - the "I saw this and looked at it" counterpart to the
 * status-change/comment clears above. Deliberately does NOT touch
 * updated_at (unlike those two): just viewing a ticket isn't an edit to it,
 * it should just stop showing up as flagged for follow-up. A no-op (no
 * extra query) when the ticket wasn't poked in the first place. */
async function clearPokeFlag(ticketId) {
  const pool = getConnection();
  await pool.query(
    "UPDATE tickets SET poked_at = NULL, poked_by = NULL WHERE id = ? AND poked_at IS NOT NULL",
    [ticketId]
  );
}

// ---------- Void requests (IT Department requests -> Super Admin decides) ----------

/** An IT Department account asks for a ticket to be voided (e.g. it's a
 * duplicate, spam, or turned out unreproducible). Only allowed while the
 * ticket has no live request already (void_status is 'None', or a past
 * request was 'Rejected' - a rejection doesn't block trying again). The
 * WHERE clause double-checks that condition atomically, so two near-
 * simultaneous requests can't both "win"; if nothing matched (someone else
 * already filed a request in the meantime), we throw so the caller can show
 * a friendly error instead of silently doing nothing. */
async function requestVoidTicket(ticketId, requestedBy, reason) {
  const pool = getConnection();
  const [result] = await pool.query(
    "UPDATE tickets SET void_status = 'Requested', void_reason = ?, " +
    "void_requested_by = ?, void_requested_at = NOW(), " +
    "void_decided_by = NULL, void_decided_at = NULL, void_decision_note = NULL, " +
    "updated_at = NOW() " +
    "WHERE id = ? AND void_status IN ('None', 'Rejected')",
    [reason, requestedBy, ticketId]
  );
  if (!result.affectedRows) {
    throw new Error("This ticket already has a pending or approved void request.");
  }
}

/** A Super Admin approves or declines a pending void request. Approving
 * marks the ticket 'Voided' (kept in the system for the audit trail /
 * reporting, just excluded from the active Open/In Progress/Resolved
 * counts - see getTicketStats); declining sets it back to 'Rejected', which
 * still allows the IT staffer to file a fresh request later. Only acts on a
 * ticket currently 'Requested', so a request can't be decided twice.
 * Returns { requestedBy, title } (or null if there was nothing pending to
 * decide) so the caller can notify whoever filed the request. */
async function decideVoidTicket(ticketId, decidedBy, approve, note = null) {
  const pool = getConnection();
  const [result] = await pool.query(
    "UPDATE tickets SET void_status = ?, void_decided_by = ?, void_decided_at = NOW(), " +
    "void_decision_note = ?, updated_at = NOW() " +
    "WHERE id = ? AND void_status = 'Requested' " +
    "RETURNING void_requested_by, title",
    [approve ? "Voided" : "Rejected", decidedBy, note, ticketId]
  );
  if (!result.length) {
    throw new Error("This ticket doesn't have a pending void request to decide.");
  }
  return { requestedBy: result[0].void_requested_by, title: result[0].title };
}

/** Every ticket with a void request still awaiting a Super Admin's
 * decision, oldest first (so the longest-waiting request is handled
 * first) - powers the Super Admin dashboard's "Void requests" panel. */
async function getVoidRequests() {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT t.id, t.title, t.branch, t.priority, t.void_reason, t.void_requested_at,
            r.full_name AS requested_by_name
     FROM tickets t
     JOIN users r ON r.id = t.void_requested_by
     WHERE t.void_status = 'Requested'
     ORDER BY t.void_requested_at`
  );
  return rows;
}

// ---------- Reopen requests (IT Department requests -> Super Admin decides) ----------

/** An IT Department account asks for a Resolved ticket to be reopened
 * because the same issue has come back. Only allowed on a ticket that's
 * currently 'Resolved' and has no live reopen request already (reopen_status
 * is 'None', 'Approved', or 'Rejected' - none of those block trying again;
 * only 'Requested' does). The WHERE clause double-checks both conditions
 * atomically, same pattern as requestVoidTicket, so two near-simultaneous
 * requests can't both "win"; if nothing matched we throw so the caller can
 * show a friendly error instead of silently doing nothing. */
async function requestReopenTicket(ticketId, requestedBy, reason) {
  const pool = getConnection();
  const [result] = await pool.query(
    "UPDATE tickets SET reopen_status = 'Requested', reopen_reason = ?, " +
    "reopen_requested_by = ?, reopen_requested_at = NOW(), " +
    "reopen_decided_by = NULL, reopen_decided_at = NULL, reopen_decision_note = NULL, " +
    "updated_at = NOW() " +
    "WHERE id = ? AND status = 'Resolved' AND reopen_status != 'Requested'",
    [reason, requestedBy, ticketId]
  );
  if (!result.affectedRows) {
    throw new Error("This ticket can't be requested for reopening right now (it may not be Resolved, or already has a pending request).");
  }
}

/** A Super Admin approves or declines a pending reopen request. Approving
 * puts the ticket back to 'In Progress' (staying with whoever's already
 * assigned) via updateTicketStatus, which also clears resolved_at the same
 * way any other move out of 'Resolved' does; declining just records the
 * decision and leaves the ticket Resolved. Either way reopen_status is
 * stamped 'Approved'/'Rejected' for the audit trail/badge, and a 'Rejected'
 * (like void's) still allows a fresh request later. Only acts on a ticket
 * currently 'Requested', so a request can't be decided twice. Returns
 * { requestedBy, title, createdBy } (or throws if nothing was pending) so
 * the caller can notify whoever filed the request and the branch that
 * raised the ticket. */
async function decideReopenTicket(ticketId, decidedBy, approve, note = null) {
  const pool = getConnection();
  const [result] = await pool.query(
    "UPDATE tickets SET reopen_status = ?, reopen_decided_by = ?, reopen_decided_at = NOW(), " +
    "reopen_decision_note = ?, updated_at = NOW() " +
    "WHERE id = ? AND reopen_status = 'Requested' " +
    "RETURNING reopen_requested_by, title, created_by",
    [approve ? "Approved" : "Rejected", decidedBy, note, ticketId]
  );
  if (!result.length) {
    throw new Error("This ticket doesn't have a pending reopen request to decide.");
  }
  if (approve) {
    await updateTicketStatus(ticketId, "In Progress");
  }
  return {
    requestedBy: result[0].reopen_requested_by,
    title: result[0].title,
    createdBy: result[0].created_by,
  };
}

/** Every ticket with a reopen request still awaiting a Super Admin's
 * decision, oldest first - powers the Super Admin dashboard's "Reopen
 * requests" panel, mirroring getVoidRequests. */
async function getReopenRequests() {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT t.id, t.title, t.branch, t.priority, t.reopen_reason, t.reopen_requested_at,
            r.full_name AS requested_by_name
     FROM tickets t
     JOIN users r ON r.id = t.reopen_requested_by
     WHERE t.reopen_status = 'Requested'
     ORDER BY t.reopen_requested_at`
  );
  return rows;
}

/** Same as getReopenRequests, but scoped to tickets actually assigned to
 * this one IT Department account - the "awaiting your decision" queue for
 * the person who'll actually pick the work back up, now that reopen
 * requests are decided by the assignee (not Super-Admin-only). Mirrors
 * getReopenRequests' shape so it can feed the same bell-row/big-alert
 * pattern, just per-user instead of system-wide. */
async function getReopenRequestsForAssignee(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT t.id, t.title, t.branch, t.priority, t.reopen_reason, t.reopen_requested_at,
            r.full_name AS requested_by_name
     FROM tickets t
     JOIN users r ON r.id = t.reopen_requested_by
     WHERE t.reopen_status = 'Requested' AND t.assigned_to = ?
     ORDER BY t.reopen_requested_at`,
    [userId]
  );
  return rows;
}

async function getDistinctBranches() {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT DISTINCT branch FROM tickets ORDER BY branch");
  return rows.map((r) => r.branch);
}

/** Status counts for the dashboard stat cards. Super Admin and IT
 * Department both see every (non-voided) ticket in the system here - IT
 * Department is a team, and this mirrors the "IT Team Performance" widget
 * on the same dashboard, which already shows the whole team rather than
 * just the signed-in person's own numbers. (Their "My Queue" ticket LIST is
 * still scoped down via getTickets - that's a workload view, not a stats
 * view, so it's unaffected by this.) Head Office and Branch Staff accounts
 * are scoped down to just the tickets THEY created, so their dashboard
 * cards reflect their own branch's/department's tickets, not every
 * branch's. */
async function getTicketStats(role = null, userId = null, scope = null) {
  const pool = getConnection();
  // Voided tickets are excluded here so a voided ticket's old status (it
  // keeps whatever Open/In Progress/Resolved value it had when the void
  // request was approved - see decideVoidTicket) doesn't inflate the
  // dashboard's active-ticket counts.
  let query = "SELECT status, COUNT(*) AS cnt FROM tickets t WHERE t.void_status != 'Voided'";
  const params = [];
  if (role && role !== "Super Admin" && role !== "IT Department") {
    query += " AND t.created_by = ?";
    params.push(userId);
  }
  if (scope) {
    query += scope.clause("t.branch");
    params.push(...scope.params);
  }
  query += " GROUP BY status";

  const [rows] = await pool.query(query, params);
  const stats = { Open: 0, "In Progress": 0, Resolved: 0 };
  for (const row of rows) stats[row.status] = row.cnt;
  return stats;
}

// ---------- Branches (Super Admin managed) ----------

/** Return every branch name a Super Admin has set up, alphabetically. This
 * is the single source of truth for every 'Branch' dropdown in the app. */
async function getBranches() {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT name FROM branches ORDER BY name");
  return rows.map((r) => r.name);
}

/** Add a new branch. Throws the underlying DB error (e.g. duplicate name)
 * so the caller can show a friendly message. */
async function addBranch(name, groupName = null, corporation = null, isGlobal = false) {
  const pool = getConnection();
  const corp = groupName ? (corporation || null) : null;
  await pool.query(
    "INSERT INTO branches (name, group_name, corporation, is_global) VALUES (?, ?, ?, ?)",
    [name, groupName || null, corp, corp ? !!isGlobal : false]
  );
}

/** Add many branches at once (e.g. from an imported spreadsheet). Names
 * that already exist are skipped rather than raising an error, so a
 * re-imported/overlapping list is safe to run. Returns how many of the
 * given names were newly added vs already present. */
async function addBranchesBulk(names) {
  const pool = getConnection();
  const existing = new Set(await getBranches());
  let added = 0;
  let skipped = 0;
  for (const name of names) {
    if (existing.has(name)) {
      skipped++;
      continue;
    }
    await pool.query(
      "INSERT INTO branches (name) VALUES (?) ON CONFLICT (name) DO NOTHING",
      [name]
    );
    existing.add(name);
    added++;
  }
  return { added, skipped };
}

/** Remove a branch from the managed list. Existing accounts/tickets that
 * already used this branch name keep it as plain text - only the dropdown
 * list changes. */
async function deleteBranch(name) {
  const pool = getConnection();
  await pool.query("DELETE FROM branches WHERE name = ?", [name]);
}

/** Rename a branch. Unlike delete, this cascades the new name to every
 * place the old name is already stored as plain text - branch_staff, users,
 * and tickets - so existing accounts/tickets stay in sync. All-or-nothing:
 * rolls back if any step fails (e.g. the new name collides with an existing
 * branch). */
async function updateBranch(oldName, newName) {
  const pool = getConnection();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE branches SET name = ? WHERE name = ?", [newName, oldName]);
    await conn.query(
      "UPDATE branch_staff SET branch_name = ? WHERE branch_name = ?",
      [newName, oldName]
    );
    await conn.query("UPDATE users SET branch = ? WHERE branch = ?", [newName, oldName]);
    await conn.query("UPDATE tickets SET branch = ? WHERE branch = ?", [newName, oldName]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------- Departments (Super Admin managed) ----------
// Mirrors the Branches section above exactly, but for Head Office
// departments - see the 'departments' table comment in db.js.

/** Every department name a Super Admin has set up, alphabetically. Single
 * source of truth for every 'Department' dropdown in the app. */
async function getDepartments() {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT name FROM departments ORDER BY name");
  return rows.map((r) => r.name);
}

/** Add a new department. Throws the underlying DB error (e.g. duplicate
 * name) so the caller can show a friendly message. */
async function addDepartment(name) {
  const pool = getConnection();
  await pool.query("INSERT INTO departments (name) VALUES (?)", [name]);
}

/** Remove a department from the managed list. Existing accounts that
 * already used this department name keep it as plain text - only the
 * dropdown list changes. */
async function deleteDepartment(name) {
  const pool = getConnection();
  await pool.query("DELETE FROM departments WHERE name = ?", [name]);
}

/** Rename a department. Cascades the new name to every place the old name
 * is already stored as plain text - head_office_employees and users (for
 * Head Office Employee rows only, since 'users.branch' also holds branch
 * names for Branch Staff) - so existing accounts stay in sync. All-or-
 * nothing: rolls back if any step fails (e.g. the new name collides with an
 * existing department). */
async function updateDepartment(oldName, newName) {
  const pool = getConnection();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE departments SET name = ? WHERE name = ?", [newName, oldName]);
    await conn.query(
      "UPDATE head_office_employees SET department = ? WHERE department = ?",
      [newName, oldName]
    );
    await conn.query(
      "UPDATE users SET branch = ? WHERE branch = ? AND role = 'Head Office Employee'",
      [newName, oldName]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------- Categories (Super Admin managed) ----------
// Mirrors the Branches section above exactly, but for ticket categories -
// see the 'categories' table comment in db.js.

/** Every category name a Super Admin has set up, alphabetically. Single
 * source of truth for the New Ticket "Category" dropdown and the IT Staff
 * specialties checkboxes. */
/** Every category name a Super Admin has set up, in their chosen display
 * order (see moveCategoryUp/Down below) - not alphabetical. Single source
 * of truth for the New Ticket "Category" dropdown and the IT Staff
 * specialties checkboxes. */
async function getCategories() {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT name FROM categories ORDER BY position, name");
  return rows.map((r) => r.name);
}

/** Add a new category. Throws the underlying DB error (e.g. duplicate name)
 * so the caller can show a friendly message. Placed last in display order. */
async function addCategory(name) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO categories (name, position) " +
    "VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM categories))",
    [name]
  );
}

/** Remove a category from the managed list. Existing tickets/specialties
 * that already used this category keep it as plain text - only the
 * dropdown/checkbox list changes. */
async function deleteCategory(name) {
  const pool = getConnection();
  await pool.query("DELETE FROM categories WHERE name = ?", [name]);
}

/** Rename a category. Cascades the new name to every place the old name is
 * already stored as plain text - tickets and it_specialties - so existing
 * tickets and staff specialties stay in sync. All-or-nothing: rolls back if
 * any step fails (e.g. the new name collides with an existing category). */
async function updateCategory(oldName, newName) {
  const pool = getConnection();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE categories SET name = ? WHERE name = ?", [newName, oldName]);
    await conn.query("UPDATE tickets SET category = ? WHERE category = ?", [newName, oldName]);
    // it_specialties has a (user_id, category) primary key - if a staff
    // member somehow already has both the old and new name checked, the old
    // row is now redundant, so drop it instead of failing the whole rename
    // on a PK collision.
    await conn.query(
      "DELETE FROM it_specialties WHERE category = ? AND user_id IN " +
      "(SELECT user_id FROM it_specialties WHERE category = ?)",
      [oldName, newName]
    );
    await conn.query(
      "UPDATE it_specialties SET category = ? WHERE category = ?",
      [newName, oldName]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Swap a category with its neighbor in display order (the Manage
 * Categories panel's up/down arrows). `direction` is 'up' or 'down'; a
 * no-op if the category is already first/last. Shared by
 * moveCategoryUp/moveCategoryDown below. */
async function _swapCategoryPosition(name, direction) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT id, position FROM categories WHERE name = ?", [name]);
  const current = rows[0];
  if (!current) return;

  const cmp = direction === "up" ? "<" : ">";
  const order = direction === "up" ? "DESC" : "ASC";
  const [neighborRows] = await pool.query(
    `SELECT id, position FROM categories WHERE position ${cmp} ? ORDER BY position ${order} LIMIT 1`,
    [current.position]
  );
  const neighbor = neighborRows[0];
  if (!neighbor) return; // already first/last

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE categories SET position = ? WHERE id = ?", [neighbor.position, current.id]);
    await conn.query("UPDATE categories SET position = ? WHERE id = ?", [current.position, neighbor.id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Move a category one place earlier in display order. */
async function moveCategoryUp(name) {
  await _swapCategoryPosition(name, "up");
}

/** Move a category one place later in display order. */
async function moveCategoryDown(name) {
  await _swapCategoryPosition(name, "down");
}

// ---------- Comments ----------

/** A comment (from either side of the conversation) counts as the ticket
 * having been acted on, so clear any pending poke flag the same way a
 * status change does (see updateTicketStatus). */
async function addComment(ticketId, userId, comment) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO comments (ticket_id, user_id, comment, created_at) VALUES (?, ?, ?, NOW())",
    [ticketId, userId, comment]
  );
  await pool.query(
    "UPDATE tickets SET updated_at = NOW(), poked_at = NULL, poked_by = NULL WHERE id = ?",
    [ticketId]
  );
}

async function getComments(ticketId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT c.*, u.full_name, u.role
     FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.ticket_id = ?
     ORDER BY c.created_at ASC`,
    [ticketId]
  );
  return rows;
}

// ---------- Team Workspace: shared files & memos ----------
// Powers the link-library + announcement-board section of the Team
// Workspace tab. "Shared files" are external links (e.g. Google
// Drive/SharePoint), not uploaded files - adding a brand-new link is Super
// Admin-only; editing an existing one's name/URL is open to IT Department
// too (see server's /api/workspace/files* routes for the actual role
// checks - these functions just do the writes/reads). `contentType`/
// `fileSize` are always null now that this is link-only, but the columns
// stay in place so no schema change was needed to make the switch.

/** A brand-new shared link entry. Only ever called for a Super Admin
 * submission - see server's POST /api/workspace/files. `blobUrl` here is
 * the external link itself (despite the column name, kept as-is to avoid a
 * migration), not a Blob-storage URL. */
async function createWorkspaceFile(uploaderId, filename, blobUrl, contentType, fileSize, description) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "INSERT INTO workspace_files " +
    "(original_filename, blob_url, content_type, file_size, description, uploaded_by, created_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, NOW()) RETURNING id",
    [filename, blobUrl, contentType || null, fileSize || null, description || null, uploaderId]
  );
  return rows[0].id;
}

/** Every shared file, newest first, with the uploader's and last updater's
 * names joined in for display. */
async function listWorkspaceFiles() {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT f.*, up.full_name AS uploaded_by_name, ud.full_name AS updated_by_name
     FROM workspace_files f
     JOIN users up ON up.id = f.uploaded_by
     LEFT JOIN users ud ON ud.id = f.updated_by
     ORDER BY f.created_at DESC`
  );
  return rows;
}

async function getWorkspaceFileById(id) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT * FROM workspace_files WHERE id = ?", [id]);
  return rows[0] || null;
}

/** Update a shared link's name/URL (same entry, new value) - open to IT
 * Department as well as Super Admin. Snapshots the row's current name/URL
 * into workspace_file_versions before overwriting it, so old versions stay
 * recoverable/auditable, then bumps `version`. */
async function updateWorkspaceFileContent(fileId, updaterId, filename, blobUrl, contentType, fileSize) {
  const pool = getConnection();
  const existing = await getWorkspaceFileById(fileId);
  if (!existing) return null;

  await pool.query(
    "INSERT INTO workspace_file_versions " +
    "(file_id, version, original_filename, blob_url, content_type, file_size, changed_by, changed_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, NOW())",
    [fileId, existing.version, existing.original_filename, existing.blob_url,
      existing.content_type, existing.file_size, updaterId]
  );

  await pool.query(
    "UPDATE workspace_files SET original_filename = ?, blob_url = ?, content_type = ?, file_size = ?, " +
    "updated_by = ?, updated_at = NOW(), version = version + 1 WHERE id = ?",
    [filename, blobUrl, contentType || null, fileSize || null, updaterId, fileId]
  );
  return true;
}

/** Past versions of a file, most recent first - powers a "version history"
 * link/modal for a file row. */
async function getWorkspaceFileVersions(fileId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT v.*, u.full_name AS changed_by_name
     FROM workspace_file_versions v
     JOIN users u ON u.id = v.changed_by
     WHERE v.file_id = ?
     ORDER BY v.version DESC`,
    [fileId]
  );
  return rows;
}

/** Super Admin-only cleanup - removes the entry and (via ON DELETE CASCADE)
 * its version history. */
async function deleteWorkspaceFile(id) {
  const pool = getConnection();
  await pool.query("DELETE FROM workspace_files WHERE id = ?", [id]);
}

/** Post a memo/announcement (Branch Opening, Branch Closed, Memorandum,
 * Other Announcement) - Super Admin-only, see server's POST
 * /api/workspace/memos. `imageUrl` is optional - a Blob URL for a photo
 * attached to the memo (e.g. a picture of the branch being opened), shown
 * inline wherever the memo is displayed. */
async function createWorkspaceMemo(posterId, memoType, title, body, imageUrl) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "INSERT INTO workspace_memos (memo_type, title, body, image_url, posted_by, created_at) " +
    "VALUES (?, ?, ?, ?, ?, NOW()) RETURNING id",
    [memoType, title, body || null, imageUrl || null, posterId]
  );
  return rows[0].id;
}

async function listWorkspaceMemos() {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT m.*, u.full_name AS posted_by_name
     FROM workspace_memos m
     JOIN users u ON u.id = m.posted_by
     ORDER BY m.created_at DESC`
  );
  return rows;
}

async function deleteWorkspaceMemo(id) {
  const pool = getConnection();
  await pool.query("DELETE FROM workspace_memos WHERE id = ?", [id]);
}

/** Log a new IT Request (Team Workspace -> IT Request) - any IT Department
 * or Super Admin account can raise one for themselves, see server's POST
 * /api/workspace/it-requests. `branches` is an array of one or more branch
 * names (a request can concern more than one branch), stored as JSON.
 * `imageUrl` is optional - a Blob URL for a photo attached to the request
 * (e.g. a picture of the issue), shown inline wherever the request is
 * displayed. */
async function createITRequest(requestedBy, requestDate, branches, description, imageUrl) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "INSERT INTO it_requests (request_date, branches, description, image_url, requested_by, created_at) " +
    "VALUES (?, ?, ?, ?, ?, NOW()) RETURNING id",
    [requestDate, JSON.stringify(branches), description, imageUrl || null, requestedBy]
  );
  return rows[0].id;
}

/** Parses one it_requests row's stored `branches` JSON back into a plain
 * array, tolerating rows from before this column existed as JSON (falls
 * back to a single-item array of the raw string). */
function parseRequestBranches(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch (e) {
    return [raw];
  }
}

/** All logged IT Requests, most recently requested first, with the
 * requester's name attached and `branches` parsed back into an array -
 * powers the Team Workspace "IT Request" list for both Super Admin and IT
 * Department (view-only for requests raised by a teammate). Optionally
 * scoped to [startDate, endDate] (inclusive, by request_date) - omit both
 * for the full unfiltered log. */
async function listITRequests(startDate = null, endDate = null) {
  const pool = getConnection();
  let query = `SELECT r.*, u.full_name AS requested_by_name
               FROM it_requests r
               JOIN users u ON u.id = r.requested_by`;
  const params = [];
  if (startDate && endDate) {
    query += " WHERE r.request_date BETWEEN ? AND ?";
    params.push(startDate, endDate);
  }
  query += " ORDER BY r.request_date DESC, r.created_at DESC";
  const [rows] = await pool.query(query, params);
  return rows.map((r) => ({ ...r, branches: parseRequestBranches(r.branches) }));
}

/** Look up a single IT Request by id (used to check who raised it before
 * allowing a delete). */
async function getITRequestById(id) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT * FROM it_requests WHERE id = ?", [id]);
  if (!rows[0]) return null;
  return { ...rows[0], branches: parseRequestBranches(rows[0].branches) };
}

async function deleteITRequest(id) {
  const pool = getConnection();
  await pool.query("DELETE FROM it_requests WHERE id = ?", [id]);
}

// ---------- Team Workspace: Item Borrowing ----------
// A catalog IT maintains (borrow_items) plus a log of who currently has
// what (item_borrows). See db.js's table comments for the shape and
// server's /api/borrow-items* / /api/item-borrows* / /api/workspace/
// item-borrows* routes for who's allowed to do what.

/** The full item catalog, alphabetically - powers both the Super Admin
 * "manage items" panel and the Head Office Employee/IT Department "pick
 * an item to borrow" list. */
async function listBorrowItems() {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT * FROM borrow_items ORDER BY name");
  return rows;
}

async function getBorrowItemById(id) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT * FROM borrow_items WHERE id = ?", [id]);
  return rows[0] || null;
}

/** Add a new item to the catalog. total_quantity and available_quantity
 * start equal, since nothing's been borrowed yet. */
async function createBorrowItem(name, description, quantity, userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "INSERT INTO borrow_items (name, description, total_quantity, available_quantity, created_by, created_at) " +
    "VALUES (?, ?, ?, ?, ?, NOW()) RETURNING id",
    [name, description || null, quantity, quantity, userId]
  );
  return rows[0].id;
}

/** Edit an existing item's name/description/total quantity. Currently-
 * borrowed units (total - available) are preserved across the change -
 * available_quantity is recomputed as newTotal - currentlyBorrowed rather
 * than overwritten outright, so shrinking or growing the total doesn't
 * clobber what's actually out. Throws if newTotal would be less than what's
 * currently borrowed (the caller should surface that as a friendly error). */
async function updateBorrowItem(id, name, description, totalQuantity, userId) {
  const pool = getConnection();
  const existing = await getBorrowItemById(id);
  if (!existing) throw new Error("Item not found.");
  const currentlyBorrowed = existing.total_quantity - existing.available_quantity;
  if (totalQuantity < currentlyBorrowed) {
    throw new Error(`Quantity can't be less than ${currentlyBorrowed}, the amount currently borrowed.`);
  }
  await pool.query(
    "UPDATE borrow_items SET name = ?, description = ?, total_quantity = ?, available_quantity = ?, " +
    "updated_by = ?, updated_at = NOW() WHERE id = ?",
    [name, description || null, totalQuantity, totalQuantity - currentlyBorrowed, userId, id]
  );
}

/** Remove an item from the catalog entirely. Past borrow records referring
 * to it keep their snapshotted item_name and just lose the item_id link
 * (ON DELETE SET NULL) - history stays readable. */
async function deleteBorrowItem(id) {
  const pool = getConnection();
  await pool.query("DELETE FROM borrow_items WHERE id = ?", [id]);
}

/** Record a new borrow request and reserve it against the item's
 * available_quantity in one transaction, so two departments can't both
 * count on the same last unit while the request is still pending. Starts
 * out 'Pending' - a Super Admin still has to approve
 * it (see decideItemBorrow) before it's actually handed out; denying it
 * later releases the reservation back to available_quantity. `department`
 * and `borrowedBy` come from the logged-in account making the request
 * (a Head Office Employee, or an IT Department account borrowing for
 * itself) - server derives them, never trusts client input for who's
 * borrowing;
 * `borrowerName` is the actual staff member on the ground using the item,
 * which the department account types in per-request since one department
 * login is shared by several people.
 * Throws a friendly error if the item doesn't exist or doesn't have enough
 * available. */
async function createItemBorrow(itemId, quantity, department, borrowedBy, borrowerName, borrowDate, expectedReturnDate, notes) {
  const pool = getConnection();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT * FROM borrow_items WHERE id = ? FOR UPDATE", [itemId]);
    const item = rows[0];
    if (!item) throw new Error("Item not found.");
    if (quantity > item.available_quantity) {
      throw new Error(`Only ${item.available_quantity} of "${item.name}" available right now.`);
    }
    await conn.query(
      "UPDATE borrow_items SET available_quantity = available_quantity - ? WHERE id = ?",
      [quantity, itemId]
    );
    const [inserted] = await conn.query(
      "INSERT INTO item_borrows (item_id, item_name, quantity, department, borrowed_by, borrower_name, borrow_date, " +
      "expected_return_date, return_date, status, notes, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'Pending', ?, NOW()) RETURNING id",
      [itemId, item.name, quantity, department, borrowedBy, borrowerName, borrowDate, expectedReturnDate || null, notes || null]
    );
    await conn.commit();
    return inserted[0].id;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** A Super Admin approves or denies a pending borrow
 * request. Approving just flips the status to 'Borrowed' - the requested
 * quantity was already reserved out of available_quantity when the request
 * was filed (see createItemBorrow), so nothing further to deduct. Denying
 * flips it to 'Denied' and releases that reservation back to the item's
 * available_quantity, and requires a `note` explaining why (the caller
 * should validate this before calling in - enforced here too as a
 * safety net). Only acts on a request currently 'Pending', so one can't be
 * decided twice. Returns { requestedBy, itemName, quantity } (or throws if
 * nothing was pending) so the caller can notify whoever filed it. */
async function decideItemBorrow(id, decidedBy, approve, note = null) {
  if (!approve && !note) {
    throw new Error("Please explain why this borrow request is being denied.");
  }
  const pool = getConnection();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT * FROM item_borrows WHERE id = ? FOR UPDATE", [id]);
    const borrow = rows[0];
    if (!borrow) throw new Error("Borrow request not found.");
    if (borrow.status !== "Pending") throw new Error("This borrow request has already been decided.");
    await conn.query(
      "UPDATE item_borrows SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ? WHERE id = ?",
      [approve ? "Borrowed" : "Denied", decidedBy, note, id]
    );
    if (!approve && borrow.item_id) {
      await conn.query(
        "UPDATE borrow_items SET available_quantity = available_quantity + ? WHERE id = ?",
        [borrow.quantity, borrow.item_id]
      );
    }
    await conn.commit();
    return { requestedBy: borrow.borrowed_by, itemName: borrow.item_name, quantity: borrow.quantity };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Every borrow request still awaiting a Super Admin
 * decision, oldest first (so the longest-waiting request is handled
 * first) - powers the admin notification bell's "pending borrow requests"
 * count/deep-link, mirroring getVoidRequests. */
async function getPendingItemBorrows() {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT b.*, u.full_name AS borrowed_by_name
     FROM item_borrows b
     JOIN users u ON u.id = b.borrowed_by
     WHERE b.status = 'Pending'
     ORDER BY b.created_at`
  );
  return rows;
}

/** The borrow log, most recently borrowed first, with the borrower's name
 * attached. Optionally scoped to [startDate, endDate] (inclusive, by
 * borrow_date) and/or a single `department` - omit a filter to leave it
 * unscoped. Powers both the Super Admin "records" table
 * (unfiltered or date-filtered) and a requesting account's own borrow
 * history (department-filtered to just their own). */
async function listItemBorrows(startDate = null, endDate = null, department = null) {
  const pool = getConnection();
  let query = `SELECT b.*, u.full_name AS borrowed_by_name
               FROM item_borrows b
               JOIN users u ON u.id = b.borrowed_by`;
  const clauses = [];
  const params = [];
  if (startDate && endDate) {
    clauses.push("b.borrow_date BETWEEN ? AND ?");
    params.push(startDate, endDate);
  }
  if (department) {
    clauses.push("b.department = ?");
    params.push(department);
  }
  if (clauses.length) query += " WHERE " + clauses.join(" AND ");
  query += " ORDER BY b.borrow_date DESC, b.created_at DESC";
  const [rows] = await pool.query(query, params);
  return rows;
}

async function getItemBorrowById(id) {
  const pool = getConnection();
  const [rows] = await pool.query("SELECT * FROM item_borrows WHERE id = ?", [id]);
  return rows[0] || null;
}

/** Mark a borrow returned and restock the item in one transaction - a
 * no-op restock (item_id is NULL) if the catalog item was since deleted.
 * Throws if this borrow is already marked returned. */
async function markItemBorrowReturned(id) {
  const pool = getConnection();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT * FROM item_borrows WHERE id = ? FOR UPDATE", [id]);
    const borrow = rows[0];
    if (!borrow) throw new Error("Borrow record not found.");
    if (borrow.status !== "Borrowed") throw new Error("Only an approved, currently-borrowed item can be marked returned.");
    await conn.query(
      "UPDATE item_borrows SET status = 'Returned', return_date = NOW() WHERE id = ?",
      [id]
    );
    if (borrow.item_id) {
      await conn.query(
        "UPDATE borrow_items SET available_quantity = available_quantity + ? WHERE id = ?",
        [borrow.quantity, borrow.item_id]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Delete a borrow record outright (e.g. it was logged by mistake, or the
 * requester wants to cancel their own still-pending request) - restocks
 * the item first if its quantity is still reserved (status 'Pending' or
 * 'Borrowed' - a 'Denied' or 'Returned' record already released/returned
 * its reservation, so there's nothing left to restock for those), so the
 * catalog's available count doesn't end up permanently short. */
async function deleteItemBorrow(id) {
  const pool = getConnection();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT * FROM item_borrows WHERE id = ? FOR UPDATE", [id]);
    const borrow = rows[0];
    if (!borrow) throw new Error("Borrow record not found.");
    if ((borrow.status === "Borrowed" || borrow.status === "Pending") && borrow.item_id) {
      await conn.query(
        "UPDATE borrow_items SET available_quantity = available_quantity + ? WHERE id = ?",
        [borrow.quantity, borrow.item_id]
      );
    }
    await conn.query("DELETE FROM item_borrows WHERE id = ?", [id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** How many files (new or updated) and memos have appeared since this user
 * last opened each respective section - drives the nav "dot" the same way
 * absent/pending-request counts do elsewhere, but per-section (Shared
 * Files vs Memos) rather than one combined count, so a new memo lights up
 * "Memos" specifically instead of just the "Team Workspace" group. A user
 * who's never opened a section yet (no files_seen_at/memos_seen_at row)
 * sees everything currently posted in that section as unread. Returns
 * {files, memos}. */
async function getWorkspaceUnreadCount(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT
        (SELECT COUNT(*) FROM workspace_files f
          WHERE GREATEST(f.created_at, COALESCE(f.updated_at, f.created_at)) > COALESCE(
            (SELECT files_seen_at FROM workspace_reads WHERE user_id = ?), 'epoch'::timestamp)) AS files,
        (SELECT COUNT(*) FROM workspace_memos m
          WHERE m.created_at > COALESCE(
            (SELECT memos_seen_at FROM workspace_reads WHERE user_id = ?), 'epoch'::timestamp)) AS memos`,
    [userId, userId]
  );
  const r = rows[0] || { files: 0, memos: 0 };
  return { files: r.files || 0, memos: r.memos || 0 };
}

/** Marks "now" as this user's last-seen point for one Team Workspace
 * section - called when they open "Shared Files" or "Memos", so only that
 * section's previously-unread items stop counting (the other section's dot
 * is untouched). `section` is "files" or "memos". */
async function markWorkspaceSeen(userId, section) {
  const pool = getConnection();
  const column = section === "memos" ? "memos_seen_at" : "files_seen_at";
  await pool.query(
    `INSERT INTO workspace_reads (user_id, ${column}) VALUES (?, NOW()) ` +
    `ON CONFLICT (user_id) DO UPDATE SET ${column} = NOW()`,
    [userId]
  );
}

// ---------- Notification bell "seen" state (topbar bell in app.js) ----------
// See db.js's notification_reads table comment for the two shapes of
// category tracked here. Every function below is scoped to a single
// user_id, since each IT staff member's/Super Admin's notifications - and
// what they've each individually acknowledged - are entirely their own.

const COUNT_NOTIF_CATEGORIES = ["availability", "device", "void", "assist", "reopen"];

/** This user's last-acknowledged value for each "live pending count"
 * category (availability/device/void/assist) - 0 for any category they've
 * never acknowledged. Compared against the current live count in
 * server.js's /api/stats to decide whether that category is still
 * "unseen" for the bell badge - see markCountNotifSeen below. */
async function getNotificationSeenCounts(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT availability_seen_count, device_seen_count, void_seen_count, assist_seen_count, reopen_seen_count " +
    "FROM notification_reads WHERE user_id = ?",
    [userId]
  );
  const r = rows[0] || {};
  return {
    availability: r.availability_seen_count || 0,
    device: r.device_seen_count || 0,
    void: r.void_seen_count || 0,
    assist: r.assist_seen_count || 0,
    reopen: r.reopen_seen_count || 0,
  };
}

/** Record the count this user just acknowledged for one "live pending
 * count" category, so it stops counting toward their bell badge until the
 * live count changes again - and, unlike the old client-only tracking,
 * survives a page refresh since it's stored here rather than in a JS
 * variable. `category` must be one of COUNT_NOTIF_CATEGORIES. */
async function markCountNotifSeen(userId, category, count) {
  if (!COUNT_NOTIF_CATEGORIES.includes(category)) {
    throw new Error(`Unknown notification category: ${category}`);
  }
  const pool = getConnection();
  const column = `${category}_seen_count`;
  await pool.query(
    `INSERT INTO notification_reads (user_id, ${column}) VALUES (?, ?) ` +
    `ON CONFLICT (user_id) DO UPDATE SET ${column} = EXCLUDED.${column}`,
    [userId, count]
  );
}

/** Tickets currently flagged by a Super Admin "poke" (see pokeTicket) that
 * are assigned to this user - the notification-bell counterpart to the
 * push notification server.js's /api/tickets/:id/poke sends the assignee.
 * Action-queue style, like the assist/void/reopen bell rows: stays flagged
 * for as long as poked_at is set on the ticket, which is cleared
 * automatically the moment it's acted on (see updateTicketStatus/
 * addComment) - there's nothing to separately "mark seen" here. */
async function getPokedOwnTicketIds(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT id FROM tickets t
     WHERE t.poked_at IS NOT NULL
       AND (t.assigned_to = ? OR EXISTS (
         SELECT 1 FROM ticket_collaborators tc WHERE tc.ticket_id = t.id AND tc.user_id = ?
       ))
     ORDER BY poked_at DESC`,
    [userId, userId]
  );
  return rows.map((r) => r.id);
}

// How long a ticket can sit 'Open' after becoming its assignee's (see
// assigned_at) before the automatic escalation kicks in - both for the
// in-app banner/bell (getStaleOpenTicketIds) and the repeating push
// notification (getTicketsNeedingEscalationPush).
const STALE_OPEN_MINUTES = 10;

// How long after a ticket becomes Resolved its creator/assignee can still
// request a reopen - after this window a recurrence needs a fresh ticket
// instead, so a resolved issue can't be quietly kept alive indefinitely.
// Mirrored client-side in app.js's canRequestReopen (the button just
// doesn't render past the window) - this is the authoritative, server-side
// copy, enforced in server.js's /reopen/request route via
// isWithinReopenWindow below.
const REOPEN_WINDOW_HOURS = 24;

/** Whether ticket t is still within its reopen window - Resolved, with
 * resolved_at set, and less than REOPEN_WINDOW_HOURS old. */
function isWithinReopenWindow(t) {
  if (!t.resolved_at) return false;
  const resolvedAt = new Date(t.resolved_at).getTime();
  return Date.now() - resolvedAt <= REOPEN_WINDOW_HOURS * 60 * 60 * 1000;
}

/** This user's own assigned tickets that have sat in 'Open' status for
 * STALE_OPEN_MINUTES or more since becoming theirs - the automatic,
 * always-on counterpart to a Super Admin's manual poke
 * (getPokedOwnTicketIds just above), which is what drives app.js's
 * top-of-app escalation banner as well as its bell row. Recomputed fresh
 * from assigned_at on every call, so it's accurate to the second regardless
 * of when the push-notification sweep last ran (see
 * getTicketsNeedingEscalationPush/markEscalated, which only pace the push,
 * not this). Clears itself the moment the ticket's status changes or it's
 * reassigned, since both reset the columns this query reads (see
 * updateTicketStatus/assignTicket). Excludes Voided tickets - a ticket a
 * Super Admin has voided isn't meant to be worked at all, so it shouldn't
 * nag its (former) assignee just for having sat Open. */
async function getStaleOpenTicketIds(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT id FROM tickets
     WHERE assigned_to = ? AND status = 'Open'
       AND assigned_at IS NOT NULL
       AND assigned_at <= NOW() - INTERVAL '${STALE_OPEN_MINUTES} minutes'
       AND void_status != 'Voided'
     ORDER BY assigned_at ASC`,
    [userId]
  );
  return rows.map((r) => r.id);
}

/** Tickets due for their next auto-escalation push - still 'Open'
 * STALE_OPEN_MINUTES after becoming the assignee's, and either never
 * escalated before or not escalated again in the last STALE_OPEN_MINUTES
 * (see markEscalated, which stamps escalated_at every time this fires, so
 * the same ticket gets re-pushed roughly once per 10-minute window rather
 * than on every sweep). Called from server.js's escalation sweep, which
 * piggybacks on the existing /api/stats poll traffic since this app has no
 * real background cron (see server.js's runEscalationSweep for why). A
 * ticket drops out of this list the instant its status changes or it's
 * reassigned - both clear escalated_at (see updateTicketStatus/
 * assignTicket) - so a resolved/in-progress/reassigned ticket never lingers
 * here. Also excludes Voided tickets, same reasoning as
 * getStaleOpenTicketIds above. Returns full rows (not just ids): the caller
 * needs assigned_to/ title/branch/priority to build the push payload
 * without a second lookup per ticket. */
async function getTicketsNeedingEscalationPush() {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT id, assigned_to, title, branch, priority FROM tickets
     WHERE status = 'Open' AND assigned_to IS NOT NULL
       AND assigned_at IS NOT NULL
       AND assigned_at <= NOW() - INTERVAL '${STALE_OPEN_MINUTES} minutes'
       AND (escalated_at IS NULL OR escalated_at <= NOW() - INTERVAL '${STALE_OPEN_MINUTES} minutes')
       AND void_status != 'Voided'
     ORDER BY assigned_at ASC`
  );
  return rows;
}

/** Tiny change-detector for the live ticket refresh (app.js syncTickets).
 * Returns a string that changes whenever any ticket's status, assignee,
 * void/reopen state, province flag or updated_at changes, or a ticket is
 * added/removed - so an admin's open Tickets list/dashboard can reload
 * itself when IT staff move a ticket to In Progress/Resolved, instead of
 * needing a manual refresh. `scope` is the BSP-mode branch scope from
 * getItBranchScope (null = every ticket). */
async function getTicketSyncFingerprint(scope) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n,
            COALESCE(MD5(STRING_AGG(
              t.id || ':' || t.status || ':' || COALESCE(t.assigned_to::text, '') || ':' ||
              t.void_status || ':' || t.reopen_status || ':' || t.is_province::text || ':' ||
              COALESCE(EXTRACT(EPOCH FROM t.updated_at)::text, '') || ':' ||
              COALESCE(EXTRACT(EPOCH FROM t.status_updated_at)::text, ''),
              ',' ORDER BY t.id)), '') AS h
     FROM tickets t
     WHERE TRUE${scope ? scope.clause("t.branch") : ""}`,
    scope ? [...scope.params] : []
  );
  return `${rows[0].n}-${rows[0].h}`;
}

/** Stamp a ticket as just having been auto-escalated (see
 * getTicketsNeedingEscalationPush), so it isn't picked up again until
 * another full STALE_OPEN_MINUTES has passed. */
async function markEscalated(ticketId) {
  const pool = getConnection();
  await pool.query("UPDATE tickets SET escalated_at = NOW() WHERE id = ?", [ticketId]);
}

/** How many tickets are newly assigned to this user since they last opened
 * "Tickets" (or otherwise acknowledged this notification) - the
 * ticket-notification counterpart to getWorkspaceUnreadCount's unread
 * files/memos. Per-user by definition (t.assigned_to = userId), so each IT
 * staff member only ever sees a count for tickets actually assigned to
 * them, never a colleague's. A user who's never opened Tickets yet sees
 * every ticket currently assigned to them as new. */
async function getNewAssignedTicketsCount(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `WITH seen AS (
       SELECT COALESCE((SELECT tickets_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp) AS ts
     )
     SELECT COUNT(*) AS count FROM (
       SELECT t.id FROM tickets t, seen WHERE t.assigned_to = ? AND t.assigned_at > seen.ts
       UNION
       SELECT tc.ticket_id FROM ticket_collaborators tc, seen WHERE tc.user_id = ? AND tc.added_at > seen.ts
     ) x`,
    [userId, userId, userId]
  );
  return rows[0] ? rows[0].count || 0 : 0;
}

/** Same as getNewAssignedTicketsCount, but returns the actual ticket ids
 * (newest-assigned first) instead of just a count. Lets the notification
 * bell open the ticket directly when there's exactly one, instead of only
 * being able to point at the Tickets tab in general. */
async function getNewAssignedTicketIds(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `WITH seen AS (
       SELECT COALESCE((SELECT tickets_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp) AS ts
     )
     SELECT id FROM (
       SELECT t.id, t.assigned_at AS changed_at FROM tickets t, seen WHERE t.assigned_to = ? AND t.assigned_at > seen.ts
       UNION
       SELECT tc.ticket_id AS id, tc.added_at AS changed_at FROM ticket_collaborators tc, seen
        WHERE tc.user_id = ? AND tc.added_at > seen.ts
     ) x
     ORDER BY changed_at DESC`,
    [userId, userId, userId]
  );
  return rows.map((r) => r.id);
}

/** Marks "now" as this user's last-seen point for their assigned-tickets
 * notification - called when they open the Tickets tab, mirroring
 * markWorkspaceSeen for Shared Files/Memos. */
async function markTicketsNotifSeen(userId) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO notification_reads (user_id, tickets_seen_at) VALUES (?, NOW()) " +
    "ON CONFLICT (user_id) DO UPDATE SET tickets_seen_at = NOW()",
    [userId]
  );
}

/** How many of this Branch Staff account's own submitted tickets have had
 * their STATUS changed since they last opened "Tickets" - the Branch-side
 * counterpart to getNewAssignedTicketsCount above. Deliberately scoped to
 * status_updated_at only (see updateTicketStatus) rather than the general
 * updated_at column, so a comment, reassignment, or void decision never
 * notifies the branch - status is the only thing they're notified about,
 * matching /api/tickets/:id/status being the only route that pushes to
 * them. `t.status_updated_at IS NOT NULL` excludes tickets that have never
 * had a status change at all. */
async function getBranchTicketUpdatesCount(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM tickets t
      WHERE t.created_by = ?
        AND t.status_updated_at IS NOT NULL
        AND t.status_updated_at > COALESCE(
          (SELECT branch_updates_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp)`,
    [userId, userId]
  );
  return rows[0] ? rows[0].count || 0 : 0;
}

/** Same as getBranchTicketUpdatesCount, but returns the actual ticket ids
 * (most-recently-updated first) instead of just a count - the deep-link
 * counterpart to getNewAssignedTicketIds above, for the Branch Staff/Head
 * Office side. */
async function getBranchTicketUpdateIds(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT t.id FROM tickets t
      WHERE t.created_by = ?
        AND t.status_updated_at IS NOT NULL
        AND t.status_updated_at > COALESCE(
          (SELECT branch_updates_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp)
      ORDER BY t.status_updated_at DESC`,
    [userId, userId]
  );
  return rows.map((r) => r.id);
}

/** Marks "now" as this Branch Staff account's last-seen point for their
 * "your ticket was updated" notification - called when they open the
 * Tickets tab, mirroring markTicketsNotifSeen above. */
async function markBranchTicketUpdatesSeen(userId) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO notification_reads (user_id, branch_updates_seen_at) VALUES (?, NOW()) " +
    "ON CONFLICT (user_id) DO UPDATE SET branch_updates_seen_at = NOW()",
    [userId]
  );
}

/** How many tickets THIS IT Department account filed a void request for
 * that a Super Admin has since decided (Voided or Rejected), since they
 * last opened "Tickets" (or otherwise acknowledged this notification) - the
 * void-decision counterpart to getBranchTicketUpdatesCount above. Uses
 * void_decided_at rather than a one-off flag so a ticket that's rejected,
 * re-requested, and decided again still counts as a fresh, unseen decision
 * the second time. A user who's never opened Tickets yet sees every void
 * request of theirs that's already been decided as new. */
async function getVoidDecisionsCount(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM tickets t
      WHERE t.void_requested_by = ?
        AND t.void_status IN ('Voided', 'Rejected')
        AND t.void_decided_at > COALESCE(
          (SELECT void_decision_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp)`,
    [userId, userId]
  );
  return rows[0] ? rows[0].count || 0 : 0;
}

/** Same as getVoidDecisionsCount, but returns the actual ticket ids
 * (most-recently-decided first) instead of just a count - the deep-link
 * counterpart to getNewAssignedTicketIds above, for an IT Department
 * account's own void requests. */
async function getVoidDecisionIds(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT t.id FROM tickets t
      WHERE t.void_requested_by = ?
        AND t.void_status IN ('Voided', 'Rejected')
        AND t.void_decided_at > COALESCE(
          (SELECT void_decision_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp)
      ORDER BY t.void_decided_at DESC`,
    [userId, userId]
  );
  return rows.map((r) => r.id);
}

/** Marks "now" as this IT Department account's last-seen point for their
 * "your void request was decided" notification - called when they open the
 * Tickets tab, mirroring markBranchTicketUpdatesSeen above. */
async function markVoidDecisionsSeen(userId) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO notification_reads (user_id, void_decision_seen_at) VALUES (?, NOW()) " +
    "ON CONFLICT (user_id) DO UPDATE SET void_decision_seen_at = NOW()",
    [userId]
  );
}

/** How many tickets THIS IT Department account filed a reopen request for
 * that a Super Admin has since decided (Approved or Rejected), since they
 * last opened "Tickets" - the reopen-decision counterpart to
 * getVoidDecisionsCount above. Uses reopen_decided_at rather than a one-off
 * flag so a ticket that's rejected, re-requested, and decided again still
 * counts as a fresh, unseen decision the second time. */
async function getReopenDecisionsCount(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM tickets t
      WHERE t.reopen_requested_by = ?
        AND t.reopen_status IN ('Approved', 'Rejected')
        AND t.reopen_decided_at > COALESCE(
          (SELECT reopen_decision_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp)`,
    [userId, userId]
  );
  return rows[0] ? rows[0].count || 0 : 0;
}

/** Same as getReopenDecisionsCount, but returns the actual ticket ids
 * (most-recently-decided first) instead of just a count - the deep-link
 * counterpart to getVoidDecisionIds above, for an IT Department account's
 * own reopen requests. */
async function getReopenDecisionIds(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT t.id FROM tickets t
      WHERE t.reopen_requested_by = ?
        AND t.reopen_status IN ('Approved', 'Rejected')
        AND t.reopen_decided_at > COALESCE(
          (SELECT reopen_decision_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp)
      ORDER BY t.reopen_decided_at DESC`,
    [userId, userId]
  );
  return rows.map((r) => r.id);
}

/** Marks "now" as this IT Department account's last-seen point for their
 * "your reopen request was decided" notification - called when they open
 * the Tickets tab, mirroring markVoidDecisionsSeen above. */
async function markReopenDecisionsSeen(userId) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO notification_reads (user_id, reopen_decision_seen_at) VALUES (?, NOW()) " +
    "ON CONFLICT (user_id) DO UPDATE SET reopen_decision_seen_at = NOW()",
    [userId]
  );
}

/** How many of THIS user's own availability_requests (any kind - 'lock',
 * 'absence', or a self-filed 'field' request) a Super Admin has since
 * decided (Approved or Denied), since they last opened the IT Staff &
 * Availability tab - the availability-request counterpart to
 * getVoidDecisionsCount above. A 'field' request is the main case this
 * matters for (the requester stays logged in and wants to know the
 * outcome); 'lock'/'absence' requests are included too since there's no
 * reason to withhold the same notification from them. */
async function getAvailabilityDecisionsCount(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM availability_requests r
      WHERE r.user_id = ?
        AND r.status IN ('Approved', 'Denied')
        AND r.decided_at > COALESCE(
          (SELECT availability_decision_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp)`,
    [userId, userId]
  );
  return rows[0] ? rows[0].count || 0 : 0;
}

/** Marks "now" as this user's last-seen point for their own "your
 * availability request was decided" notification - called when they open
 * the IT Staff & Availability tab, mirroring markVoidDecisionsSeen above. */
async function markAvailabilityDecisionsSeen(userId) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO notification_reads (user_id, availability_decision_seen_at) VALUES (?, NOW()) " +
    "ON CONFLICT (user_id) DO UPDATE SET availability_decision_seen_at = NOW()",
    [userId]
  );
}

/** Same as getVoidDecisionIds, but for a Head Office Employee's own
 * item_borrows a Super Admin account has since decided
 * (Borrowed or Denied) - the Item Borrowing counterpart to
 * voidDecisions/reopenDecisions/availabilityDecisions above. Returns the
 * actual borrow ids (most-recently-decided first) rather than just a
 * count, same deep-link shape as getVoidDecisionIds. */
async function getBorrowDecisionIds(userId) {
  const pool = getConnection();
  const [rows] = await pool.query(
    `SELECT b.id FROM item_borrows b
      WHERE b.borrowed_by = ?
        AND b.status IN ('Borrowed', 'Denied')
        AND b.decided_at > COALESCE(
          (SELECT borrow_decision_seen_at FROM notification_reads WHERE user_id = ?), 'epoch'::timestamp)
      ORDER BY b.decided_at DESC`,
    [userId, userId]
  );
  return rows.map((r) => r.id);
}

/** Marks "now" as this Head Office Employee's last-seen point for their
 * "your borrow request was decided" notification - called when they open
 * the Borrow Items tab, mirroring markVoidDecisionsSeen above. */
async function markBorrowDecisionsSeen(userId) {
  const pool = getConnection();
  await pool.query(
    "INSERT INTO notification_reads (user_id, borrow_decision_seen_at) VALUES (?, NOW()) " +
    "ON CONFLICT (user_id) DO UPDATE SET borrow_decision_seen_at = NOW()",
    [userId]
  );
}

/** Cheap "did any ticket change?" fingerprint for the live-refresh poll
 * (server.js GET /api/tickets/sync): ticket count + newest updated_at.
 * updated_at moves on every status change, reassignment, comment, poke and
 * void/reopen decision, so a different fingerprint means "reload what you
 * are looking at". One small aggregate query - no ticket rows are sent. */
async function getTicketsFingerprint() {
  const pool = getConnection();
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS c, COALESCE(EXTRACT(EPOCH FROM MAX(updated_at)), 0)::float8 AS m FROM tickets"
  );
  return `${rows[0].c}:${rows[0].m}`;
}

module.exports = {
  getTicketsFingerprint,
  getSiteTheme,
  setSiteTheme,
  BSP_GROUPS,
  STAFF_GROUPS,
  getSystemMode,
  getItBranchScope,
  isBranchInItScope,
  filterTicketIdsInScope,
  setSystemMode,
  CORPORATIONS,
  getBranchGroups,
  getBranchGroup,
  getBranchStaffGroup,
  updateBranchGroup,
  getUserGroup,
  updateUserGroup,
  authenticate,
  usernameExists,
  branchAccountExists,
  departmentAccountExists,
  registerUser,
  updateUser,
  getItSpecialties,
  setItSpecialties,
  getItDepartmentUsers,
  getSuperAdminUsers,
  getItDepartmentUsers,
  markAbsent,
  markAbsentRange,
  unmarkAbsent,
  getAbsences,
  getAbsenceHistory,
  getAbsentToday,
  isAbsentToday,
  getLockedStaff,
  setAvailability,
  restoreExpiredAvailability,
  getAvailabilityLog,
  requestAvailability,
  requestFieldUnavailability,
  getOwnPendingAvailabilityRequest,
  getPendingAvailabilityRequests,
  decideAvailabilityRequest,
  clearTodaysAbsence,
  isTrustedDevice,
  touchTrustedDevice,
  trustDevice,
  createDeviceLoginRequest,
  getDeviceRequests,
  decideDeviceRequest,
  getTeamWorkload,
  getTeamStats,
  getUpcomingAbsences,
  recordLogin,
  getAttendanceLog,
  getTodayAttendance,
  recordAssist,
  getTicketAssists,
  getTicketCollaboratorIds,
  setTicketCollaborators,
  isTicketAssignee,
  getAllUsers,
  deleteUser,
  createTicket,
  addTicketAttachment,
  getTicketAttachments,
  getTickets,
  getTicketById,
  updateTicketStatus,
  updateTicketProvince,
  assignTicket,
  pokeTicket,
  clearPokeFlag,
  isUserUnavailableToday,
  requestVoidTicket,
  decideVoidTicket,
  getVoidRequests,
  requestReopenTicket,
  decideReopenTicket,
  getReopenRequests,
  getReopenRequestsForAssignee,
  getReopenDecisionsCount,
  getReopenDecisionIds,
  markReopenDecisionsSeen,
  getAvailabilityDecisionsCount,
  markAvailabilityDecisionsSeen,
  getDistinctBranches,
  getTicketStats,
  getBranches,
  addBranch,
  addBranchesBulk,
  deleteBranch,
  updateBranch,
  getDepartments,
  addDepartment,
  deleteDepartment,
  updateDepartment,
  getCategories,
  addCategory,
  deleteCategory,
  updateCategory,
  moveCategoryUp,
  moveCategoryDown,
  addComment,
  getComments,
  createWorkspaceFile,
  listWorkspaceFiles,
  getWorkspaceFileById,
  updateWorkspaceFileContent,
  getWorkspaceFileVersions,
  deleteWorkspaceFile,
  createWorkspaceMemo,
  listWorkspaceMemos,
  deleteWorkspaceMemo,
  createITRequest,
  listITRequests,
  getITRequestById,
  deleteITRequest,
  listBorrowItems,
  getBorrowItemById,
  createBorrowItem,
  updateBorrowItem,
  deleteBorrowItem,
  createItemBorrow,
  decideItemBorrow,
  getPendingItemBorrows,
  listItemBorrows,
  getItemBorrowById,
  markItemBorrowReturned,
  deleteItemBorrow,
  getBorrowDecisionIds,
  markBorrowDecisionsSeen,
  getWorkspaceUnreadCount,
  markWorkspaceSeen,
  getNotificationSeenCounts,
  markCountNotifSeen,
  getNewAssignedTicketsCount,
  getNewAssignedTicketIds,
  getPokedOwnTicketIds,
  getStaleOpenTicketIds,
  isWithinReopenWindow,
  REOPEN_WINDOW_HOURS,
  getTicketsNeedingEscalationPush,
  getTicketSyncFingerprint,
  markEscalated,
  markTicketsNotifSeen,
  getBranchTicketUpdatesCount,
  getBranchTicketUpdateIds,
  markBranchTicketUpdatesSeen,
  getVoidDecisionsCount,
  getVoidDecisionIds,
  markVoidDecisionsSeen,
};