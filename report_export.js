/**
 * report_export.js
 * Builds the formatted .xlsx workbook behind the Reporting tab's
 * "Download Report" button.
 *
 * Nothing here touches the database - it takes report data the server
 * already fetched from reporting.js and turns it into a styled Excel
 * workbook, using the 'exceljs' package (the closest JS equivalent to
 * Python's openpyxl).
 */

const ExcelJS = require("exceljs");

const INVALID_SHEET_CHARS = new Set(["[", "]", ":", "*", "?", "/", "\\"]);

/** Turn a branch name into a valid, unique Excel sheet name: strip
 * characters Excel forbids in sheet titles, cap at the 31-char limit, and
 * de-duplicate by appending a counter. */
function sheetSafeName(name, usedNames) {
  let cleaned = Array.from(name).filter((ch) => !INVALID_SHEET_CHARS.has(ch)).join("").trim() || "Branch";
  cleaned = cleaned.slice(0, 31);
  let candidate = cleaned;
  let n = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = cleaned.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

// ---------- Shared styling ----------
// One palette + one set of sheet-building helpers, reused by every workbook
// builder below, so both exports share the exact same look instead of
// drifting apart.
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4F46E5" } };   // COLOR_PRIMARY
const TITLE_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111827" } };    // COLOR_SIDEBAR
const SUBTOTAL_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E7FF" } }; // COLOR_PRIMARY_SOFT
const STRIPE_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };   // COLOR_SURFACE_ALT
const SECTION_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111827" } };

const WHITE_BOLD = { name: "Calibri", size: 12, bold: true, color: { argb: "FFFFFFFF" } };
const SECTION_FONT = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
const HEADER_FONT = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
const LABEL_FONT = { name: "Calibri", size: 10, bold: true, color: { argb: "FF64748B" } };
const NORMAL_FONT = { name: "Calibri", size: 10, color: { argb: "FF111827" } };
const BOLD_FONT = { name: "Calibri", size: 10, bold: true, color: { argb: "FF111827" } };
const LINK_FONT = { name: "Calibri", size: 10, color: { argb: "FF4F46E5" }, underline: true };

const THIN = { style: "thin", color: { argb: "FFE2E6EE" } };
const CELL_BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const CENTER = { horizontal: "center", vertical: "middle" };
const LEFT = { horizontal: "left", vertical: "middle" };

function styleSheet(ws) {
  ws.views = [{ showGridLines: false }];
}

function mergeTitle(ws, row, text, fill, font, lastCol, height = 22) {
  ws.mergeCells(row, 1, row, lastCol);
  for (let col = 1; col <= lastCol; col++) {
    const cell = ws.getCell(row, col);
    cell.fill = fill;
  }
  const cell = ws.getCell(row, 1);
  cell.value = text;
  cell.font = font;
  cell.alignment = LEFT;
  ws.getRow(row).height = height;
}

function headerRow(ws, row, headers, startCol = 1) {
  headers.forEach((text, i) => {
    const cell = ws.getCell(row, startCol + i);
    cell.value = text;
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = i > 0 ? CENTER : LEFT;
    cell.border = CELL_BORDER;
  });
  ws.getRow(row).height = 20;
}

/** Write one row of values and return the next row index (mirrors the
 * Python helper's `return row + 1` convention). */
function dataRow(ws, row, values, { fill = null, font = null, startCol = 1 } = {}) {
  values.forEach((val, i) => {
    const cell = ws.getCell(row, startCol + i);
    cell.value = val;
    cell.font = font || NORMAL_FONT;
    cell.alignment = i > 0 ? CENTER : LEFT;
    if (fill) cell.fill = fill;
    cell.border = CELL_BORDER;
  });
  return row + 1;
}

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function setColumnWidths(ws, widths) {
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
}

/** Build a formatted .xlsx workbook (font/fill/border styling, sized
 * columns, frozen header rows) for the currently-generated report:
 *   - a summary sheet with IT staff performance + a per-branch overview
 *   - one additional sheet PER BRANCH, with that branch's ticket breakdown
 *     by category ("concerns")
 * Returns an ExcelJS Workbook; the caller streams/saves it as needed.
 */
function buildReportWorkbook(report, periodLabel) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Summary");
  styleSheet(ws);

  const STAFF_COLS = 8;   // Staff Member .. Avg Resolution (hrs)
  const BRANCH_COLS = 6;  // Branch .. Top Concern (summary table)
  const lastCol = Math.max(STAFF_COLS, BRANCH_COLS);

  let r = 1;
  mergeTitle(ws, r, "IT Ticket System — Report", TITLE_FILL, WHITE_BOLD, lastCol, 26);
  r += 1;
  ws.getCell(r, 1).value = "Period:";
  ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = periodLabel;
  ws.getCell(r, 2).font = BOLD_FONT;
  r += 2;

  // ---- IT Staff Performance ----
  mergeTitle(ws, r, "IT Staff Performance", SECTION_FILL, SECTION_FONT, lastCol);
  r += 1;
  headerRow(ws, r, ["Staff Member", "Role", "Assigned", "Resolved", "Open",
    "In Progress", "Resolution Rate (%)", "Avg Resolution (hrs)"]);
  r += 1;
  const firstStaffRow = r;
  report.rows.forEach((rowData, i) => {
    const avgHrs = rowData.avg_resolution_hours;
    r = dataRow(ws, r, [
      rowData.full_name, rowData.role, rowData.assigned, rowData.resolved,
      rowData.open, rowData.in_progress, rowData.resolution_rate,
      avgHrs !== null ? avgHrs : "—",
    ], { fill: i % 2 ? STRIPE_FILL : null });
  });
  if (report.rows.length === 0) {
    r = dataRow(ws, r, ["No IT staff accounts in this period", "", "", "", "", "", "", ""]);
  }
  const s = report.summary;
  const avgHrs = s.avg_resolution_hours;
  r = dataRow(ws, r, [
    "Overall Totals", "", s.total_assigned, s.total_resolved, s.total_open,
    s.total_in_progress, s.overall_resolution_rate,
    avgHrs !== null ? avgHrs : "—",
  ], { fill: SUBTOTAL_FILL, font: BOLD_FONT });
  // Percent formatting on the resolution-rate column (values are already
  // e.g. 87.5, not 0.875, so the custom format just appends "%").
  for (let rowI = firstStaffRow; rowI < r; rowI++) {
    ws.getCell(rowI, 7).numFmt = '0.0"%"';
  }
  r += 2;

  // ---- Branch Summary (one row per branch, busiest first, linking out to
  // that branch's own sheet for the full category breakdown) ----
  mergeTitle(ws, r, "Branch Summary", SECTION_FILL, SECTION_FONT, lastCol);
  r += 1;
  headerRow(ws, r, ["Branch", "Total Tickets", "Resolved", "Open", "In Progress", "Top Concern"]);
  r += 1;
  const branchSummary = report.branch_summary;
  const branchRows = report.branch_rows;

  // Assign each branch its own sheet name up front, so the summary table
  // can link to it before that sheet has actually been built.
  const usedNames = new Set(["summary"]);
  const branchSheetNames = {};
  for (const b of branchSummary) {
    branchSheetNames[b.branch] = sheetSafeName(b.branch, usedNames);
  }

  if (branchSummary.length === 0) {
    r = dataRow(ws, r, ["No tickets in this period", "", "", "", "", ""]);
  } else {
    branchSummary.forEach((b, i) => {
      const fill = i % 2 ? STRIPE_FILL : null;
      const r2 = dataRow(ws, r, [b.branch, b.total, b.resolved, b.open,
        b.in_progress, b.top_category || "—"], { fill });
      const branchCell = ws.getCell(r, 1);
      branchCell.value = { text: b.branch, hyperlink: `#'${branchSheetNames[b.branch]}'!A1` };
      branchCell.font = LINK_FONT;
      r = r2;
    });
  }

  setColumnWidths(ws, [22, 18, 13, 11, 9, 12, 18, 20].slice(0, lastCol));
  ws.views = [{ showGridLines: false, state: "frozen", ySplit: 1 }];

  // ---- One sheet per branch: its ticket breakdown by category ----
  const byBranch = {};
  for (const rd of branchRows) {
    if (!byBranch[rd.branch]) byBranch[rd.branch] = [];
    byBranch[rd.branch].push(rd);
  }

  for (const b of branchSummary) {
    const branch = b.branch;
    const bws = wb.addWorksheet(branchSheetNames[branch]);
    styleSheet(bws);
    let br = 1;
    mergeTitle(bws, br, `Branch Concerns — ${branch}`, TITLE_FILL, WHITE_BOLD, 5, 26);
    br += 1;
    bws.getCell(br, 1).value = "Period:";
    bws.getCell(br, 1).font = LABEL_FONT;
    bws.getCell(br, 2).value = periodLabel;
    bws.getCell(br, 2).font = BOLD_FONT;
    br += 1;
    const backCell = bws.getCell(br, 1);
    backCell.value = { text: "← Back to Summary", hyperlink: "#'Summary'!A1" };
    backCell.font = LINK_FONT;
    br += 2;

    headerRow(bws, br, ["Category", "Total Tickets", "Resolved", "Open", "In Progress"]);
    br += 1;
    const firstRow = br;
    (byBranch[branch] || []).forEach((rd, i) => {
      br = dataRow(bws, br, [rd.category, rd.total, rd.resolved, rd.open, rd.in_progress],
        { fill: i % 2 ? STRIPE_FILL : null });
    });
    if (!byBranch[branch] || byBranch[branch].length === 0) {
      br = dataRow(bws, br, ["No tickets in this period", "", "", "", ""]);
    }
    br = dataRow(bws, br, ["Total", b.total, b.resolved, b.open, b.in_progress],
      { fill: SUBTOTAL_FILL, font: BOLD_FONT });

    setColumnWidths(bws, [22, 15, 12, 10, 13]);
    bws.views = [{ showGridLines: false, state: "frozen", ySplit: firstRow - 1 }];
  }

  return wb;
}

/** Build a formatted single-sheet .xlsx workbook for one IT staff member's
 * own "My Performance" self-service report: their summary stats, which
 * branches they've been assisting, and a day-by-day assigned/resolved
 * breakdown.
 *
 * perf     - a reporting.getStaffPerformanceReport() object
 * daily    - a list of {day, assigned, resolved} objects, one per day in
 *            the period
 * branches - a reporting.getStaffBranchBreakdown() list
 */
function buildStaffReportWorkbook(report, periodLabel) {
  const { perf, daily, branches, tickets = [], scope } = report;
  const LAST_COL = 8;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("My Report");
  styleSheet(ws);

  let r = 1;
  mergeTitle(ws, r, "IT Ticket System — Staff Report", TITLE_FILL, WHITE_BOLD, LAST_COL, 26);
  r += 1;
  ws.getCell(r, 1).value = "Staff Member:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = perf.full_name; ws.getCell(r, 2).font = BOLD_FONT;
  ws.getCell(r, 5).value = "Role:"; ws.getCell(r, 5).font = LABEL_FONT;
  ws.getCell(r, 6).value = perf.role; ws.getCell(r, 6).font = BOLD_FONT;
  r += 1;
  ws.getCell(r, 1).value = "Period:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = periodLabel; ws.getCell(r, 2).font = BOLD_FONT;
  r += 1;
  ws.getCell(r, 1).value = "Report Scope:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = scope ? scope.label : "All tickets received"; ws.getCell(r, 2).font = BOLD_FONT;
  r += 1;
  if (scope && scope.restricted) {
    ws.getCell(r, 1).value = "Branches In Scope:"; ws.getCell(r, 1).font = LABEL_FONT;
    ws.getCell(r, 2).value = (scope.branches && scope.branches.length) ? scope.branches.join(", ") : "—";
    ws.getCell(r, 2).font = BOLD_FONT;
    r += 1;
  }
  const branchNames = branches.length ? branches.map((b) => b.branch).join(", ") : "—";
  ws.getCell(r, 1).value = "Branches Assisted:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = branchNames; ws.getCell(r, 2).font = BOLD_FONT;
  r += 2;

  // ---- Summary ----
  mergeTitle(ws, r, "Summary", SECTION_FILL, SECTION_FONT, LAST_COL);
  r += 1;
  headerRow(ws, r, ["Received", "Resolved", "Open", "In Progress", "Resolution Rate (%)"]);
  r += 1;
  const avgHrs = perf.avg_resolution_hours;
  r = dataRow(ws, r, [
    perf.assigned, perf.resolved, perf.open, perf.in_progress, perf.resolution_rate,
  ], { fill: SUBTOTAL_FILL, font: BOLD_FONT });
  ws.getCell(r - 1, 5).numFmt = '0.0"%"';
  ws.getCell(r, 1).value = "Avg. Resolution Time:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = avgHrs !== null && avgHrs !== undefined ? `${avgHrs} hrs` : "—"; ws.getCell(r, 2).font = BOLD_FONT;
  r += 2;

  // ---- Branches Assisted ----
  mergeTitle(ws, r, "Branches Assisted", SECTION_FILL, SECTION_FONT, LAST_COL);
  r += 1;
  headerRow(ws, r, ["Branch", "Total Tickets", "Resolved", "Open", "In Progress"]);
  r += 1;
  if (branches.length === 0) {
    r = dataRow(ws, r, ["No tickets in this period", "", "", "", ""]);
  } else {
    branches.forEach((b, i) => {
      r = dataRow(ws, r, [b.branch, b.total, b.resolved, b.open, b.in_progress],
        { fill: i % 2 ? STRIPE_FILL : null });
    });
  }
  r += 1;

  // ---- Daily breakdown ----
  mergeTitle(ws, r, "Daily Breakdown", SECTION_FILL, SECTION_FONT, LAST_COL);
  r += 1;
  headerRow(ws, r, ["Date", "Received", "Resolved"]);
  r += 1;
  if (daily.length === 0) {
    r = dataRow(ws, r, ["No tickets in this period", "", ""]);
  } else {
    daily.forEach((d, i) => {
      r = dataRow(ws, r, [d.day, d.assigned, d.resolved], { fill: i % 2 ? STRIPE_FILL : null });
    });
  }

  setColumnWidths(ws, [24, 24, 14, 14, 18, 14, 14, 14]);
  ws.views = [{ showGridLines: false }];

  // ---- Ticket list (second sheet) ----
  const wt = wb.addWorksheet("Tickets");
  styleSheet(wt);
  mergeTitle(wt, 1, `Tickets — ${perf.full_name} (${periodLabel})`, TITLE_FILL, WHITE_BOLD, 8, 24);
  headerRow(wt, 2, ["Ticket #", "Title", "Branch", "Category", "Priority", "Status", "Created", "Resolved"]);
  let tr = 3;
  const fmtDt = (v) => (v ? new Date(v).toISOString().replace("T", " ").slice(0, 16) : "");
  if (tickets.length === 0) {
    tr = dataRow(wt, tr, ["No tickets in this period", "", "", "", "", "", "", ""]);
  } else {
    tickets.forEach((t, i) => {
      tr = dataRow(wt, tr, [
        "#T-" + String(t.id).padStart(5, "0"), t.title, t.branch, t.category, t.priority, t.status,
        fmtDt(t.created_at), fmtDt(t.resolved_at),
      ], { fill: i % 2 ? STRIPE_FILL : null });
    });
  }
  setColumnWidths(wt, [12, 44, 26, 20, 12, 14, 18, 18]);
  wt.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];

  return wb;
}

/** Build a formatted single-sheet .xlsx workbook for the Super Admin's
 * "Branch History" report: one branch's own summary stats, its ticket
 * breakdown by category ("concerns"), and a day-by-day created/resolved
 * breakdown.
 *
 * branchPerf - a reporting.getBranchPerformanceSummary() object
 * daily      - a list of {day, assigned, resolved} objects, one per day
 * categories - a reporting.getBranchConcernsReport(branch=...) list
 */
function buildBranchReportWorkbook(branchPerf, daily, categories, periodLabel) {
  const LAST_COL = 5;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Branch History");
  styleSheet(ws);

  let r = 1;
  mergeTitle(ws, r, "IT Ticket System — Branch History", TITLE_FILL, WHITE_BOLD, LAST_COL, 26);
  r += 1;
  ws.getCell(r, 1).value = "Branch:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = branchPerf.branch; ws.getCell(r, 2).font = BOLD_FONT;
  r += 1;
  ws.getCell(r, 1).value = "Period:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = periodLabel; ws.getCell(r, 2).font = BOLD_FONT;
  r += 2;

  // ---- Summary ----
  mergeTitle(ws, r, "Summary", SECTION_FILL, SECTION_FONT, LAST_COL);
  r += 1;
  headerRow(ws, r, ["Total Tickets", "Resolved", "Open", "In Progress", "Resolution Rate (%)"]);
  r += 1;
  r = dataRow(ws, r, [
    branchPerf.total, branchPerf.resolved, branchPerf.open,
    branchPerf.in_progress, branchPerf.resolution_rate,
  ], { fill: SUBTOTAL_FILL, font: BOLD_FONT });
  ws.getCell(r - 1, 5).numFmt = '0.0"%"';
  const avgHrs = branchPerf.avg_resolution_hours;
  ws.getCell(r, 1).value = "Avg. Resolution Time:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = avgHrs !== null ? `${avgHrs} hrs` : "—"; ws.getCell(r, 2).font = BOLD_FONT;
  r += 2;

  // ---- Concerns (category breakdown) ----
  mergeTitle(ws, r, "Concerns by Category", SECTION_FILL, SECTION_FONT, LAST_COL);
  r += 1;
  headerRow(ws, r, ["Category", "Total Tickets", "Resolved", "Open", "In Progress"]);
  r += 1;
  if (categories.length === 0) {
    r = dataRow(ws, r, ["No tickets in this period", "", "", "", ""]);
  } else {
    categories.forEach((c, i) => {
      r = dataRow(ws, r, [c.category, c.total, c.resolved, c.open, c.in_progress],
        { fill: i % 2 ? STRIPE_FILL : null });
    });
  }
  r += 1;

  // ---- Daily breakdown ----
  mergeTitle(ws, r, "Daily Breakdown", SECTION_FILL, SECTION_FONT, LAST_COL);
  r += 1;
  headerRow(ws, r, ["Date", "Assigned", "Resolved"]);
  r += 1;
  const firstRow = r;
  if (daily.length === 0) {
    r = dataRow(ws, r, ["No tickets in this period", "", ""]);
  } else {
    daily.forEach((d, i) => {
      r = dataRow(ws, r, [d.day, d.assigned, d.resolved], { fill: i % 2 ? STRIPE_FILL : null });
    });
  }

  setColumnWidths(ws, [22, 14, 14, 14, 18]);
  ws.views = [{ showGridLines: false, state: "frozen", ySplit: firstRow - 1 }];

  return wb;
}

/** Build a formatted single-sheet .xlsx workbook for the Super Admin-only
 * IT Staff Attendance report: one row per login event within the period,
 * newest first - who signed in, when, and from a desktop or a phone.
 *
 * rows - a data.getAttendanceLog() list: {full_name, role, device_label,
 *        device_kind, logged_in_at}
 */
function buildAttendanceReportWorkbook(rows, periodLabel) {
  const LAST_COL = 4;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Attendance");
  styleSheet(ws);

  let r = 1;
  mergeTitle(ws, r, "IT Ticket System — IT Staff Attendance", TITLE_FILL, WHITE_BOLD, LAST_COL, 26);
  r += 1;
  ws.getCell(r, 1).value = "Period:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = periodLabel; ws.getCell(r, 2).font = BOLD_FONT;
  r += 1;
  ws.getCell(r, 1).value = "Total Logins:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = rows.length; ws.getCell(r, 2).font = BOLD_FONT;
  r += 2;

  headerRow(ws, r, ["Staff Member", "Role", "Login Time", "Device"]);
  r += 1;
  const firstRow = r;
  if (rows.length === 0) {
    r = dataRow(ws, r, ["No logins in this period", "", "", ""]);
  } else {
    rows.forEach((row, i) => {
      const loginTime = row.logged_in_at instanceof Date
        ? row.logged_in_at.toLocaleString()
        : new Date(row.logged_in_at).toLocaleString();
      r = dataRow(ws, r, [
        row.full_name, row.role, loginTime, row.device_label || row.device_kind || "Unknown device",
      ], { fill: i % 2 ? STRIPE_FILL : null });
    });
  }

  setColumnWidths(ws, [24, 18, 24, 32]);
  ws.views = [{ showGridLines: false, state: "frozen", ySplit: firstRow - 1 }];

  return wb;
}

/** Build a formatted single-sheet .xlsx workbook for the Team Workspace
 * "IT Request" log - one row per request, most recently requested first.
 * Deliberately excludes the attached image (if any): a Blob URL/binary
 * isn't meaningful in a spreadsheet cell, and the file itself is never
 * bundled into the download.
 *
 * rows - a data.listITRequests() list: {request_date, branches (array),
 *        description, requested_by_name, created_at}
 */
function buildITRequestsWorkbook(rows, periodLabel) {
  const LAST_COL = 4;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("IT Requests");
  styleSheet(ws);

  let r = 1;
  mergeTitle(ws, r, "IT Ticket System — IT Requests", TITLE_FILL, WHITE_BOLD, LAST_COL, 26);
  r += 1;
  ws.getCell(r, 1).value = "Period:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = periodLabel; ws.getCell(r, 2).font = BOLD_FONT;
  r += 1;
  ws.getCell(r, 1).value = "Total Requests:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = rows.length; ws.getCell(r, 2).font = BOLD_FONT;
  r += 2;

  headerRow(ws, r, ["Date of Request", "Branch(es)", "Description", "Requested By"]);
  r += 1;
  const firstRow = r;
  if (rows.length === 0) {
    r = dataRow(ws, r, ["No requests in this period", "", "", ""]);
  } else {
    rows.forEach((row, i) => {
      r = dataRow(ws, r, [
        row.request_date,
        (row.branches || []).join(", "),
        row.description,
        row.requested_by_name,
      ], { fill: i % 2 ? STRIPE_FILL : null });
    });
  }

  setColumnWidths(ws, [16, 26, 50, 22]);
  ws.views = [{ showGridLines: false, state: "frozen", ySplit: firstRow - 1 }];

  return wb;
}

/** Build a formatted .xlsx workbook for the per-corporation report:
 *   - "Summary": one row per corporation (totals, resolution rate, avg time,
 *     top IT staff by resolved tickets), with links to its own sheet
 *   - "IT Staff by Corporation": flat table (filterable) of every IT
 *     Department / Super Admin account that handled tickets for each
 *     corporation
 *   - one sheet PER corporation that had tickets: its IT staff / admin
 *     table and a branch breakdown
 *
 * report - a reporting.getCorporationReport() result: {corporations, summary}
 */
function buildCorporationReportWorkbook(report, periodLabel) {
  const { corporations, summary } = report;
  const wb = new ExcelJS.Workbook();
  const usedNames = new Set(["summary", "it staff by corporation"]);
  const sheetNames = {};
  for (const c of corporations) {
    if (c.total > 0) sheetNames[c.corporation] = sheetSafeName(c.corporation, usedNames);
  }
  const fmtHrs = (h) => (h !== null && h !== undefined ? h : "—");

  // ===== Summary =====
  const ws = wb.addWorksheet("Summary");
  styleSheet(ws);
  const LAST = 9;
  let r = 1;
  mergeTitle(ws, r, "IT Ticket System — Report per Corporation", TITLE_FILL, WHITE_BOLD, LAST, 26);
  r += 1;
  ws.getCell(r, 1).value = "Period:"; ws.getCell(r, 1).font = LABEL_FONT;
  ws.getCell(r, 2).value = periodLabel; ws.getCell(r, 2).font = BOLD_FONT;
  r += 2;

  mergeTitle(ws, r, "Overall", SECTION_FILL, SECTION_FONT, LAST);
  r += 1;
  headerRow(ws, r, ["Corporations w/ Tickets", "Total Tickets", "Resolved", "Open", "In Progress", "Resolution Rate (%)"]);
  r += 1;
  r = dataRow(ws, r, [
    summary.corporations_with_tickets, summary.total_tickets, summary.total_resolved,
    summary.total_open, summary.total_in_progress, summary.overall_resolution_rate,
  ], { fill: SUBTOTAL_FILL, font: BOLD_FONT });
  ws.getCell(r - 1, 6).numFmt = '0.0"%"';
  r += 1;

  mergeTitle(ws, r, "By Corporation", SECTION_FILL, SECTION_FONT, LAST);
  r += 1;
  headerRow(ws, r, [
    "Corporation", "Branches", "Total Tickets", "Resolved", "Open", "In Progress",
    "Resolution Rate (%)", "Avg. Resolution (hrs)", "Top IT Staff (resolved)",
  ]);
  const headerRowIdx = r;
  r += 1;
  corporations.forEach((c, i) => {
    const top = c.staff.find((s) => s.resolved > 0);
    const fill = i % 2 ? STRIPE_FILL : null;
    const r2 = dataRow(ws, r, [
      c.corporation, c.branch_count, c.total, c.resolved, c.open, c.in_progress,
      c.resolution_rate, fmtHrs(c.avg_resolution_hours),
      top ? `${top.full_name} (${top.resolved})` : "—",
    ], { fill });
    ws.getCell(r, 7).numFmt = '0.0"%"';
    ws.getCell(r, 1).alignment = LEFT;
    if (sheetNames[c.corporation]) {
      const cell = ws.getCell(r, 1);
      cell.value = { text: c.corporation, hyperlink: `#'${sheetNames[c.corporation]}'!A1` };
      cell.font = LINK_FONT;
    }
    r = r2;
  });
  r = dataRow(ws, r, [
    "Total", "", summary.total_tickets, summary.total_resolved, summary.total_open,
    summary.total_in_progress, summary.overall_resolution_rate, "", "",
  ], { fill: SUBTOTAL_FILL, font: BOLD_FONT });
  ws.getCell(r - 1, 7).numFmt = '0.0"%"';
  setColumnWidths(ws, [44, 12, 14, 12, 10, 13, 19, 21, 32]);
  ws.views = [{ showGridLines: false, state: "frozen", ySplit: headerRowIdx }];

  // ===== IT Staff by Corporation (flat, filterable) =====
  const sws = wb.addWorksheet("IT Staff by Corporation");
  styleSheet(sws);
  const SL = 9;
  let sr = 1;
  mergeTitle(sws, sr, "IT Staff & Admin — Performance per Corporation", TITLE_FILL, WHITE_BOLD, SL, 26);
  sr += 1;
  sws.getCell(sr, 1).value = "Period:"; sws.getCell(sr, 1).font = LABEL_FONT;
  sws.getCell(sr, 2).value = periodLabel; sws.getCell(sr, 2).font = BOLD_FONT;
  sr += 1;
  sws.getCell(sr, 1).value = "Note: a ticket with collaborators counts for each collaborator, so staff rows can add up to more than the corporation's ticket total.";
  sws.getCell(sr, 1).font = LABEL_FONT;
  sr += 2;
  headerRow(sws, sr, [
    "Corporation", "IT Staff / Admin", "Role", "Assigned", "Resolved", "Open",
    "In Progress", "Resolution Rate (%)", "Avg. Resolution (hrs)",
  ]);
  const staffHeaderIdx = sr;
  sr += 1;
  let n = 0;
  for (const c of corporations) {
    for (const st of c.staff) {
      sr = dataRow(sws, sr, [
        c.corporation, st.full_name, st.role, st.assigned, st.resolved, st.open,
        st.in_progress, st.resolution_rate, fmtHrs(st.avg_resolution_hours),
      ], { fill: n % 2 ? STRIPE_FILL : null });
      sws.getCell(sr - 1, 8).numFmt = '0.0"%"';
      sws.getCell(sr - 1, 2).alignment = LEFT;
      sws.getCell(sr - 1, 3).alignment = LEFT;
      n += 1;
    }
  }
  if (n === 0) sr = dataRow(sws, sr, ["No tickets in this period", "", "", "", "", "", "", "", ""]);
  else sws.autoFilter = { from: { row: staffHeaderIdx, column: 1 }, to: { row: staffHeaderIdx, column: SL } };
  setColumnWidths(sws, [44, 26, 16, 12, 12, 10, 13, 19, 21]);
  sws.views = [{ showGridLines: false, state: "frozen", ySplit: staffHeaderIdx }];

  // ===== One sheet per corporation =====
  for (const c of corporations) {
    if (!sheetNames[c.corporation]) continue;
    const cws = wb.addWorksheet(sheetNames[c.corporation]);
    styleSheet(cws);
    const CL = 8;
    let cr = 1;
    mergeTitle(cws, cr, `Corporation Report — ${c.corporation}`, TITLE_FILL, WHITE_BOLD, CL, 26);
    cr += 1;
    cws.getCell(cr, 1).value = "Period:"; cws.getCell(cr, 1).font = LABEL_FONT;
    cws.getCell(cr, 2).value = periodLabel; cws.getCell(cr, 2).font = BOLD_FONT;
    cr += 1;
    const back = cws.getCell(cr, 1);
    back.value = { text: "← Back to Summary", hyperlink: "#'Summary'!A1" };
    back.font = LINK_FONT;
    cr += 2;

    mergeTitle(cws, cr, "Summary", SECTION_FILL, SECTION_FONT, CL);
    cr += 1;
    headerRow(cws, cr, ["Branches", "Total Tickets", "Resolved", "Open", "In Progress", "Resolution Rate (%)", "Avg. Resolution (hrs)"]);
    cr += 1;
    cr = dataRow(cws, cr, [
      c.branch_count, c.total, c.resolved, c.open, c.in_progress,
      c.resolution_rate, fmtHrs(c.avg_resolution_hours),
    ], { fill: SUBTOTAL_FILL, font: BOLD_FONT });
    cws.getCell(cr - 1, 6).numFmt = '0.0"%"';
    cr += 1;

    mergeTitle(cws, cr, "IT Staff & Admin", SECTION_FILL, SECTION_FONT, CL);
    cr += 1;
    headerRow(cws, cr, ["IT Staff / Admin", "Role", "Assigned", "Resolved", "Open", "In Progress", "Resolution Rate (%)", "Avg. Resolution (hrs)"]);
    cr += 1;
    c.staff.forEach((st, i) => {
      cr = dataRow(cws, cr, [
        st.full_name, st.role, st.assigned, st.resolved, st.open, st.in_progress,
        st.resolution_rate, fmtHrs(st.avg_resolution_hours),
      ], { fill: i % 2 ? STRIPE_FILL : null });
      cws.getCell(cr - 1, 7).numFmt = '0.0"%"';
      cws.getCell(cr - 1, 2).alignment = LEFT;
    });
    cr += 1;

    mergeTitle(cws, cr, "Branches", SECTION_FILL, SECTION_FONT, CL);
    cr += 1;
    headerRow(cws, cr, ["Branch", "Total Tickets", "Resolved", "Open", "In Progress", "Resolution Rate (%)", "Avg. Resolution (hrs)"]);
    cr += 1;
    c.branches.forEach((b, i) => {
      cr = dataRow(cws, cr, [
        b.branch, b.total, b.resolved, b.open, b.in_progress,
        b.resolution_rate, fmtHrs(b.avg_resolution_hours),
      ], { fill: i % 2 ? STRIPE_FILL : null });
      cws.getCell(cr - 1, 6).numFmt = '0.0"%"';
    });

    setColumnWidths(cws, [36, 16, 14, 12, 10, 13, 19, 21]);
  }

  return wb;
}

module.exports = {
  buildReportWorkbook,
  buildStaffReportWorkbook,
  buildBranchReportWorkbook,
  buildCorporationReportWorkbook,
  buildAttendanceReportWorkbook,
  buildITRequestsWorkbook,
};