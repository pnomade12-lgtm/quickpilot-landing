"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createOrderLiveHandler,
  sameAggregateMeaning,
  semanticDigest,
} = require("../order-live-guard");

function representative(overrides = {}) {
  return {
    order_card_no: "qp_bce6e254f16d49d6b2f0e343e66b285d",
    platform: "인성",
    signature: "인성|화성장지동|천안두정동|다마스",
    origin: "*** / @화성장지동",
    raw_text: "AUTO_POPUP|q|*** / @화성장지동|천안두정동|46200",
    source: "auto",
    agency: "0312228228",
    status: "detected",
    detected_at: 1785391080000,
    accepted_at: null,
    arrive_at: null,
    delivered_at: null,
    updated_at: 1785391080100,
    snapshot_revision: 93156,
    snapshot_hash: "a".repeat(64),
    state_revision: 93156,
    last_state_patch_id: "patch-a",
    distance_source: "insung_detail",
    distance_updated_at: 1785391080100,
    pickup_dist_km: 4.2,
    trip_dist_km: 66.1,
    ...overrides,
  };
}

function change(before, after) {
  return {
    before: { val: () => before },
    after: { val: () => after },
  };
}

function context(eventId = "event-1", orderId = "qp_bce6e254f16d49d6b2f0e343e66b285d") {
  return {
    eventId,
    params: {
      uid: "director-uid",
      date: "2026-07-31",
      orderId,
    },
  };
}

function createMemoryDb(seed = {}) {
  const values = new Map(Object.entries(seed));
  const stats = {
    refCalls: 0,
    committedWrites: 0,
    updates: 0,
    transactions: 0,
  };

  function snapshot(value) {
    return { val: () => value };
  }

  function ref(path) {
    stats.refCalls += 1;
    return {
      child(childPath) {
        return ref(`${path}/${childPath}`);
      },
      async update(value) {
        stats.committedWrites += 1;
        stats.updates += 1;
        values.set(path, value);
      },
      async transaction(mutator) {
        stats.transactions += 1;
        const current = values.has(path) ? values.get(path) : null;
        const next = mutator(current);
        if (next === undefined) {
          return { committed: false, snapshot: snapshot(current) };
        }
        stats.committedWrites += 1;
        values.set(path, next);
        return { committed: true, snapshot: snapshot(next) };
      },
    };
  }

  return { db: { ref }, stats, values };
}

const serverValue = {
  increment(value) {
    return { ".sv": { increment: value } };
  },
};

test("10,000 transport/provenance echoes keep one semantic digest", () => {
  const base = representative();
  const expected = semanticDigest(base, base.order_card_no);
  for (let index = 0; index < 10000; index += 1) {
    const echo = representative({
      updated_at: base.updated_at + index + 1,
      snapshot_revision: base.snapshot_revision + index + 1,
      snapshot_hash: (index % 16).toString(16).repeat(64),
      state_revision: base.state_revision + index + 1,
      last_state_patch_id: `patch-${index}`,
      distance_source: index % 2 ? "geodb" : "insung_detail",
      distance_updated_at: base.distance_updated_at + index + 1,
      pickup_dist_km: 1 + index / 10,
      trip_dist_km: 10 + index / 10,
      amount: 10000 + index,
      memo: `transport-only-${index}`,
      snapshot_origin_label: `표시-${index}`,
    });
    assert.equal(semanticDigest(echo, base.order_card_no), expected);
    assert.equal(sameAggregateMeaning(base, echo, base.order_card_no), true);
  }
});

test("every aggregate-relevant change changes the digest", () => {
  const base = representative();
  const orderId = base.order_card_no;
  const variants = [
    null,
    representative({ signature: "인성|화성장지동|천안성정동|다마스" }),
    representative({ platform: "통합콜" }),
    representative({ detected_at: base.detected_at + 3600000 }),
    representative({ accepted_at: base.detected_at + 1000 }),
    representative({ agency: "15887299" }),
    representative({ source: "user_click" }),
  ];
  for (const variant of variants) {
    assert.notEqual(
      semanticDigest(variant, orderId),
      semanticDigest(base, orderId),
    );
  }
});

test("semantic no-op returns before every DB and log side effect", async () => {
  const base = representative();
  const echo = representative({
    updated_at: base.updated_at + 1,
    snapshot_revision: base.snapshot_revision + 1,
    distance_source: "geodb",
    distance_updated_at: base.distance_updated_at + 1,
  });
  let dbTouched = 0;
  const handler = createOrderLiveHandler({
    db: {
      ref() {
        dbTouched += 1;
        throw new Error("no-op must not touch RTDB");
      },
    },
    serverValue,
  });
  await handler(change(base, echo), context());
  assert.equal(dbTouched, 0);
});

test("duplicate event aborts after one uncommitted guard transaction", async () => {
  const guardPath =
    "v1/app/agg_shadow_guard/2026-07-31/director-uid";
  const memory = createMemoryDb({
    [guardPath]: {
      mutationSeq: 7,
      lastEvent: "event-duplicate",
    },
  });
  const handler = createOrderLiveHandler({
    db: memory.db,
    serverValue,
  });
  await handler(change(null, representative()), context("event-duplicate"));
  assert.equal(memory.stats.refCalls, 1);
  assert.equal(memory.stats.transactions, 1);
  assert.equal(memory.stats.committedWrites, 0);
});

test("one new semantic order stays within the bounded downstream write budget", async () => {
  const memory = createMemoryDb();
  const handler = createOrderLiveHandler({
    db: memory.db,
    serverValue,
  });
  await handler(change(null, representative()), context("event-create"));
  assert.ok(memory.stats.committedWrites > 0);
  assert.ok(
    memory.stats.committedWrites <= 11,
    `expected at most 11 committed writes, got ${memory.stats.committedWrites}`,
  );
});

test("same route signature with different representative IDs keeps both orders", async () => {
  const memory = createMemoryDb();
  const handler = createOrderLiveHandler({ db: memory.db, serverValue });
  const firstId = "qp_representative_a";
  const secondId = "qp_representative_b";

  await handler(change(null, representative({ order_card_no: firstId })), context("event-a", firstId));
  await handler(change(null, representative({ order_card_no: secondId })), context("event-b", secondId));

  const seenPrefix = "v1/app/agg_shadow_seen/2026-07-31/director-uid/";
  assert.equal(memory.values.get(`${seenPrefix}_oid_${firstId}`), 1);
  assert.equal(memory.values.get(`${seenPrefix}_oid_${secondId}`), 1);
});
