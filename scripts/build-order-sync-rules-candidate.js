"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const baselinePath = path.resolve(
  root,
  "..",
  "QuickPilot_beta",
  "analysis",
  "proof",
  "20260730",
  "billing_emergency_containment",
  "database_rules_after_orders_block_20260730_1821.json",
);
const controlTemplatePath = path.join(
  root,
  "rules",
  "order-sync-control-template.json",
);
const candidatePath = path.join(
  root,
  "rules",
  "database.rules.order-sync-candidate.json",
);
const versionLockPath = path.resolve(root, "..", "QuickPilot_beta", ".version_lock");
const expectedBaselineRawSha256 =
  "5d89c19f60b47650f8baf8bbdc340488bc21d8fc624e9b2381990bd3ba052541";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = stableValue(value[key]);
    }
    return output;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadBaseline() {
  const raw = fs.readFileSync(baselinePath);
  const rawHash = sha256(raw);
  if (rawHash !== expectedBaselineRawSha256) {
    throw new Error(
      `preserved after-block rules hash drifted: ${rawHash}`,
    );
  }
  return JSON.parse(raw.toString("utf8"));
}

function readRequiredVersionCode() {
  const value = Number.parseInt(fs.readFileSync(versionLockPath, "utf8").trim(), 10);
  if (!Number.isInteger(value) || value < 1) throw new Error("invalid QuickPilot .version_lock");
  return value;
}

function renderControlArtifact() {
  const requiredVersionCode = readRequiredVersionCode();
  const template = loadJson(controlTemplatePath);
  if (
    template.schema !== "qp-order-sync-control-template-v2" ||
    template.deployable !== false ||
    template.required_version_code !== 0
  ) {
    throw new Error("version-neutral control template is malformed");
  }
  const rendered = clone(template);
  rendered.schema = "qp-order-sync-control-v2";
  rendered.required_version_code = requiredVersionCode;
  rendered.false_by_default_value.minimum_client_version_code = requiredVersionCode;
  rendered.control_rules.minimum_client_version_code[".validate"] =
    `newData.isNumber() && newData.val() >= ${requiredVersionCode}`;
  rendered.reason = `Rendered from .version_lock for vc${requiredVersionCode}; not a live admission approval.`;
  return rendered;
}

function buildCandidate() {
  const baseline = loadBaseline();
  const controlArtifact = renderControlArtifact();
  if (
    controlArtifact.schema !== "qp-order-sync-control-v2" ||
    controlArtifact.deployable !== false ||
    controlArtifact.required_version_code !== readRequiredVersionCode()
  ) {
    throw new Error("rendered control artifact does not match .version_lock");
  }

  const candidate = clone(baseline);
  const user = candidate.rules.v1.users.$uid;
  const orders = user.orders;
  if (orders[".write"] !== false) {
    throw new Error("preserved baseline is not fail-closed at orders/.write");
  }
  delete orders[".write"];
  orders.$date.$orderId[".write"] = controlArtifact.write_expression;

  const app = candidate.rules.v1.app;
  if (app.order_sync_control !== undefined) {
    throw new Error("preserved baseline already contains order_sync_control");
  }
  app.order_sync_control = controlArtifact.control_rules;
  return { baseline, candidate, controlArtifact };
}

function diffPaths(before, after, currentPath = "") {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (
    !before ||
    !after ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return [currentPath || "/"];
  }
  const paths = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const childPath = `${currentPath}/${key}`;
    if (!Object.prototype.hasOwnProperty.call(before, key)) {
      paths.push(childPath);
    } else if (!Object.prototype.hasOwnProperty.call(after, key)) {
      paths.push(childPath);
    } else {
      paths.push(...diffPaths(before[key], after[key], childPath));
    }
  }
  return paths;
}

function main() {
  const { baseline, candidate } = buildCandidate();
  const differences = diffPaths(baseline, candidate);
  const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
  const shouldWrite = process.argv.includes("--write");
  if (shouldWrite) fs.writeFileSync(candidatePath, candidateText, "utf8");
  console.log(`QP_ORDER_SYNC_RULES_BUILD=${shouldWrite ? "WRITTEN" : "DRY_RUN"}`);
  console.log(`BASELINE_CANONICAL_SHA256=${sha256(canonicalJson(baseline))}`);
  console.log(`CANDIDATE_CANONICAL_SHA256=${sha256(canonicalJson(candidate))}`);
  console.log(`CANDIDATE_FILE_SHA256=${sha256(candidateText)}`);
  console.log(`DIFF_PATHS=${differences.join(",")}`);
}

if (require.main === module) main();

module.exports = {
  baselinePath,
  buildCandidate,
  candidatePath,
  canonicalJson,
  controlTemplatePath,
  diffPaths,
  expectedBaselineRawSha256,
  readRequiredVersionCode,
  renderControlArtifact,
  sha256,
};
