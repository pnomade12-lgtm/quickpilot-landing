"use strict";

const crypto = require("crypto");

const ORDER_TS_FIELDS = [
  "detected_at",
  "accepted_at",
  "arrive_at",
  "delivered_at",
];

function shadowKey(signature, orderId) {
  // Aggregate ownership follows the representative ID. Route/signature is
  // descriptive data and must never merge two real orders into one shadow.
  return `_oid_${String(orderId).replace(/[.#$/\[\]]/g, "_")}`;
}

function parseOrigin(order) {
  const platform = order.platform || "";
  const raw = order.raw_text || "";
  const origin = order.origin || "";
  let token;
  if (/인성/.test(platform)) {
    const match = /@([^|/]+)/.exec(origin) || /@([^|/]+)/.exec(raw);
    token = match
      ? match[1]
      : origin.replace(/[*]+/g, "").replace(/\//g, " ");
  } else {
    token = origin.split("/")[0];
  }
  token = (token || "")
    .split(")")
    .pop()
    .replace(/^\s*\d{1,2}:\d{2}\s*/, "")
    .replace(/^\s*\d{1,2}시\s*/, "")
    .replace(/[.\s]+$/, "")
    .trim();
  if (!token || !/(동|읍|면|리|가)$/.test(token)) return null;
  return token;
}

function liveKeyParts(order) {
  const detected = Number(order.detected_at) || 0;
  if (!detected) return null;
  const origin = parseOrigin(order);
  const signatureParts = (order.signature || "").split("|");
  const destination =
    (signatureParts.length >= 3 ? signatureParts[2] : signatureParts[1]) || "";
  if (!origin || !destination) return null;
  const key = `${origin}|${destination}`.replace(/[.#$\[\]\/]/g, "_");
  const platform = (order.platform || "기타").replace("통합콜", "통합");
  const platformKey = ["인성", "통합", "카카오"].includes(platform)
    ? platform
    : "기타";
  const hour = new Date(detected + 9 * 3600000).getUTCHours();
  const source =
    order.source === "auto" ||
    order.source === "user_click" ||
    order.source === "kakao"
      ? order.source
      : /^ACTION/.test(order.raw_text || "")
        ? "user_click"
        : "auto";
  return {
    key,
    pfk: platformKey,
    hour,
    agency: order.agency || "",
    source,
  };
}

function orderMaxTs(order) {
  let max = 0;
  for (const field of ORDER_TS_FIELDS) {
    const value = Number(order && order[field]) || 0;
    if (value > max) max = value;
  }
  return max;
}

function orderAggregateProjection(order, orderId) {
  if (!order) return null;
  const live = liveKeyParts(order);
  return [
    1,
    shadowKey(order.signature, orderId),
    String(order.platform || "기타"),
    orderMaxTs(order),
    live
      ? [live.key, live.pfk, live.hour, String(live.agency), live.source]
      : null,
  ];
}

function semanticDigest(order, orderId) {
  const projection = orderAggregateProjection(order, orderId);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(projection))
    .digest("hex");
}

function sameAggregateMeaning(before, after, orderId) {
  return semanticDigest(before, orderId) === semanticDigest(after, orderId);
}

function createOrderLiveHandler({ db, serverValue }) {
  if (!db || typeof db.ref !== "function") {
    throw new Error("orderLive requires an RTDB adapter");
  }
  if (!serverValue || typeof serverValue.increment !== "function") {
    throw new Error("orderLive requires ServerValue.increment");
  }

  return async function orderLiveHandler(change, context) {
    const before = change.before.val();
    const after = change.after.val();
    const orderId = context.params.orderId;

    // Cost firewall: this must remain before Date.now(), db.ref(), logging, or
    // any other side effect. Transport/provenance-only echoes stop here.
    if (sameAggregateMeaning(before, after, orderId)) return null;

    const date = context.params.date;
    const uid = context.params.uid;
    const beforeIdentity = before
      ? `${shadowKey(before.signature, orderId)}|${String(before.platform || "기타")}`
      : "";
    const afterIdentity = after
      ? `${shadowKey(after.signature, orderId)}|${String(after.platform || "기타")}`
      : "";
    const shadowMayBeStale =
      !after ||
      (before &&
        (beforeIdentity !== afterIdentity ||
          orderMaxTs(after) < orderMaxTs(before)));
    const shadowGuardRef = db.ref(
      `v1/app/agg_shadow_guard/${date}/${uid}`,
    );
    const guardMutation = await shadowGuardRef.transaction((current) => {
      // Firebase may deliver an event more than once. An immediately repeated
      // event must not fan out into any aggregate writes.
      if (current && current.lastEvent === context.eventId) return undefined;
      const next = Object.assign({}, current || {});
      next.mutationSeq = (Number(next.mutationSeq) || 0) + 1;
      next.lastEvent = context.eventId;
      next.lastOrderId = orderId;
      next.lastWriteAt = Date.now();
      next.lastSource = String((after || before || {}).source || "");
      next.lastPlatform = String((after || before || {}).platform || "");
      next.lastStatus = String((after || before || {}).status || "");
      if (shadowMayBeStale) {
        next.verified = false;
        next.dirty = true;
        next.dirtyEvent = context.eventId;
        next.dirtyAt = Date.now();
      }
      return next;
    });
    if (!guardMutation.committed) return null;

    const eventGuard = guardMutation.snapshot.val() || {};
    const eventMutationSeq = Number(eventGuard.mutationSeq) || 0;
    if (!after) return null;

    const seenKey = shadowKey(after.signature, orderId);
    const shadowBase = `v1/app/agg_shadow/${date}/${uid}`;
    const shadowSeen = await db
      .ref(`v1/app/agg_shadow_seen/${date}/${uid}/${seenKey}`)
      .transaction((current) => (current ? undefined : 1));
    if (shadowSeen.committed) {
      const platform = (after.platform || "기타").replace(
        /[.#$/\[\]]/g,
        "_",
      );
      await db.ref(shadowBase).update({
        cnt: serverValue.increment(1),
        [`plat/${platform}`]: serverValue.increment(1),
      });
    }

    const detectedMax = orderMaxTs(after);
    if (detectedMax) {
      await db
        .ref(`${shadowBase}/lastTs`)
        .transaction((current) =>
          current && current > detectedMax ? current : detectedMax,
        );
    }

    if (!shadowMayBeStale) {
      await shadowGuardRef.transaction((current) => {
        const state = current == null ? eventGuard : current;
        if (
          !state ||
          state.verified !== true ||
          state.dirty === true ||
          (Number(state.mutationSeq) || 0) !== eventMutationSeq
        ) {
          return undefined;
        }
        return Object.assign({}, state, {
          verifiedSeq: eventMutationSeq,
          verifiedAt: Date.now(),
        });
      });
    }

    const parts = liveKeyParts(after);
    if (!parts) return null;
    const seenRef = db.ref(`v1/app/data_live_seen/${date}/${parts.key}`);
    const liveRef = db.ref(`v1/app/data_live/${date}`);
    const userSeen = await db
      .ref(`v1/app/data_live_seen/${date}/_users/${uid}`)
      .transaction((current) => (current ? undefined : 1));
    if (userSeen.committed) {
      await liveRef.update({ activeUsers: serverValue.increment(1) });
    }

    const countSeen = await seenRef
      .child("c")
      .transaction((current) => (current ? undefined : 1));
    if (countSeen.committed) {
      const increment = serverValue.increment(1);
      const update = {
        total: increment,
        [`platform/${parts.pfk}`]: increment,
        [`hourly/${parts.hour}`]: increment,
        updatedAt: Date.now(),
      };
      if (parts.source) update[`bySource/${parts.source}`] = increment;
      await liveRef.update(update);
    }

    if (parts.agency) {
      const agencySeen = await seenRef
        .child("a")
        .transaction((current) => (current ? undefined : 1));
      if (agencySeen.committed) {
        await liveRef.update({
          [`agencies/${parts.agency}`]: serverValue.increment(1),
        });
        const agencyPhone = String(parts.agency).replace(/[^0-9]/g, "");
        if (agencyPhone) {
          await db
            .ref(`v1/agencies/${agencyPhone}/cleanCount`)
            .transaction((current) => (Number(current) || 0) + 1);
        }
      }
    }
    return null;
  };
}

module.exports = {
  ORDER_TS_FIELDS,
  createOrderLiveHandler,
  liveKeyParts,
  orderAggregateProjection,
  orderMaxTs,
  parseOrigin,
  sameAggregateMeaning,
  semanticDigest,
  shadowKey,
};
