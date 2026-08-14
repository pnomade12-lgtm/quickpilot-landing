const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..", "QuickPilot_beta");
const appSyncPath = path.join(repoRoot, "app", "src", "main", "java", "com", "quickpilot", "db", "FirebaseSync.kt");
const policyPath = path.join(repoRoot, "app", "src", "main", "java", "com", "quickpilot", "db", "FirebaseSyncBatchPolicy.kt");
const testPath = path.join(repoRoot, "app", "src", "test", "kotlin", "com", "quickpilot", "db", "CostGuardContractTest.kt");
const rulesPath = path.resolve(__dirname, "..", "database.rules.json");

const source = fs.readFileSync(appSyncPath, "utf8");
const policy = fs.readFileSync(policyPath, "utf8");
const tests = fs.readFileSync(testPath, "utf8");
const rules = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
const failures = [];

function requireText(text, label, haystack = source) {
  if (!haystack.includes(text)) failures.push(`Missing marker: ${label}`);
}

function rejectText(text, label, haystack = source) {
  if (haystack.includes(text)) failures.push(`Forbidden old-risk marker remains: ${label}`);
}

function getRule(parts) {
  let cur = rules.rules;
  for (const part of parts) cur = cur && cur[part];
  return cur;
}

for (const marker of [
  ["private val corePending = HashMap<String, Any?>()", "core pending map"],
  ["private val noisyPending = HashMap<String, Any?>()", "noisy pending map"],
  ["private val pending = SplitPending()", "split pending facade"],
  ["FirebaseSyncBatchPolicy.isNoisyPath(path)", "central noisy classifier use"],
  ["noisyPending[path] = value", "noisy path routes to noisy pending"],
  ["corePending[path] = value", "core path routes to core pending"],
  ["val coreBatch = HashMap(corePending)", "debounced core batch drain"],
  ["val noisyBatch = HashMap(noisyPending)", "debounced noisy batch drain"],
  ["flushBatchAsync(\"core\", coreBatch, restoreOnFailure = true)", "core async restore enabled"],
  ["flushBatchAsync(\"noisy\", noisyBatch, restoreOnFailure = false)", "noisy async restore disabled"],
  ["flushBatchNow(\"core\", batches.first, restoreOnFailure = true)", "core flushNow restore enabled"],
  ["flushBatchNow(\"noisy\", batches.second, restoreOnFailure = false)", "noisy flushNow restore disabled"],
  ["corePending.putAll(batch)", "restore only into core pending"],
]) {
  requireText(marker[0], marker[1]);
}

for (const marker of [
  ["private val pending = HashMap<String, Any?>()", "single pending map"],
  ["HashMap(pending)", "single pending drain"],
  ["pending.clear()", "single pending clear"],
  ["pending.putAll(batch)", "single pending restore"],
  ["db.updateChildren(batch as Map<String, Any?>)", "old casted single batch update"],
]) {
  rejectText(marker[0], marker[1]);
}

for (const marker of [
  ["path.contains(\"/window_dumps/\")", "window_dumps is noisy"],
  ["path.contains(\"/order_logs/\")", "order_logs is noisy"],
  ["path.contains(\"/diag/\")", "diag is noisy"],
  ["FirebaseSyncBatchSplit", "split data holder"],
]) {
  requireText(marker[0], marker[1], policy);
}

for (const marker of [
  ["blockedNoisyPathsDoNotShareBatchesWithOrdersOrManualEdits", "batch split unit test"],
  ["v1/users/u/orders/2026-07-01/order1/status", "orders plus diag case"],
  ["v1/users/u/manual_edits/2026-07-01/42", "manual edits plus diag case"],
  ["v1/users/u/order_edits/42/42", "order edits plus diag case"],
  ["v1/users/u/window_dumps/20635/3", "orders plus window_dumps case"],
]) {
  requireText(marker[0], marker[1], tests);
}

const userRules = (((rules.rules.v1 || {}).users || {}).$uid) || {};
for (const pathName of ["window_dumps", "order_logs", "diag"]) {
  const write = getRule(["v1", "users", "$uid", pathName, ".write"]);
  if (write !== false) failures.push(`RTDB rules must block ${pathName}`);
}

for (const pathName of ["orders", "manual_edits", "order_edits", "status", "app_version", "global_memos", "social_feed"]) {
  const write = (userRules[pathName] || {})[".write"];
  if (typeof write !== "string" || !write.includes("auth.uid === $uid")) {
    failures.push(`RTDB rules must keep ${pathName} writable by owner/admin`);
  }
}

if (failures.length) {
  console.error("cost-control batch-split check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("cost-control batch-split check passed");
console.log("Observed: FirebaseSync splits corePending and noisyPending before updateChildren calls.");
console.log("Observed: window_dumps/order_logs/diag route to noisyPending and are not restored into corePending on failure.");
console.log("Observed: RTDB rules candidate blocks only noisy branches while keeping core writes allowed.");
