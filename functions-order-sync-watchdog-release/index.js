"use strict";

const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const thresholds = require("./thresholds.json");
const { evaluateMetrics, nextBlockedControl } = require("./order-sync-watchdog");

initializeApp();

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
