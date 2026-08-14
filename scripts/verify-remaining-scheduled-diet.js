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

const shadowHelpers = section("function shadowGuardTrusted", "function snapMaxTs");
const shadowSandbox = {};
vm.runInNewContext(shadowHelpers, shadowSandbox);

if (!shadowSandbox.shadowGuardTrusted({ verified: true, dirty: false, mutationSeq: 3, verifiedSeq: 3 })) {
  throw new Error("matching verified shadow guard must be trusted");
}
if (shadowSandbox.shadowGuardTrusted({ verified: true, dirty: false, mutationSeq: 4, verifiedSeq: 3 })) {
  throw new Error("advanced mutation sequence must force a raw check");
}
if (shadowSandbox.shadowGuardTrusted({ verified: true, dirty: true, mutationSeq: 3, verifiedSeq: 3 })) {
  throw new Error("dirty shadow guard must force a raw check");
}
const sample = shadowSandbox.rotatingShadowSample(["u4", "u1", "u2", "u1", "u3"], "2026-07-18", 3);
if (sample.length !== 3 || new Set(sample).size !== 3) throw new Error("weekly sample must be bounded and unique");

const reconcile = section("const SHADOW_WEEKLY_SAMPLE_SIZE", "exports.orderLive");
[
  ["dirty_plus_rotating_sample_v1", "dirty/sample reconciliation method"],
  ["rotatingShadowSample", "weekly rotating sample"],
  ["sampleMismatch", "sample mismatch gate"],
  ["escalatedFull", "conditional full escalation"],
  ["SHADOW_SEEN_RETENTION_DAYS + 1", "bounded seen retention"],
  ["absent_on_demand", "on-demand map cache policy"],
].forEach(([value, label]) => requireText(reconcile, value, label));
if (reconcile.includes("getOrBuildDataAggregate(")) throw new Error("nightly reconciliation must not rebuild historical GPS cache");
if (reconcile.includes("/gps_track/")) throw new Error("nightly reconciliation must not read historical GPS");
if (reconcile.includes('db.ref("v1/app/data_live_seen/" + date).remove')) {
  throw new Error("yesterday's live dedup markers must survive late updates");
}

const lookup = section("const AGENCY_DAILY_LOOKUP_VERSION", "function agencyDailyMemoFromRow");
[
  ["AGENCY_DAILY_LOOKUP_MAX_AGE_MS", "weekly agency lookup refresh"],
  ['db.ref("v1/app/insung_agency_stats_meta/lookup")', "small lookup cache"],
  ["namePhonePairs", "RTDB-safe agency name lookup list"],
  ['db.ref("v1/app/data_live_seen/" + date + "/_users")', "active user source"],
  ['db.ref("v1/app/agg_shadow/" + date)', "historical active user fallback"],
  ["all_users_fallback", "active user fallback"],
].forEach(([value, label]) => requireText(lookup, value, label));

const windowHelpers = section("function agencyStatsWindowFrom", "function agencyDailyMemoFromRow");
const windowSandbox = {};
vm.runInNewContext(windowHelpers, windowSandbox);
if (windowSandbox.agencyStatsWindowFrom("2026-06-28", "2026-06-01", "2026-07-18") !== "2026-06-01") {
  throw new Error("agency stats start date must preserve earliest coverage");
}
if (windowSandbox.agencyStatsWindowTo("2026-06-27", "2026-06-27", "2026-07-18") !== "2026-07-18") {
  throw new Error("agency stats end date must advance with daily processing");
}

const dailyBuild = section("async function buildAgencyDailyDelta", "async function runAgencyStatsDaily");
requireText(dailyBuild, "agencyDailyUserScope(date)", "active-user-only daily scan");
requireText(dailyBuild, "loadAgencyDailyLookup", "cached agency lookup");
if (dailyBuild.includes('db.ref("v1/agencies").once')) throw new Error("daily delta must not read the full agency root directly");

const dailyTick = section("exports.agencyStatsDailyTick", "exports.agencyStatsDailyNow");
requireText(dailyTick, "runAgencyStatsDaily(date)", "daily agency stats execution");
requireText(dailyTick, "daily_", "daily cache metric");
if (dailyTick.includes("isWeeklyBillingRun")) throw new Error("agency stats must not skip six days each week");

const dailyRun = section("async function runAgencyStatsDaily", "exports.agencyStatsDailyTick");
requireText(dailyRun, "currentDate > date", "latest incremental date regression guard");

console.log("verify-remaining-scheduled-diet: PASS");
