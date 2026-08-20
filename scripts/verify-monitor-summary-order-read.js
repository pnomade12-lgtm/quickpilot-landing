const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sourcePath = path.resolve(__dirname, "..", "functions", "index.js");
const source = fs.readFileSync(sourcePath, "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    throw new Error(`missing section: ${startMarker}`);
  }
  return source.slice(start, end);
}

function requireText(body, text, label) {
  if (!body.includes(text)) throw new Error(`missing ${label}`);
}

const summarizeUser = section("async function summarizeUser", "async function listUids");
requireText(summarizeUser, 'db.ref("v1/app/agg_shadow/"', "agg_shadow read");
requireText(summarizeUser, 'db.ref("v1/app/agg_shadow_guard/"', "agg_shadow guard read");
[
  'db.ref(base + "/profile")',
  'db.ref(base + "/app_version")',
  'db.ref(base + "/crash_logs")',
  'db.ref(base + "/user_actions/"',
].forEach(text => {
  if (summarizeUser.includes(text)) throw new Error(`five-minute summarizeUser must not repeat fixed read: ${text}`);
});
requireText(summarizeUser, "fixedMonitorInput(monitorInput, now)", "combined monitor input");
requireText(summarizeUser, "shadowGuard.verified === true", "verified shadow gate");
requireText(summarizeUser, "shadowGuard.verifiedSeq", "verified shadow mutation sequence");
requireText(summarizeUser, 'db.ref(base + "/orders/" + date)', "raw fallback read");
requireText(summarizeUser, "shadowMatchesRaw(shadow, os, orderLastTs)", "raw comparison before verification");
requireText(summarizeUser, "shadowMismatchUsers", "shadow mismatch metric");
requireText(summarizeUser, "shadowSeenFromOrders(orders)", "one-time stale shadow repair");
requireText(summarizeUser, "shadowRepairUsers", "shadow repair metric");
requireText(summarizeUser, "current == null ? shadowGuard : current", "transaction initial-null fallback");
requireText(summarizeUser, 'const repairToken = uid + ":" + shadowMutationSeq', "idempotent repair token");

const monitorSummary = section("exports.monitorSummary =", "exports.monitorSummaryNow =");
requireText(monitorSummary, 'cache: "monitor_input_v1_with_verified_shadow"', "billing log read mode");
requireText(source, 'mode: "verified_shadow_monitor_input_v1"', "persistent monitor health mode");
requireText(source, "shadowRepairUids: readMetrics.shadowRepairUids", "persistent repaired uid list");
requireText(source, "rawFallbackUids: readMetrics.rawFallbackUids", "persistent raw fallback uid list");
requireText(source, "shadowVerifyRaceUids: readMetrics.shadowVerifyRaceUids", "persistent verify race uid list");
requireText(source, "fixedCacheRootReads: readMetrics.fixedCacheRootReads", "fixed cache root read metric");
requireText(source, "fixedFallbackReads: readMetrics.fixedFallbackReads", "fixed fallback read metric");

const buildSummary = section("async function buildSummary", "const RUN =");
requireText(buildSummary, "db.ref(MONITOR_INPUT_PATH).once", "single combined monitor input read");
requireText(buildSummary, "loadMonitorInputCache(uids, now, inputSnap, readMetrics)", "monitor input cache load");
requireText(buildSummary, "ensureMonitorInput(uid, monitorInputs[uid], now, readMetrics)", "new-user fallback guard");

const monitorProfileLive = section("exports.monitorProfileLive =", "exports.monitorVersionLive =");
requireText(monitorProfileLive, '.ref("/v1/users/{uid}/profile").onWrite', "profile change trigger");
requireText(monitorProfileLive, 'MONITOR_INPUT_PATH + "/" + ctx.params.uid + "/profile"', "profile cache target");
const monitorVersionLive = section("exports.monitorVersionLive =", "exports.monitorCrashLive =");
requireText(monitorVersionLive, '.ref("/v1/users/{uid}/app_version").onWrite', "version change trigger");
const monitorCrashLive = section("exports.monitorCrashLive =", "// ===== 데이터 탭");
requireText(monitorCrashLive, '.ref("/v1/users/{uid}/crash_logs/{crashId}").onCreate', "crash change trigger");
requireText(monitorCrashLive, "applyMonitorCrashEvent(current", "crash retry-safe cache update");
requireText(summarizeUser, "Math.max(gpsTs, fixed.seenTs, orderLastTs)", "activity from existing gps and order changes");

const orderLive = section("exports.orderLive =", "async function recountAgencies");
requireText(orderLive, 'const sBase = "v1/app/agg_shadow/"', "orderLive agg_shadow target");
requireText(orderLive, '["plat/" + pf]', "orderLive platform increment");
requireText(orderLive, 'sBase + "/lastTs"', "orderLive last timestamp update");
requireText(orderLive, "const before = change.before.val()", "orderLive before snapshot");
requireText(orderLive, "const shadowMayBeStale", "delete or identity-change guard");
requireText(orderLive, 'db.ref("v1/app/agg_shadow_guard/"', "dirty shadow guard write");
requireText(orderLive, "next.mutationSeq", "order mutation sequence");
requireText(orderLive, "verifiedSeq: eventMutationSeq", "verified sequence advance after safe write");
requireText(orderLive, "current == null ? eventGuard : current", "orderLive transaction initial-null fallback");
requireText(orderLive, "next.lastOrderId = ctx.params.orderId", "last order source trace");

const helperStart = source.indexOf("function lastOrderTs");
const helperEnd = source.indexOf("function snapMaxTs");
if (helperStart < 0 || helperEnd <= helperStart) throw new Error("shadow helper section not found");
const sandbox = {};
vm.runInNewContext(
  'const ORDER_TS_FIELDS = ["detected_at", "accepted_at", "arrive_at", "delivered_at"];\n' +
    source.slice(helperStart, helperEnd),
  sandbox
);
const sampleOrders = {
  a: { signature: "인성|A", platform: "인성", detected_at: 100 },
  b: { signature: "인성|A", platform: "인성", detected_at: 110 },
  c: { signature: "통합콜|B", platform: "통합콜", accepted_at: 120 },
};
const sampleStats = sandbox.ordStats(sampleOrders);
if (sampleStats.cnt !== 2 || sampleStats.plat["인성"] !== 1 || sampleStats.plat["통합콜"] !== 1) {
  throw new Error("sample dedup stats must contain two canonical orders");
}
const sampleSeen = sandbox.shadowSeenFromOrders(sampleOrders);
if (Object.keys(sampleSeen).length !== 2) throw new Error("repaired seen set must drop duplicate/stale keys");
if (sandbox.shadowMatchesRaw({ cnt: 3, plat: { "인성": 2, "통합콜": 1 }, lastTs: 120 }, sampleStats, 120)) {
  throw new Error("stale shadow must not pass raw comparison");
}
if (!sandbox.shadowMatchesRaw({ cnt: 2, plat: { "인성": 1, "통합콜": 1 }, lastTs: 120 }, sampleStats, 120)) {
  throw new Error("repaired shadow must pass raw comparison");
}

const dateHelperStart = source.indexOf("function dayStartMs");
const dateHelperEnd = source.indexOf("function kstDayOfWeek");
const fixedHelperStart = source.indexOf("function monitorProfileInput");
const fixedHelperEnd = source.indexOf("async function readMonitorInputFallback");
if (dateHelperStart < 0 || dateHelperEnd <= dateHelperStart || fixedHelperStart < 0 || fixedHelperEnd <= fixedHelperStart) {
  throw new Error("monitor input helper section not found");
}
const fixedSandbox = {};
vm.runInNewContext(
  source.slice(dateHelperStart, dateHelperEnd) + "\n" + source.slice(fixedHelperStart, fixedHelperEnd),
  fixedSandbox
);
const fixedNow = Date.UTC(2026, 6, 16, 12, 0, 0);
const fixedSeed = fixedSandbox.monitorCacheSeedFromSummary({
  nick: "old", name: "driver", phone: "01000000000", ver: "0.13",
  crCnt: 2, lastCrashTs: fixedNow - 1000, seenTs: fixedNow - 5000,
}, fixedNow);
const fixedMerged = fixedSandbox.mergeMonitorCacheEntry(fixedSeed, {
  profile: { nick: "new" },
  version: { value: "0.14" },
  crash: { date: fixedSandbox.kstDate(fixedNow), count: 3, lastTs: fixedNow },
  seenTs: fixedNow + 1000,
});
const fixedValue = fixedSandbox.fixedMonitorInput(fixedMerged, fixedNow);
if (fixedValue.nick !== "new" || fixedValue.name !== "driver" || fixedValue.ver !== "0.14") {
  throw new Error("changed fixed fields must override the seeded summary without dropping unchanged fields");
}
if (fixedValue.crCnt !== 3 || fixedValue.lastCrashTs !== fixedNow || fixedValue.seenTs !== fixedNow + 1000) {
  throw new Error("crash and latest activity cache must preserve the newest values");
}
if (fixedSandbox.fixedMonitorInput(fixedMerged, fixedNow + 86400000).crCnt !== 0) {
  throw new Error("previous-day crash count must reset without rereading crash logs");
}
const firstCrash = fixedSandbox.applyMonitorCrashEvent({}, {
  date: "2026-07-16", eventDate: "2026-07-16", eventKey: "100", ts: fixedNow,
  now: fixedNow, baseline: 2, summaryLastTs: fixedNow - 1000,
});
const repeatedCrash = fixedSandbox.applyMonitorCrashEvent(firstCrash, {
  date: "2026-07-16", eventDate: "2026-07-16", eventKey: "100", ts: fixedNow,
  now: fixedNow + 1, baseline: 2, summaryLastTs: fixedNow - 1000,
});
const nextCrash = fixedSandbox.applyMonitorCrashEvent(repeatedCrash, {
  date: "2026-07-16", eventDate: "2026-07-16", eventKey: "101", ts: fixedNow + 2,
  now: fixedNow + 2, baseline: 2, summaryLastTs: fixedNow - 1000,
});
if (firstCrash.count !== 3 || repeatedCrash.count !== 3 || nextCrash.count !== 4) {
  throw new Error("crash cache must count new paths once and ignore trigger retries");
}

console.log("PASS monitorSummary uses one fixed-input cache, keeps one-time fallback, and preserves verified shadow repair");
