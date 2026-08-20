const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "functions", "index.js"), "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`missing section: ${startMarker}`);
  return source.slice(start, end);
}

const pureSource = section(
  "const AGENCY_VOLUME_MIN_ORDERS",
  "async function agencyVolumeSyncTouchedCounts",
);
const sandbox = { Date, Math, Number, Object, String };
vm.createContext(sandbox);
vm.runInContext(pureSource, sandbox);

const ranked = vm.runInContext(`agencyVolumeAssignments({
  "01000000001": { agencyKey: "01000000001", count: 100 },
  "01000000002": { agencyKey: "01000000002", count: 90 },
  "01000000003": { agencyKey: "01000000003", count: 80 },
  "01000000004": { agencyKey: "01000000004", count: 70 },
  "01000000005": { agencyKey: "01000000005", count: 60 },
  "01000000006": { agencyKey: "01000000006", count: 50 },
  "01000000007": { agencyKey: "01000000007", count: 40 },
  "01000000008": { agencyKey: "01000000008", count: 30 },
  "01000000009": { agencyKey: "01000000009", count: 20 },
  "01000000010": { agencyKey: "01000000010", count: 10 },
  "01000000011": { agencyKey: "01000000011", count: 9, star: 3 }
})`, sandbox);
const stars = Array.from(ranked.rows, row => row.star);
if (JSON.stringify(stars) !== JSON.stringify([5, 4, 4, 3, 3, 2, 2, 1, 1, 0])) {
  throw new Error(`unexpected percentile stars: ${JSON.stringify(stars)}`);
}
if (ranked.rows.length !== 10) throw new Error("under-10 agencies must be excluded");
if (ranked.distribution[0] !== 1) throw new Error("bottom 10 percent must receive the dash grade");
if (ranked.ineligibleRows.length !== 1 || ranked.ineligibleRows[0].star !== 0) {
  throw new Error("an agency below 10 clean orders must have a stale star cleared");
}

const tied = vm.runInContext(`agencyVolumeAssignments({
  "01000000101": { agencyKey: "01000000101", count: 100 },
  "01000000102": { agencyKey: "01000000102", count: 100 },
  "01000000103": { agencyKey: "01000000103", count: 80 },
  "01000000104": { agencyKey: "01000000104", count: 70 },
  "01000000105": { agencyKey: "01000000105", count: 60 },
  "01000000106": { agencyKey: "01000000106", count: 50 },
  "01000000107": { agencyKey: "01000000107", count: 40 },
  "01000000108": { agencyKey: "01000000108", count: 30 },
  "01000000109": { agencyKey: "01000000109", count: 20 },
  "01000000110": { agencyKey: "01000000110", count: 10 }
})`, sandbox);
if (tied.rows[0].star !== tied.rows[1].star) throw new Error("equal counts must receive equal stars");

const bootstrap = vm.runInContext(`agencyVolumeBootstrapIndex({
  "01012345678": { name: "valid", phone: "010-1234-5678", cleanCount: 20, volumeStars: 2 },
  "short": { name: "invalid", phone: "24", cleanCount: 99 },
  "nameless": { phone: "01099998888", cleanCount: 99 }
})`, sandbox);
if (!bootstrap["01012345678"] || bootstrap["01012345678"].count !== 20) {
  throw new Error("valid agency must seed the compact index");
}
if (Object.keys(bootstrap).length !== 1) throw new Error("invalid phone/name rows must not seed the index");

const dates = vm.runInContext(`agencyVolumeDateRange("2026-07-16", "2026-07-19")`, sandbox);
if (JSON.stringify(Array.from(dates)) !== JSON.stringify(["2026-07-17", "2026-07-18", "2026-07-19"])) {
  throw new Error(`date catch-up failed: ${JSON.stringify(Array.from(dates))}`);
}
let longGapRejected = false;
try {
  vm.runInContext(`agencyVolumeDateRange("2026-05-01", "2026-07-19")`, sandbox);
} catch (_) {
  longGapRejected = true;
}
if (!longGapRejected) throw new Error("a gap over 31 days must require a fresh bootstrap");

const refresh = section("async function refreshAgencyVolumeStars", "function agencyDailyDigits");
if (!refresh.includes('db.ref(AGENCY_VOLUME_INDEX_PATH).once("value")')) {
  throw new Error("daily refresh must read the compact volume index");
}
const bootstrapBranch = section("if (bootstrap) {", "} else if (!Object.keys(index).length)");
if (!bootstrapBranch.includes('db.ref("v1/agencies").once("value")')) {
  throw new Error("one-time bootstrap must read the agency directory");
}
if (!refresh.includes("assignments.rows.concat(assignments.ineligibleRows)")) {
  throw new Error("daily refresh must clear stale stars below the 10-order minimum");
}
if (!refresh.includes("starsCleared: cleared")) {
  throw new Error("daily refresh must report cleared dash grades");
}

const scheduled = section("exports.agencyStatsDailyTick", "exports.agencyStatsDailyNow");
if (!scheduled.includes("refreshAgencyVolumeStars({ throughDate: date })")) {
  throw new Error("midnight agency stats must refresh volume stars");
}
if (!scheduled.includes("agency volume star refresh failed")) {
  throw new Error("volume refresh failure must not hide silently");
}

const manual = source.slice(source.indexOf("exports.agencyVolumeStarsNow"));
if (!manual.includes('dryRun: req.query.execute !== "1"')) {
  throw new Error("manual endpoint must be read-only unless execute=1");
}

console.log("verify-agency-volume-stars: PASS");
