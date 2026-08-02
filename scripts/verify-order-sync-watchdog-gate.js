"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const release = path.join(root, "functions-order-sync-watchdog-release");
const failures = [];
const expectedFiles = [
  "index.js",
  "order-sync-watchdog.js",
  "package.json",
  "test/order-sync-watchdog.test.js",
  "thresholds.json",
].sort();

const actualFiles = fs.readdirSync(release, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(release, path.join(entry.parentPath || entry.path, entry.name)).replaceAll("\\", "/"))
  .filter((name) => !name.startsWith("node_modules/"))
  .sort();
if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
  failures.push(`isolated watchdog allow-list drifted: ${JSON.stringify(actualFiles)}`);
}

const policy = JSON.parse(fs.readFileSync(path.join(root, "rules/data-cost-policy.json"), "utf8"));
const thresholds = JSON.parse(fs.readFileSync(path.join(release, "thresholds.json"), "utf8"));
for (const [key, expected] of Object.entries(policy.automatic_stop_thresholds || {})) {
  if (thresholds[key] !== expected) failures.push(`watchdog threshold drifted: ${key}`);
}
if (thresholds.collector_max_age_ms !== 120000) failures.push("collector age must be 120000ms");

const index = fs.readFileSync(path.join(release, "index.js"), "utf8");
for (const marker of [
  'schedule: "every 1 minutes"',
  "maxInstances: 1",
  'db.ref("v1/app/order_sync_control")',
  'db.ref("v1/app/order_sync_metrics/current")',
  "if (breaches.length === 0) return null;",
  "nextBlockedControl",
]) {
  if (!index.includes(marker)) failures.push(`watchdog source lost marker: ${marker}`);
}
for (const forbidden of ["functions/index.js", "database.rules.json", "hosting", "remove("] ) {
  if (index.includes(forbidden)) failures.push(`watchdog source contains forbidden scope: ${forbidden}`);
}

const testResult = spawnSync(process.execPath, ["--test", "test/order-sync-watchdog.test.js"], {
  cwd: release,
  encoding: "utf8",
});
if (testResult.status !== 0) failures.push(testResult.stdout + testResult.stderr);
else process.stdout.write(testResult.stdout);

if (failures.length) {
  console.error("QP_ORDER_SYNC_WATCHDOG_GATE=FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("QP_ORDER_SYNC_WATCHDOG_GATE=PASS");
console.log("QP_ORDER_SYNC_WATCHDOG_SCOPE=ORDER_SYNC_ONLY");
