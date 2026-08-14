"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const thresholds = require("../thresholds.json");
const { evaluateMetrics, nextBlockedControl } = require("../order-sync-watchdog");
const {
  buildMonitoringMetrics,
  latestDelta,
  monitoringFilters,
} = require("../monitoring-collector");

const now = 1785553200000;
function safeMetrics(overrides = {}) {
  return {
    collector_ok: true,
    collected_at: now,
    monitoring_observed_at: now - 60000,
    denied_order_requests: 0,
    blocked_idle_order_operations: 0,
    semantic_changes: 1,
    order_live_invocations: 1,
    outbound_bytes: 1024,
    resource_load_percent: 20,
    historical_replay_rows: 0,
    ...overrides,
  };
}

test("10,000 safe one-minute samples produce zero block decisions", () => {
  for (let index = 0; index < 10000; index += 1) {
    assert.deepEqual(evaluateMetrics(safeMetrics(), thresholds, now), []);
  }
});

test("every locked threshold is fail-closed", () => {
  for (const metrics of [
    safeMetrics({ denied_order_requests: 1 }),
    safeMetrics({ blocked_idle_order_operations: 1 }),
    safeMetrics({ semantic_changes: 1, order_live_invocations: 2 }),
    safeMetrics({ order_live_invocations: 301, semantic_changes: 301 }),
    safeMetrics({ outbound_bytes: 20971521 }),
    safeMetrics({ resource_load_percent: 86 }),
    safeMetrics({ historical_replay_rows: 1 }),
  ]) {
    assert.ok(evaluateMetrics(metrics, thresholds, now).length > 0);
  }
});

test("missing or stale collector blocks order sync", () => {
  assert.deepEqual(evaluateMetrics(null, thresholds, now), ["collector_unavailable"]);
  assert.deepEqual(
    evaluateMetrics(safeMetrics({ collected_at: now - 120001 }), thresholds, now),
    ["collector_stale"],
  );
  assert.deepEqual(
    evaluateMetrics(
      safeMetrics({ monitoring_observed_at: now - 300001 }),
      thresholds,
      now,
    ),
    ["collector_signal_stale"],
  );
});

function point(value, endTime) {
  const typedValue = Number.isInteger(value)
    ? { int64Value: String(value) }
    : { doubleValue: value };
  return { interval: { endTime }, value: typedValue };
}

test("collector sums only the newest aligned delta bucket", () => {
  const latest = new Date(now - 60000).toISOString();
  const old = new Date(now - 120000).toISOString();
  assert.deepEqual(
    latestDelta(
      [
        { points: [point(7, latest), point(9000, old)] },
        { points: [point(2, latest), point(8000, old)] },
      ],
      now - 120000,
    ),
    { value: 9, observedAt: now - 60000 },
  );
});

test("collector turns monitored storm signals into a fail-closed sample", () => {
  const end = new Date(now - 60000).toISOString();
  const metrics = buildMonitoringMetrics({
    now,
    control: { enabled: true, mode: "CANARY", generation: 11 },
    series: {
      deniedWrites: [{ points: [point(1, end)] }],
      outboundBytes: [{ points: [point(1024, end)] }],
      databaseLoad: [{ points: [point(0.2, end)] }],
      orderLiveInvocations: [{ points: [point(1, end)] }],
    },
  });
  assert.equal(metrics.collector_ok, true);
  assert.equal(metrics.control_generation, 11);
  assert.deepEqual(evaluateMetrics(metrics, thresholds, now), ["denied_order_requests"]);
});

test("collector filter is bounded to one database and the orderLive function", () => {
  const filters = monitoringFilters("quickpilot-39d72-default-rtdb");
  assert.match(filters.deniedWrites, /request_method = "WRITE"/);
  assert.match(filters.deniedWrites, /result = "DENY"/);
  assert.match(filters.outboundBytes, /quickpilot-39d72-default-rtdb/);
  assert.match(filters.orderLiveInvocations, /function_name = "orderLive"/);
  assert.doesNotMatch(JSON.stringify(filters), /v1\/users|orders\//);
});

test("block transition increments generation once and clears canary admission", () => {
  const next = nextBlockedControl(
    {
      enabled: true,
      mode: "CANARY",
      generation: 7,
      minimum_client_version_code: 460,
      allowed_uid: "director-uid",
      allowed_date: "2026-08-01",
    },
    "WATCHDOG-proof",
    now,
    ["outbound_bytes"],
  );
  assert.equal(next.enabled, false);
  assert.equal(next.mode, "BLOCKED");
  assert.equal(next.generation, 8);
  assert.equal(next.minimum_client_version_code, 460);
  assert.equal(next.allowed_uid, "");
  assert.equal(next.allowed_date, "");
  assert.equal(next.blocked_reason, "outbound_bytes");
});

test("already blocked control produces zero writes", () => {
  assert.equal(
    nextBlockedControl(
      { enabled: false, mode: "BLOCKED", generation: 8 },
      "WATCHDOG-repeat",
      now,
      ["collector_stale"],
    ),
    undefined,
  );
});
