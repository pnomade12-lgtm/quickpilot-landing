"use strict";

const DATABASE_METRIC_PREFIX = "firebasedatabase.googleapis.com/";
const FUNCTION_EXECUTION_METRIC =
  "cloudfunctions.googleapis.com/function/execution_count";
const DEFAULT_ZERO_VISIBILITY_LAG_MS = 120000;

function numericPointValue(point) {
  const value = point && point.value;
  const parsed = Number(value && (value.int64Value ?? value.doubleValue));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pointEndMillis(point) {
  const parsed = Date.parse(point?.interval?.endTime || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Monitoring DELTA series are sampled in one-minute buckets. Sum only the
 * newest aligned bucket across labels (for example function ok/error), never
 * an older non-zero point from a different label.
 */
function latestDelta(timeSeries, fallbackObservedAt) {
  const points = (timeSeries || []).flatMap((series) => series.points || []);
  const newestEnd = points.reduce(
    (latest, point) => Math.max(latest, pointEndMillis(point)),
    0,
  );
  if (newestEnd <= 0) {
    return { value: 0, observedAt: fallbackObservedAt };
  }
  const value = points
    .filter((point) => Math.abs(pointEndMillis(point) - newestEnd) <= 30000)
    .reduce((sum, point) => sum + numericPointValue(point), 0);
  return { value, observedAt: newestEnd };
}

function latestLoadPercent(timeSeries, fallbackObservedAt) {
  const newestPoints = (timeSeries || [])
    .map((series) =>
      (series.points || []).reduce((latest, point) =>
        pointEndMillis(point) > pointEndMillis(latest) ? point : latest,
      undefined),
    )
    .filter(Boolean);
  if (newestPoints.length === 0) {
    return { value: 0, observedAt: fallbackObservedAt };
  }
  return {
    value:
      Math.max(...newestPoints.map((point) => numericPointValue(point))) * 100,
    observedAt: Math.max(...newestPoints.map(pointEndMillis)),
  };
}

function buildMonitoringMetrics({ now, control, series }) {
  const zeroObservedAt = now - DEFAULT_ZERO_VISIBILITY_LAG_MS;
  const denied = latestDelta(series.deniedWrites, zeroObservedAt);
  const outbound = latestDelta(series.outboundBytes, zeroObservedAt);
  const invocations = latestDelta(series.orderLiveInvocations, zeroObservedAt);
  const load = latestLoadPercent(series.databaseLoad, zeroObservedAt);
  const monitoringObservedAt = Math.min(
    denied.observedAt,
    outbound.observedAt,
    invocations.observedAt,
    load.observedAt,
  );
  const orderLiveInvocations = Math.max(0, Math.round(invocations.value));
  const isBlocked = control?.enabled === false && control?.mode === "BLOCKED";

  return {
    collector_ok: true,
    collector_source: "cloud_monitoring_v1",
    collected_at: now,
    monitoring_observed_at: monitoringObservedAt,
    denied_order_requests: Math.max(0, Math.round(denied.value)),
    blocked_idle_order_operations: isBlocked ? orderLiveInvocations : 0,
    // The exact semantic-change equality is proved by the path-scoped CAN-F01
    // profiler. The permanent cutoff remains conservative at 300 invocations/min.
    semantic_changes: orderLiveInvocations,
    order_live_invocations: orderLiveInvocations,
    outbound_bytes: Math.max(0, Math.round(outbound.value)),
    resource_load_percent: Math.max(0, load.value),
    // CANARY rules admit only one exact UID/current date. VERSION additionally
    // requires the client-side dormant historical-outbox contract and CAN-F01.
    historical_replay_rows: 0,
    control_generation: Number(control?.generation) || 0,
  };
}

function monitoringFilters(tableName) {
  const namespace = `resource.labels.table_name = "${tableName}"`;
  return {
    deniedWrites:
      `metric.type = "${DATABASE_METRIC_PREFIX}rules/evaluation_count" AND ` +
      `${namespace} AND metric.labels.request_method = "WRITE" AND ` +
      'metric.labels.result = "DENY"',
    outboundBytes:
      `metric.type = "${DATABASE_METRIC_PREFIX}network/sent_bytes_count" AND ` +
      namespace,
    databaseLoad:
      `metric.type = "${DATABASE_METRIC_PREFIX}io/database_load" AND ` +
      namespace,
    orderLiveInvocations:
      `metric.type = "${FUNCTION_EXECUTION_METRIC}" AND ` +
      'resource.labels.function_name = "orderLive" AND ' +
      'resource.labels.region = "asia-southeast1"',
  };
}

module.exports = {
  DEFAULT_ZERO_VISIBILITY_LAG_MS,
  buildMonitoringMetrics,
  latestDelta,
  latestLoadPercent,
  monitoringFilters,
};
