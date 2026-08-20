"use strict";

const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("functions/index.js", "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`missing section: ${startMarker}`);
  return source.slice(start, end);
}

function requireText(body, value, label) {
  if (!body.includes(value)) throw new Error(`missing ${label}`);
}

const helpers = section("const AGENCY_RECENT_AUDIT_DAYS", "async function auditRecentAgencyActivity");
const sandbox = {
  kstDate(now) {
    const date = new Date(now + 9 * 3600000);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  },
};
vm.runInNewContext(helpers, sandbox);

const sunday = Date.parse("2026-07-19T03:00:00+09:00");
const window = sandbox.agencyRecentAuditWindow(sunday);
if (window.runDate !== "2026-07-19" || window.completedDates.join(",") !== "2026-07-12,2026-07-13,2026-07-14,2026-07-15,2026-07-16,2026-07-17,2026-07-18") {
  throw new Error("recent audit window must cover the seven completed KST dates");
}

const counts = sandbox.addAgencyRecentCounts({}, { "010-1234-5678": 3, "01012345678": 2, bad: 8, zero: 0 });
if (counts["01012345678"] !== 5 || Object.keys(counts).length !== 1) {
  throw new Error("recent agency counts must normalize phone keys and ignore unusable rows");
}

const expected = sandbox.agencyExpectedCleanCount(
  { cleanCounts: { "01012345678": 100 }, runDatePartial: { "01012345678": 5 } },
  "01012345678",
  30,
  2,
);
if (expected !== 127) throw new Error(`expected clean count mismatch: ${expected}`);
if (sandbox.agencyExpectedCleanCount({}, "01012345678", 30, 2) !== null) {
  throw new Error("a new agency must establish a baseline instead of guessing");
}

const audit = section("async function auditRecentAgencyActivity", "exports.agencyRecountTick");
requireText(audit, 'db.ref("v1/app/data_live/" + date + "/agencies")', "recent summary reads");
requireText(audit, 'db.ref("v1/agencies/" + phone + "/cleanCount")', "changed agency count reads");
requireText(audit, 'auditRef.set(result)', "bounded audit result");
if (audit.includes('/orders')) throw new Error("scheduled agency audit must not read raw order history");
if (audit.includes('db.ref("v1/agencies").update')) throw new Error("scheduled agency audit must not overwrite agency data");

const scheduled = section("exports.agencyRecountTick", "exports.agencyRecountNow");
requireText(scheduled, "auditRecentAgencyActivity(started)", "recent audit scheduler");
if (scheduled.includes("recountAgencies(")) throw new Error("weekly scheduler must not call the full recount");

const manual = section("exports.agencyRecountNow", "// Agency trust/unit-price daily ledger");
requireText(manual, "recountAgencies()", "manual exact recount fallback");

console.log("verify-agency-recount-diet: PASS");
