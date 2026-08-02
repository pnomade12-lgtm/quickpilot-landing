"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "functions-order-live-release");
const configPath = path.join(root, "firebase.order-live-only.json");
const deployScriptPath = path.join(root, "scripts", "deploy-order-live-only.ps1");
const controlTemplatePath = path.join(root, "rules", "order-sync-control-template.json");
const {
  readRequiredVersionCode,
  renderControlArtifact,
} = require("./build-order-sync-rules-candidate");
const requiredVersionCode = readRequiredVersionCode();
const dataCostVerifierPath = path.join(
  root,
  "scripts",
  "verify-data-cost-policy.js",
);

const failures = [];

function read(relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!fs.existsSync(fullPath)) {
    failures.push(`missing required file: ${relativePath}`);
    return "";
  }
  return fs.readFileSync(fullPath, "utf8");
}

function requireText(source, marker, label) {
  if (!source.includes(marker)) failures.push(`${label} must include ${marker}`);
}

const expectedReleaseFiles = [
  "index.js",
  "order-live-guard.js",
  "package-lock.json",
  "package.json",
  "test/order-live-guard.test.js",
].sort();
if (fs.existsSync(releaseDir)) {
  const actualReleaseFiles = [];
  function walk(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else actualReleaseFiles.push(relative.replace(/\\/g, "/"));
    }
  }
  walk(releaseDir);
  actualReleaseFiles.sort();
  if (JSON.stringify(actualReleaseFiles) !== JSON.stringify(expectedReleaseFiles)) {
    failures.push(
      `isolated release file set mismatch: ${JSON.stringify(actualReleaseFiles)}`,
    );
  }
}

const configRaw = read("firebase.order-live-only.json");
let config = {};
try {
  config = JSON.parse(configRaw);
} catch (error) {
  failures.push(`firebase.order-live-only.json is invalid JSON: ${error.message}`);
}
if (JSON.stringify(Object.keys(config).sort()) !== JSON.stringify(["functions"])) {
  failures.push("isolated config must expose only functions");
}
if (!config.functions || config.functions.source !== "functions-order-live-release") {
  failures.push("isolated config must use functions-order-live-release");
}
if (config.database || config.hosting || config.storage || config.firestore) {
  failures.push("isolated config must not include database/hosting/storage/firestore");
}
if (
  !Array.isArray(config.functions && config.functions.predeploy) ||
  config.functions.predeploy.length !== 1 ||
  config.functions.predeploy[0] !==
    "node scripts/verify-order-live-cost-gate.js"
) {
  failures.push("isolated config must run the exact server cost predeploy gate");
}

const controlPublisherSource = read("scripts/publish-order-sync-control.ps1");
for (const marker of [
  "Read-ProtectedRelease",
  "Verify-InstalledCanary",
  "Verify-CanaryPass",
  "CANARY may open only from the exact matching BLOCKED control",
  "VERSION may open only from the exact matching live CANARY",
  "VERSION is forbidden through vc459",
  "QP_ORDER_SYNC_CANARY_APPROVED",
  "QP_ORDER_SYNC_VERSION_APPROVED",
  "published control did not exact-readback",
]) {
  requireText(
    controlPublisherSource,
    marker,
    "order_sync_control transition publisher",
  );
}

const indexSource = read("functions-order-live-release/index.js");
for (const marker of [
  'require("./order-live-guard")',
  "createOrderLiveHandler",
  "timeoutSeconds: 30",
  'memory: "256MB"',
  "maxInstances: 10",
  '.database.instance("quickpilot-39d72-default-rtdb")',
  '.ref("/v1/users/{uid}/orders/{date}/{orderId}")',
  ".onWrite(orderLiveHandler)",
]) {
  requireText(indexSource, marker, "isolated index.js");
}
for (const forbidden of [
  "functions/index.js",
  "firebase.json",
  "exports.monitor",
  "exports.reconcile",
]) {
  if (indexSource.includes(forbidden)) {
    failures.push(`isolated index.js must not reference ${forbidden}`);
  }
}

const guardSource = read(
  "functions-order-live-release/order-live-guard.js",
);
const handlerStart = guardSource.indexOf(
  "return async function orderLiveHandler",
);
const handlerSource = handlerStart >= 0 ? guardSource.slice(handlerStart) : "";
const earlyReturn = handlerSource.indexOf(
  "if (sameAggregateMeaning(before, after, orderId)) return null;",
);
const firstDbRef = handlerSource.indexOf("const shadowGuardRef = db.ref(");
if (handlerStart < 0 || earlyReturn < 0) {
  failures.push("orderLive handler must have a pure semantic early return");
} else if (firstDbRef < 0 || earlyReturn > firstDbRef) {
  failures.push("semantic early return must occur before the first RTDB reference");
}
for (const marker of [
  "orderAggregateProjection",
  "semanticDigest",
  'createHash("sha256")',
  "updated_at",
  "snapshot_revision",
  "distance_source",
]) {
  if (
    ["updated_at", "snapshot_revision", "distance_source"].includes(marker)
  ) {
    if (guardSource.includes(`order.${marker}`)) {
      failures.push(`${marker} must not enter the aggregate projection`);
    }
  } else {
    requireText(guardSource, marker, "order-live guard");
  }
}
for (const marker of [
  "current.lastEvent === context.eventId",
  "if (!guardMutation.committed) return null;",
]) {
  requireText(guardSource, marker, "duplicate event guard");
}
if (handlerSource.includes("console.") || handlerSource.includes("logger.")) {
  failures.push("orderLive handler must not emit per-event logs");
}

const packageRaw = read("functions-order-live-release/package.json");
let packageJson = {};
try {
  packageJson = JSON.parse(packageRaw);
} catch (error) {
  failures.push(`isolated package.json is invalid JSON: ${error.message}`);
}
if (
  packageJson.scripts?.test !==
  "node --test test/order-live-guard.test.js"
) {
  failures.push("isolated package must expose the exact orderLive test command");
}
if (
  packageJson.dependencies?.["firebase-admin"] !== "12.1.0" ||
  packageJson.dependencies?.["firebase-functions"] !== "5.0.1"
) {
  failures.push("isolated package dependencies must stay exactly pinned");
}

const deploySource = read("scripts/deploy-order-live-only.ps1");
for (const marker of [
  "[switch]$Execute",
  "firebase.order-live-only.json",
  "--only",
  "functions:orderLive",
  "QP_ORDER_LIVE_DEPLOY_APPROVED",
  "cf88a416502890b58ff33399fe04137108cd79c7",
  "database:get",
  "/.settings/rules",
]) {
  requireText(deploySource, marker, "orderLive deploy script");
}
for (const forbidden of [
  "--only functions ",
  "--only functions,",
  "firebase deploy --only functions\n",
  "functions/index.js",
  "--only database",
  "--only hosting",
]) {
  if (deploySource.includes(forbidden)) {
    failures.push(`orderLive deploy script must not include ${forbidden}`);
  }
}

read(path.relative(root, controlTemplatePath).replaceAll("\\", "/"));
let canary = {};
try {
  canary = renderControlArtifact();
} catch (error) {
  failures.push(`rendered control artifact is invalid: ${error.message}`);
}
if (canary.deployable !== false) {
  failures.push("canary artifact must be non-deployable until rendered and merged");
}
for (const marker of [
  "auth.uid === $uid",
  "child('order_sync_control').child('enabled').val() === true",
  "newData.child('client_version_code').isNumber()",
  "child('minimum_client_version_code').val()",
  "child('mode').val() === 'CANARY'",
  "child('allowed_uid').val() === $uid",
  "child('allowed_date').val() === $date",
  "child('mode').val() === 'VERSION'",
]) {
  if (!String(canary.write_expression || "").includes(marker)) {
    failures.push(`canary write expression must include ${marker}`);
  }
}
if (
  canary.control_rules?.[".read"] !== "auth != null" ||
  !String(canary.control_rules?.[".write"] || "").includes(
    "pnomade12@gmail.com",
  )
) {
  failures.push("order_sync_control must be auth-readable and release-admin-writable");
}
if (
  canary.false_by_default_value?.enabled !== false ||
  canary.false_by_default_value?.mode !== "BLOCKED" ||
  canary.false_by_default_value?.minimum_client_version_code !== requiredVersionCode
) {
  failures.push(`order_sync_control must define the vc${requiredVersionCode} false-by-default value`);
}
for (const field of ["client_version_code"]) {
  if (!canary.required_order_payload_fields?.includes(field)) {
    failures.push(`canary payload contract must require ${field}`);
  }
}
for (const forbiddenField of [
  "sync_control_generation",
  "sync_control_evidence_id",
]) {
  if (
    canary.required_order_payload_fields?.includes(forbiddenField) ||
    String(canary.write_expression || "").includes(
      `newData.child('${forbiddenField}')`,
    )
  ) {
    failures.push(
      `${forbiddenField} must remain local release evidence, not server order admission`,
    );
  }
}
for (const localControlField of ["generation", "evidence_id"]) {
  if (
    !Object.prototype.hasOwnProperty.call(
      canary.false_by_default_value || {},
      localControlField,
    ) ||
    !Object.prototype.hasOwnProperty.call(
      canary.control_rules || {},
      localControlField,
    )
  ) {
    failures.push(
      `order_sync_control must retain ${localControlField} for bounded app release proof`,
    );
  }
}

function localOrderWriteDecision({ authUid, targetUid, date, control, payload }) {
  if (!authUid || authUid !== targetUid || control.enabled !== true) return false;
  if (!Number.isFinite(payload.client_version_code)) return false;
  if (payload.client_version_code < control.minimum_client_version_code) {
    return false;
  }
  if (control.mode === "CANARY") {
    return control.allowed_uid === targetUid && control.allowed_date === date;
  }
  return control.mode === "VERSION";
}

const canaryControl = {
  enabled: true,
  mode: "CANARY",
  generation: 7,
  evidence_id: `QP-V${requiredVersionCode}-CANARY`,
  minimum_client_version_code: requiredVersionCode,
  allowed_uid: "director-uid",
  allowed_date: "2026-07-31",
};
const validPayload = {
  client_version_code: requiredVersionCode,
};
const localCanaryCases = [
  {
    label: "exact canary",
    expected: true,
    input: {
      authUid: "director-uid",
      targetUid: "director-uid",
      date: "2026-07-31",
      control: canaryControl,
      payload: validPayload,
    },
  },
  {
    label: "blocked mode",
    expected: false,
    input: {
      authUid: "director-uid",
      targetUid: "director-uid",
      date: "2026-07-31",
      control: { ...canaryControl, enabled: false, mode: "BLOCKED" },
      payload: validPayload,
    },
  },
  {
    label: "old client missing payload proof",
    expected: false,
    input: {
      authUid: "director-uid",
      targetUid: "director-uid",
      date: "2026-07-31",
      control: canaryControl,
      payload: {},
    },
  },
  {
    label: "sub-minimum client",
    expected: false,
    input: {
      authUid: "director-uid",
      targetUid: "director-uid",
      date: "2026-07-31",
      control: canaryControl,
      payload: { ...validPayload, client_version_code: requiredVersionCode - 1 },
    },
  },
  {
    label: "other uid",
    expected: false,
    input: {
      authUid: "other-uid",
      targetUid: "other-uid",
      date: "2026-07-31",
      control: canaryControl,
      payload: validPayload,
    },
  },
  {
    label: "other date",
    expected: false,
    input: {
      authUid: "director-uid",
      targetUid: "director-uid",
      date: "2026-07-30",
      control: canaryControl,
      payload: validPayload,
    },
  },
  {
    label: "version rollout",
    expected: true,
    input: {
      authUid: "user-uid",
      targetUid: "user-uid",
      date: "2026-08-01",
      control: { ...canaryControl, mode: "VERSION" },
      payload: validPayload,
    },
  },
];
for (const candidate of localCanaryCases) {
  if (localOrderWriteDecision(candidate.input) !== candidate.expected) {
    failures.push(`local order_sync_control decision failed: ${candidate.label}`);
  }
}

if (
  canary.rollback?.orders_write !== false ||
  canary.rollback?.remove_child_write_rule !== true
) {
  failures.push("canary artifact must define fail-closed rollback");
}

if (!failures.length) {
  const policyCheck = spawnSync(process.execPath, [dataCostVerifierPath], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (policyCheck.status !== 0) {
    failures.push(
      `data cost policy check failed:\n${policyCheck.stdout || ""}\n${policyCheck.stderr || ""}`,
    );
  } else {
    process.stdout.write(policyCheck.stdout);
  }
}

if (!failures.length) {
  const test = spawnSync(
    process.execPath,
    ["--test", "test/order-live-guard.test.js"],
    {
      cwd: releaseDir,
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  if (test.status !== 0) {
    failures.push(
      `orderLive tests failed:\n${test.stdout || ""}\n${test.stderr || ""}`,
    );
  } else {
    process.stdout.write(test.stdout);
  }
}

if (failures.length) {
  console.error("QP_ORDER_LIVE_COST_GATE=FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("QP_ORDER_LIVE_COST_GATE=PASS");
console.log(
  "isolated source only; semantic no-op DB/log=0; duplicate event guarded; deploy target functions:orderLive",
);
