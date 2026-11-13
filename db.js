/**
 * db.js
 * Handles the Neon (serverless PostgreSQL) database connection, schema
 * creation and seed data for the IT Ticket System.
 *
 * Requires the 'pg' npm package (a Postgres driver) and a Neon connection
 * string in config.js / the DATABASE_URL env var.
 *
 * ---------------------------------------------------------------------
 * Compatibility note for readers of data.js / reporting.js:
 * Those two files were originally written against mysql2's API - they call
 * pool.query(sql, params) with '?' placeholders and destructure the result
 * as `[rows] = await pool.query(...)`, and use pool.getConnection() with
 * conn.beginTransaction()/commit()/rollback()/release() for transactions.
 * Rather than rewrite every call site to Postgres's native '$1,$2,...'
 * placeholder style, the thin adapter below (`wrapQueryable`) preserves that
 * same calling convention on top of 'pg', converting '?' -> '$1..$n' and
 * mimicking mysql2's [rows]/[resultHeader] return shape. Actual SQL dialect
 * differences that aren't just placeholder syntax (CURDATE(), DATE(...),
 * TIMESTAMPDIFF(), GROUP_CONCAT(), ON DUPLICATE KEY UPDATE, ORDER BY
 * FIELD(...), AUTO_INCREMENT/ENUM in DDL) were rewritten in the actual query
 * text throughout data.js/reporting.js/db.js, since those aren't things an
 * adapter can paper over.
 * ---------------------------------------------------------------------
 */

const { Pool, types } = require("pg");
const { DB_CONFIG } = require("./config");

// Matches the initial ticket categories seeded below - these are the
// concerns the demo IT Department accounts are set up to handle.
const DEMO_IT_SPECIALTIES = ["Hardware", "Software", "Internet/Network", "CCTV",
  "Accounts", "Printer", "Other"];

// ---- type parsing: keep this close to mysql2's old behavior ----
// Postgres returns BIGINT (oid 20, used by COUNT(*)/SUM on integer columns)
// and NUMERIC (oid 1700) as strings by default, to avoid silent precision
// loss. This app's counts/sums are always small, so parsing them back to
// plain JS numbers is safe and matches how the code (reduce(), arithmetic,
// === comparisons) already expects to use them.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
// DATE (oid 1082) is kept as a plain "YYYY-MM-DD" string, mirroring
// mysql2's dateStrings:true option that the rest of the app relies on.
types.setTypeParser(1082, (val) => val);

let pool = null;

/** Convert a '?'-style query into Postgres's '$1,$2,...' style. Operates on
 * the final, already-assembled query text, so it works fine even for
 * queries built up dynamically (e.g. getTickets()'s search-word loop). */
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** Run one query through a raw 'pg' client/pool and return mysql2-shaped
 * results: `[rows]` for SELECTs (and any query with a RETURNING clause), or
 * `[{ affectedRows, insertId }]` for plain INSERT/UPDATE/DELETE - close
 * enough to mysql2's ResultSetHeader for how this app uses it. */
async function runQuery(target, sql, params = []) {
  const text = toPositional(sql);
  const result = await target.query(text, params);
  if (/^\s*(SELECT|WITH)/i.test(sql) || /RETURNING/i.test(sql)) {
    return [result.rows, result];
  }
  return [{ affectedRows: result.rowCount, insertId: undefined }, result];
}

/** Wrap a raw pg Pool or pg Client so it exposes the same shape data.js/
 * reporting.js already call: .query(sql, params) with mysql2 semantics. */
function wrapQueryable(target) {
  return { query: (sql, params) => runQuery(target, sql, params), _raw: target };
}

/** Lazily create (and reuse) a connection pool for the configured Neon
 * database. */
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: DB_CONFIG.connectionString,
      ssl: DB_CONFIG.ssl,
      max: 5, // per serverless instance; many instances x 10 could exhaust Neon's connection limit
    });
  }
  return pool;
}

/** Public accessor - returns an mysql2-shaped wrapper around the shared
 * pool, which callers use with pool.query()/pool.getConnection(). */
function getConnection() {
  const p = getPool();
  const wrapped = wrapQueryable(p);
  // Transaction support: mirrors mysql2's pool.getConnection() ->
  // conn.beginTransaction()/commit()/rollback()/release() pattern (used by
  // data.updateBranch), on top of pg's pool.connect()/BEGIN/COMMIT/ROLLBACK.
  wrapped.getConnection = async () => {
    const client = await p.connect();
    const wrappedClient = wrapQueryable(client);
    wrappedClient.beginTransaction = () => client.query("BEGIN");
    wrappedClient.commit = () => client.query("COMMIT");
    wrappedClient.rollback = () => client.query("ROLLBACK");
    wrappedClient.release = () => client.release();
    return wrappedClient;
  };
  return wrapped;
}

function friendlyConnectionError(err) {
  return (
    "Could not connect to Neon (Postgres).\n\n" +
    `Details: ${err.message}\n\n` +
    "Checklist:\n" +
    "  1. Make sure your Neon project/branch is active (Neon auto-suspends " +
    "idle compute, but the first connection wakes it - if it's the very " +
    "first connect, try again in a few seconds).\n" +
    "  2. Check config.js / the DATABASE_URL env var matches the connection " +
    "string from the Neon console (Dashboard -> Connection Details).\n" +
    "  3. Make sure the connection string includes '?sslmode=require'.\n"
  );
}

/** Create the tables if they don't exist yet, and seed demo accounts the
 * first time the app runs. Unlike the old XAMPP/MySQL version, there's no
 * "create the database" step - Neon databases are created ahead of time
 * (e.g. via the Neon console), and DB_CONFIG.connectionString already
 * points at one. */
async function _runFullInit() {
  const p = getConnection();

  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(150) NOT NULL,
        role VARCHAR(30) NOT NULL
          CHECK (role IN ('Super Admin','IT Department','Head Office Employee','Branch Staff')),
        branch VARCHAR(100),
        created_at TIMESTAMP NOT NULL,

        -- Whether this account may currently log in. Meaningful for IT
        -- Department accounts only a Super Admin can flip this to false
        -- (see data.setAvailability); the affected staff member is then
        -- blocked at /api/login and must file an availability_requests row
        -- (see below) for a Super Admin to review and approve.
        is_available BOOLEAN NOT NULL DEFAULT TRUE,

        -- Optional date range for a lock set via data.setAvailability(...,
        -- false, ...) - purely informational (shown in the roster/history
        -- so a Super Admin can see how long someone's expected to be out),
        -- except unavailable_until also doubles as an auto-restore date:
        -- see the login check in server.js. Both are cleared whenever the
        -- account is marked available again (manually or via that
        -- auto-restore).
        unavailable_from DATE,
        unavailable_until DATE
      )
    `);
  } catch (err) {
    console.error(friendlyConnectionError(err));
    throw err;
  }
  // Migration for 'users' tables created before is_available/the
  // unavailable_from/unavailable_until date range existed.
  await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE`);
  await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS unavailable_from DATE`);
  await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS unavailable_until DATE`);
  // BSP MODE: which of the 4 fixed groups (Line 1 / Line 2 / Line 3 /
  // Global Reliance Management & Holdings Corp - see data.BSP_GROUPS) this
  // account belongs to. Only meaningful for IT Department accounts - it's
  // what BSP MODE checks against a ticket's branch group (see branches.
  // group_name below, and data._pickBalancedItStaff/getTickets) to decide
  // who may be auto-assigned or "assist" a ticket. NULL means "not tagged
  // to a group yet" - such staff are simply left out of BSP MODE's
  // auto-assignment/assist pool until a Super Admin tags them.
  await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS group_name VARCHAR(100)`);
  // Restricted admin portal: a Super Admin account with can_change_mode =
  // FALSE has every Super Admin function EXCEPT switching the system between
  // Normal and BSP Mode (enforced in server.js's POST /api/settings/mode and
  // reflected read-only in app.js's system mode panel). Everyone else
  // defaults to TRUE, so existing accounts behave exactly as before.
  await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS can_change_mode BOOLEAN NOT NULL DEFAULT TRUE`);

  // Sessions used to live in an in-memory Map in server.js - that doesn't
  // survive across separate serverless invocations, so they're stored here
  // instead. expires_at lets us treat an old/expired row as "not logged in".
  await p.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR(64) PRIMARY KEY,
      user_data JSONB NOT NULL,
      expires_at TIMESTAMP NOT NULL
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      description TEXT NOT NULL,
      category VARCHAR(50) NOT NULL,
      priority VARCHAR(20) NOT NULL
        CHECK (priority IN ('Low','Medium','High','Critical')),
      status VARCHAR(20) NOT NULL DEFAULT 'Open'
        CHECK (status IN ('Open','In Progress','Resolved')),
      branch VARCHAR(100) NOT NULL,
      concern_name VARCHAR(150),
      -- Optional extra contact/location details a Branch Staff member can
      -- attach when submitting a ticket (see the "Submit a Ticket" form) -
      -- an AnyDesk remote-access ID so IT can jump straight into a remote
      -- session, and a branch number/code for branches that use one
      -- alongside (or instead of) their name. Both are free text and
      -- purely informational - neither is validated or used for routing.
      anydesk_number VARCHAR(50),
      branch_number VARCHAR(50),
      created_by INT NOT NULL REFERENCES users(id),
      assigned_to INT REFERENCES users(id),
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      -- Set the moment a ticket's status becomes 'Resolved' (see
      -- data.updateTicketStatus) and cleared if it's ever reopened, separate
      -- from updated_at (which changes on every edit). Used by the
      -- Reporting tab to measure resolution time.
      resolved_at TIMESTAMP,
      -- Stamped only by an actual status change (see data.updateTicketStatus),
      -- separate from updated_at (which also moves on comments, assignment,
      -- and void decisions). This is what the branch's "your ticket was
      -- updated" notification is scoped to now - a branch is only ever
      -- pushed/notified about its ticket's STATUS, never the internal IT/
      -- Super Admin conversation or reassignment (see
      -- data.getBranchTicketUpdatesCount).
      status_updated_at TIMESTAMP,

      -- "Void" is a separate workflow layered on top of the normal
      -- Open/In Progress/Resolved lifecycle, not a fourth status value -
      -- that keeps resolution-time reporting (which only cares about
      -- Resolved/resolved_at) untouched. An IT Department account can
      -- REQUEST a ticket be voided (e.g. duplicate, spam, unreproducible);
      -- only a Super Admin can approve (Voided) or decline (Rejected) that
      -- request. 'Rejected' still allows a fresh request later - see
      -- data.requestVoidTicket.
      void_status VARCHAR(20) NOT NULL DEFAULT 'None'
        CHECK (void_status IN ('None','Requested','Voided','Rejected')),
      void_reason TEXT,
      void_requested_by INT REFERENCES users(id),
      void_requested_at TIMESTAMP,
      void_decided_by INT REFERENCES users(id),
      void_decided_at TIMESTAMP,
      void_decision_note TEXT,
      -- Reopen requests: an IT Department account asks a Super Admin to move
      -- a Resolved ticket back into active work because the issue has
      -- recurred. Same None/Requested/Approved-or-Rejected shape as
      -- void_status above - see the ALTER TABLE block below for the full
      -- comment (kept there since it's what runs against existing
      -- deployments; this CREATE TABLE only matters for brand-new ones).
      reopen_status VARCHAR(20) NOT NULL DEFAULT 'None'
        CHECK (reopen_status IN ('None','Requested','Approved','Rejected')),
      reopen_reason TEXT,
      reopen_requested_by INT REFERENCES users(id),
      reopen_requested_at TIMESTAMP,
      reopen_decided_by INT REFERENCES users(id),
      reopen_decided_at TIMESTAMP,
      reopen_decision_note TEXT,
      -- Marks a ticket as needing an actual physical/on-site visit (e.g. a
      -- province branch IT can't just remote into) rather than reflecting
      -- anything about the branch itself - set per ticket, at submission or
      -- later by IT/Super Admin, since the same branch can have some
      -- tickets solvable remotely and others that need a visit. Tickets
      -- flagged this way are fully excluded from every performance report
      -- (reporting.js) so travel time to site doesn't count against an IT
      -- staff member's resolution stats.
      is_province BOOLEAN NOT NULL DEFAULT FALSE,

      -- A Super Admin "poke" - a lightweight nudge that doesn't change
      -- status or reassign anything, just flags "this needs attention" and
      -- pushes the assignee a notification (see data.pokeTicket). Cleared
      -- automatically the moment the ticket's status changes or anyone
      -- comments on it (see updateTicketStatus/addComment), so the flag
      -- never lingers past the point it's actually acted on.
      poked_at TIMESTAMP,
      poked_by INT REFERENCES users(id),

      -- Automatic escalation: the auto-repeating counterpart to poked_at
      -- above, fired by server.js's escalation sweep instead of a Super
      -- Admin manually poking it (see data.getTicketsNeedingEscalationPush /
      -- data.markEscalated). Stamped each time the sweep sends a push for
      -- this ticket, so it isn't re-pushed again until another 10 minutes
      -- has passed; cleared the moment the ticket's status changes or it's
      -- reassigned (see updateTicketStatus/assignTicket), same as poked_at.
      -- Only paces the PUSH notification - the in-app banner/bell row (see
      -- data.getStaleOpenTicketIds) is recomputed fresh every poll and
      -- doesn't depend on this column at all.
      escalated_at TIMESTAMP
    )
  `);

  // Migration for tickets tables created before the void-request columns
  // existed (CREATE TABLE IF NOT EXISTS above is a no-op on an
  // already-existing table, so older deployments need these added
  // explicitly). Safe to run every startup: ADD COLUMN IF NOT EXISTS is a
  // no-op once the column is there, and the CHECK constraint add is
  // wrapped since Postgres has no "ADD CONSTRAINT IF NOT EXISTS".
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS void_status VARCHAR(20) NOT NULL DEFAULT 'None'`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS void_reason TEXT`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS void_requested_by INT REFERENCES users(id)`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS void_requested_at TIMESTAMP`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS void_decided_by INT REFERENCES users(id)`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS void_decided_at TIMESTAMP`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS void_decision_note TEXT`);
  // Reopen requests - same "IT Department requests, Super Admin decides"
  // shape as the void-request columns just above, but for the opposite
  // situation: a Resolved ticket's issue has come back, so IT wants it
  // moved back into active work instead of staying closed out. Kept as its
  // own request/decision workflow (rather than letting IT just flip the
  // status straight back themselves) so a Super Admin gets visibility into
  // recurring issues instead of tickets quietly bouncing in and out of
  // Resolved. See data.requestReopenTicket / data.decideReopenTicket.
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopen_status VARCHAR(20) NOT NULL DEFAULT 'None'`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopen_reason TEXT`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopen_requested_by INT REFERENCES users(id)`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopen_requested_at TIMESTAMP`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopen_decided_by INT REFERENCES users(id)`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopen_decided_at TIMESTAMP`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reopen_decision_note TEXT`);
  try {
    await p.query(`ALTER TABLE tickets ADD CONSTRAINT tickets_reopen_status_check CHECK (reopen_status IN ('None','Requested','Approved','Rejected'))`);
  } catch (err) {
    // Already present (or a fresh table already got it via the CREATE
    // TABLE above once that's updated) - Postgres has no clean "ADD
    // CONSTRAINT IF NOT EXISTS", so this is expected and fine, same as the
    // void_status constraint below.
  }
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS anydesk_number VARCHAR(50)`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS branch_number VARCHAR(50)`);
  // When this ticket most recently became this assignee's - set at creation
  // (auto-assignment) and again on every manual reassignment (see
  // data.createTicket / data.assignTicket), separate from updated_at (which
  // also bumps on status/void changes and would otherwise make "new ticket"
  // notifications fire for edits that aren't actually a new assignment).
  // Drives each IT staff member's own "N new tickets assigned to you" bell
  // notification (data.getNewAssignedTicketsCount) - compared per-user
  // against that user's own tickets_seen_at (see notification_reads below).
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP`);
  await p.query(`UPDATE tickets SET assigned_at = created_at WHERE assigned_at IS NULL`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_province BOOLEAN NOT NULL DEFAULT FALSE`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS poked_at TIMESTAMP`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS poked_by INT REFERENCES users(id)`);
  await p.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP`);
  try {
    await p.query(`ALTER TABLE tickets ADD CONSTRAINT tickets_void_status_check CHECK (void_status IN ('None','Requested','Voided','Rejected'))`);
  } catch (err) {
    // Already present (or a fresh table that got it from CREATE TABLE
    // above) - Postgres has no clean "IF NOT EXISTS" for this, so a
    // "constraint already exists" error here is expected and fine.
  }

  await p.query(`
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id),
      comment TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL
    )
  `);

  // Optional image attachments a requester can add to a ticket (e.g. a photo
  // of the broken hardware). file_path is where the app copies the image on
  // disk (see server.ATTACHMENTS_DIR); original_filename keeps the name the
  // file had before it was copied, just for display.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ticket_attachments (
      id SERIAL PRIMARY KEY,
      ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      file_path VARCHAR(500) NOT NULL,
      original_filename VARCHAR(255) NOT NULL,
      uploaded_at TIMESTAMP NOT NULL
    )
  `);

  // Role-specific tables. Every account has a row in 'users', and ALSO a row
  // in exactly one of these four tables, matching its role. This keeps each
  // role's own details (e.g. a Head Office employee's department, a Branch
  // Staff member's branch) in separate, purpose-built storage instead of one
  // catch-all column.
  await p.query(`
    CREATE TABLE IF NOT EXISTS super_admins (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS it_department (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS head_office_employees (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      department VARCHAR(100) NOT NULL
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS branch_staff (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      branch_name VARCHAR(100) NOT NULL
    )
  `);

  // IT Department specialties. Each IT Department account picks one or more
  // concerns it handles (Hardware, Software, etc, matching the managed
  // ticket categories below) - a many-rows-per-user table since an IT staff
  // member can cover more than one concern. Tickets are only auto-assigned
  // to staff who cover that ticket's category.
  await p.query(`
    CREATE TABLE IF NOT EXISTS it_specialties (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category VARCHAR(50) NOT NULL,
      PRIMARY KEY (user_id, category)
    )
  `);

  // IT absences. A Super Admin marks an IT Department staff member
  // absent/on-field for a specific date. Auto-assignment skips anyone absent
  // "today" (see data._pickBalancedItStaff), and the IT Dashboard shows a
  // banner so other IT staff know to cover their tickets. One row per user
  // per date - marking the same person absent twice for the same day just
  // updates the reason (see data.markAbsent).
  await p.query(`
    CREATE TABLE IF NOT EXISTS it_absences (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      absence_date DATE NOT NULL,
      reason VARCHAR(255),
      marked_by INT NOT NULL REFERENCES users(id),
      created_at TIMESTAMP NOT NULL,
      CONSTRAINT uniq_user_date UNIQUE (user_id, absence_date)
    )
  `);

  // Availability requests. When a Super Admin marks an IT Department
  // account unavailable (users.is_available = false), that account is
  // blocked from logging in (see server's /api/login) until a Super Admin
  // restores it. Instead of just retrying their password, the blocked staff
  // member can file a request here from the login screen (see
  // /api/availability/request) - it shows up as a pending approval for
  // every Super Admin (see data.getPendingAvailabilityRequests /
  // the sidebar bell in app.js) until one of them approves (which flips
  // is_available back to true) or denies it. Only one Pending request per
  // user at a time - filing again while one is already pending just reuses
  // it (see data.requestAvailability).
  //
  // `kind` distinguishes what's actually blocking the account: 'lock' is
  // the is_available=false case described above; 'absence' is for someone
  // blocked by being marked absent today (it_absences) instead - same
  // request/approve UI, but approving one clears today's absence record
  // rather than touching is_available (see data.decideAvailabilityRequest).
  // Existing rows predate this column and are all 'lock' requests, hence
  // the default.
  //
  // 'field' is the opposite direction: an IT Department/Super Admin
  // account that's currently ABLE to log in asks a Super Admin to mark
  // THEM unavailable (e.g. heading out on a site visit), instead of
  // waiting for a Super Admin to do it. reason/unavailable_from/
  // unavailable_until (added below) hold what the staffer typed in, and
  // are applied via setAvailability only if/when a Super Admin approves -
  // denying one leaves the account untouched (see
  // data.requestFieldUnavailability / data.decideAvailabilityRequest).
  await p.query(`
    CREATE TABLE IF NOT EXISTS availability_requests (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending','Approved','Denied')),
      requested_at TIMESTAMP NOT NULL,
      decided_by INT REFERENCES users(id),
      decided_at TIMESTAMP
    )
  `);
  // Migration for 'availability_requests' tables created before `kind`
  // existed.
  await p.query(`ALTER TABLE availability_requests ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'lock'`);
  // Migration for the 'field' kind below - a staff member requesting to be
  // marked unavailable themselves (as opposed to 'lock'/'absence', which
  // both request the account be RESTORED). These carry the reason/date
  // range the staffer typed in, applied by data.decideAvailabilityRequest
  // if a Super Admin approves.
  await p.query(`ALTER TABLE availability_requests ADD COLUMN IF NOT EXISTS reason VARCHAR(255)`);
  await p.query(`ALTER TABLE availability_requests ADD COLUMN IF NOT EXISTS unavailable_from DATE`);
  await p.query(`ALTER TABLE availability_requests ADD COLUMN IF NOT EXISTS unavailable_until DATE`);
  // Speeds up the Super Admin "pending availability requests" bell/panel,
  // which filters on status = 'Pending' on every dashboard/sidebar load.
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_availability_requests_status ON availability_requests (status)"
  );

  // Availability log. A permanent audit trail of every time an account's
  // is_available flag changed (see data.setAvailability) - separate from
  // availability_requests, which only tracks a blocked staff member's
  // pending/approved/denied *requests* to be unblocked, not the underlying
  // lock/unlock events themselves (a Super Admin can lock/unlock directly
  // without any request ever being filed). changed_by is nullable so a
  // system-driven change (if one is ever added later) doesn't require a
  // fake admin id; reason is optional context typed in by the Super Admin.
  await p.query(`
    CREATE TABLE IF NOT EXISTS availability_log (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_available BOOLEAN NOT NULL,
      changed_by INT REFERENCES users(id),
      reason VARCHAR(255),
      unavailable_from DATE,
      unavailable_until DATE,
      changed_at TIMESTAMP NOT NULL
    )
  `);
  // Migration for 'availability_log' tables created before the
  // unavailable_from/unavailable_until date range existed.
  await p.query(`ALTER TABLE availability_log ADD COLUMN IF NOT EXISTS unavailable_from DATE`);
  await p.query(`ALTER TABLE availability_log ADD COLUMN IF NOT EXISTS unavailable_until DATE`);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_availability_log_user ON availability_log (user_id, changed_at DESC)"
  );

  // Ticket assists. Records every time an IT Department/Super Admin account
  // steps in to help on a ticket - typically one belonging to a staff member
  // marked absent that day - so there's a permanent, queryable record of who
  // actually covered the work (see data.recordAssist / data.getTicketAssists).
  await p.query(`
    CREATE TABLE IF NOT EXISTS ticket_assists (
      id SERIAL PRIMARY KEY,
      ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      original_assignee INT REFERENCES users(id),
      assisted_by INT NOT NULL REFERENCES users(id),
      note VARCHAR(255),
      assisted_at TIMESTAMP NOT NULL
    )
  `);

  // Multi-staff assignment ("work together" tickets) - a Super Admin can
  // add one or more additional IT Department staff onto a ticket alongside
  // its normal `tickets.assigned_to` owner. Every listed collaborator has
  // the SAME rights on the ticket as the primary assignee (status changes,
  // comments, void/reopen requests, resolving it) - this is deliberately
  // NOT a "helper with limited actions" table, unlike ticket_assists above
  // (which is a one-person absence-coverage takeover log, not a standing
  // team). See data.js's getTicketCollaborators/setTicketCollaborators and
  // getTickets()'s IT-Department scoping for how membership here grants
  // queue visibility and action rights identically to assigned_to.
  await p.query(`
    CREATE TABLE IF NOT EXISTS ticket_collaborators (
      id SERIAL PRIMARY KEY,
      ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id),
      added_by INT REFERENCES users(id),
      added_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (ticket_id, user_id)
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_ticket_collaborators_ticket ON ticket_collaborators (ticket_id)"
  );
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_ticket_collaborators_user ON ticket_collaborators (user_id)"
  );

  // Branches. The list of branch names is no longer hardcoded in the app - a
  // Super Admin manages it here (Manage Branches panel), and every "Branch"
  // dropdown (registration, account form, ticket filters) reads from this
  // table.
  await p.query(`
    CREATE TABLE IF NOT EXISTS branches (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL
    )
  `);
  // BSP MODE: which of the 4 fixed groups this branch has been tagged into
  // (see data.BSP_GROUPS) - NULL until a Super Admin tags it. Only
  // consulted while BSP MODE is on (see app_settings below); in Normal Mode
  // it's stored but ignored everywhere.
  await p.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS group_name VARCHAR(100)`);
  // Corporation tag - only meaningful once a branch has a Line of Business
  // (group_name); see data.CORPORATIONS for the allowed values.
  await p.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS corporation VARCHAR(150)`);
  // "Global" tag - checked when the branch's corporation is partnered with
  // Global. A plain label for now (doesn't affect ticket routing).
  await p.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_global BOOLEAN NOT NULL DEFAULT FALSE`);
  // "Global Reliance Management & Holdings Corp" was retired as a Line of
  // Business - clear any leftover tags pointing at a group that no longer
  // exists (keep this list in sync with data.BSP_GROUPS). Idempotent.
  await p.query(
    `UPDATE branches SET group_name = NULL, corporation = NULL WHERE group_name IS NOT NULL AND group_name NOT IN ('Line 1','Line 2','Line 3')`
  );
  await p.query(
    `UPDATE users SET group_name = NULL WHERE group_name IS NOT NULL AND group_name NOT IN ('Line 1','Line 2','Line 3','Global')`
  );

  // Head Office departments. Same idea as branches above: a Super Admin
  // manages this list (Manage Departments panel), and the "Department"
  // dropdown - both on public self-registration and the admin New Account
  // form - reads from this table instead of free text, so a department has
  // to exist before an account can be created for it.
  await p.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL
    )
  `);

  // Ticket categories. Same idea as branches/departments above: no longer
  // hardcoded in server.js - a Super Admin manages this list (Manage
  // Categories panel), and the "Category" dropdown on the New Ticket form,
  // plus the IT Staff specialties checkboxes, read from this table.
  // 'position' controls display order (the Manage Categories panel's
  // up/down arrows) - lower numbers show first.
  await p.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) UNIQUE NOT NULL,
      position INT
    )
  `);
  await p.query(`ALTER TABLE categories ADD COLUMN IF NOT EXISTS position INT`);
  // Backfill position for any row that doesn't have one yet (a fresh table,
  // or one created before 'position' existed) - alphabetical order, same as
  // the old default, so nothing visibly reorders on upgrade.
  await p.query(`
    UPDATE categories SET position = sub.rn
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY name) AS rn FROM categories) sub
    WHERE categories.id = sub.id AND categories.position IS NULL
  `);

  // Tracks which demo/seed accounts (below) have ever been created,
  // independent of whether they still exist right now. Without this, a
  // Super Admin deleting a demo account (e.g. the seeded 'admin' IT
  // Department account) would see it silently reappear on the next app
  // restart, because this used to only check "does this username exist
  // right now" and recreate anything missing.
  await p.query(`
    CREATE TABLE IF NOT EXISTS demo_accounts_seeded (
      username VARCHAR(64) PRIMARY KEY,
      seeded_at TIMESTAMP NOT NULL
    )
  `);

  // Trusted devices for Branch Staff login lock. A row here means this
  // device_id is allowed to sign this user straight in (see server's
  // /api/login). Created either implicitly - the device used to
  // self-register the branch account, approved_by NULL - or by an IT/Super
  // Admin approving a device_login_requests row (see decideDeviceRequest
  // below). One row per user+device; re-approving the same device_id just
  // refreshes its label/approver/last_login_at instead of duplicating.
  await p.query(`
    CREATE TABLE IF NOT EXISTS trusted_devices (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id VARCHAR(64) NOT NULL,
      device_label VARCHAR(150),
      approved_by INT REFERENCES users(id),
      approved_at TIMESTAMP NOT NULL,
      last_login_at TIMESTAMP,
      CONSTRAINT uniq_trusted_user_device UNIQUE (user_id, device_id)
    )
  `);

  // Device sign-in approval requests. Filed when a Branch Staff account
  // tries to log in from a device that isn't in trusted_devices yet (see
  // server's /api/login) - auto-assigned to a balanced, on-duty IT
  // Department staffer the same way a ticket gets auto-assigned (see
  // data._pickOnDutyItStaff), so it shows up as a "Device sign-in
  // approvals" item for them to approve/decline. Declining doesn't retry
  // itself - it just gets flagged for a Super Admin to review/override
  // (superadmin_notified; see server's /api/device-requests/:id/decline).
  await p.query(`
    CREATE TABLE IF NOT EXISTS device_login_requests (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id VARCHAR(64) NOT NULL,
      device_label VARCHAR(150),
      status VARCHAR(20) NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending','Approved','Declined')),
      assigned_to INT REFERENCES users(id),
      requested_at TIMESTAMP NOT NULL,
      decided_by INT REFERENCES users(id),
      decided_at TIMESTAMP,
      decision_note VARCHAR(255),
      superadmin_notified BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  // Speeds up both the "am I still Pending?" login poll and the IT/Super
  // Admin "Device sign-in approvals" panel, which filter on status.
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_device_requests_status ON device_login_requests (status)"
  );
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_device_requests_assigned ON device_login_requests (assigned_to, status)"
  );

  // Desktop push notification subscriptions (Web Push). One row per
  // browser/device a user has enabled notifications on, so the same person
  // can get pushes on both their desktop and laptop. `endpoint` is unique
  // per browser subscription and doubles as the natural key for removing a
  // stale one (see push.js's cleanup on a 404/410 send failure).
  await p.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint VARCHAR(500) UNIQUE NOT NULL,
      p256dh VARCHAR(255) NOT NULL,
      auth VARCHAR(255) NOT NULL,
      created_at TIMESTAMP NOT NULL
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id)"
  );

  // Login/attendance log. One row per successful sign-in, used by the
  // Super Admin-only "IT Staff Attendance" panel on Team Workspace ->
  // Overview to see when each IT Department / Super Admin account actually
  // logged in and whether it was from a desktop or a phone (device_kind is
  // parsed client-side from navigator.userAgent by app.js's
  // getDeviceLabel(), the same helper already used for the Branch Staff
  // trusted-device flow - see server's /api/login). This is intentionally
  // separate from trusted_devices/device_login_requests, which are about
  // *authorizing* a device for Branch Staff, not recording attendance.
  // Nothing here is ever exposed to non-Super-Admin accounts (see
  // requireRole(req, "Super Admin") on every /api/attendance* route).
  await p.query(`
    CREATE TABLE IF NOT EXISTS login_log (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id VARCHAR(64),
      device_label VARCHAR(150),
      device_kind VARCHAR(20),
      logged_in_at TIMESTAMP NOT NULL
    )
  `);
  // Speeds up both "attendance for this one staff member" lookups and the
  // date-ranged Attendance report/export, which always filters/orders on
  // logged_in_at.
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_login_log_user_time ON login_log (user_id, logged_in_at DESC)"
  );
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_login_log_time ON login_log (logged_in_at DESC)"
  );

  // Index to keep the Reporting tab's per-staff aggregation (grouping/
  // filtering tickets by assignee + created date) fast even as the tickets
  // table grows. Unlike MySQL, Postgres supports IF NOT EXISTS here.
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_tickets_assigned_created ON tickets (assigned_to, created_at)"
  );
  // Speeds up the Super Admin "pending void requests" panel/query, which
  // filters on void_status = 'Requested' every time the dashboard loads.
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_tickets_void_status ON tickets (void_status)"
  );

  // ---------------- Team Workspace: shared files & memos ----------------
  // A shared file library + announcement board for the Team Workspace tab.
  // Only a Super Admin can add a brand-new file (uploaded_by); IT Department
  // accounts can update an existing file's content (updated_by) but not
  // create new entries - see server's /api/workspace/files* routes. Memos
  // (Branch Opening / Branch Closed / Memorandum / Other Announcement) are
  // Super Admin-only, view-only for IT Department.
  await p.query(`
    CREATE TABLE IF NOT EXISTS workspace_files (
      id SERIAL PRIMARY KEY,
      original_filename VARCHAR(255) NOT NULL,
      blob_url VARCHAR(500) NOT NULL,
      content_type VARCHAR(150),
      file_size INT,
      description VARCHAR(255),
      uploaded_by INT NOT NULL REFERENCES users(id),
      created_at TIMESTAMP NOT NULL,
      updated_by INT REFERENCES users(id),
      updated_at TIMESTAMP,
      version INT NOT NULL DEFAULT 1
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_workspace_files_created ON workspace_files (created_at DESC)"
  );

  // One row per past version of a file, written just before its content is
  // replaced (see data.updateWorkspaceFileContent) - keeps a full history of
  // who changed a shared file and when, since workspace_files itself only
  // holds the current version.
  await p.query(`
    CREATE TABLE IF NOT EXISTS workspace_file_versions (
      id SERIAL PRIMARY KEY,
      file_id INT NOT NULL REFERENCES workspace_files(id) ON DELETE CASCADE,
      version INT NOT NULL,
      original_filename VARCHAR(255) NOT NULL,
      blob_url VARCHAR(500) NOT NULL,
      content_type VARCHAR(150),
      file_size INT,
      changed_by INT NOT NULL REFERENCES users(id),
      changed_at TIMESTAMP NOT NULL
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_workspace_file_versions_file ON workspace_file_versions (file_id, version DESC)"
  );

  await p.query(`
    CREATE TABLE IF NOT EXISTS workspace_memos (
      id SERIAL PRIMARY KEY,
      memo_type VARCHAR(30) NOT NULL
        CHECK (memo_type IN ('Branch Opening','Branch Closed','Memorandum','Other Announcement')),
      title VARCHAR(200) NOT NULL,
      body TEXT,
      image_url VARCHAR(500),
      posted_by INT NOT NULL REFERENCES users(id),
      created_at TIMESTAMP NOT NULL
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_workspace_memos_created ON workspace_memos (created_at DESC)"
  );
  // Migration for workspace_memos tables created before the optional image
  // attachment existed (CREATE TABLE IF NOT EXISTS above is a no-op on an
  // already-existing table) - safe to run every startup.
  await p.query(`ALTER TABLE workspace_memos ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)`);

  // "IT Request" log under Team Workspace: lets any IT Department (or
  // Super Admin) account record a request they're raising for one or more
  // branches - when it was raised, which branch(es) it concerns, a
  // description, and an optional photo (e.g. a picture of the broken
  // equipment). `branches` holds a JSON-encoded array of branch names
  // (a request can concern more than one branch at once) rather than a
  // single string. Viewable by both roles; a request can be deleted by
  // whoever raised it or by a Super Admin - see server's
  // /api/workspace/it-requests* routes.
  await p.query(`
    CREATE TABLE IF NOT EXISTS it_requests (
      id SERIAL PRIMARY KEY,
      request_date DATE NOT NULL,
      branches TEXT NOT NULL,
      description TEXT NOT NULL,
      image_url VARCHAR(500),
      requested_by INT NOT NULL REFERENCES users(id),
      created_at TIMESTAMP NOT NULL
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_it_requests_date ON it_requests (request_date DESC, created_at DESC)"
  );
  // Migration for an early version of this table that stored a single
  // "branch" string column instead of a JSON "branches" array - safe to
  // run every startup; a no-op once the rename below has already happened.
  await p.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'it_requests' AND column_name = 'branch')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'it_requests' AND column_name = 'branches') THEN
        ALTER TABLE it_requests ADD COLUMN branches TEXT;
        UPDATE it_requests SET branches = '["' || REPLACE(branch, '"', '\\"') || '"]';
        ALTER TABLE it_requests ALTER COLUMN branches SET NOT NULL;
        ALTER TABLE it_requests DROP COLUMN branch;
      END IF;
    END $$;
  `);

  // "Item Borrowing" under Team Workspace: an IT-managed catalog of
  // lendable items (`borrow_items` - name, description, and how many are
  // owned vs currently available), plus a log of who borrowed what
  // (`item_borrows`). Only Super Admin / IT Department can add, edit, or
  // remove catalog items (see server's /api/borrow-items* routes); any Head
  // Office Employee account, or an IT Department account borrowing for
  // itself, can borrow from it for their own department
  // (server derives the department from the logged-in account rather than
  // trusting client input), which decrements available_quantity, and a
  // Super Admin / IT Department account marks it returned later (restoring
  // the quantity) - see /api/item-borrows* / /api/workspace/item-borrows*.
  await p.query(`
    CREATE TABLE IF NOT EXISTS borrow_items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      description VARCHAR(255),
      total_quantity INT NOT NULL DEFAULT 1,
      available_quantity INT NOT NULL DEFAULT 1,
      created_by INT NOT NULL REFERENCES users(id),
      created_at TIMESTAMP NOT NULL,
      updated_by INT REFERENCES users(id),
      updated_at TIMESTAMP
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_borrow_items_name ON borrow_items (name)"
  );

  // One row per borrow. `item_name` snapshots the catalog item's name at
  // borrow time (and `item_id` goes NULL, per ON DELETE SET NULL, if the
  // item is later removed from the catalog) so this history keeps reading
  // correctly even after the item itself is edited or deleted.
  //
  // A borrow starts life 'Pending' - the requested quantity is reserved
  // (deducted from available_quantity) right away so two departments can't
  // both count on the same last unit while it awaits a decision, but it
  // isn't actually handed out yet. A Super Admin account
  // then decides it: approving flips it to 'Borrowed' (the reservation
  // stands); denying flips it to 'Denied' and releases the reservation
  // back to available_quantity, with decision_note recording why (see
  // server's /api/item-borrows/:id/decide, data.decideItemBorrow).
  await p.query(`
    CREATE TABLE IF NOT EXISTS item_borrows (
      id SERIAL PRIMARY KEY,
      item_id INT REFERENCES borrow_items(id) ON DELETE SET NULL,
      item_name VARCHAR(150) NOT NULL,
      quantity INT NOT NULL DEFAULT 1,
      department VARCHAR(100) NOT NULL,
      borrowed_by INT NOT NULL REFERENCES users(id),
      borrow_date DATE NOT NULL,
      expected_return_date DATE,
      return_date DATE,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Borrowed','Returned','Denied')),
      decided_by INT REFERENCES users(id),
      decided_at TIMESTAMP,
      decision_note VARCHAR(255),
      notes VARCHAR(255),
      created_at TIMESTAMP NOT NULL
    )
  `);
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_item_borrows_date ON item_borrows (borrow_date DESC, created_at DESC)"
  );
  await p.query(
    "CREATE INDEX IF NOT EXISTS idx_item_borrows_status ON item_borrows (status)"
  );
  // Migration for item_borrows tables created before the approve/deny
  // workflow existed (CREATE TABLE IF NOT EXISTS above is a no-op on an
  // already-existing table) - same "ADD COLUMN IF NOT EXISTS + wrapped ADD
  // CONSTRAINT" shape as the tickets void/reopen migration above. Rows
  // that already exist predate this feature and were auto-approved, so
  // they're left as 'Borrowed'/'Returned' rather than backfilled to
  // 'Pending'.
  await p.query(`ALTER TABLE item_borrows ADD COLUMN IF NOT EXISTS decided_by INT REFERENCES users(id)`);
  await p.query(`ALTER TABLE item_borrows ADD COLUMN IF NOT EXISTS decided_at TIMESTAMP`);
  await p.query(`ALTER TABLE item_borrows ADD COLUMN IF NOT EXISTS decision_note VARCHAR(255)`);
  // The name of the actual staff member borrowing the item, distinct from
  // `department` (which department it's for) and `borrowed_by` (the shared
  // Head Office Employee account that filed the request). Nullable so
  // existing rows filed before this field existed don't break; new
  // requests always populate it (see server's POST /api/item-borrows).
  await p.query(`ALTER TABLE item_borrows ADD COLUMN IF NOT EXISTS borrower_name VARCHAR(150)`);
  await p.query(`ALTER TABLE item_borrows ALTER COLUMN status SET DEFAULT 'Pending'`);
  await p.query(`ALTER TABLE item_borrows DROP CONSTRAINT IF EXISTS item_borrows_status_check`);
  try {
    await p.query(`ALTER TABLE item_borrows ADD CONSTRAINT item_borrows_status_check CHECK (status IN ('Pending','Borrowed','Returned','Denied'))`);
  } catch (err) {
    // Already present - Postgres has no clean "ADD CONSTRAINT IF NOT
    // EXISTS", so this is expected and fine, same as the tickets
    // void/reopen constraints above.
  }

  // Per-user "last time they opened Team Workspace" markers, used to
  // compute separate unread counts for Shared Files and Memos (each gets
  // its own nav dot - see data.getWorkspaceUnreadCount /
  // data.markWorkspaceSeen). Tracked per-section rather than as one
  // timestamp so opening "Shared Files" doesn't also clear the "Memos" dot
  // (and vice versa).
  await p.query(`
    CREATE TABLE IF NOT EXISTS workspace_reads (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      files_seen_at TIMESTAMP,
      memos_seen_at TIMESTAMP
    )
  `);
  // Migration for workspace_reads tables created before the split above
  // (single last_seen_at column). CREATE TABLE IF NOT EXISTS above is a
  // no-op on an already-existing table, so the new columns must be added
  // explicitly here - then the old timestamp is carried over to both and
  // dropped. No-op on a fresh install.
  await p.query(`ALTER TABLE workspace_reads ADD COLUMN IF NOT EXISTS files_seen_at TIMESTAMP`);
  await p.query(`ALTER TABLE workspace_reads ADD COLUMN IF NOT EXISTS memos_seen_at TIMESTAMP`);
  await p.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'workspace_reads' AND column_name = 'last_seen_at'
      ) THEN
        UPDATE workspace_reads
           SET files_seen_at = COALESCE(files_seen_at, last_seen_at),
               memos_seen_at = COALESCE(memos_seen_at, last_seen_at);
        ALTER TABLE workspace_reads DROP COLUMN last_seen_at;
      END IF;
    END $$;
  `);

  // Per-user "seen" state for the topbar notification bell (see
  // app.js's refreshNotifications/markNotifSeen), persisted server-side so
  // it survives a page refresh instead of resetting every time the app
  // reloads (the bell used to track "seen" only in an in-memory JS
  // variable, which is why the counts came back after a refresh).
  //
  // Two shapes of category live here:
  //  - "live pending count" categories (availability/device/void/assist):
  //    we store the exact count the user last acknowledged in
  //    *_seen_count; the row stays "seen" until the live count changes
  //    again (matches data.getPerformanceReport-style live counts, which
  //    only go up/down as requests are filed/decided, not "read").
  //  - "new since last opened" categories (tickets, mirroring the existing
  //    files/memos pattern in workspace_reads): tickets_seen_at is compared
  //    against tickets.assigned_at (see data.getNewAssignedTicketsCount).
  await p.query(`
    CREATE TABLE IF NOT EXISTS notification_reads (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      availability_seen_count INT NOT NULL DEFAULT 0,
      device_seen_count INT NOT NULL DEFAULT 0,
      void_seen_count INT NOT NULL DEFAULT 0,
      assist_seen_count INT NOT NULL DEFAULT 0,
      reopen_seen_count INT NOT NULL DEFAULT 0,
      tickets_seen_at TIMESTAMP,
      branch_updates_seen_at TIMESTAMP,
      void_decision_seen_at TIMESTAMP,
      reopen_decision_seen_at TIMESTAMP
    )
  `);
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS availability_seen_count INT NOT NULL DEFAULT 0`);
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS device_seen_count INT NOT NULL DEFAULT 0`);
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS void_seen_count INT NOT NULL DEFAULT 0`);
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS assist_seen_count INT NOT NULL DEFAULT 0`);
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS reopen_seen_count INT NOT NULL DEFAULT 0`);
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS tickets_seen_at TIMESTAMP`);
  // Branch Staff's "your ticket was updated" bell - separate timestamp from
  // tickets_seen_at above (which is IT/Admin's "new tickets assigned to me").
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS branch_updates_seen_at TIMESTAMP`);
  // IT Department's "a void request you filed was decided" bell - separate
  // timestamp again, since it tracks void_decided_at on tickets this user
  // filed a void request for, not tickets assigned to them (see
  // data.getVoidDecisionsCount).
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS void_decision_seen_at TIMESTAMP`);
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS reopen_decision_seen_at TIMESTAMP`);
  // Counterpart for a staffer's own availability_requests (e.g. a 'field'
  // request they filed to be marked unavailable) getting Approved/Denied -
  // same pattern as void/reopen decision seen-at above.
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS availability_decision_seen_at TIMESTAMP`);
  // A Head Office Employee's own item_borrows getting Approved/Denied -
  // same pattern again, for the Item Borrowing approve/deny workflow (see
  // data.getBorrowDecisionIds / markBorrowDecisionsSeen).
  await p.query(`ALTER TABLE notification_reads ADD COLUMN IF NOT EXISTS borrow_decision_seen_at TIMESTAMP`);

  // BSP MODE: a tiny generic key/value settings table. Currently holds a
  // single row - key 'system_mode', value 'normal' or 'bsp' (see
  // data.getSystemMode/setSystemMode) - but kept generic (rather than a
  // dedicated single-row table) in case another app-wide toggle needs
  // storing later.
  await p.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key VARCHAR(50) PRIMARY KEY,
      value TEXT
    )
  `);

  // Seed the initial branch list, only the first time (i.e. only if no
  // branches exist yet). After that, branches are entirely managed by a
  // Super Admin via the Manage Branches panel.
  {
    const [rows] = await p.query("SELECT COUNT(*) AS c FROM branches");
    if (rows[0].c === 0) {
      for (const name of ["Branch A", "Branch B", "Branch C", "Branch D"]) {
        await p.query("INSERT INTO branches (name) VALUES (?)", [name]);
      }
    }
  }

  // Seed the initial department list the same way branches are seeded
  // above - only the first time (i.e. only if no departments exist yet).
  // "Head Office" matches the demo Head Office Employee account below, so
  // that account's department exists in the managed list from the start.
  {
    const [rows] = await p.query("SELECT COUNT(*) AS c FROM departments");
    if (rows[0].c === 0) {
      await p.query("INSERT INTO departments (name) VALUES (?)", ["Head Office"]);
    }
  }

  // Seed the initial category list the same way branches/departments are
  // seeded above - only the first time (i.e. only if no categories exist
  // yet). These match the categories the app shipped with before this
  // became a managed list, so upgrading doesn't change anyone's dropdown.
  {
    const [rows] = await p.query("SELECT COUNT(*) AS c FROM categories");
    if (rows[0].c === 0) {
      const seedCategories = ["Hardware", "Software", "Internet/Network", "CCTV", "Accounts", "Printer", "Other"];
      for (let i = 0; i < seedCategories.length; i++) {
        await p.query("INSERT INTO categories (name, position) VALUES (?, ?)", [seedCategories[i], i + 1]);
      }
    }
  }

  // Seed demo accounts, but only the ones that have genuinely never existed
  // before (see demo_accounts_seeded above). A demo account that was
  // deliberately deleted stays deleted - it will NOT come back on the next
  // restart.
  const demoAccounts = [
    ["superadmin", "super123", "System Super Admin", "Super Admin", "Head Office"],
    ["admin", "admin123", "IT Support Admin", "IT Department", "IT Department"],
    ["headoffice1", "office123", "Head Office Employee", "Head Office Employee", "Head Office"],
    ["branch1", "branch123", "Branch Staff User", "Branch Staff", "Branch A"],
  ];
  for (const [username, password, fullName, role, branch] of demoAccounts) {
    const [[seededRow]] = [(await p.query(
      "SELECT 1 FROM demo_accounts_seeded WHERE username = ?", [username]
    ))[0]];
    const alreadySeeded = !!seededRow;

    const [[userRow]] = [(await p.query(
      "SELECT 1 FROM users WHERE username = ?", [username]
    ))[0]];
    const userExists = !!userRow;

    if (userExists && !alreadySeeded) {
      // Upgrading from before this fix existed: this demo account is
      // already sitting in 'users' from a previous seeding run that
      // predates demo_accounts_seeded. Just record it now so future
      // restarts respect a delete, without touching the account itself.
      await p.query(
        "INSERT INTO demo_accounts_seeded (username, seeded_at) VALUES (?, NOW())",
        [username]
      );
    } else if (!userExists && !alreadySeeded) {
      await p.query(
        "INSERT INTO users (username, password, full_name, role, branch, created_at) " +
        "VALUES (?, ?, ?, ?, ?, NOW())",
        [username, password, fullName, role, branch]
      );
      await p.query(
        "INSERT INTO demo_accounts_seeded (username, seeded_at) VALUES (?, NOW())",
        [username]
      );
    }
    // else: alreadySeeded and !userExists -> was deliberately deleted; leave it alone.
  }

  // Second admin portal login (itrocks): a Super Admin that can't change Normal/BSP
  // Mode (can_change_mode = FALSE). Same "only if it never existed before"
  // rule as the demo accounts above - if it's deliberately deleted it stays
  // deleted, and an existing account with this username is never modified.
  {
    const username = "itrocks";
    const [seededRows] = await p.query("SELECT 1 FROM demo_accounts_seeded WHERE username = ?", [username]);
    const [userRows] = await p.query("SELECT 1 FROM users WHERE username = ?", [username]);
    if (seededRows.length === 0) {
      if (userRows.length === 0) {
        await p.query(
          "INSERT INTO users (username, password, full_name, role, branch, can_change_mode, created_at) " +
          "VALUES (?, ?, ?, ?, ?, FALSE, NOW())",
          [username, "itrocks1", "IT Department Admin", "Super Admin", "Head Office"]
        );
      }
      await p.query("INSERT INTO demo_accounts_seeded (username, seeded_at) VALUES (?, NOW())", [username]);
    }
  }

  // Backfill role-specific rows for any account that doesn't have one yet
  // (accounts created before these tables existed). Uses each user's
  // existing 'branch' value as the starting department/branch name.
  const [allUsers] = await p.query("SELECT id, role, branch FROM users");
  for (const { id: userId, role, branch } of allUsers) {
    if (role === "Super Admin") {
      const [[row]] = [(await p.query("SELECT 1 FROM super_admins WHERE user_id = ?", [userId]))[0]];
      if (!row) await p.query("INSERT INTO super_admins (user_id) VALUES (?)", [userId]);
    } else if (role === "IT Department") {
      const [[row]] = [(await p.query("SELECT 1 FROM it_department WHERE user_id = ?", [userId]))[0]];
      if (!row) await p.query("INSERT INTO it_department (user_id) VALUES (?)", [userId]);
      // Backfill: an IT Department account with no concerns set yet
      // (pre-existing installs, or the seeded demo admin) is given every
      // concern so it isn't silently excluded from auto-assignment.
      const [[countRow]] = [(await p.query(
        "SELECT COUNT(*) AS c FROM it_specialties WHERE user_id = ?", [userId]
      ))[0]];
      if (countRow.c === 0) {
        for (const cat of DEMO_IT_SPECIALTIES) {
          await p.query(
            "INSERT INTO it_specialties (user_id, category) VALUES (?, ?)",
            [userId, cat]
          );
        }
      }
    } else if (role === "Head Office Employee") {
      const [[row]] = [(await p.query("SELECT 1 FROM head_office_employees WHERE user_id = ?", [userId]))[0]];
      if (!row) {
        await p.query(
          "INSERT INTO head_office_employees (user_id, department) VALUES (?, ?)",
          [userId, branch || "General"]
        );
      }
    } else if (role === "Branch Staff") {
      const [[row]] = [(await p.query("SELECT 1 FROM branch_staff WHERE user_id = ?", [userId]))[0]];
      if (!row) {
        await p.query(
          "INSERT INTO branch_staff (user_id, branch_name) VALUES (?, ?)",
          [userId, branch || "Branch A"]
        );
      }
    }
  }
}

/** Bump this string WHENEVER you change the schema or seed data in
 * _runFullInit() above (new table/column/index, new seeded account, etc).
 * initDb() compares it with the version stored in the database and skips
 * the whole ~500-query setup when they match. */
const SCHEMA_VERSION = "2026-10-14-1";

/** Fast startup check. The full setup (_runFullInit) is ~140 DDL statements
 * plus one query PER USER for the role-table backfill - hundreds of
 * sequential round trips to Neon. On serverless that used to run on every
 * cold start (several seconds before the first request could be answered).
 * Now a cold start costs 2 quick queries once the database is already at
 * SCHEMA_VERSION; the full setup runs only after a deploy that bumped it.
 * `force` re-runs everything regardless (used by `node db.js`). */
async function initDb({ force = false } = {}) {
  const p = getConnection();
  await p.query(
    "CREATE TABLE IF NOT EXISTS app_meta (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL)"
  );
  if (!force) {
    const [rows] = await p.query("SELECT value FROM app_meta WHERE key = 'schema_version'");
    if (rows[0] && rows[0].value === SCHEMA_VERSION) return;
  }
  await _runFullInit();
  await p.query(
    "INSERT INTO app_meta (key, value) VALUES ('schema_version', ?) " +
    "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [SCHEMA_VERSION]
  );
}

module.exports = { getConnection, getPool, initDb, DB_CONFIG };

if (require.main === module) {
  initDb({ force: true })
    .then(() => {
      console.log("Neon database is ready.");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}