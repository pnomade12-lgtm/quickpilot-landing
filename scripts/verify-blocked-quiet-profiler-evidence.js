"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT = "quickpilot-39d72";
const INSTANCE = "quickpilot-39d72-default-rtdb";
const CONTROL_PATH = "/v1/app/order_sync_control";
const SCHEMA_VERSION = 1;
const MINIMUM_WINDOW_MS = 120000;
const DEFAULT_MAX_AGE_MS = 300000;
const CLOCK_SKEW_MS = 30000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const WRITE_NAMES = new Set([
  "realtime-write",
  "realtime-update",
  "realtime-transaction",
  "rest-write",
  "rest-update",
]);

function fail(message) {
  throw new Error(`QP_BLOCKED_QUIET_PROFILER_BLOCKED: ${message}`);
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${label} must be an integer`);
  return parsed;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected argument ${token}`);
    const name = token.slice(2);
    if (name === "capture") {
      result.capture = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${token} requires a value`);
    }
    result[name] = value;
    index += 1;
  }
  return result;
}

function normalizedPathSegments(value) {
  if (Array.isArray(value)) {
    return value.map((segment) => String(segment)).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split("/").filter(Boolean);
  }
  return [];
}

function isOrderPath(segments) {
  return (
    segments.length >= 4 &&
    segments[0] === "v1" &&
    segments[1] === "users" &&
    segments[3] === "orders"
  );
}

function isOrderLiveDownstreamPath(segments) {
  if (
    segments.length < 3 ||
    segments[0] !== "v1" ||
    segments[1] !== "app"
  ) {
    return false;
  }
  return [
    "agg_shadow_guard",
    "agg_shadow",
    "agg_shadow_seen",
    "data_live",
    "data_live_seen",
  ].includes(segments[2]);
}

function offendingOrderUids(events) {
  const uids = new Set();
  for (const event of events) {
    if (!WRITE_NAMES.has(String(event.name || ""))) continue;
    const segments = normalizedPathSegments(event.path);
    if (
      isOrderPath(segments) &&
      /^[A-Za-z0-9_-]{1,128}$/.test(segments[2] || "")
    ) {
      uids.add(segments[2]);
    }
  }
  return uids;
}

function parseRawEvents(rawText) {
  const events = [];
  for (const [index, rawLine] of rawText.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        fail(`raw profiler line ${index + 1} is not an event object`);
      }
      events.push(event);
    } catch (error) {
      if (String(error.message).startsWith("QP_BLOCKED_QUIET_PROFILER_BLOCKED:")) {
        throw error;
      }
      fail(`raw profiler line ${index + 1} is not valid JSON`);
    }
  }
  return events;
}

function summarizeEvents(events) {
  const eventNameCounts = {};
  let allowedFalseWriteEvents = 0;
  let orderPathWriteEvents = 0;
  let orderLivePathWriteEvents = 0;
  let rootUpdateEvents = 0;

  for (const event of events) {
    const name = String(event.name || "unknown");
    eventNameCounts[name] = (eventNameCounts[name] || 0) + 1;
    if (!WRITE_NAMES.has(name)) continue;

    const segments = normalizedPathSegments(event.path);
    if (event.allowed === false) allowedFalseWriteEvents += 1;
    if (isOrderPath(segments)) orderPathWriteEvents += 1;
    if (isOrderLiveDownstreamPath(segments)) {
      orderLivePathWriteEvents += 1;
    }
    if (
      segments.length === 0 &&
      (name === "realtime-update" || name === "rest-update")
    ) {
      rootUpdateEvents += 1;
    }
  }

  return {
    total_events: events.length,
    event_name_counts: eventNameCounts,
    allowed_false_write_events: allowedFalseWriteEvents,
    order_path_write_events: orderPathWriteEvents,
    order_live_path_write_events: orderLivePathWriteEvents,
    root_update_events: rootUpdateEvents,
    offending_uid_count: offendingOrderUids(events).size,
    offending_client_versions: {},
  };
}

function canonicalControl(value) {
  return {
    enabled: value?.enabled,
    mode: String(value?.mode || ""),
    generation: Number(value?.generation),
    evidence_id: String(value?.evidence_id || ""),
    minimum_client_version_code: Number(
      value?.minimum_client_version_code,
    ),
    allowed_uid: String(value?.allowed_uid || ""),
    allowed_date: String(value?.allowed_date || ""),
  };
}

function sameControl(left, right) {
  return JSON.stringify(canonicalControl(left)) === JSON.stringify(canonicalControl(right));
}

function validateBlockedControl(control, expectedGeneration, expectedMinimum) {
  const current = canonicalControl(control);
  if (
    current.enabled !== false ||
    current.mode !== "BLOCKED" ||
    current.generation !== expectedGeneration ||
    current.minimum_client_version_code !== expectedMinimum ||
    current.allowed_uid !== "" ||
    current.allowed_date !== ""
  ) {
    fail("control is not the exact expected fail-closed BLOCKED state");
  }
  if (!current.evidence_id) fail("control evidence_id is missing");
  return current;
}

function evidenceFailures(
  proof,
  { expectedGeneration, expectedMinimum, now, maxAgeMs },
) {
  const failures = [];
  const add = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const startedAt = Number(proof?.window_started_at);
  const endedAt = Number(proof?.window_ended_at);
  const durationMs = Number(proof?.duration_ms);
  const capturedAt = Number(proof?.captured_at);
  const counts = proof?.counts || {};
  const control = canonicalControl(proof?.control || {});
  const readback = canonicalControl(proof?.control_readback || {});

  add(proof?.schema_version === SCHEMA_VERSION, "schema_version mismatch");
  add(
    proof?.kind === "QP_BLOCKED_QUIET_PROFILER_EVIDENCE",
    "kind mismatch",
  );
  add(proof?.project === PROJECT, "project mismatch");
  add(proof?.instance === INSTANCE, "instance mismatch");
  add(proof?.profiler_complete === true, "profiler did not complete");
  add(Number.isSafeInteger(startedAt), "window_started_at is invalid");
  add(Number.isSafeInteger(endedAt), "window_ended_at is invalid");
  add(Number.isSafeInteger(durationMs), "duration_ms is invalid");
  add(Number.isSafeInteger(capturedAt), "captured_at is invalid");
  add(durationMs >= MINIMUM_WINDOW_MS, "quiet window is shorter than two minutes");
  add(
    endedAt - startedAt >= MINIMUM_WINDOW_MS,
    "wall-clock quiet window is shorter than two minutes",
  );
  add(
    Math.abs(durationMs - (endedAt - startedAt)) <= 5000,
    "duration does not match the recorded window",
  );
  add(Math.abs(capturedAt - endedAt) <= CLOCK_SKEW_MS, "captured_at mismatch");
  add(endedAt <= now + CLOCK_SKEW_MS, "quiet proof is from the future");
  add(now - endedAt <= maxAgeMs, "quiet proof is stale");
  add(control.enabled === false, "control was not disabled");
  add(control.mode === "BLOCKED", "control mode was not BLOCKED");
  add(control.generation === expectedGeneration, "control generation mismatch");
  add(
    control.minimum_client_version_code === expectedMinimum,
    "minimum client version mismatch",
  );
  add(control.allowed_uid === "", "control allowed_uid was not empty");
  add(control.allowed_date === "", "control allowed_date was not empty");
  add(Boolean(control.evidence_id), "control evidence_id is missing");
  add(sameControl(control, readback), "control changed during the quiet window");
  add(
    Number.isSafeInteger(counts.total_events) && counts.total_events >= 0,
    "total event count is invalid",
  );
  for (const field of [
    "allowed_false_write_events",
    "order_path_write_events",
    "order_live_path_write_events",
  ]) {
    add(
      counts[field] === 0,
      `${field} must be zero (observed=${counts[field]})`,
    );
  }
  add(
    Number.isSafeInteger(counts.offending_uid_count) &&
      counts.offending_uid_count >= 0,
    "offending_uid_count is invalid",
  );
  add(
    Number.isSafeInteger(counts.root_update_events) &&
      counts.root_update_events >= 0,
    "root_update_events is invalid",
  );
  const clientVersions = counts.offending_client_versions;
  const validClientVersions =
    clientVersions &&
    typeof clientVersions === "object" &&
    !Array.isArray(clientVersions) &&
    Object.entries(clientVersions).every(
      ([key, value]) =>
        (/^(beta|관제)-0\.\d{1,3}[a-z]?$/u.test(key) ||
          key === "unknown_or_other") &&
        Number.isSafeInteger(value) &&
        value >= 0,
    );
  add(validClientVersions, "offending_client_versions is invalid");
  if (validClientVersions) {
    const versionTotal = Object.values(clientVersions).reduce(
      (sum, value) => sum + value,
      0,
    );
    add(
      versionTotal === counts.offending_uid_count,
      "offending client version counts do not add up",
    );
    if (counts.order_path_write_events > 0) {
      failures.push(
        `offending clients: uid_count=${counts.offending_uid_count}, ` +
          `versions=${JSON.stringify(clientVersions)}`,
      );
    }
  }
  const eventNameCounts = counts.event_name_counts;
  add(
    eventNameCounts &&
      typeof eventNameCounts === "object" &&
      !Array.isArray(eventNameCounts),
    "event_name_counts is invalid",
  );
  if (
    eventNameCounts &&
    typeof eventNameCounts === "object" &&
    !Array.isArray(eventNameCounts)
  ) {
    const eventCounts = Object.values(eventNameCounts);
    add(
      eventCounts.every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ),
      "event_name_counts contains an invalid count",
    );
    const summedEvents = eventCounts.reduce((sum, value) => sum + value, 0);
    add(summedEvents === counts.total_events, "event counts do not add up");
  }
  add(HASH_PATTERN.test(String(proof?.raw_sha256 || "")), "raw SHA-256 is invalid");
  add(proof?.privacy?.raw_persisted === false, "raw profiler data was persisted");
  add(
    proof?.privacy?.identifiers_persisted === false,
    "profiler identifiers were persisted",
  );
  add(
    proof?.privacy?.paths_persisted === false,
    "profiler paths were persisted",
  );
  add(
    proof?.privacy?.ephemeral_raw_deleted === true,
    "ephemeral raw profiler file was not confirmed deleted",
  );
  return failures;
}

function verifyEvidence(proof, options) {
  const failures = evidenceFailures(proof, options);
  if (failures.length > 0) fail(failures.join("; "));
  return proof;
}

function firebaseExecutable() {
  return process.platform === "win32" ? "firebase.cmd" : "firebase";
}

function runFirebase(args, timeout) {
  const result = spawnSync(firebaseExecutable(), args, {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32",
    timeout,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`Firebase read-only command failed (${args[0]})`);
  }
  return result.stdout;
}

function readLiveControl() {
  const text = runFirebase(
    [
      "database:get",
      CONTROL_PATH,
      "--project",
      PROJECT,
      "--instance",
      INSTANCE,
    ],
    30000,
  ).trim();
  try {
    return JSON.parse(text);
  } catch {
    fail("live control readback was not valid JSON");
  }
}

function readLiveJson(pathValue) {
  const text = runFirebase(
    [
      "database:get",
      pathValue,
      "--project",
      PROJECT,
      "--instance",
      INSTANCE,
    ],
    30000,
  ).trim();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeVersionBucket(value) {
  const version = String(value || "");
  return /^(beta|관제)-0\.\d{1,3}[a-z]?$/u.test(version)
    ? version
    : "unknown_or_other";
}

function clientVersionDistribution(uids) {
  const distribution = {};
  for (const uid of uids) {
    let version = readLiveJson(`/v1/users/${uid}/app_version`);
    if (typeof version !== "string") {
      const monitorVersion = readLiveJson(
        `/v1/app/monitor_input/${uid}/version`,
      );
      version = monitorVersion?.value;
    }
    const bucket = safeVersionBucket(version);
    distribution[bucket] = (distribution[bucket] || 0) + 1;
  }
  return distribution;
}

function captureEvidence({ outputPath, expectedGeneration, expectedMinimum, durationSeconds }) {
  if (durationSeconds * 1000 < MINIMUM_WINDOW_MS) {
    fail("capture duration must be at least two minutes");
  }
  const outputParent = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outputParent)) fail("output parent directory does not exist");
  if (fs.existsSync(path.resolve(outputPath))) {
    fail("output evidence already exists; refusing to overwrite it");
  }

  const before = validateBlockedControl(
    readLiveControl(),
    expectedGeneration,
    expectedMinimum,
  );
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "qp-blocked-quiet-"));
  const rawPath = path.join(tempDirectory, "profiler.ndjson");
  const startedAt = Date.now();
  let rawText = "";
  try {
    runFirebase(
      [
        "database:profile",
        "--raw",
        "--no-collapse",
        "--duration",
        String(durationSeconds),
        "--output",
        rawPath,
        "--project",
        PROJECT,
        "--instance",
        INSTANCE,
      ],
      (durationSeconds + 45) * 1000,
    );
    rawText = fs.readFileSync(rawPath, "utf8");
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
  const endedAt = Date.now();
  const after = validateBlockedControl(
    readLiveControl(),
    expectedGeneration,
    expectedMinimum,
  );
  if (!sameControl(before, after)) fail("live control changed during capture");

  const events = parseRawEvents(rawText);
  const counts = summarizeEvents(events);
  counts.offending_client_versions = clientVersionDistribution(
    offendingOrderUids(events),
  );
  const proof = {
    schema_version: SCHEMA_VERSION,
    kind: "QP_BLOCKED_QUIET_PROFILER_EVIDENCE",
    project: PROJECT,
    instance: INSTANCE,
    captured_at: endedAt,
    window_started_at: startedAt,
    window_ended_at: endedAt,
    duration_ms: endedAt - startedAt,
    profiler_complete: true,
    control: before,
    control_readback: after,
    counts,
    raw_sha256: crypto.createHash("sha256").update(rawText).digest("hex"),
    privacy: {
      raw_persisted: false,
      identifiers_persisted: false,
      paths_persisted: false,
      ephemeral_raw_deleted: true,
    },
  };
  verifyEvidence(proof, {
    expectedGeneration,
    expectedMinimum,
    now: endedAt,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
  });
  fs.writeFileSync(
    path.resolve(outputPath),
    `${JSON.stringify(proof, null, 2)}\n`,
    "utf8",
  );
  return proof;
}

function printPass(proof) {
  console.log("QP_BLOCKED_QUIET_PROFILER=PASS");
  console.log(`window_ms=${proof.duration_ms}`);
  console.log(`events=${proof.counts.total_events}`);
  console.log(`raw_sha256=${proof.raw_sha256}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const expectedGeneration = integer(
    args["expected-generation"],
    "expected generation",
  );
  const expectedMinimum = integer(
    args["expected-minimum-client-version-code"],
    "expected minimum client version",
  );

  if (args.capture) {
    if (!args.output) fail("--capture requires --output");
    const durationSeconds = integer(
      args["duration-seconds"] || 120,
      "duration seconds",
    );
    printPass(
      captureEvidence({
        outputPath: args.output,
        expectedGeneration,
        expectedMinimum,
        durationSeconds,
      }),
    );
    return;
  }

  if (!args.evidence) fail("--evidence is required");
  const maxAgeMs = integer(
    args["max-age-ms"] || DEFAULT_MAX_AGE_MS,
    "max age",
  );
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(path.resolve(args.evidence), "utf8"));
  } catch {
    fail("evidence file is missing or invalid JSON");
  }
  printPass(
    verifyEvidence(proof, {
      expectedGeneration,
      expectedMinimum,
      now: args.now ? integer(args.now, "now") : Date.now(),
      maxAgeMs,
    }),
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error?.message || error));
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  MINIMUM_WINDOW_MS,
  canonicalControl,
  evidenceFailures,
  parseRawEvents,
  sameControl,
  summarizeEvents,
  verifyEvidence,
};
