const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sourcePath = path.resolve(__dirname, "..", "functions", "index.js");
const source = fs.readFileSync(sourcePath, "utf8");

function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`missing section: ${startMarker}`);
  return source.slice(start, end);
}

function requireText(body, text, label) {
  if (!body.includes(text)) throw new Error(`missing ${label}`);
}

const cacheHelpers = section("const DATA_CACHE_BUILD_LEASE_MS", "function waitForDataCache");
requireText(cacheHelpers, "activeUntil > now", "active lease guard");
requireText(cacheHelpers, "activeToken !== token", "different builder guard");

const sandbox = {};
vm.runInNewContext(cacheHelpers, sandbox);
const now = 1000000;
const active = { token: "first", startedAt: now - 1000, expiresAt: now + 30000 };
if (sandbox.dataCacheBuildClaim(active, now, "second") !== undefined) {
  throw new Error("a second request must not claim an active date build");
}
const expired = sandbox.dataCacheBuildClaim({ token: "first", expiresAt: now - 1 }, now, "second");
if (!expired || expired.token !== "second" || expired.expiresAt <= now) {
  throw new Error("an expired build must be recoverable by the next request");
}
const renewed = sandbox.dataCacheBuildClaim(active, now, "first");
if (!renewed || renewed.token !== "first" || renewed.startedAt !== active.startedAt) {
  throw new Error("the current builder must keep its original start time");
}

const builder = section("async function getOrBuildDataAggregate", "// 개인 운행");
requireText(builder, 'db.ref("v1/app/data_cache_build/" + date)', "per-date build lock");
requireText(builder, "builtByOtherRequest", "wait for the winning request");
requireText(builder, "releaseDataCacheBuild(lockRef, token)", "lock release");
requireText(builder, "cacheRef.set({ aggregate, builtAt: Date.now() })", "unchanged cache output");

const aggregateCalls = [...source.matchAll(/\bcomputeAggregate\(/g)].length;
if (aggregateCalls !== 2) {
  throw new Error(`all aggregate builders must share one lock; found ${aggregateCalls - 1} direct call(s)`);
}

const dataTab = section("exports.dataTab =", "// ===== data_live");
requireText(dataTab, "getOrBuildDataAggregate(date, y, mo, d, readMetrics)", "dataTab shared builder");
requireText(dataTab, "cache: cacheStatus", "aggregate cache metric");
requireText(dataTab, "personalCache:", "personal cache metric");

const backfill = section("exports.backfillCache =", "exports.reconcileShadow =");
requireText(backfill, "getOrBuildDataAggregate(dk, dp[0], dp[1], dp[2])", "backfill shared builder");
const reconcile = section("exports.reconcileShadow =", "exports.orderLive =");
requireText(reconcile, "absent_on_demand", "reconcile on-demand cache policy");
if (reconcile.includes("getOrBuildDataAggregate(")) {
  throw new Error("nightly reconciliation must not build an unrequested historical GPS cache");
}

const helperRuntime = section("const DATA_CACHE_BUILD_LEASE_MS", "// 개인 운행");
const state = new Map();
const nativeSetTimeout = setTimeout;
const snapshot = value => ({ val: () => value });
class FakeRef {
  constructor(key) { this.key = key; }
  child(name) { return new FakeRef(this.key + "/" + name); }
  async once() { return snapshot(state.has(this.key) ? state.get(this.key) : null); }
  async set(value) {
    state.set(this.key, value);
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "aggregate")) {
      state.set(this.key + "/aggregate", value.aggregate);
    }
  }
  async transaction(update) {
    const current = state.has(this.key) ? state.get(this.key) : null;
    const next = update(current);
    if (next === undefined) return { committed: false, snapshot: snapshot(current) };
    if (next === null) state.delete(this.key);
    else state.set(this.key, next);
    return { committed: true, snapshot: snapshot(next) };
  }
}

let computeCount = 0;
const runtimeSandbox = {
  db: { ref: key => new FakeRef(key) },
  computeAggregate: async () => {
    computeCount++;
    await new Promise(resolve => nativeSetTimeout(resolve, 20));
    return { orders: { total: 1 }, heat: [], marker: "same-result" };
  },
  functions: { https: { HttpsError: class HttpsError extends Error {} } },
  process: { pid: 1 },
  setTimeout: resolve => nativeSetTimeout(resolve, 1),
  Math,
  Date,
  Promise,
};
vm.runInNewContext(helperRuntime, runtimeSandbox);

(async () => {
  const first = runtimeSandbox.getOrBuildDataAggregate("2026-07-17", 2026, 7, 17, {});
  const second = runtimeSandbox.getOrBuildDataAggregate("2026-07-17", 2026, 7, 17, {});
  const results = await Promise.all([first, second]);
  if (computeCount !== 1) throw new Error(`concurrent requests computed ${computeCount} times`);
  if (results.filter(result => result.cacheStatus === "new").length !== 1 ||
      results.filter(result => result.cacheStatus === "wait_hit").length !== 1) {
    throw new Error(`unexpected concurrent cache statuses: ${results.map(result => result.cacheStatus).join(",")}`);
  }
  const third = await runtimeSandbox.getOrBuildDataAggregate("2026-07-17", 2026, 7, 17, {});
  if (third.cacheStatus !== "hit" || computeCount !== 1) {
    throw new Error("a completed date cache must be reused without recomputing");
  }
  console.log("PASS data cache builds are single-flight per date and preserve the existing cache payload");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
