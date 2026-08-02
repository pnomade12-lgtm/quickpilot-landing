"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const thresholds = require("../thresholds.json");
const { evaluateMetrics, nextBlockedControl } = require("../order-sync-watchdog");

const now = 1785553200000;
function safeMetrics(overrides = {}) {
  return {
    collector_ok: true,
    collected_at: now,
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
});

test("block transition increments generation once and preserves other state", () => {
  const next = nextBlockedControl(
    { enabled: true, mode: "VERSION", generation: 7, minimum_client_version_code: 460 },
    "WATCHDOG-proof",
    now,
    ["outbound_bytes"],
  );
  assert.equal(next.enabled, false);
  assert.equal(next.mode, "BLOCKED");
  assert.equal(next.generation, 8);
  assert.equal(next.minimum_client_version_code, 460);
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
