"use strict";

const DATABASE_LOAD_MAX_OBSERVATION_LAG_MS = 1800000;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function evaluateMetrics(metrics, thresholds, now) {
  if (!metrics || metrics.collector_ok !== true) return ["collector_unavailable"];
  const collectedAt = number(metrics.collected_at);
  if (
    collectedAt <= 0 ||
    collectedAt > now + 30000 ||
    now - collectedAt > thresholds.collector_max_age_ms
  ) {
    return ["collector_stale"];
  }
  const monitoringObservedAt = number(metrics.monitoring_observed_at);
  if (
    monitoringObservedAt <= 0 ||
    monitoringObservedAt > now + 30000 ||
    now - monitoringObservedAt > thresholds.monitoring_max_lag_ms
  ) {
    return ["collector_signal_stale"];
  }
  const resourceLoadObservedAt = number(metrics.resource_load_observed_at);
  if (
    metrics.resource_load_current !== true ||
    resourceLoadObservedAt <= 0 ||
    resourceLoadObservedAt > now + 30000 ||
    now - resourceLoadObservedAt > DATABASE_LOAD_MAX_OBSERVATION_LAG_MS
  ) {
    return ["resource_load_signal_stale"];
  }

  const breaches = [];
  if (number(metrics.denied_order_requests) > thresholds.denied_order_requests) {
    breaches.push("denied_order_requests");
  }
  if (
    number(metrics.blocked_idle_order_operations) >
    thresholds.blocked_idle_order_operations
  ) {
    breaches.push("blocked_idle_order_operations");
  }
  const semanticChanges = number(metrics.semantic_changes);
  const invocations = number(metrics.order_live_invocations);
  if (
    invocations > semanticChanges * thresholds.max_invocations_per_semantic_change ||
    invocations > thresholds.order_live_invocations_per_minute
  ) {
    breaches.push("order_live_invocations");
  }
  if (number(metrics.outbound_bytes) > thresholds.outbound_bytes_per_minute) {
    breaches.push("outbound_bytes");
  }
  if (number(metrics.resource_load_percent) > thresholds.resource_load_percent) {
    breaches.push("resource_load_percent");
  }
  if (number(metrics.historical_replay_rows) > thresholds.historical_replay_rows) {
    breaches.push("historical_replay_rows");
  }
  return breaches;
}

function nextBlockedControl(current, evidenceId, now, breaches) {
  const state = current || {};
  if (state.enabled === false && state.mode === "BLOCKED") return undefined;
  return {
    ...state,
    enabled: false,
    mode: "BLOCKED",
    allowed_uid: "",
    allowed_date: "",
    generation: number(state.generation) + 1,
    evidence_id: evidenceId,
    blocked_reason: breaches.join(","),
    blocked_at: now,
  };
}

module.exports = {
  DATABASE_LOAD_MAX_OBSERVATION_LAG_MS,
  evaluateMetrics,
  nextBlockedControl,
};
