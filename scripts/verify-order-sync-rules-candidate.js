"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  buildCandidate,
  candidatePath,
  canonicalJson,
  diffPaths,
  sha256,
  readRequiredVersionCode,
} = require("./build-order-sync-rules-candidate");

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "firebase.order-sync-rules-only.json");
const failures = [];
const requiredVersionCode = readRequiredVersionCode();
const allowedDiffPaths = [
  "/rules/v1/app/order_sync_control",
  "/rules/v1/users/$uid/orders/.write",
  "/rules/v1/users/$uid/orders/$date/$orderId/.write",
].sort();

function fail(message) {
  failures.push(message);
}

let expected;
try {
  expected = buildCandidate();
} catch (error) {
  fail(error.message);
}

let candidate;
if (!fs.existsSync(candidatePath)) {
  fail(`missing full candidate: ${candidatePath}`);
} else {
  try {
    candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  } catch (error) {
    fail(`candidate JSON invalid: ${error.message}`);
  }
}

if (expected && candidate) {
  if (canonicalJson(candidate) !== canonicalJson(expected.candidate)) {
    fail("full candidate is not the exact preserved-baseline transformation");
  }
  const differences = diffPaths(expected.baseline, candidate).sort();
  if (JSON.stringify(differences) !== JSON.stringify(allowedDiffPaths)) {
    fail(`unapproved rules diff: ${JSON.stringify(differences)}`);
  }
  const orderWrite =
    candidate.rules.v1.users.$uid.orders.$date.$orderId[".write"];
  if (
    candidate.rules.v1.users.$uid.orders[".write"] !== undefined ||
    candidate.rules.v1.users.$uid.orders.$date[".write"] !== undefined ||
    typeof orderWrite !== "string"
  ) {
    fail("candidate must grant only the exact orderId leaf");
  }
  for (const marker of [
    "order_sync_control",
    "client_version_code",
    "minimum_client_version_code",
    "mode').val() === 'CANARY'",
    "allowed_uid').val() === $uid",
    "allowed_date').val() === $date",
    "mode').val() === 'VERSION'",
  ]) {
    if (!orderWrite.includes(marker)) {
      fail(`candidate order admission missing ${marker}`);
    }
  }
  for (const forbidden of [
    "sync_control_generation",
    "sync_control_evidence_id",
  ]) {
    if (orderWrite.includes(forbidden)) {
      fail(`${forbidden} must not be an order payload admission field`);
    }
  }
  const control = candidate.rules.v1.app.order_sync_control;
  if (
    control[".read"] !== "auth != null" ||
    !String(control[".write"] || "").includes("pnomade12@gmail.com")
  ) {
    fail("order_sync_control access is not auth-read/admin-write");
  }
}

let config;
if (!fs.existsSync(configPath)) {
  fail("missing firebase.order-sync-rules-only.json");
} else {
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`rules-only config JSON invalid: ${error.message}`);
  }
}
if (config) {
  if (JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(["database"])) {
    fail("rules-only config must expose only database");
  }
  if (
    config.database?.rules !==
      "rules/database.rules.order-sync-candidate.json"
  ) {
    fail("rules-only config must not reference dirty database.rules.json");
  }
  if (
    !Array.isArray(config.database?.predeploy) ||
    config.database.predeploy.length !== 1 ||
    config.database.predeploy[0] !==
      "node scripts/verify-order-sync-rules-candidate.js --live-baseline"
  ) {
    fail("rules-only config must enforce the exact live-baseline predeploy");
  }
}

function readLiveRules() {
  const result = spawnSync(
    "firebase",
    [
      "database:get",
      "/.settings/rules",
      "--project",
      "quickpilot-39d72",
    ],
    { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
  );
  if (result.status !== 0) {
    throw new Error(
      `live rules read failed: ${result.error?.message || result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return JSON.parse(result.stdout);
}

if (process.argv.includes("--live-baseline") && expected) {
  try {
    const live = readLiveRules();
    if (canonicalJson(live) !== canonicalJson(expected.baseline)) {
      fail(
        `live rules are not the preserved after-block baseline: ${sha256(canonicalJson(live))}`,
      );
    }
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv.includes("--live-candidate") && expected) {
  try {
    const live = readLiveRules();
    if (canonicalJson(live) !== canonicalJson(expected.candidate)) {
      fail(
        `live rules are not the exact vc${requiredVersionCode} candidate: ${sha256(canonicalJson(live))}`,
      );
    }
  } catch (error) {
    fail(error.message);
  }
}

if (failures.length) {
  console.error("QP_ORDER_SYNC_RULES_GATE=FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("QP_ORDER_SYNC_RULES_GATE=PASS");
console.log(
  `BASELINE_CANONICAL_SHA256=${sha256(canonicalJson(expected.baseline))}`,
);
console.log(
  `CANDIDATE_CANONICAL_SHA256=${sha256(canonicalJson(expected.candidate))}`,
);
