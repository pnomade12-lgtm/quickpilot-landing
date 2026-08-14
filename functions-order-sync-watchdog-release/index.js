"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const thresholds = require("./thresholds.json");
const { evaluateMetrics, nextBlockedControl } = require("./order-sync-watchdog");
const {
  buildMonitoringMetrics,
  monitoringFilters,
} = require("./monitoring-collector");

initializeApp();

const PROJECT_ID =
  process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "quickpilot-39d72";
const DATABASE_INSTANCE = "quickpilot-39d72-default-rtdb";

async function accessToken() {
  const response = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error(`metadata_token_${response.status}`);
  const body = await response.json();
  if (!body.access_token) throw new Error("metadata_token_missing");
  return body.access_token;
}

async function timeSeries(token, filter, now) {
  const query = new URLSearchParams({
    filter,
    "interval.startTime": new Date(now - 45 * 60000).toISOString(),
    "interval.endTime": new Date(now).toISOString(),
    view: "FULL",
    pageSize: "200",
  });
  const response = await fetch(
    `https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/timeSeries?${query}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(7000),
    },
  );
  if (!response.ok) throw new Error(`monitoring_timeseries_${response.status}`);
  const body = await response.json();
  return body.timeSeries || [];
}

exports.orderSyncMetricsCollector = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Seoul",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 1,
  },
  async () => {
    const db = getDatabase();
    const control = (
      await db.ref("v1/app/order_sync_control").once("value")
    ).val() || {};
    const metricsRef = db.ref("v1/app/order_sync_metrics/current");
    const now = Date.now();
    try {
      const token = await accessToken();
      const filters = monitoringFilters(DATABASE_INSTANCE);
      const [deniedWrites, outboundBytes, databaseLoad, orderLiveInvocations] =
        await Promise.all([
          timeSeries(token, filters.deniedWrites, now),
          timeSeries(token, filters.outboundBytes, now),
          timeSeries(token, filters.databaseLoad, now),
          timeSeries(token, filters.orderLiveInvocations, now),
        ]);
      await metricsRef.set(
        buildMonitoringMetrics({
          now,
          control,
          series: {
            deniedWrites,
            outboundBytes,
            databaseLoad,
            orderLiveInvocations,
          },
        }),
      );
    } catch (error) {
      await metricsRef.set({
        collector_ok: false,
        collector_source: "cloud_monitoring_v1",
        collected_at: now,
        collector_error: String(error?.message || "collector_failed").slice(0, 120),
        control_generation: Number(control?.generation) || 0,
      });
    }
    return null;
  },
);

exports.orderSyncWatchdog = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "Asia/Seoul",
    timeoutSeconds: 30,
    memory: "256MiB",
    maxInstances: 1,
  },
  async () => {
    const db = getDatabase();
    const controlRef = db.ref("v1/app/order_sync_control");
    const control = (await controlRef.once("value")).val() || {};
    if (control.enabled === false && control.mode === "BLOCKED") return null;

    const now = Date.now();
    const metrics = (
      await db.ref("v1/app/order_sync_metrics/current").once("value")
    ).val();
    const breaches = evaluateMetrics(metrics, thresholds, now);
    if (breaches.length === 0) return null;

    const evidenceId = `WATCHDOG-${now}`;
    await controlRef.transaction((current) =>
      nextBlockedControl(current, evidenceId, now, breaches),
    );
    return null;
  },
);
