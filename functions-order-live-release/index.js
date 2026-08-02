"use strict";

const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
const { createOrderLiveHandler } = require("./order-live-guard");

const DB_URL =
  "https://quickpilot-39d72-default-rtdb.asia-southeast1.firebasedatabase.app";
const REGION = "asia-southeast1";

admin.initializeApp({ databaseURL: DB_URL });

const orderLiveHandler = createOrderLiveHandler({
  db: admin.database(),
  serverValue: admin.database.ServerValue,
});

exports.orderLive = functions
  .region(REGION)
  .runWith({
    timeoutSeconds: 30,
    memory: "256MB",
    maxInstances: 10,
  })
  .database.instance("quickpilot-39d72-default-rtdb")
  .ref("/v1/users/{uid}/orders/{date}/{orderId}")
  .onWrite(orderLiveHandler);
