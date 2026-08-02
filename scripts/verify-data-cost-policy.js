"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appRoot = path.resolve(root, "..", "QuickPilot_beta");
const policyPath = path.join(root, "rules", "data-cost-policy.json");
const rulesPath = path.join(root, "database.rules.json");
const orderGuardPath = path.join(
  root,
  "functions-order-live-release",
  "order-live-guard.js",
);
const orderGuardTestPath = path.join(
  root,
  "functions-order-live-release",
  "test",
  "order-live-guard.test.js",
);
const appSyncPath = path.join(
  appRoot,
  "app",
  "src",
  "main",
  "java",
  "com",
  "quickpilot",
  "db",
  "FirebaseSync.kt",
);
const orderDateReaderPath = path.join(
  appRoot,
  "app",
  "src",
  "main",
  "java",
  "com",
  "quickpilot",
  "db",
  "OrderDateKeyReader.kt",
);
const appCoreInvariantPath = path.join(
  appRoot,
  "scripts",
  "verify-qp-core-invariants.ps1",
);

const failures = [];

function readText(file, label) {
  if (!fs.existsSync(file)) {
    failures.push(`missing ${label}: ${file}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function readJson(file, label) {
  const text = readText(file, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    failures.push(`invalid ${label}: ${error.message}`);
    return {};
  }
}

function requireText(source, marker, label) {
  if (!source.includes(marker)) failures.push(`${label} lost marker: ${marker}`);
}

const policy = readJson(policyPath, "data cost policy");
const rules = readJson(rulesPath, "database rules");
const appSync = readText(appSyncPath, "FirebaseSync.kt");
const orderDateReader = readText(orderDateReaderPath, "OrderDateKeyReader.kt");
const appCoreInvariant = readText(
  appCoreInvariantPath,
  "verify-qp-core-invariants.ps1",
);
const orderGuard = readText(orderGuardPath, "isolated orderLive guard");
const orderGuardTests = readText(orderGuardTestPath, "isolated orderLive tests");

if (policy.schema_version !== 2) failures.push("policy schema_version must be 2");
if (!String(policy.policy_id || "").startsWith("QP-DATA-COST-SAFETY-")) {
  failures.push("policy_id must identify the QP data-cost safety contract");
}

const truthPaths = new Set((policy.truth_data && policy.truth_data.paths) || []);
for (const required of [
  "/v1/users/{uid}/orders/{date}/{representative_id}",
  "/v1/users/{uid}/manual_edits",
  "/v1/users/{uid}/order_edits",
  "/v1/users/{uid}/earnings/{date}",
  "/v1/users/{uid}/expenses",
  "/v1/agencies",
  "/v1/reports",
]) {
  if (!truthPaths.has(required)) failures.push(`truth path missing: ${required}`);
}

const compactPaths = new Set(
  (policy.compact_product_data && policy.compact_product_data.paths) || [],
);
for (const required of [
  "/v1/users/{uid}/daily_drive/{date}",
  "/v1/app/data_live/{date}",
  "/v1/app/data_maps/{date}",
  "/v1/app/data_cache/{date}",
]) {
  if (!compactPaths.has(required)) failures.push(`compact path missing: ${required}`);
}

const boundedRaw = policy.bounded_raw_data || [];
for (const item of boundedRaw) {
  if (!Number.isInteger(item.retention_days) || item.retention_days < 1) {
    failures.push(`bounded raw retention must be positive: ${item.path || "unknown"}`);
  }
  if (!String(item.deletion_precondition || "").trim()) {
    failures.push(`bounded raw deletion precondition missing: ${item.path || "unknown"}`);
  }
}

const budget = policy.order_write_budget || {};
const exactBudgets = {
  semantic_noop_client_transactions: 0,
  semantic_noop_function_database_operations: 0,
  one_semantic_change_client_transactions: 1,
  one_semantic_change_function_invocations: 1,
  one_semantic_change_max_downstream_committed_writes: 11,
  permission_denied_retries: 0,
  historical_permission_backlog_release: 0,
};
for (const [key, expected] of Object.entries(exactBudgets)) {
  if (budget[key] !== expected) {
    failures.push(`order write budget ${key} must equal ${expected}`);
  }
}

const maintenance = policy.maintenance_limits || {};
const exactMaintenanceLimits = {
  authentication: "release_admin_required",
  dry_run_default: true,
  max_uids: 10,
  max_dates: 1,
  max_concurrency: 2,
  max_read_bytes: 5242880,
  raw_window_hours: 2,
  raw_max_records: 500,
  raw_max_bytes: 1048576,
};
for (const [key, expected] of Object.entries(exactMaintenanceLimits)) {
  if (maintenance[key] !== expected) {
    failures.push(`maintenance limit ${key} must equal ${expected}`);
  }
}

if (JSON.stringify(policy.rollout_windows_seconds) !== JSON.stringify([120, 600, 3600])) {
  failures.push("rollout windows must be exactly 120/600/3600 seconds");
}
const stopThresholds = policy.automatic_stop_thresholds || {};
const exactStopThresholds = {
  denied_order_requests: 0,
  blocked_idle_order_operations: 0,
  max_invocations_per_semantic_change: 1,
  order_live_invocations_per_minute: 300,
  outbound_bytes_per_minute: 20971520,
  resource_load_percent: 85,
  historical_replay_rows: 0,
};
for (const [key, expected] of Object.entries(exactStopThresholds)) {
  if (stopThresholds[key] !== expected) {
    failures.push(`automatic stop threshold ${key} must equal ${expected}`);
  }
}
if (policy.service_isolation?.automatic_stop_scope !== "order_sync_only") {
  failures.push("automatic stop must affect order sync only");
}
for (const service of ["login", "read", "social", "hosting", "update"]) {
  if (!policy.service_isolation?.must_remain_available?.includes(service)) {
    failures.push(`service isolation must preserve ${service}`);
  }
}

const userRules =
  (((rules.rules || {}).v1 || {}).users || {}).$uid || {};
for (const rootName of ["window_dumps", "order_logs", "diag"]) {
  if (!policy.forbidden_new_raw_uploads.includes(`/v1/users/{uid}/${rootName}`)) {
    failures.push(`forbidden raw policy missing ${rootName}`);
  }
  if (!userRules[rootName] || userRules[rootName][".write"] !== false) {
    failures.push(`database rules must block ${rootName}`);
  }
}

for (const marker of [
  'prefBool("raw_dump_upload_enabled", false)',
  'prefBool("raw_order_log_upload_enabled", false)',
  'prefBool("user_action_upload_enabled", false)',
  'prefBool("diag_upload_enabled", false)',
  'prefBool("system_event_upload_enabled", false)',
]) {
  requireText(appSync, marker, "raw/diagnostic upload default");
}
requireText(orderDateReader, "shallow=true", "order date key read");
if (orderDateReader.includes("/orders.json?auth=")) {
  failures.push("order date key reader must not download full order bodies");
}
requireText(
  appCoreInvariant,
  "quickpilot-landing\\scripts\\verify-data-cost-policy.js",
  "every-build data cost gate",
);
requireText(
  appCoreInvariant,
  "QP_DATA_COST_POLICY_STATUS=PASS",
  "every-build data cost pass marker",
);

requireText(
  orderGuard,
  "if (sameAggregateMeaning(before, after, orderId)) return null;",
  "semantic no-op firewall",
);
requireText(
  orderGuardTests,
  "one new semantic order stays within the bounded downstream write budget",
  "bounded orderLive regression",
);
requireText(
  orderGuardTests,
  "memory.stats.committedWrites <= 11",
  "orderLive committed-write ceiling",
);
requireText(
  orderGuardTests,
  "same route signature with different representative IDs keeps both orders",
  "representative identity isolation regression",
);

const functionsSource = readText(
  path.join(root, "functions", "index.js"),
  "broad functions source",
);
const scheduledBodies = [
  "monitorSummary",
  "dataMapsTick",
  "serverStatsTick",
  "reconcileShadow",
  "agencyRecountTick",
  "agencyStatsDailyTick",
];
for (const name of scheduledBodies) {
  requireText(functionsSource, `exports.${name}`, "scheduled function inventory");
}
for (const forbidden of [
  'db.ref("v1/users").once("value")',
  "db.ref('v1/users').once('value')",
]) {
  if (functionsSource.includes(forbidden)) {
    failures.push(`scheduled/server source contains a root user body read: ${forbidden}`);
  }
}

const rollout = policy.rollout_contract || [];
if (
  JSON.stringify(rollout) !==
  JSON.stringify([
    "BLOCKED",
    "EXACT_UID_DATE_CANARY",
    "MEASURED_CANARY_PASS",
    "VERSION",
    "MEASURED_VERSION_PASS",
  ])
) {
  failures.push("rollout contract must remain fail-closed and measured");
}
if (!Array.isArray(policy.automatic_stop_signals) || policy.automatic_stop_signals.length < 6) {
  failures.push("automatic stop signals are incomplete");
}

if (failures.length) {
  console.error("QP_DATA_COST_POLICY_STATUS=FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("QP_DATA_COST_POLICY_STATUS=PASS");
console.log(`QP_DATA_COST_POLICY_ID=${policy.policy_id}`);
console.log("QP_DATA_COST_TRUTH_DATA=PROTECTED");
console.log("QP_DATA_COST_RAW_DATA=BOUNDED_OR_BLOCKED");
console.log("QP_DATA_COST_ROLLOUT=BLOCKED_CANARY_MEASURED_VERSION");
