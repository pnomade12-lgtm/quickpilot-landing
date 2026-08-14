// monitorSummary — 5분마다 변경분을 읽어 모니터 목록용 요약을
// /v1/app/monitor_summary 에 적는다. 모니터는 이 노드 하나만 읽어 가볍게 표시.
// 모니터 페이지(renderNow·statusOf)와 "같은 결론"을 내도록 계산식을 그대로 옮김.
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");

const DB_URL = "https://quickpilot-39d72-default-rtdb.asia-southeast1.firebasedatabase.app";
admin.initializeApp({ databaseURL: DB_URL });
const db = admin.database();

const REGION = "asia-southeast1";
const MOVE_W = 30 * 60000;      // 활성/휴면 판정 창 = 최근 30분
const MOVE_DISP_M = 500;        // 활성 인정 최소 변위 — 30분 창에서 이만큼 멀어져야 '운행'(주차 중 드리프트 컷)

function haversineM(la1, ln1, la2, ln2) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLa = rad(la2 - la1), dLn = rad(ln2 - ln1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const ORDER_TS_FIELDS = ["detected_at", "accepted_at", "arrive_at", "delivered_at"];

// KST 오늘 0시 epoch ms
function dayStartMs(now) { return now - ((now + 9 * 3600000) % 86400000); }
// orders 경로 키 = KST YYYY-MM-DD
function kstDate(now) {
  const k = new Date(now + 9 * 3600000);
  return k.getUTCFullYear() + "-" + String(k.getUTCMonth() + 1).padStart(2, "0") + "-" + String(k.getUTCDate()).padStart(2, "0");
}
function kstDayOfWeek(now) {
  return new Date(now + 9 * 3600000).getUTCDay(); // 0=Sun
}
function isWeeklyBillingRun(now) {
  return kstDayOfWeek(now) === 0;
}
function qpBillingLog(functionName, payload) {
  console.log("qp_billing_read", Object.assign({ functionName }, payload || {}));
}
let monitorSummaryReadMetrics = null;

function lastOrderTs(orders) {
  let mx = 0;
  Object.values(orders || {}).forEach(o => {
    ORDER_TS_FIELDS.forEach(f => { const v = Number(o && o[f]); if (v && v > mx) mx = v; });
  });
  return mx;
}
// [shadow] orderLive 증분과 reconcile 진실 count가 동일 키로 dedup하도록 공통 키.
// sig 있으면 RTDB키 안전 치환, 없으면 orderId 폴백(dedupBySig의 'sig없음=distinct'와 동일 효과).
function shadowKey(sig, oid) { return sig ? String(sig).replace(/[.#$/\[\]]/g, "_") : ("_oid_" + oid); }
function sortObj(o) { const r = {}; Object.keys(o || {}).sort().forEach(k => r[k] = o[k]); return r; }   // plat 비교용 키정렬
// signature 기준 중복제거 — 같은 오더가 여러 키(숫자키+sig키 전환기·재팝)로 들어와도 한 번만. sig 없으면 distinct.
function dedupBySig(vals) {
  const seen = new Set(); const out = [];
  (vals || []).forEach(o => { if (!o) return; const sig = o.signature; if (sig) { if (seen.has(sig)) return; seen.add(sig); } out.push(o); });
  return out;
}
function ordStats(orders) {
  const plat = {};
  const arr = dedupBySig(Object.values(orders || {}));
  arr.forEach(o => { const pf = o.platform || "기타"; plat[pf] = (plat[pf] || 0) + 1; });
  return { cnt: arr.length, plat };
}
function shadowMatchesRaw(shadow, rawStats, rawLastTs) {
  const shadowCount = Number(shadow && shadow.cnt) || 0;
  const shadowPlat = sortObj((shadow && shadow.plat) || {});
  return shadowCount === rawStats.cnt &&
    JSON.stringify(shadowPlat) === JSON.stringify(sortObj(rawStats.plat || {})) &&
    (Number(shadow && shadow.lastTs) || 0) === (Number(rawLastTs) || 0);
}
function orderMaxTs(order) {
  let mx = 0;
  ORDER_TS_FIELDS.forEach(f => { const v = Number(order && order[f]) || 0; if (v > mx) mx = v; });
  return mx;
}
function shadowSeenFromOrders(orders) {
  const seen = {};
  Object.entries(orders || {}).forEach(([orderId, order]) => {
    if (order) seen[shadowKey(order.signature, orderId)] = 1;
  });
  return seen;
}
function shadowGuardTrusted(state) {
  const mutationSeq = Number(state && state.mutationSeq) || 0;
  return !!state && state.verified === true && state.dirty !== true &&
    (Number(state.verifiedSeq) || 0) === mutationSeq;
}
function stableTextHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function rotatingShadowSample(uids, date, limit) {
  return [...new Set((uids || []).filter(Boolean))]
    .sort((a, b) => stableTextHash(date + "|" + a) - stableTextHash(date + "|" + b))
    .slice(0, Math.max(0, Number(limit) || 0));
}
function snapMaxTs(snap) {
  let mx = 0; snap.forEach(c => { const t = Number((c.val() && c.val().ts) || c.key) || 0; if (t > mx) mx = t; return false; });
  return mx;
}

const MONITOR_INPUT_PATH = "v1/app/monitor_input";

function monitorProfileInput(profile) {
  const p = profile || {};
  return {
    nick: String(p.nickname || ""),
    name: String(p.name || ""),
    phone: String(p.phone || ""),
    region: String(p.region || ""),
    vt: String(p.vehicle_type || ""),
    email: String(p.email || ""),
  };
}

function monitorCacheSeedFromSummary(summary, now) {
  const s = summary || {};
  const lastCrashTs = Number(s.lastCrashTs) || 0;
  return {
    complete: true,
    profile: {
      nick: String(s.nick || ""),
      name: String(s.name || ""),
      phone: String(s.phone || ""),
      region: String(s.region || ""),
      vt: String(s.vt || ""),
      email: String(s.email || ""),
    },
    version: { value: String(s.ver || "") },
    crash: {
      date: kstDate(now),
      count: lastCrashTs >= dayStartMs(now) ? Math.max(0, Number(s.crCnt) || 0) : 0,
      lastTs: lastCrashTs,
    },
    seenTs: Math.max(0, Number(s.seenTs) || 0),
  };
}

function mergeMonitorCacheEntry(seed, current) {
  const base = seed && typeof seed === "object" ? seed : {};
  const cur = current && typeof current === "object" ? current : {};
  const next = Object.assign({}, base, cur);
  next.profile = Object.assign({}, base.profile || {}, cur.profile || {});
  next.version = Object.assign({}, base.version || {}, cur.version || {});

  const baseCrash = base.crash && typeof base.crash === "object" ? base.crash : {};
  const curCrash = cur.crash && typeof cur.crash === "object" ? cur.crash : {};
  if (String(curCrash.date || "") === String(baseCrash.date || "")) {
    next.crash = Object.assign({}, baseCrash, curCrash, {
      count: Math.max(Number(baseCrash.count) || 0, Number(curCrash.count) || 0),
      lastTs: Math.max(Number(baseCrash.lastTs) || 0, Number(curCrash.lastTs) || 0),
    });
  } else if (String(curCrash.date || "") > String(baseCrash.date || "")) {
    next.crash = Object.assign({}, baseCrash, curCrash, {
      lastTs: Math.max(Number(baseCrash.lastTs) || 0, Number(curCrash.lastTs) || 0),
    });
  } else {
    next.crash = Object.assign({}, curCrash, baseCrash, {
      lastTs: Math.max(Number(baseCrash.lastTs) || 0, Number(curCrash.lastTs) || 0),
    });
  }
  next.seenTs = Math.max(Number(base.seenTs) || 0, Number(cur.seenTs) || 0);
  next.complete = base.complete === true || cur.complete === true;
  return next;
}

function fixedMonitorInput(entry, now) {
  const e = entry && typeof entry === "object" ? entry : {};
  const profile = e.profile && typeof e.profile === "object" ? e.profile : {};
  const version = e.version && typeof e.version === "object" ? e.version : {};
  const crash = e.crash && typeof e.crash === "object" ? e.crash : {};
  return {
    nick: String(profile.nick || ""),
    name: String(profile.name || ""),
    phone: String(profile.phone || ""),
    region: String(profile.region || ""),
    vt: String(profile.vt || ""),
    email: String(profile.email || ""),
    ver: String(version.value || ""),
    crCnt: String(crash.date || "") === kstDate(now) ? Math.max(0, Number(crash.count) || 0) : 0,
    lastCrashTs: Math.max(0, Number(crash.lastTs) || 0),
    seenTs: Math.max(0, Number(e.seenTs) || 0),
  };
}

function applyMonitorCrashEvent(current, event) {
  const cur = current && typeof current === "object" ? Object.assign({}, current) : {};
  const date = String(event.date || "");
  const eventKey = String(event.eventKey || "");
  const seen = String(cur.date || "") === date && cur.seen && typeof cur.seen === "object" ? Object.assign({}, cur.seen) : {};
  if (eventKey && seen[eventKey]) return cur;

  const count = String(cur.date || "") === date
    ? Math.max(Number(cur.count) || 0, Number(event.baseline) || 0)
    : Math.max(0, Number(event.baseline) || 0);
  if (eventKey) seen[eventKey] = Number(event.now) || Date.now();
  const trimmedSeen = {};
  Object.entries(seen).sort((a, b) => Number(a[1]) - Number(b[1])).slice(-32)
    .forEach(([key, at]) => { trimmedSeen[key] = at; });
  return {
    date,
    count: count + (String(event.eventDate || "") === date ? 1 : 0),
    lastTs: Math.max(Number(cur.lastTs) || 0, Number(event.summaryLastTs) || 0, Number(event.ts) || 0),
    seen: trimmedSeen,
    updatedAt: Number(event.now) || Date.now(),
  };
}

async function readMonitorInputFallback(uid, now) {
  const base = "v1/users/" + uid;
  const bucket = Math.floor(now / 86400000);
  const dayStart = dayStartMs(now);
  const [profSnap, verSnap, crashSnap, actLastSnap] = await Promise.all([
    db.ref(base + "/profile").once("value"),
    db.ref(base + "/app_version").once("value"),
    db.ref(base + "/crash_logs").orderByKey().startAt(String(dayStart)).once("value"),
    db.ref(base + "/user_actions/" + bucket).orderByKey().limitToLast(1).once("value"),
  ]);
  let crashCount = 0;
  let lastCrashTs = 0;
  crashSnap.forEach(child => {
    const t = Number((child.val() && child.val().ts) || child.key) || 0;
    if (t >= dayStart) crashCount += 1;
    if (t > lastCrashTs) lastCrashTs = t;
    return false;
  });
  return {
    complete: true,
    profile: monitorProfileInput(profSnap.val()),
    version: { value: String(verSnap.val() || "") },
    crash: { date: kstDate(now), count: crashCount, lastTs: lastCrashTs },
    seenTs: snapMaxTs(actLastSnap),
    seededAt: now,
  };
}

async function ensureMonitorInput(uid, entry, now, readMetrics) {
  if (entry && entry.complete === true) {
    if (readMetrics) readMetrics.fixedCacheUsers = (readMetrics.fixedCacheUsers || 0) + 1;
    return entry;
  }
  const seed = await readMonitorInputFallback(uid, now);
  if (readMetrics) {
    readMetrics.fixedFallbackUsers = (readMetrics.fixedFallbackUsers || 0) + 1;
    readMetrics.fixedFallbackReads = (readMetrics.fixedFallbackReads || 0) + 4;
    readMetrics.fixedFallbackUids.push(uid);
  }
  const ref = db.ref(MONITOR_INPUT_PATH + "/" + uid);
  const result = await ref.transaction(current => mergeMonitorCacheEntry(seed, current));
  return result.committed ? (result.snapshot.val() || seed) : seed;
}

async function summarizeUser(uid, now, monitorInput, readMetrics) {
  readMetrics = readMetrics || monitorSummaryReadMetrics;
  const base = "v1/users/" + uid;
  const bucket = Math.floor(now / 86400000);   // 앱 epoch-day 버킷
  const date = kstDate(now);
  const dayStart = dayStartMs(now);

  // 프로필·버전·최근 오류·최근 동작은 monitor_input 한 묶음에서 받는다.
  // 상태(커서+버퍼)와 오더 검증값만 병렬로 읽고, GPS는 커서가 정해진 뒤 증분 읽음.
  const [stateSnap, shadowSnap, shadowGuardSnap] = await Promise.all([
    db.ref("v1/app/agg_state/" + uid).once("value"),
    db.ref("v1/app/agg_shadow/" + date + "/" + uid).once("value"),   // [shadow] 증분 카운트 대조용
    db.ref("v1/app/agg_shadow_guard/" + date + "/" + uid).once("value"),
  ]);

  const fixed = fixedMonitorInput(monitorInput, now);
  const shadow = shadowSnap.val() || null;
  const shadowGuard = shadowGuardSnap.val() || {};
  const shadowGuardRef = db.ref("v1/app/agg_shadow_guard/" + date + "/" + uid);
  const shadowMutationSeq = Number(shadowGuard.mutationSeq) || 0;
  const shadowTrusted = shadowGuard.verified === true && shadowGuard.dirty !== true &&
    (Number(shadowGuard.verifiedSeq) || 0) === shadowMutationSeq;
  let os;
  let orderLastTs;
  if (shadowTrusted) {
    os = {
      cnt: Math.max(0, Number(shadow && shadow.cnt) || 0),
      plat: shadow && shadow.plat && typeof shadow.plat === "object" ? shadow.plat : {},
    };
    orderLastTs = Number(shadow && shadow.lastTs) || 0;
    if (readMetrics) readMetrics.verifiedShadowUsers = (readMetrics.verifiedShadowUsers || 0) + 1;
  } else {
    const orders = (await db.ref(base + "/orders/" + date).once("value")).val() || {};
    os = ordStats(orders);
    orderLastTs = lastOrderTs(orders);
    if (readMetrics) {
      readMetrics.ordersReadCount = (readMetrics.ordersReadCount || 0) + Object.keys(orders).length;
      readMetrics.rawFallbackUsers = (readMetrics.rawFallbackUsers || 0) + 1;
      readMetrics.rawFallbackUids.push(uid);
    }
    const exactShadow = shadowMatchesRaw(shadow, os, orderLastTs);
    if (!exactShadow) {
      if (readMetrics) {
        readMetrics.shadowMismatchUsers = (readMetrics.shadowMismatchUsers || 0) + 1;
        readMetrics.shadowMismatchUids.push(uid);
      }
      const repairToken = uid + ":" + shadowMutationSeq;
      const claim = await shadowGuardRef.transaction(current => {
        const state = current == null ? shadowGuard : current;
        if ((Number(state && state.mutationSeq) || 0) !== shadowMutationSeq) return;
        return Object.assign({}, state || {}, { repairToken, repairStartedAt: now });
      });
      if (claim.committed) {
        const seen = shadowSeenFromOrders(orders);
        const repair = {};
        repair["v1/app/agg_shadow/" + date + "/" + uid] = os.cnt > 0 ? { cnt: os.cnt, plat: os.plat, lastTs: orderLastTs } : null;
        repair["v1/app/agg_shadow_seen/" + date + "/" + uid] = Object.keys(seen).length ? seen : null;
        await db.ref().update(repair);
        const claimedGuard = claim.snapshot.val() || {};
        const verified = await shadowGuardRef.transaction(current => {
          const state = current == null ? claimedGuard : current;
          if ((Number(state && state.mutationSeq) || 0) !== shadowMutationSeq || String(state && state.repairToken || "") !== repairToken) return;
          const next = Object.assign({}, state || {}, {
            verified: true,
            dirty: false,
            verifiedSeq: shadowMutationSeq,
            verifiedAt: now,
            repairedAt: now,
          });
          delete next.repairToken;
          delete next.repairStartedAt;
          return next;
        });
        if (readMetrics) {
          if (verified.committed) {
            readMetrics.shadowRepairUsers = (readMetrics.shadowRepairUsers || 0) + 1;
            readMetrics.shadowRepairUids.push(uid);
          } else {
            readMetrics.shadowRepairRaceUsers = (readMetrics.shadowRepairRaceUsers || 0) + 1;
            readMetrics.shadowRepairRaceUids.push(uid);
          }
        }
      } else if (readMetrics) {
        readMetrics.shadowRepairRaceUsers = (readMetrics.shadowRepairRaceUsers || 0) + 1;
        readMetrics.shadowRepairRaceUids.push(uid);
      }
    } else {
      const verified = await shadowGuardRef.transaction(current => {
        const state = current == null ? shadowGuard : current;
        if ((Number(state && state.mutationSeq) || 0) !== shadowMutationSeq) return;
        const next = Object.assign({}, state || {}, {
          verified: true,
          dirty: false,
          verifiedSeq: shadowMutationSeq,
          verifiedAt: now,
        });
        delete next.repairToken;
        delete next.repairStartedAt;
        return next;
      });
      if (!verified.committed && readMetrics) {
        readMetrics.shadowVerifyRaceUsers = (readMetrics.shadowVerifyRaceUsers || 0) + 1;
        readMetrics.shadowVerifyRaceUids.push(uid);
      }
    }
  }

  // GPS 증분 읽기 — 커서(state.cur) 이후 새 점만. 활성 판정에 필요한 최근 30분은 다운샘플 버퍼(state.buf)에 누적·트림.
  // 커서가 30분 밖이면(첫 실행·앱 꺼졌다 켜짐) 시드: 최근 30분을 한 번 다시 읽어 버퍼 재구성.
  const state = stateSnap.val() || {};
  let buf = Array.isArray(state.buf) ? state.buf : [];   // [[tsMs, lat, lng, mv], ...]
  const seeded = !(state.cur && state.cur >= now - MOVE_W);
  const readStart = seeded ? (now - MOVE_W) : (state.cur + 1);
  if (seeded) buf = [];
  const bucketStart = bucket * 86400000;
  const gpsReads = [db.ref(base + "/gps_track/main/" + bucket).orderByKey().startAt(String(readStart)).once("value")];
  if (readStart < bucketStart) gpsReads.push(db.ref(base + "/gps_track/main/" + (bucket - 1)).orderByKey().startAt(String(readStart)).once("value"));   // UTC 자정(09시 KST) 경계 걸치면 직전 버킷 꼬리도
  const gpsSnaps = await Promise.all(gpsReads);

  const newPts = [];
  gpsSnaps.forEach(s => s.forEach(c => {
    const v = c.val(); if (!v) return;
    const t = Number(v.ts) || 0; if (!t) return;
    const la = Number(v.lat), ln = Number(v.lng);
    const sp = v.speed_kmh != null ? Number(v.speed_kmh) : null;
    const mv = (sp != null ? (sp > 3 && !v.is_stop) : !v.is_stop) ? 1 : 0;
    newPts.push({ t, la, ln, mv });
  }));
  if (readMetrics) readMetrics.gpsReadCount = (readMetrics.gpsReadCount || 0) + newPts.length;
  newPts.sort((a, b) => a.t - b.t);

  // 버퍼에 누적(15초 다운샘플) + 마지막 점 갱신
  const round5 = x => Math.round(x * 1e5) / 1e5;
  let lastBufTs = buf.length ? buf[buf.length - 1][0] : 0;
  let lastPt = state.last || null;
  newPts.forEach(pt => {
    if (!Number.isFinite(pt.la) || !Number.isFinite(pt.ln)) return;
    if (pt.t - lastBufTs >= 15000) { buf.push([pt.t, round5(pt.la), round5(pt.ln), pt.mv]); lastBufTs = pt.t; }
    lastPt = { ts: pt.t, lat: pt.la, lng: pt.ln };
  });
  const cutoff = now - MOVE_W;
  buf = buf.filter(e => e[0] >= cutoff);   // 30분 밖 트림

  // 버퍼에서 변위(박스 대각) + lastMoveTs. 변위 500m 미만이면 제자리 드리프트로 미인정.
  let lastMoveCand = 0, has = false, minLa = Infinity, maxLa = -Infinity, minLn = Infinity, maxLn = -Infinity;
  buf.forEach(e => {
    const t = e[0], la = e[1], ln = e[2], mv = e[3];
    has = true; if (la < minLa) minLa = la; if (la > maxLa) maxLa = la; if (ln < minLn) minLn = ln; if (ln > maxLn) maxLn = ln;
    if (mv && t > lastMoveCand) lastMoveCand = t;
  });
  const spanM = has ? haversineM(minLa, minLn, maxLa, maxLn) : 0;
  const lastMoveTs = (lastMoveCand && spanM >= MOVE_DISP_M) ? lastMoveCand : 0;

  const gpsTs = lastPt ? lastPt.ts : 0;
  const lat = lastPt ? lastPt.lat : null, lng = lastPt ? lastPt.lng : null;
  const seenTs = Math.max(gpsTs, fixed.seenTs, orderLastTs);

  // 상태 저장 — 다음 실행은 이 커서 이후만 읽음
  const newCur = newPts.length ? newPts[newPts.length - 1].t : now;
  await db.ref("v1/app/agg_state/" + uid).set({ cur: newCur, buf, last: lastPt || null });

  // [HQ#6 설계통합] 신규 gps(prevCur 이후)를 당일 격자 delta로 — dataMaps gps 이중리더 제거. 활동판정 buf와 별개.
  const prevCur = state.cur || 0; const cellDelta = {};
  newPts.forEach(pt => { if (pt.t > prevCur && pt.t >= dayStart && pt.la > 33 && pt.la < 39 && pt.ln > 124 && pt.ln < 131) { const key = Math.round(pt.la / 0.03) + "," + Math.round(pt.ln / 0.03); cellDelta[key] = (cellDelta[key] || 0) + 1; } });

  return {
    nick: fixed.nick, name: fixed.name, phone: fixed.phone, region: fixed.region,
    vt: fixed.vt, email: fixed.email, ver: fixed.ver,
    ordCnt: os.cnt, shadow, plat: os.plat, lastOrderTs: orderLastTs,
    crCnt: fixed.crCnt, lastCrashTs: fixed.lastCrashTs,
    seenTs, lastMoveTs, gpsTs,
    lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
    cellDelta,
  };
}

// uid 목록은 키만(shallow) — v1/users 통째 읽으면 전 유저 gps·orders까지 끌려와 타임아웃.
// Admin SDK엔 shallow가 없어 함수 서비스계정 access_token으로 REST shallow 호출.
async function listUids() {
  const tokRes = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  const tok = (await tokRes.json()).access_token;
  const res = await fetch(DB_URL + "/v1/users.json?shallow=true&access_token=" + tok);
  const obj = (await res.json()) || {};
  return Object.keys(obj).filter(k => k !== "director-nuri");
}

async function loadMonitorInputCache(uids, now, inputSnap, readMetrics) {
  let cache = inputSnap.val() || {};
  readMetrics.fixedCacheRootReads = 1;
  if (cache._meta && cache._meta.seeded === true) return cache;

  const previous = (await db.ref("v1/app/monitor_summary").once("value")).val() || {};
  readMetrics.fixedCacheRootReads += 1;
  const seeds = {};
  uids.forEach(uid => {
    if (previous[uid] && typeof previous[uid] === "object") {
      seeds[uid] = monitorCacheSeedFromSummary(previous[uid], now);
    }
  });

  const inputRef = db.ref(MONITOR_INPUT_PATH);
  const result = await inputRef.transaction(current => {
    const next = current && typeof current === "object" ? Object.assign({}, current) : {};
    Object.keys(seeds).forEach(uid => {
      next[uid] = mergeMonitorCacheEntry(seeds[uid], next[uid]);
    });
    next._meta = Object.assign({}, next._meta || {}, {
      seeded: true,
      schema: "monitor_input_v1",
      seededAt: Number((next._meta || {}).seededAt) || now,
      sourceSummaryTs: Number((previous._meta || {}).ts) || 0,
    });
    return next;
  });

  readMetrics.fixedCacheSeedUsers = Object.keys(seeds).length;
  readMetrics.fixedCacheSeeded = result.committed;
  if (result.committed) return result.snapshot.val() || cache;

  Object.keys(seeds).forEach(uid => { cache[uid] = mergeMonitorCacheEntry(seeds[uid], cache[uid]); });
  return cache;
}

async function buildSummary() {
  const now = Date.now();
  const [uids, inputSnap] = await Promise.all([
    listUids(),
    db.ref(MONITOR_INPUT_PATH).once("value"),
  ]);
  const readMetrics = {
    ordersReadCount: 0,
    gpsReadCount: 0,
    users: uids.length,
    verifiedShadowUsers: 0,
    rawFallbackUsers: 0,
    rawFallbackUids: [],
    shadowMismatchUsers: 0,
    shadowRepairUsers: 0,
    shadowRepairRaceUsers: 0,
    shadowVerifyRaceUsers: 0,
    shadowMismatchUids: [],
    shadowRepairUids: [],
    shadowRepairRaceUids: [],
    shadowVerifyRaceUids: [],
    fixedCacheRootReads: 0,
    fixedCacheUsers: 0,
    fixedCacheSeedUsers: 0,
    fixedCacheSeeded: false,
    fixedFallbackUsers: 0,
    fixedFallbackReads: 0,
    fixedFallbackUids: [],
  };
  monitorSummaryReadMetrics = readMetrics;
  const monitorInputs = await loadMonitorInputCache(uids, now, inputSnap, readMetrics);

  const out = {}; const gridAcc = {};
  await Promise.all(uids.map(async uid => {
    try {
      const monitorInput = await ensureMonitorInput(uid, monitorInputs[uid], now, readMetrics);
      const r = await summarizeUser(uid, now, monitorInput, readMetrics);
      const cd = r.cellDelta || {};
      for (const k in cd) gridAcc[k] = (gridAcc[k] || 0) + cd[k];
      delete r.cellDelta;
      out[uid] = r;
    } catch (e) { /* 한 명 실패가 전체를 막지 않음 */ }
  }));
  out._meta = {
    ts: now,
    n: Object.keys(out).length,
    gridN: Object.keys(gridAcc).length,
    health: {
      mode: "verified_shadow_monitor_input_v1",
      ordersReadCount: readMetrics.ordersReadCount,
      verifiedShadowUsers: readMetrics.verifiedShadowUsers,
      rawFallbackUsers: readMetrics.rawFallbackUsers,
      rawFallbackUids: readMetrics.rawFallbackUids,
      shadowMismatchUsers: readMetrics.shadowMismatchUsers,
      shadowRepairUsers: readMetrics.shadowRepairUsers,
      shadowRepairRaceUsers: readMetrics.shadowRepairRaceUsers,
      shadowVerifyRaceUsers: readMetrics.shadowVerifyRaceUsers,
      shadowMismatchUids: readMetrics.shadowMismatchUids,
      shadowRepairUids: readMetrics.shadowRepairUids,
      shadowRepairRaceUids: readMetrics.shadowRepairRaceUids,
      shadowVerifyRaceUids: readMetrics.shadowVerifyRaceUids,
      fixedCacheRootReads: readMetrics.fixedCacheRootReads,
      fixedCacheUsers: readMetrics.fixedCacheUsers,
      fixedCacheSeedUsers: readMetrics.fixedCacheSeedUsers,
      fixedCacheSeeded: readMetrics.fixedCacheSeeded,
      fixedFallbackUsers: readMetrics.fixedFallbackUsers,
      fixedFallbackReads: readMetrics.fixedFallbackReads,
      fixedFallbackUids: readMetrics.fixedFallbackUids,
    },
  };
  await db.ref("v1/app/monitor_summary").set(out);
  // [HQ#6 설계통합] 격자 delta 합산 1회 쓰기(increment). try 분리 — 실패해도 본 기능(요약) 영향 0.
  try {
    const ds = kstDate(now); const upd = {};
    for (const k in gridAcc) upd["grid/" + k.replace(/[.#$/\[\]]/g, "_")] = admin.database.ServerValue.increment(gridAcc[k]);
    if (Object.keys(upd).length) await db.ref("v1/app/data_maps_state/" + ds).update(upd);
  } catch (e) {}
  out._meta._readMetrics = readMetrics;
  monitorSummaryReadMetrics = null;
  return out._meta;
}

const RUN = { timeoutSeconds: 120, memory: "256MB" };

// 5분 스케줄 (Blaze 필요) — 비용 절감. 실시간성 불필요(활성=30분 기준)·증분 읽기로 비용 추가 절감.
exports.monitorSummary = functions.region(REGION).runWith(RUN).pubsub.schedule("every 5 minutes").onRun(async () => {
  const started = Date.now();
  const meta = await buildSummary();
  const readMetrics = meta._readMetrics || {};
  delete meta._readMetrics;
  qpBillingLog("monitorSummary", {
    readDate: kstDate(started),
    ordersReadCount: readMetrics.ordersReadCount || 0,
    gpsReadCount: readMetrics.gpsReadCount || 0,
    verifiedShadowUsers: readMetrics.verifiedShadowUsers || 0,
    rawFallbackUsers: readMetrics.rawFallbackUsers || 0,
    rawFallbackUids: readMetrics.rawFallbackUids || [],
    shadowMismatchUsers: readMetrics.shadowMismatchUsers || 0,
    shadowRepairUsers: readMetrics.shadowRepairUsers || 0,
    shadowRepairRaceUsers: readMetrics.shadowRepairRaceUsers || 0,
    shadowVerifyRaceUsers: readMetrics.shadowVerifyRaceUsers || 0,
    shadowMismatchUids: readMetrics.shadowMismatchUids || [],
    shadowRepairUids: readMetrics.shadowRepairUids || [],
    shadowRepairRaceUids: readMetrics.shadowRepairRaceUids || [],
    shadowVerifyRaceUids: readMetrics.shadowVerifyRaceUids || [],
    fixedCacheRootReads: readMetrics.fixedCacheRootReads || 0,
    fixedCacheUsers: readMetrics.fixedCacheUsers || 0,
    fixedCacheSeedUsers: readMetrics.fixedCacheSeedUsers || 0,
    fixedCacheSeeded: readMetrics.fixedCacheSeeded === true,
    fixedFallbackUsers: readMetrics.fixedFallbackUsers || 0,
    fixedFallbackReads: readMetrics.fixedFallbackReads || 0,
    fixedFallbackUids: readMetrics.fixedFallbackUids || [],
    cache: "monitor_input_v1_with_verified_shadow",
    durationMs: Date.now() - started,
  });
  console.log("monitor_summary updated", meta);
  return null;
});

// 수동 트리거(검증용) — 배포 후 한 번 호출해 노드 채우고 결과 확인.
exports.monitorSummaryNow = functions.region(REGION).runWith(RUN).https.onRequest(async (req, res) => {
  const meta = await buildSummary();
  delete meta._readMetrics;
  res.json({ ok: true, meta });
});

// 프로필·버전·최근 오류는 바뀔 때만 작은 관제 입력값을 갱신한다.
// 최근 활동은 이미 읽는 GPS·오더 시각을 사용해 user_actions 전용 함수를 만들지 않는다.
// 클라이언트 원문 쓰기는 그대로 끝나며 이 후속 함수가 앱 응답 경로를 기다리게 하지 않는다.
exports.monitorProfileLive = functions.region(REGION).database.instance("quickpilot-39d72-default-rtdb")
  .ref("/v1/users/{uid}/profile").onWrite(async (change, ctx) => {
    const value = change.after.exists() ? change.after.val() : {};
    await db.ref(MONITOR_INPUT_PATH + "/" + ctx.params.uid + "/profile").set(Object.assign(
      monitorProfileInput(value),
      { updatedAt: Date.now() }
    ));
    return null;
  });

exports.monitorVersionLive = functions.region(REGION).database.instance("quickpilot-39d72-default-rtdb")
  .ref("/v1/users/{uid}/app_version").onWrite(async (change, ctx) => {
    await db.ref(MONITOR_INPUT_PATH + "/" + ctx.params.uid + "/version").set({
      value: String(change.after.exists() ? (change.after.val() || "") : ""),
      updatedAt: Date.now(),
    });
    return null;
  });

exports.monitorCrashLive = functions.region(REGION).database.instance("quickpilot-39d72-default-rtdb")
  .ref("/v1/users/{uid}/crash_logs/{crashId}").onCreate(async (snap, ctx) => {
    const now = Date.now();
    const value = snap.val() || {};
    const ts = Number(value.ts || ctx.params.crashId) || now;
    const date = kstDate(now);
    const eventKey = String(ctx.params.crashId).replace(/[.#$/\[\]]/g, "_");
    const crashRef = db.ref(MONITOR_INPUT_PATH + "/" + ctx.params.uid + "/crash");
    const [cachedSnap, summarySnap] = await Promise.all([
      crashRef.once("value"),
      db.ref("v1/app/monitor_summary/" + ctx.params.uid).once("value"),
    ]);
    const cached = cachedSnap.val() || {};
    const summary = summarySnap.val() || {};
    const summaryCount = Number(summary.lastCrashTs) >= dayStartMs(now) ? (Number(summary.crCnt) || 0) : 0;
    const baseline = String(cached.date || "") === date ? Math.max(Number(cached.count) || 0, summaryCount) : summaryCount;

    await crashRef.transaction(current => applyMonitorCrashEvent(current, {
      date,
      eventDate: kstDate(ts),
      eventKey,
      ts,
      now,
      baseline,
      summaryLastTs: Number(summary.lastCrashTs) || 0,
    }));
    return null;
  });

// ===== 데이터 탭 (앱) — 전날 기준 전체 집계 + 본인 운행. server.html(통계 페이지)과 같은 그림. =====
// 집계는 날짜별 캐시(/v1/app/data_cache/<date>) — 첫 호출 때 계산(느림), 이후 캐시. 개인 운행은 매 호출 서버 계산.
const h3 = require("h3-js");
const PAL = ["#FFF176", "#FFD54F", "#FFB300", "#FB8C00", "#F4511E", "#D32F2F"];   // 우버식 노랑→빨강
let _geoCache = null;
async function geoCache() {
  if (_geoCache) return _geoCache;
  try {
    _geoCache = require("./geo_cache.json") || {};
  } catch (e) {
    try {
      const r = await fetch("https://quickpilot-39d72.web.app/geo_cache.json");
      _geoCache = (await r.json()) || {};
    } catch (e2) {
      _geoCache = {};
    }
  }
  return _geoCache;
}
// 토큰이 캐시에 정확히 없으면, 캐시에 있는 동으로 "끝나는" 가장 긴 동을 찾아 좌표 반환(앞 군더더기 제거: "1박스기안동"→"기안동").
function resolveGeo(tok, cache) {
  if (cache[tok] && cache[tok].lat) return cache[tok];
  for (let i = 1; i < tok.length - 1; i++) { const suf = tok.slice(i); if (cache[suf] && cache[suf].lat) return cache[suf]; }
  return null;
}
// 출발지 동 파싱 — server.html parseOrigin과 동일 규칙(geo_cache 키와 매칭).
function parseOrigin(r) {
  const p = r.platform || "", raw = r.raw_text || ""; let og = r.origin || ""; let t;
  if (/인성/.test(p)) { const m = /@([^|/]+)/.exec(og) || /@([^|/]+)/.exec(raw); t = m ? m[1] : og.replace(/[*]+/g, "").replace(/\//g, " "); }
  else { t = og.split("/")[0]; }
  t = (t || "").split(")").pop().replace(/^\s*\d{1,2}:\d{2}\s*/, "").replace(/^\s*\d{1,2}시\s*/, "").replace(/[.\s]+$/, "").trim();
  if (!t || !/(동|읍|면|리|가)$/.test(t)) return null;
  return t;
}
const dateKey = (y, mo, d) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

async function computeAggregate(y, mo, d, readMetrics) {
  const ds = dateKey(y, mo, d);
  const dayStart = Date.UTC(y, mo - 1, d) - 9 * 3600000, dayEnd = dayStart + 86400000;
  const uids = await listUids();
  const hours = new Array(24).fill(0);
  const plat = {}, originCnt = {}; let totalOrd = 0, activeUsers = 0;
  const allSigs = new Set();         // 유저 교차 중복제거 — 같은 콜을 여러 유저가 감지해도 시장 distinct는 1
  await Promise.all(uids.map(async uid => {
    try {
      const arr = dedupBySig(Object.values((await db.ref("v1/users/" + uid + "/orders/" + ds).once("value")).val() || {}));   // 유저별 sig 중복제거(전환기 이중키·재팝 흡수)
      if (readMetrics) readMetrics.ordersReadCount = (readMetrics.ordersReadCount || 0) + arr.length;
      if (arr.length) activeUsers++;
      arr.forEach(r => {
        const t = Number(r.detected_at) || 0; if (t) hours[new Date(t + 9 * 3600000).getUTCHours()]++;
        const pf = (r.platform || "기타").replace("통합콜", "통합"); plat[pf] = (plat[pf] || 0) + 1; totalOrd++;
        const og = parseOrigin(r); if (og) originCnt[og] = (originCnt[og] || 0) + 1;
        if (r.signature) allSigs.add(r.signature);
      });
    } catch (e) {}
  }));
  const distinctCalls = allSigs.size;   // 시장 distinct 콜(유저 교차·정확 재팝 제거). 금액인상 재등록은 별개 콜로 남음(정직 한계).
  // 육각 분포(자동배차 감지) — 출발지 동→좌표→H3 res6 셀별 건수
  const cache = await geoCache();
  const cells = new Map();
  Object.entries(originCnt).forEach(([tok, n]) => {
    const c = resolveGeo(tok, cache);
    if (c && c.lat) { const h = h3.latLngToCell(c.lat, c.lng, 6); let cell = cells.get(h); if (!cell) { cell = { n: 0, top: "", topN: 0 }; cells.set(h, cell); } cell.n += n; if (n > cell.topN) { cell.topN = n; cell.top = tok; } }
  });
  const maxN = cells.size ? Math.max(...[...cells.values()].map(c => c.n)) : 1;
  const hex = [...cells.entries()].sort((a, b) => a[1].n - b[1].n).map(([h, c]) => {
    const idx = Math.min(PAL.length - 1, Math.floor(Math.sqrt(c.n / maxN) * PAL.length));
    return { boundary: h3.cellToBoundary(h), count: c.n, area: c.top, color: PAL[idx] };
  });
  // 히트맵 — GPS 격자(0.03°) 밀도값
  const CELL = 0.03;
  const bk0 = Math.floor(dayStart / 86400000), bk1 = Math.floor((dayEnd - 1) / 86400000);
  const grid = new Map();
  await Promise.all(uids.map(async uid => {
    for (let bk = bk0; bk <= bk1; bk++) {
      try {
        const o = (await db.ref("v1/users/" + uid + "/gps_track/main/" + bk).once("value")).val();
        if (!o) continue;
        if (readMetrics) readMetrics.gpsReadCount = (readMetrics.gpsReadCount || 0) + Object.keys(o).length;
        Object.values(o).forEach(pt => {
          const t = Number(pt && pt.ts) || 0, la = Number(pt && pt.lat), ln = Number(pt && pt.lng);
          if (t >= dayStart && t < dayEnd && la && ln && la > 33 && la < 39 && ln > 124 && ln < 131) {
            const k = Math.round(la / CELL) + "," + Math.round(ln / CELL);
            grid.set(k, (grid.get(k) || 0) + 1);
          }
        });
      } catch (e) {}
    }
  }));
  const counts = [...grid.values()].sort((a, b) => a - b);
  const p90 = counts.length ? counts[Math.floor(counts.length * 0.9)] : 0;
  const heat = []; grid.forEach((v, k) => { const a = k.split(",").map(Number); heat.push({ lat: a[0] * CELL, lng: a[1] * CELL, w: v }); });
  const heatMax = p90 ? Math.round(p90 * 0.73) : 340;
  const platform = { "인성": plat["인성"] || 0, "통합": plat["통합"] || 0, "카카오": plat["카카오"] || 0, "기타": 0 };
  Object.keys(plat).forEach(k => { if (!["인성", "통합", "카카오"].includes(k)) platform["기타"] += plat[k]; });
  return { orders: { total: totalOrd, distinctCalls, activeUsers, avgPerUser: activeUsers ? +(totalOrd / activeUsers).toFixed(1) : 0, platform }, hourly: hours, hex, heat, heatMax };
}

const DATA_CACHE_BUILD_LEASE_MS = 120000;
const DATA_CACHE_BUILD_WAIT_MS = 240000;
const DATA_CACHE_BUILD_POLL_MS = 1000;

function dataCacheBuildClaim(current, now, token) {
  const active = current && typeof current === "object" ? current : {};
  const activeToken = String(active.token || "");
  const activeUntil = Number(active.expiresAt) || 0;
  if (activeToken && activeToken !== token && activeUntil > now) return;
  return {
    token,
    startedAt: activeToken === token ? (Number(active.startedAt) || now) : now,
    expiresAt: now + DATA_CACHE_BUILD_LEASE_MS,
  };
}

function waitForDataCache(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readCachedAggregate(cacheRef) {
  return (await cacheRef.child("aggregate").once("value")).val() || null;
}

async function releaseDataCacheBuild(lockRef, token) {
  await lockRef.transaction(current => {
    if (String(current && current.token || "") !== token) return;
    return null;
  }).catch(() => {});
}

async function getOrBuildDataAggregate(date, y, mo, d, readMetrics) {
  const cacheRef = db.ref("v1/app/data_cache/" + date);
  const cached = await readCachedAggregate(cacheRef);
  if (cached) return { aggregate: cached, cacheStatus: "hit" };

  const lockRef = db.ref("v1/app/data_cache_build/" + date);
  const token = [Date.now(), process.pid, Math.random().toString(36).slice(2)].join("_");
  const deadline = Date.now() + DATA_CACHE_BUILD_WAIT_MS;

  while (Date.now() < deadline) {
    const claimNow = Date.now();
    const claim = await lockRef.transaction(current => dataCacheBuildClaim(current, claimNow, token));
    const lock = claim.snapshot.val() || {};
    if (claim.committed && String(lock.token || "") === token) {
      try {
        const cachedAfterClaim = await readCachedAggregate(cacheRef);
        if (cachedAfterClaim) return { aggregate: cachedAfterClaim, cacheStatus: "hit_after_claim" };
        const aggregate = await computeAggregate(y, mo, d, readMetrics);
        await cacheRef.set({ aggregate, builtAt: Date.now() });
        return { aggregate, cacheStatus: "new" };
      } finally {
        await releaseDataCacheBuild(lockRef, token);
      }
    }

    await waitForDataCache(DATA_CACHE_BUILD_POLL_MS);
    const builtByOtherRequest = await readCachedAggregate(cacheRef);
    if (builtByOtherRequest) return { aggregate: builtByOtherRequest, cacheStatus: "wait_hit" };
  }

  const cachedAfterWait = await readCachedAggregate(cacheRef);
  if (cachedAfterWait) return { aggregate: cachedAfterWait, cacheStatus: "wait_hit" };
  throw new functions.https.HttpsError("unavailable", "날짜별 데이터 준비가 지연되고 있습니다. 잠시 후 다시 시도해 주세요.");
}

// 개인 운행 — monitor-all loadDetail과 동일 산식(작업 윈도우·속도적분·트립시간). 서버값으로 통일.
function roundCoord(x) {
  return Math.round(Number(x) * 1e5) / 1e5;
}

const DAILY_DRIVE_GPS_SOURCE = "secondary_first_v1";
const DRIVE_MAX_CONTIGUOUS_GAP_MS = 90000;
const DRIVE_MAX_CONTIGUOUS_SEGMENT_M = 5000;
const DRIVE_MAX_PLAUSIBLE_SPEED_MPS = 50; // 180km/h

function driveSegmentBreak(previous, current) {
  const fromTs = Number(previous && previous.ts) || 0;
  const toTs = Number(current && current.ts) || 0;
  const dt = toTs - fromTs;
  const fromLat = Number(previous && previous.lat), fromLng = Number(previous && previous.lng);
  const toLat = Number(current && current.lat), toLng = Number(current && current.lng);
  if (dt <= 0 || dt > DRIVE_MAX_CONTIGUOUS_GAP_MS) return true;
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) return true;
  const distanceM = haversineM(fromLat, fromLng, toLat, toLng);
  return distanceM >= DRIVE_MAX_CONTIGUOUS_SEGMENT_M || distanceM / (dt / 1000) > DRIVE_MAX_PLAUSIBLE_SPEED_MPS;
}

function driveOperationSignal(status) {
  const value = status && typeof status === "object" ? status : {};
  const ts = Number(value.ts) || 0;
  const inactive = value.ui_session_active === false || value.dispatch_on === false || value.stage === "closed";
  const active = value.dispatch_on === true && value.ui_session_active !== false && value.stage !== "closed";
  return { ts, inactive, active };
}

function computeDriveOperation(points, now, status, allowLiveOperation) {
  const ordered = (points || []).filter(Boolean).slice().sort((a, b) => Number(a.ts) - Number(b.ts));
  const sessionEvidenceKnown = ordered.length > 1 && ordered.every(o =>
    Object.prototype.hasOwnProperty.call(o, "ui_session_active") &&
    Object.prototype.hasOwnProperty.call(o, "dispatch_active")
  );
  let completedMs = 0;
  let candidateStartMs = 0;
  let candidateMovingKm = 0;

  function active(o) {
    return !!o && (o.ui_session_active === true || o.ui_session_active === 1 || o.ui_session_active === "true") &&
      (o.dispatch_active === true || o.dispatch_active === 1 || o.dispatch_active === "true");
  }
  function moving(o) {
    if (!o || o.is_stop) return false;
    const speed = o.speed_kmh == null ? null : Number(o.speed_kmh);
    return speed == null ? true : Number.isFinite(speed) && speed > 3 && speed <= 180;
  }
  function close(endMs) {
    if (candidateStartMs > 0 && candidateMovingKm >= 1) {
      completedMs += Math.max(0, Number(endMs) - candidateStartMs);
    }
    candidateStartMs = 0;
    candidateMovingKm = 0;
  }

  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1], current = ordered[i];
    const previousActive = active(previous), currentActive = active(current);
    if (previousActive && currentActive) {
      const validMovingSegment = !driveSegmentBreak(previous, current) && moving(previous) && moving(current);
      if (validMovingSegment) {
        const segmentKm = haversineM(Number(previous.lat), Number(previous.lng), Number(current.lat), Number(current.lng)) / 1000;
        if (Number.isFinite(segmentKm) && segmentKm > 0) {
          if (!candidateStartMs) candidateStartMs = Number(previous.ts) || 0;
          candidateMovingKm += segmentKm;
        }
      }
    } else if (candidateStartMs) {
      close(previousActive ? Number(current.ts) : Number(previous.ts));
    }
  }

  const last = ordered[ordered.length - 1] || null;
  const signal = driveOperationSignal(status);
  if (candidateStartMs && signal.inactive && signal.ts > Number(last && last.ts || 0)) {
    close(signal.ts);
  } else if (candidateStartMs && !active(last)) {
    close(Number(last && last.ts || 0));
  }
  const activeStartMs = allowLiveOperation && candidateStartMs > 0 && candidateMovingKm >= 1 ? candidateStartMs : 0;
  const operationMs = completedMs + (activeStartMs > 0 ? Math.max(0, now - activeStartMs) : 0);
  return {
    operationKnown: sessionEvidenceKnown && operationMs > 0,
    operationCompletedMs: completedMs,
    activeOperationStartMs: activeStartMs,
    operationMin: Math.floor(operationMs / 60000),
  };
}

function normalizeDailyDrive(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    km: Number(raw.km) || 0,
    durMin: Number(raw.durMin) || 0,
    trackedMin: Number(raw.trackedMin) || 0,
    driveMin: Number(raw.driveMin) || 0,
    orderWindowMin: Number(raw.orderWindowMin) || 0,
    driveEligibilityKnown: raw.driveEligibilityKnown === true,
    eligiblePointCount: Number(raw.eligiblePointCount) || 0,
    runPct: Number(raw.runPct) || 0,
    workStartMs: Number(raw.workStartMs) || 0,
    workEndMs: Number(raw.workEndMs) || 0,
    route: Array.isArray(raw.route) ? raw.route : [],
    rawPointCount: Number(raw.rawPointCount) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    source: raw.source || "daily_drive",
    summaryVersion: raw.summaryVersion || "daily_drive_v1",
    gpsSource: raw.gpsSource || "",
    operationDefinition: raw.operationDefinition || "",
    operationKnown: raw.operationKnown === true,
    operationCompletedMs: Number(raw.operationCompletedMs) || 0,
    activeOperationStartMs: Number(raw.activeOperationStartMs) || 0,
  };
}

function compressDriveRoute(points) {
  const out = [];
  let lastSelected = null, previousRaw = null;
  function append(point, breakBefore) {
    const t = Number(point && point.ts) || 0;
    const lat = Number(point && point.lat), lng = Number(point && point.lng);
    if (!t || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const previous = out[out.length - 1];
    if (previous && previous[2] === t) {
      if (breakBefore) previous[3] = true;
      lastSelected = point;
      return;
    }
    out.push([roundCoord(lat), roundCoord(lng), t, !!breakBefore]);
    lastSelected = point;
  }
  for (const o of points || []) {
    const t = Number(o && o.ts) || 0;
    const lat = Number(o && o.lat);
    const lng = Number(o && o.lng);
    if (!t || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (previousRaw && driveSegmentBreak(previousRaw, o)) {
      append(previousRaw, false); // 점선이 정확히 끊긴 마지막 점에서 시작하게 보존
      append(o, true);
    } else {
      const farEnough = !lastSelected || haversineM(lastSelected.lat, lastSelected.lng, lat, lng) >= 180;
      const oldEnough = !lastSelected || t - Number(lastSelected.ts) >= 120000;
      if (!lastSelected || farEnough || oldEnough) append(o, false);
    }
    previousRaw = o;
  }
  if (previousRaw) append(previousRaw, false);
  if (out.length <= 600) return out;
  const step = Math.ceil(out.length / 600);
  // 다운샘플해도 점선 양 끝은 반드시 남긴다. 나머지는 같은 연결 구간 안의 단순 축약이다.
  return out.filter((point, i) =>
    i === 0 || i === out.length - 1 || point[3] === true ||
    (i + 1 < out.length && out[i + 1][3] === true) || i % step === 0
  );
}

async function computePersonal(uid, y, mo, d, readMetrics) {
  const ds = dateKey(y, mo, d);
  const dayStart = Date.UTC(y, mo - 1, d) - 9 * 3600000, dayEnd = dayStart + 86400000;
  const driveRef = db.ref("v1/users/" + uid + "/daily_drive/" + ds);
  const isToday = ds === kstDate(Date.now());
  let driveStatus = {};
  try {
    const [cachedSnap, statusSnap] = await Promise.all([
      driveRef.once("value"),
      db.ref("v1/users/" + uid + "/status").once("value"),
    ]);
    const cachedDrive = normalizeDailyDrive(cachedSnap.val());
    driveStatus = statusSnap.val() || {};
    const trustedEmpty = !(cachedDrive && cachedDrive.source === "gps_raw_empty" && cachedDrive.rawPointCount === 0) ||
      cachedDrive.gpsSource === DAILY_DRIVE_GPS_SOURCE;
    const signal = driveOperationSignal(driveStatus);
    if (cachedDrive && cachedDrive.summaryVersion === "daily_drive_v4" &&
      cachedDrive.activeOperationStartMs > 0 && signal.inactive && signal.ts > cachedDrive.activeOperationStartMs) {
      cachedDrive.operationCompletedMs += signal.ts - cachedDrive.activeOperationStartMs;
      cachedDrive.activeOperationStartMs = 0;
      cachedDrive.operationMin = Math.floor(cachedDrive.operationCompletedMs / 60000);
      cachedDrive.driveMin = cachedDrive.operationMin;
      cachedDrive.trackedMin = cachedDrive.operationMin;
      cachedDrive.operationKnown = cachedDrive.operationCompletedMs > 0;
      cachedDrive.updatedAt = signal.ts;
      try { await driveRef.set(cachedDrive); } catch (e) {}
      if (readMetrics) readMetrics.cache = readMetrics.cache || "daily_drive_closed_signal";
      return cachedDrive;
    }
    const statusStartedAfterCache = isToday && signal.active && signal.ts > Number(cachedDrive && cachedDrive.updatedAt || 0) &&
      !(cachedDrive && cachedDrive.activeOperationStartMs > 0);
    if (cachedDrive && trustedEmpty && cachedDrive.summaryVersion === "daily_drive_v4" &&
      !statusStartedAfterCache && (!isToday || cachedDrive.updatedAt >= Date.now() - 10 * 60000)) {
      if (readMetrics) readMetrics.cache = readMetrics.cache || "daily_drive_hit";
      return cachedDrive;
    }
  } catch (e) {}
  const bk0 = Math.floor(dayStart / 86400000), bk1 = Math.floor((dayEnd - 1) / 86400000);
  let gps = {}, orders = {};
  async function readGpsRole(role) {
    let out = {};
    const reads = [];
    for (let bk = bk0; bk <= bk1; bk++) reads.push(db.ref("v1/users/" + uid + "/gps_track/" + role + "/" + bk).once("value"));
    const snaps = await Promise.all(reads);
    snaps.forEach(s => { out = Object.assign(out, s.val() || {}); });
    if (readMetrics) readMetrics.gpsReadCount = (readMetrics.gpsReadCount || 0) + Object.keys(out).length;
    return out;
  }
  let gpsRole = "secondary";
  try {
    gps = await readGpsRole("secondary");
    if (!Object.keys(gps).length) {
      gpsRole = "main_fallback";
      gps = await readGpsRole("main");
    }
    orders = (await db.ref("v1/users/" + uid + "/orders/" + ds).once("value")).val() || {};
  } catch (e) {}
  const inWin = Object.values(gps).filter(o => o && o.ts && Number(o.ts) >= dayStart && Number(o.ts) < dayEnd && (o.accuracy_m == null || Number(o.accuracy_m) < 30));
  const sec = inWin.filter(o => o.device === "second");
  const gv = (sec.length ? sec : inWin).sort((a, b) => a.ts - b.ts);
  const gTotal = gv.length;
  const now = Date.now();
  const orderRows = Object.values(orders || {}).filter(o => {
    if (!o || Number(o.accepted_at) <= 0) return false;
    const status = String(o.status || "");
    return status !== "detected" && status !== "cancelled" &&
      Number(o.is_test || 0) === 0 && Number(o.hidden || 0) === 0 && Number(o.server_hidden || 0) === 0;
  });
  const acceptedTimes = orderRows.map(o => Number(o.accepted_at) || 0).filter(t => t > 0);
  const deliveredTimes = orderRows.map(o => Number(o.delivered_at) || 0).filter(t => t > 0);
  const workStart = acceptedTimes.length ? Math.min(...acceptedTimes) : 0;
  const lastDelivered = deliveredTimes.length ? Math.max(...deliveredTimes) : 0;
  const hasActive = orderRows.some(o =>
    Number(o.delivered_at || 0) <= 0 && ["accepted", "picking_up"].includes(String(o.status || ""))
  );
  const workEnd = isToday && hasActive && now > workStart ? now : (lastDelivered > workStart ? lastDelivered : 0);
  const orderWindowMs = workStart > 0 && workEnd > workStart ? workEnd - workStart : 0;
  if (!gTotal) {
    const orderWindowMin = Math.round(orderWindowMs / 60000);
    const emptySummary = { km: 0, durMin: orderWindowMin, trackedMin: 0, driveMin: 0, orderWindowMin, driveEligibilityKnown: true, eligiblePointCount: 0, runPct: 0, workStartMs: workStart, workEndMs: workEnd, route: [], rawPointCount: 0, source: "gps_raw_empty", summaryVersion: "daily_drive_v4", gpsSource: DAILY_DRIVE_GPS_SOURCE, gpsRole, operationDefinition: "session_dispatch_1km_v2", operationKnown: false, operationCompletedMs: 0, activeOperationStartMs: 0, updatedAt: Date.now() };
    if (!isToday) {
      try { await driveRef.set(emptySummary); } catch (e) {}
    }
    return emptySummary;
  }
  const explicitEligibility = o => Object.prototype.hasOwnProperty.call(o || {}, "drive_eligible");
  const eligible = o => o && (o.drive_eligible === true || o.drive_eligible === 1 || o.drive_eligible === "true");
  const moving = o => {
    if (!o || o.is_stop) return false;
    const sp = o.speed_kmh != null ? Number(o.speed_kmh) : null;
    return sp == null ? true : Number.isFinite(sp) && sp > 3 && sp <= 180;
  };
  const driveEligibilityKnown = gv.every(explicitEligibility);
  const eligiblePointCount = gv.filter(eligible).length;
  let distM = 0, driveMs = 0, prev = null;
  gv.forEach(o => {
    const t = Number(o.ts);
    const sp = o.speed_kmh != null ? Number(o.speed_kmh) : null;
    if (prev) {
      const dt = t - Number(prev.ts);
      if (!driveSegmentBreak(prev, o)) {
        if (sp != null) {
          if (moving(prev) && moving(o)) distM += sp / 3.6 * (dt / 1000);
        } else if (o.lat && o.lng && prev.lat && prev.lng) {
          const dseg = haversineM(prev.lat, prev.lng, o.lat, o.lng);
          if (moving(prev) && moving(o)) distM += dseg;
        }
        if (eligible(prev) && eligible(o)) driveMs += dt;
      }
    }
    prev = o;
  });
  const operation = computeDriveOperation(gv, now, isToday ? driveStatus : null, isToday);
  const driveMin = operation.operationMin;
  const orderWindowMin = Math.round(orderWindowMs / 60000);
  const runPct = driveEligibilityKnown && orderWindowMin ? Math.min(100, Math.round(driveMin / orderWindowMin * 100)) : 0;
  const summary = {
    km: +(distM / 1000).toFixed(1),
    durMin: orderWindowMin,
    trackedMin: driveMin,
    driveMin,
    orderWindowMin,
    driveEligibilityKnown,
    eligiblePointCount,
    runPct,
    workStartMs: workStart,
    workEndMs: workEnd,
    route: compressDriveRoute(gv),
    rawPointCount: gTotal,
    source: "gps_raw_full",
    summaryVersion: "daily_drive_v4",
    gpsSource: DAILY_DRIVE_GPS_SOURCE,
    gpsRole,
    operationDefinition: "session_dispatch_1km_v2",
    operationKnown: operation.operationKnown,
    operationCompletedMs: operation.operationCompletedMs,
    activeOperationStartMs: operation.activeOperationStartMs,
    updatedAt: Date.now(),
  };
  try { await driveRef.set(summary); } catch (e) {}
  return summary;
}

// onCall(callable) — 앱은 getHttpsCallable("dataTab").call({date}). uid는 인증 컨텍스트에서(개인=호출자 본인).
// data.uid 폴백은 디버그/미인증 호출용. 반환 객체가 클라이언트 result.data 로 옴.
exports.dataTab = functions.region(REGION).runWith({ timeoutSeconds: 300, memory: "512MB" }).https.onCall(async (data, context) => {
  const started = Date.now();
  const date = String((data && data.date) || "");
  const uid = (context && context.auth && context.auth.uid) || (data && data.uid) || "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new functions.https.HttpsError("invalid-argument", "date=YYYY-MM-DD 필요");
  const y = +m[1], mo = +m[2], d = +m[3];
  const n = Date.now(), todayKstStart = n - ((n + 9 * 3600000) % 86400000);
  const readMetrics = { ordersReadCount: 0, gpsReadCount: 0 };
  // 6/9 — 오늘은 전체 집계(aggregate, 전 기사 무거움)만 미집계. 본인 운행(personal.drive)은 라이브로 계산해 반환(앱 데이터탭 실시간 표시).
  if (Date.UTC(y, mo - 1, d) - 9 * 3600000 >= todayKstStart) {
    const personal = uid ? { drive: await computePersonal(uid, y, mo, d, readMetrics) } : null;
    qpBillingLog("dataTab", {
      readDate: date,
      ordersReadCount: readMetrics.ordersReadCount || 0,
      gpsReadCount: readMetrics.gpsReadCount || 0,
      cache: readMetrics.cache || "today_personal",
      durationMs: Date.now() - started,
    });
    return { date, available: false, reason: "오늘은 집계 전(전날까지 조회)", personal };
  }
  const aggregateResult = await getOrBuildDataAggregate(date, y, mo, d, readMetrics);
  const aggregate = aggregateResult.aggregate;
  const cacheStatus = aggregateResult.cacheStatus;
  const personal = uid ? { drive: await computePersonal(uid, y, mo, d, readMetrics) } : null;
  const available = (aggregate.orders.total > 0) || (aggregate.heat && aggregate.heat.length > 0);
  qpBillingLog("dataTab", {
    readDate: date,
    ordersReadCount: readMetrics.ordersReadCount || 0,
    gpsReadCount: readMetrics.gpsReadCount || 0,
    cache: cacheStatus,
    personalCache: readMetrics.cache || "computed",
    durationMs: Date.now() - started,
  });
  return { date, available, aggregate, personal };
});

// ===== data_live — 숫자류 라이브 증분(인원 무관·오더 건수에만 비례). 앱은 v1/app/data_live/<date>만 구독. =====
// 중복키 = 출발동|도착동|감지시점 2시간버킷 → 가격인상 재등록·유저 교차 동시감지 모두 1콜로. (확정 무관)
// 내부 판정맵은 v1/app/data_live_seen/<date>(앱 미구독)에 분리 — 라이브 노드 가볍게 유지.
function liveKeyParts(r) {
  const detected = Number(r.detected_at) || 0; if (!detected) return null;
  const od = parseOrigin(r); const dd = (r.signature || "").split("|")[1] || "";
  if (!od || !dd) return null;
  const key = (od + "|" + dd).replace(/[.#$\[\]\/]/g, "_");   // 중복키 = 출발동+도착동 (시간·금액 요소 없음). 날짜별 노드라 하루 단위 자동 구분.
  const pf = (r.platform || "기타").replace("통합콜", "통합");
  const pfk = ["인성", "통합", "카카오"].includes(pf) ? pf : "기타";
  const hour = new Date(detected + 9 * 3600000).getUTCHours();
  // source: 필드 있으면 그대로, 없으면 raw_text로 소급(ACTION 시작=직클릭, 그 외=자동배차). 오더 행은 안 고침(집계에서만 도출).
  const source = (r.source === "auto" || r.source === "user_click" || r.source === "kakao") ? r.source : (/^ACTION/.test(r.raw_text || "") ? "user_click" : "auto");
  return { key, pfk, hour, agency: r.agency || "", source };
}

async function computeDataLive(y, mo, d) {
  const ds = dateKey(y, mo, d);
  const uids = await listUids();
  const seen = {};   // key -> {pfk,hour,agency,source}
  const users = new Set();   // 그날 기여(유효 오더 1건+) distinct uid
  await Promise.all(uids.map(async uid => {
    try {
      const arr = Object.values((await db.ref("v1/users/" + uid + "/orders/" + ds).once("value")).val() || {}).filter(Boolean);
      arr.forEach(r => {
        const p = liveKeyParts(r); if (!p) return;
        users.add(uid);
        let e = seen[p.key];
        if (!e) { seen[p.key] = { pfk: p.pfk, hour: p.hour, agency: p.agency, source: p.source }; }
        else { if (!e.agency && p.agency) e.agency = p.agency; if (e.source !== "auto" && p.source === "auto") e.source = "auto"; if (!e.source && p.source) e.source = p.source; }
      });
    } catch (e) {}
  }));
  const live = { total: 0, activeUsers: users.size, platform: { "인성": 0, "통합": 0, "카카오": 0, "기타": 0 }, hourly: {}, agencies: {}, bySource: { auto: 0, user_click: 0, kakao: 0 }, updatedAt: Date.now() };
  for (let h = 0; h < 24; h++) live.hourly[h] = 0;
  const seenWrite = {};
  Object.entries(seen).forEach(([k, e]) => {
    live.total++; live.platform[e.pfk]++; live.hourly[e.hour]++;
    if (e.agency) live.agencies[e.agency] = (live.agencies[e.agency] || 0) + 1;
    if (e.source) live.bySource[e.source]++;
    seenWrite[k] = { c: 1, a: e.agency ? 1 : 0 };
  });
  const usersWrite = {}; users.forEach(u => { usersWrite[u] = 1; });
  return { live, seenWrite, usersWrite };
}

// 백필/시드 + 검증용 — 한 날짜를 기존 orders로 data_live 재계산해 기록. onWrite 누락분 복구·과거 시드.
exports.dataLiveBackfill = functions.region(REGION).runWith({ timeoutSeconds: 300, memory: "512MB" }).https.onRequest(async (req, res) => {
  const date = String(req.query.date || "");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) { res.status(400).json({ error: "date=YYYY-MM-DD" }); return; }
  try {
    const { live, seenWrite, usersWrite } = await computeDataLive(+m[1], +m[2], +m[3]);
    await db.ref("v1/app/data_live/" + date).set(live);
    await db.ref("v1/app/data_live_seen/" + date).set(Object.assign({}, seenWrite, { _users: usersWrite }));
    res.json({ ok: true, total: live.total, activeUsers: live.activeUsers, platform: live.platform, agencies: Object.keys(live.agencies).length, bySource: live.bySource });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});

// ===== 주선사 과거 정리 — 캡처 기록(window_dumps)에서 주선사+출발동+도착동 추출·중복제거(시간·금액 無). 읽기 전용 반환(쓰기는 검증 후 별도). =====
function dongFrom(t) { t = String(t || ""); const m = /@[^\/|]*?([가-힣]+(동|읍|면|리|가))/.exec(t) || /([가-힣]+(동|읍|면|리|가))/.exec(t); return m ? m[1] : ""; }
exports.agencyScan = functions.region(REGION).runWith({ timeoutSeconds: 540, memory: "1GB" }).https.onRequest(async (req, res) => {
  const bucket = String(req.query.bucket || "");
  if (!/^\d+$/.test(bucket)) { res.status(400).json({ error: "bucket=epoch-day 숫자 필요" }); return; }
  try {
    const uids = await listUids();
    const seen = new Set();          // 전 유저 교차 dedup: 주선사|출발동|도착동
    const byAg = {};                 // phone -> {name, n}
    let frames = 0, centerFrames = 0;
    for (const uid of uids) {         // 순차 처리(메모리 바운드 — 한 유저 버킷씩)
      let o = null;
      try { o = (await db.ref("v1/users/" + uid + "/window_dumps/" + bucket).once("value")).val(); } catch (e) {}
      if (!o) continue;
      for (const k in o) {
        const x = o[k]; if (!x) continue; frames++;
        if (!/q_tvCenter|kor_tvCenter/.test(x.all_view_ids || "")) continue;
        const t = x.all_texts || "";
        const am = /^([^|\[]+)\[([0-9\-]+)\]/.exec(t.trim()); if (!am) continue;
        const phone = am[2].replace(/-/g, ""); const name = am[1].trim();
        const om = /출발지\s*\|\s*([^|]+)/.exec(t), dm = /도착지\s*\|\s*([^|]+)/.exec(t);
        const od = dongFrom(om && om[1]), dd = dongFrom(dm && dm[1]);
        if (!od || !dd) continue;
        centerFrames++;
        const key = phone + "|" + od + "|" + dd;
        if (seen.has(key)) continue; seen.add(key);
        if (!byAg[phone]) byAg[phone] = { name, n: 0 }; byAg[phone].n++;
      }
      o = null;
    }
    res.json({ bucket, frames, centerFrames, distinct: seen.size, agencies: Object.keys(byAg).length, byAg });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});

// ===== data_maps — 지도(hex·heat) 오늘만 10분 재계산·고정 노드. 과거는 dataTab. 앱은 탭 열 때/버튼 시 read. =====
// hex(출발동 H3 격자) — orders 기반(작음). dataMapsTick 증분·computeMaps 풀계산 공용.
function liveSeenOriginToken(key) {
  const raw = String(key || "").split("|")[0] || "";
  const cleaned = raw.replace(/[^0-9A-Za-z가-힣\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const toks = cleaned.split(" ");
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i].replace(/^\d{1,2}(:\d{2})?/, "").trim();
    if (/[가-힣]+(동|읍|면|리|가)$/.test(t)) return t;
  }
  return cleaned;
}
async function fillOriginCntFromLiveSeen(ds, originCnt) {
  let seen = {};
  try { seen = (await db.ref("v1/app/data_live_seen/" + ds).once("value")).val() || {}; } catch (e) {}
  Object.entries(seen).forEach(([key, v]) => {
    if (key === "_users" || !v || !v.c) return;
    const tok = liveSeenOriginToken(key);
    if (tok) originCnt[tok] = (originCnt[tok] || 0) + 1;
  });
}
async function computeHex(ds, uids, readMetrics) {
  const originCnt = {};
  await fillOriginCntFromLiveSeen(ds, originCnt);
  if (!Object.keys(originCnt).length) {
  await Promise.all(uids.map(async uid => {
    try {
      const arr = Object.values((await db.ref("v1/users/" + uid + "/orders/" + ds).once("value")).val() || {}).filter(Boolean);
      if (readMetrics) readMetrics.ordersReadCount = (readMetrics.ordersReadCount || 0) + arr.length;
      arr.forEach(r => { const og = parseOrigin(r); if (og) originCnt[og] = (originCnt[og] || 0) + 1; });
    } catch (e) {}
  }));
  }
  if (!Object.keys(originCnt).length) await fillOriginCntFromLiveSeen(ds, originCnt);
  const cache = await geoCache(); const cells = new Map();
  Object.entries(originCnt).forEach(([tok, n]) => {
    const c = resolveGeo(tok, cache);
    if (c && c.lat) { const h = h3.latLngToCell(c.lat, c.lng, 6); let cell = cells.get(h); if (!cell) { cell = { n: 0, top: "", topN: 0 }; cells.set(h, cell); } cell.n += n; if (n > cell.topN) { cell.topN = n; cell.top = tok; } }
  });
  const maxN = cells.size ? Math.max(...[...cells.values()].map(c => c.n)) : 1;
  return [...cells.entries()].sort((a, b) => a[1].n - b[1].n).map(([h, c]) => {
    const idx = Math.min(PAL.length - 1, Math.floor(Math.sqrt(c.n / maxN) * PAL.length));
    return { boundary: h3.cellToBoundary(h), count: c.n, area: c.top, color: PAL[idx] };
  });
}
async function computeMaps(y, mo, d) {
  const ds = dateKey(y, mo, d);
  const dayStart = Date.UTC(y, mo - 1, d) - 9 * 3600000, dayEnd = dayStart + 86400000;
  const uids = await listUids();
  const readMetrics = { ordersReadCount: 0, gpsReadCount: 0 };
  const hex = await computeHex(ds, uids, readMetrics);
  const CELL = 0.03; const bk0 = Math.floor(dayStart / 86400000), bk1 = Math.floor((dayEnd - 1) / 86400000); const grid = new Map();
  await Promise.all(uids.map(async uid => {
    for (let bk = bk0; bk <= bk1; bk++) {
      try {
        const o = (await db.ref("v1/users/" + uid + "/gps_track/main/" + bk).once("value")).val(); if (!o) continue;
        Object.values(o).forEach(pt => { const t = Number(pt && pt.ts) || 0, la = Number(pt && pt.lat), ln = Number(pt && pt.lng); if (t >= dayStart && t < dayEnd && la && ln && la > 33 && la < 39 && ln > 124 && ln < 131) { const k = Math.round(la / CELL) + "," + Math.round(ln / CELL); grid.set(k, (grid.get(k) || 0) + 1); } });
      } catch (e) {}
    }
  }));
  const counts = [...grid.values()].sort((a, b) => a - b); const p90 = counts.length ? counts[Math.floor(counts.length * 0.9)] : 0;
  const heat = []; grid.forEach((v, k) => { const a = k.split(",").map(Number); heat.push({ lat: a[0] * CELL, lng: a[1] * CELL, w: v }); });
  return { hex, heat, heatMax: p90 ? Math.round(p90 * 0.73) : 340 };
}
// 오늘 지도 10분 재계산(과거는 dataTab로 충분·동결). 앱은 v1/app/data_maps/<today> read + updatedAt로 "○○:○○ 기준".
async function runDataMaps() {
  const started = Date.now(), n = started, kk = new Date(n + 9 * 3600000), y = kk.getUTCFullYear(), mo = kk.getUTCMonth() + 1, d = kk.getUTCDate();
  const ds = dateKey(y, mo, d);
  const dayStart = Date.UTC(y, mo - 1, d) - 9 * 3600000, dayEnd = dayStart + 86400000;
  const uids = await listUids();
  const hex = await computeHex(ds, uids);   // [HQ#3-2 가드3] hex는 orders 풀(작음, 증분 불필요)
  // [HQ#3-2 가드1] heat는 gps 증분 — uid×버킷 커서(KST 하루=UTC 버킷2개), 신규 포인트만 read. 야간 tick이 전날 버킷 재read 안 함이 절감 본체.
  const CELL = 0.03; const bk0 = Math.floor(dayStart / 86400000), bk1 = Math.floor((dayEnd - 1) / 86400000);
  const stRef = db.ref("v1/app/data_maps_state/" + ds);
  const st = (await stRef.once("value")).val() || {};
  const grid = st.grid || {}, cur = st.cur || {};
  const CHUNK = 6;   // OOM 방지 — 동시 read 유저 수 제한(첫 실행 당일 누적분 대비). 증분 tick은 신규만이라 가벼움.
  for (let ci = 0; ci < uids.length; ci += CHUNK) {
    await Promise.all(uids.slice(ci, ci + CHUNK).map(async uid => {
      for (let bk = bk0; bk <= bk1; bk++) {
        const ck = uid + "_" + bk; const from = Number(cur[ck]) || (dayStart - 1);   // 첫 실행은 당일 0시부터(전체 버킷 read 회피)
        try {
          const snap = await db.ref("v1/users/" + uid + "/gps_track/main/" + bk).orderByKey().startAt(String(from + 1)).once("value");
          let last = from;
          snap.forEach(c => {
            const kn = Number(c.key); if (kn > last) last = kn;
            const v = c.val(); const t = Number(v && v.ts) || 0, la = Number(v && v.lat), ln = Number(v && v.lng);
            if (t >= dayStart && t < dayEnd && la && ln && la > 33 && la < 39 && ln > 124 && ln < 131) { const key = Math.round(la / CELL) + "," + Math.round(ln / CELL); grid[key] = (grid[key] || 0) + 1; }
          });
          if (last > from) cur[ck] = last;
        } catch (e) {}
      }
    }));
  }
  const gv = Object.values(grid).sort((a, b) => a - b); const p90 = gv.length ? gv[Math.floor(gv.length * 0.9)] : 0;
  const heat = Object.keys(grid).map(key => { const a = key.split(",").map(Number); return { lat: a[0] * CELL, lng: a[1] * CELL, w: grid[key] }; });
  await db.ref("v1/app/data_maps/" + ds).set({ hex, heat, heatMax: p90 ? Math.round(p90 * 0.73) : 340, updatedAt: n });
  await stRef.set({ grid, cur });   // 격자·커서 상태(전일분은 reconcile이 정리)
  console.log("dataMapsTick(증분)", ds, "hex", hex.length, "heat", heat.length, "cells", Object.keys(grid).length);
  return { ds, hex: hex.length, heat: heat.length, cells: Object.keys(grid).length };
}
exports.dataMapsTick = functions.region(REGION).runWith({ timeoutSeconds: 120, memory: "256MB" }).pubsub.schedule("every 1 hours").onRun(async () => {
  const started = Date.now(), n = started, kk = new Date(n + 9 * 3600000), y = kk.getUTCFullYear(), mo = kk.getUTCMonth() + 1, d = kk.getUTCDate();
  const ds = dateKey(y, mo, d);
  // [HQ#6 설계통합] gps read 0 — 격자는 monitorSummary가 누적(data_maps_state.grid). 여기선 grid→heat 변환 + hex(orders, 작음)만.
  const uids = await listUids();
  const readMetrics = { ordersReadCount: 0, gpsReadCount: 0 };
  const hex = await computeHex(ds, uids, readMetrics);
  const grid = (await db.ref("v1/app/data_maps_state/" + ds + "/grid").once("value")).val() || {};
  const gv = Object.values(grid).sort((a, b) => a - b); const p90 = gv.length ? gv[Math.floor(gv.length * 0.9)] : 0;
  const heat = Object.keys(grid).map(key => { const a = key.split(",").map(Number); return { lat: a[0] * 0.03, lng: a[1] * 0.03, w: grid[key] }; });
  await db.ref("v1/app/data_maps/" + ds).set({ hex, heat, heatMax: p90 ? Math.round(p90 * 0.73) : 340, updatedAt: n });
  qpBillingLog("dataMapsTick", {
    readDate: ds,
    ordersReadCount: readMetrics.ordersReadCount || 0,
    gpsReadCount: 0,
    cache: "data_live_seen_first",
    durationMs: Date.now() - started,
  });
  return null;
});
// [임시 검증] 증분 즉시 실행(?k=). 검증 후 제거 그룹(serverStatsNow·backfillCache와 함께).
exports.dataMapsNow = functions.region(REGION).runWith({ timeoutSeconds: 120, memory: "256MB" }).https.onRequest(async (req, res) => {
  if (req.query.k !== "qpmon610") { res.status(403).send("no"); return; }
  const n = Date.now(), kk = new Date(n + 9 * 3600000), ds = dateKey(kk.getUTCFullYear(), kk.getUTCMonth() + 1, kk.getUTCDate());
  const uids = await listUids();
  const hex = await computeHex(ds, uids);
  const grid = (await db.ref("v1/app/data_maps_state/" + ds + "/grid").once("value")).val() || {};
  const gv = Object.values(grid).sort((a, b) => a - b); const p90 = gv.length ? gv[Math.floor(gv.length * 0.9)] : 0;
  const heat = Object.keys(grid).map(key => { const a = key.split(",").map(Number); return { lat: a[0] * 0.03, lng: a[1] * 0.03, w: grid[key] }; });
  await db.ref("v1/app/data_maps/" + ds).set({ hex, heat, heatMax: p90 ? Math.round(p90 * 0.73) : 340, updatedAt: n });
  res.json({ ds, hex: hex.length, heat: heat.length, gridCells: Object.keys(grid).length });
});

// 서버 용량 — Cloud Monitoring storage/total_bytes 조회로 측정(루트 풀read 제거: OOM·비용 0). 주1회 갱신.
async function fetchDbBytes() {
  const tokRes = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" } });
  const tok = (await tokRes.json()).access_token;
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 6 * 3600000).toISOString();   // 최근 6시간 창에서 최신 포인트
  const filter = 'metric.type="firebasedatabase.googleapis.com/storage/total_bytes"';
  const url = "https://monitoring.googleapis.com/v3/projects/quickpilot-39d72/timeSeries"
    + "?filter=" + encodeURIComponent(filter)
    + "&interval.startTime=" + encodeURIComponent(start)
    + "&interval.endTime=" + encodeURIComponent(end);
  const res = await fetch(url, { headers: { Authorization: "Bearer " + tok } });
  const data = await res.json();
  const series = (data.timeSeries || [])[0];
  const pt = series && series.points && series.points[0];   // points[0] = 최신
  const v = pt && pt.value;
  return v ? Number(v.int64Value != null ? v.int64Value : (v.doubleValue || 0)) : 0;
}
exports.serverStatsTick = functions.region(REGION).runWith({ timeoutSeconds: 120, memory: "256MB" }).pubsub.schedule("0 0 * * 0").timeZone("Asia/Seoul").onRun(async () => {
  const bytes = await fetchDbBytes();
  const uids = await listUids();
  await db.ref("v1/app/server_stats").set({ bytes, users: uids.length, measuredAt: Date.now(), src: "monitoring" });
  console.log("server_stats(monitoring)", bytes, uids.length);
  return null;
});
// [임시 검증] Cloud Monitoring 측정 즉시 확인용(?k= 게이트). 정상 확인 후 제거 예정.
exports.serverStatsNow = functions.region(REGION).runWith({ timeoutSeconds: 120, memory: "256MB" }).https.onRequest(async (req, res) => {
  if (req.query.k !== "qpmon610") { res.status(403).send("no"); return; }
  const bytes = await fetchDbBytes();
  res.json({ bytes, gb: +(bytes / 1073741824).toFixed(3) });
});
// [임시 HQ#2-3] 과거 data_cache 1회 백필(?k=·?days=) — 과거 히트맵/분포맵 복원. 실행 후 제거 예정.
exports.backfillCache = functions.region(REGION).runWith({ timeoutSeconds: 540, memory: "1GB" }).https.onRequest(async (req, res) => {
  if (req.query.k !== "qpmon610") { res.status(403).send("no"); return; }
  const days = Math.min(Number(req.query.days) || 12, 30);
  const out = [];
  for (let i = 1; i <= days; i++) {
    const dk = kstDate(Date.now() - i * 86400000);
    const exist = (await db.ref("v1/app/data_cache/" + dk + "/aggregate").once("value")).val();
    if (exist) { out.push(dk + ":skip"); continue; }
    const dp = dk.split("-").map(Number);
    try { const built = await getOrBuildDataAggregate(dk, dp[0], dp[1], dp[2]); const agg = built.aggregate; out.push(dk + ":" + built.cacheStatus + "(heat" + (agg.heat ? agg.heat.length : 0) + ")"); }
    catch (e) { out.push(dk + ":err"); }
  }
  res.json({ days, out });
});

const SHADOW_WEEKLY_SAMPLE_SIZE = 10;
const SHADOW_SEEN_RETENTION_DAYS = 14;

async function reconcileShadowCandidate(date, uid, expectedGuard, diffs, readMetrics) {
  const now = Date.now();
  const expectedSeq = Number(expectedGuard && expectedGuard.mutationSeq) || 0;
  const guardRef = db.ref("v1/app/agg_shadow_guard/" + date + "/" + uid);
  const [ordersSnap, shadowSnap] = await Promise.all([
    db.ref("v1/users/" + uid + "/orders/" + date).once("value"),
    db.ref("v1/app/agg_shadow/" + date + "/" + uid).once("value"),
  ]);
  const orders = ordersSnap.val() || {};
  const rawStats = ordStats(orders);
  const rawLastTs = lastOrderTs(orders);
  const shadow = shadowSnap.val() || null;
  const mismatch = !shadowMatchesRaw(shadow, rawStats, rawLastTs);
  readMetrics.ordersReadCount += Object.keys(orders).length;
  if (mismatch) {
    diffs[uid] = {
      t: rawStats.cnt,
      s: Number(shadow && shadow.cnt) || 0,
      plat: JSON.stringify(sortObj((shadow && shadow.plat) || {})) === JSON.stringify(sortObj(rawStats.plat || {})) ? 1 : 0,
    };
  }

  const repairToken = "nightly:" + uid + ":" + expectedSeq + ":" + now;
  const claim = await guardRef.transaction(current => {
    const state = current == null ? (expectedGuard || {}) : current;
    if ((Number(state && state.mutationSeq) || 0) !== expectedSeq) return;
    return Object.assign({}, state || {}, { repairToken, repairStartedAt: now });
  });
  if (!claim.committed) {
    readMetrics.raceUsers += 1;
    return { uid, mismatch, repaired: false, race: true };
  }

  const seen = shadowSeenFromOrders(orders);
  const repair = {};
  repair["v1/app/agg_shadow/" + date + "/" + uid] = rawStats.cnt > 0 ? { cnt: rawStats.cnt, plat: rawStats.plat, lastTs: rawLastTs } : null;
  repair["v1/app/agg_shadow_seen/" + date + "/" + uid] = Object.keys(seen).length ? seen : null;
  await db.ref().update(repair);

  const claimedGuard = claim.snapshot.val() || {};
  const verified = await guardRef.transaction(current => {
    const state = current == null ? claimedGuard : current;
    if ((Number(state && state.mutationSeq) || 0) !== expectedSeq || String(state && state.repairToken || "") !== repairToken) return;
    const next = Object.assign({}, state || {}, {
      verified: true,
      dirty: false,
      verifiedSeq: expectedSeq,
      verifiedAt: now,
      reconciledAt: now,
    });
    delete next.repairToken;
    delete next.repairStartedAt;
    return next;
  });
  if (!verified.committed) readMetrics.raceUsers += 1;
  return { uid, mismatch, repaired: verified.committed, race: !verified.committed };
}

async function reconcileShadowCandidates(date, candidates, guards, diffs, readMetrics) {
  const results = [];
  const chunk = 8;
  for (let i = 0; i < candidates.length; i += chunk) {
    const batch = await Promise.all(candidates.slice(i, i + chunk).map(uid =>
      reconcileShadowCandidate(date, uid, guards[uid] || {}, diffs, readMetrics).catch(error => {
        readMetrics.errorUsers += 1;
        return { uid, error: String(error && error.message || error) };
      })
    ));
    results.push(...batch);
  }
  return results;
}

// Daily reconciliation reads only untrusted users. Sunday adds a rotating sample;
// a sample mismatch escalates to a full check. Historical GPS is never rebuilt here.
exports.reconcileShadow = functions.region(REGION).runWith({ timeoutSeconds: 540, memory: "512MB" }).pubsub.schedule("0 1 * * *").timeZone("Asia/Seoul").onRun(async () => {
  const started = Date.now();
  const date = kstDate(started - 86400000);
  const [guardSnap, shadowSnap, activeSnap] = await Promise.all([
    db.ref("v1/app/agg_shadow_guard/" + date).once("value"),
    db.ref("v1/app/agg_shadow/" + date).once("value"),
    db.ref("v1/app/data_live_seen/" + date + "/_users").once("value"),
  ]);
  const guards = guardSnap.val() || {};
  const shadows = shadowSnap.val() || {};
  const activeUsers = activeSnap.val() || {};
  const knownUids = [...new Set(Object.keys(guards).concat(Object.keys(shadows), Object.keys(activeUsers)))].sort();
  const untrusted = knownUids.filter(uid => !shadowGuardTrusted(guards[uid]));
  let allUids = knownUids;
  let sample = [];
  if (isWeeklyBillingRun(started)) {
    allUids = [...new Set(knownUids.concat(await listUids()))].sort();
    sample = rotatingShadowSample(allUids.filter(uid => !untrusted.includes(uid)), date, SHADOW_WEEKLY_SAMPLE_SIZE);
  }
  const candidates = [...new Set(untrusted.concat(sample))];
  const diffs = {};
  const readMetrics = { ordersReadCount: 0, gpsReadCount: 0, raceUsers: 0, errorUsers: 0 };
  const firstResults = await reconcileShadowCandidates(date, candidates, guards, diffs, readMetrics);
  const sampleSet = new Set(sample);
  const sampleMismatch = firstResults.some(result => result && sampleSet.has(result.uid) && (result.mismatch || result.race || result.error));
  let escalatedFull = false;
  if (sampleMismatch) {
    escalatedFull = true;
    const remaining = allUids.filter(uid => !candidates.includes(uid));
    await reconcileShadowCandidates(date, remaining, guards, diffs, readMetrics);
  }

  const [incHeatSnap, cacheHeatSnap] = await Promise.all([
    db.ref("v1/app/data_maps/" + date + "/heat").once("value"),
    db.ref("v1/app/data_cache/" + date + "/aggregate/heat").once("value"),
  ]);
  const incHeat = Array.isArray(incHeatSnap.val()) ? incHeatSnap.val() : [];
  const fullHeat = Array.isArray(cacheHeatSnap.val()) ? cacheHeatSnap.val() : [];
  const sumW = arr => arr.reduce((sum, point) => sum + (Number(point && point.w) || 0), 0);
  const incW = sumW(incHeat);
  const fullW = sumW(fullHeat);
  const cacheStatus = cacheHeatSnap.exists() ? "hit" : "absent_on_demand";
  const finishedAt = Date.now();
  await db.ref("v1/app/agg_shadow_recon/" + date).set({
    at: finishedAt,
    method: "dirty_plus_rotating_sample_v1",
    nDiff: Object.keys(diffs).length,
    nUsers: allUids.length,
    checkedUsers: escalatedFull ? allUids.length : candidates.length,
    untrustedUsers: untrusted.length,
    sampleUsers: sample.length,
    sampleMismatch: sampleMismatch ? 1 : 0,
    escalatedFull: escalatedFull ? 1 : 0,
    raceUsers: readMetrics.raceUsers,
    errorUsers: readMetrics.errorUsers,
    diffs,
  });
  await db.ref("v1/app/data_maps_recon/" + date).set({
    at: finishedAt,
    cacheStatus,
    incPts: incHeat.length,
    fullPts: fullHeat.length,
    incW,
    fullW,
    driftPct: fullW ? +(((incW - fullW) / fullW) * 100).toFixed(1) : null,
  });

  await db.ref("v1/app/data_maps/" + date).remove().catch(() => {});
  await db.ref("v1/app/data_maps_state/" + date).remove().catch(() => {});
  const reconOldDate = kstDate(started - 8 * 86400000);
  const seenOldDate = kstDate(started - (SHADOW_SEEN_RETENTION_DAYS + 1) * 86400000);
  await db.ref("v1/app/agg_shadow_recon/" + reconOldDate).remove().catch(() => {});
  await db.ref("v1/app/data_maps_recon/" + reconOldDate).remove().catch(() => {});
  await db.ref("v1/app/agg_shadow_seen/" + seenOldDate).remove().catch(() => {});
  await db.ref("v1/app/data_live_seen/" + seenOldDate).remove().catch(() => {});

  qpBillingLog("reconcileShadow", {
    readDate: date,
    ordersReadCount: readMetrics.ordersReadCount,
    gpsReadCount: 0,
    cache: "dirty_sample_" + cacheStatus,
    checkedUsers: escalatedFull ? allUids.length : candidates.length,
    untrustedUsers: untrusted.length,
    sampleUsers: sample.length,
    escalatedFull,
    raceUsers: readMetrics.raceUsers,
    errorUsers: readMetrics.errorUsers,
    durationMs: Date.now() - started,
  });
  console.log("reconcileShadow", date, "diffs", Object.keys(diffs).length, "checked", escalatedFull ? allUids.length : candidates.length, "/", allUids.length);
  return null;
});

// 오더 쓰기마다 증분(라이브) — race-safe 클레임(transaction)으로 유저 교차 동시감지도 1콜만.
exports.orderLive = functions.region(REGION).database.instance("quickpilot-39d72-default-rtdb")
  .ref("/v1/users/{uid}/orders/{date}/{orderId}").onWrite(async (change, ctx) => {
    const before = change.before.val();
    const after = change.after.val();
    const date = ctx.params.date;
    const uid = ctx.params.uid;
    const beforeIdentity = before ? shadowKey(before.signature, ctx.params.orderId) + "|" + String(before.platform || "기타") : "";
    const afterIdentity = after ? shadowKey(after.signature, ctx.params.orderId) + "|" + String(after.platform || "기타") : "";
    const shadowMayBeStale = !after || (before && (beforeIdentity !== afterIdentity || orderMaxTs(after) < orderMaxTs(before)));
    const shadowGuardRef = db.ref("v1/app/agg_shadow_guard/" + date + "/" + uid);
    const guardMutation = await shadowGuardRef.transaction(current => {
      const next = Object.assign({}, current || {});
      next.mutationSeq = (Number(next.mutationSeq) || 0) + 1;
      next.lastEvent = ctx.eventId;
      next.lastOrderId = ctx.params.orderId;
      next.lastWriteAt = Date.now();
      next.lastSource = String((after || before || {}).source || "");
      next.lastPlatform = String((after || before || {}).platform || "");
      next.lastStatus = String((after || before || {}).status || "");
      if (shadowMayBeStale) {
        next.verified = false;
        next.dirty = true;
        next.dirtyEvent = ctx.eventId;
        next.dirtyAt = Date.now();
      }
      return next;
    });
    const eventGuard = guardMutation.snapshot.val() || {};
    const eventMutationSeq = Number(eventGuard.mutationSeq) || 0;
    if (!after) return null;
    // [중복제거] 주선사 감지건수 cleanCount는 아래 data_live agency 클레임(콜 단위 1회) 안에서 +1 — 한 콜이 여러 기사에게 뿌려져도 1로만 센다(유저 교차 중복 제거).
    // [shadow] 감지 카운트 — liveKeyParts 게이트 앞(파싱실패 오더도 reconcile dedup엔 포함되므로 정의 일치). 별도 노드, 기존 동작 무관.
    {
      const sk = shadowKey(after.signature, ctx.params.orderId);
      const sBase = "v1/app/agg_shadow/" + date + "/" + ctx.params.uid;
      const sc = await db.ref("v1/app/agg_shadow_seen/" + date + "/" + ctx.params.uid + "/" + sk).transaction(c => c ? undefined : 1);
      if (sc.committed) {   // [HQ#2-4] cnt + plat별 cnt (dedup된 오더만)
        const pf = (after.platform || "기타").replace(/[.#$/\[\]]/g, "_");
        await db.ref(sBase).update({ cnt: admin.database.ServerValue.increment(1), ["plat/" + pf]: admin.database.ServerValue.increment(1) });
      }
      let dts = 0; ORDER_TS_FIELDS.forEach(f => { const v = Number(after[f]) || 0; if (v > dts) dts = v; });   // [HQ#3-1] lastTs = ORDER_TS_FIELDS 4종 max (lastOrderTs와 일치 — 배송중 활동판정 보존). onWrite가 상태갱신마다 발화하므로 transaction max로 누적.
      if (dts) await db.ref(sBase + "/lastTs").transaction(c => (c && c > dts) ? c : dts);
    }
    if (!shadowMayBeStale) {
      await shadowGuardRef.transaction(current => {
        const state = current == null ? eventGuard : current;
        if (!state || state.verified !== true || state.dirty === true || (Number(state.mutationSeq) || 0) !== eventMutationSeq) return;
        return Object.assign({}, state, { verifiedSeq: eventMutationSeq, verifiedAt: Date.now() });
      });
    }
    const p = liveKeyParts(after); if (!p) return null;
    const seenRef = db.ref("v1/app/data_live_seen/" + date + "/" + p.key);
    const liveRef = db.ref("v1/app/data_live/" + date);
    // 활성 유저(distinct uid) 클레임 — 유효 오더 1건+ 기여하면 1회만
    const uRes = await db.ref("v1/app/data_live_seen/" + date + "/_users/" + ctx.params.uid).transaction(cur => cur ? undefined : 1);
    if (uRes.committed) await liveRef.update({ activeUsers: admin.database.ServerValue.increment(1) });
    // 첫 카운트 클레임
    const cRes = await seenRef.child("c").transaction(cur => cur ? undefined : 1);
    if (cRes.committed) {
      const inc = admin.database.ServerValue.increment(1);
      const upd = { total: inc, ["platform/" + p.pfk]: inc, ["hourly/" + p.hour]: inc, updatedAt: Date.now() };
      if (p.source) upd["bySource/" + p.source] = inc;
      await liveRef.update(upd);
    }
    // agency 클레임(나중에 채워질 수 있어 별도)
    if (p.agency) {
      const aRes = await seenRef.child("a").transaction(cur => cur ? undefined : 1);
      if (aRes.committed) {
        await liveRef.update({ ["agencies/" + p.agency]: admin.database.ServerValue.increment(1) });
        const aph = String(p.agency).replace(/[^0-9]/g, "");   // [중복제거] 주선사 감지건수도 콜 단위 1회만(같은 콜 N명 → +1)
        if (aph) await db.ref("v1/agencies/" + aph + "/cleanCount").transaction(c => (Number(c) || 0) + 1);
      }
    }
    return null;
  });

// [6/16] 주선사 감지수(cleanCount) 자동 재집계 — data_live(orderLive가 전 유저 일별 중복제거로 누적하는 주선사별 감지) 전 날짜 합산을
// 기존 cleanCount(과거 1회 백필 base)와 비교해 더 크면 갱신(줄이지 않음). 매시간 → 모니터 열 때 최신·활발 주선사 증가.
async function recountAgencies() {
  const uids = await listUids();
  const byAg = {};   // phone -> 서로 다른 콜 수(유저 교차·재팝 중복 제거 = data_live와 동일 콜 단위). 한 콜이 N명에게 뿌려져도 1.
  const seenCall = {};   // phone -> Set(날짜|콜키) — 같은 콜 중복 제거
  for (const uid of uids) {
    let days = null;
    try { days = (await db.ref("v1/users/" + uid + "/orders").once("value")).val(); } catch (e) {}
    if (!days) continue;
    for (const d in days) {
      const o = days[d]; if (!o) continue;
      for (const k in o) {
        const r = o[k]; if (!r || !r.agency) continue;
        const ph = String(r.agency).replace(/[^0-9]/g, ""); if (!ph) continue;
        const p = liveKeyParts(r); const ck = d + "|" + (p ? p.key : ("_n_" + uid + "_" + k));   // 라이브와 동일 콜키(파싱 실패분은 노드 단위로 보존)
        const s = seenCall[ph] || (seenCall[ph] = new Set());
        if (s.has(ck)) continue; s.add(ck);
        byAg[ph] = (byAg[ph] || 0) + 1;
      }
    }
  }
  const ags = (await db.ref("v1/agencies").once("value")).val() || {};
  const upd = {}; let n = 0;
  for (const key in ags) {
    const a = ags[key]; if (!a) continue;
    const ph = String(a.phone || "").replace(/[^0-9]/g, "");
    const cnt = byAg[ph] || 0;
    if (cnt > 0 && cnt !== (Number(a.cleanCount) || 0)) { upd[key + "/cleanCount"] = cnt; n++; }   // 서로 다른 콜 수로 갱신(중복 제거라 기존 부풀림은 내려갈 수 있음·잔존 오더 기준)
  }
  if (Object.keys(upd).length) await db.ref("v1/agencies").update(upd);
  console.log("recountAgencies(raw count) updated", n, "/", Object.keys(ags).length);
  return n;
}

const AGENCY_RECENT_AUDIT_DAYS = 7;
const AGENCY_RECENT_AUDIT_CHUNK = 25;

function agencyRecentAuditWindow(now) {
  const runDate = kstDate(now);
  const completedDates = [];
  for (let daysAgo = AGENCY_RECENT_AUDIT_DAYS; daysAgo >= 1; daysAgo -= 1) {
    completedDates.push(kstDate(now - daysAgo * 86400000));
  }
  return { runDate, completedDates };
}

function addAgencyRecentCounts(target, source) {
  Object.entries(source || {}).forEach(([key, value]) => {
    const phone = String(key || "").replace(/[^0-9]/g, "");
    const count = Math.max(0, Number(value) || 0);
    if (phone && count > 0) target[phone] = (Number(target[phone]) || 0) + count;
  });
  return target;
}

function agencyExpectedCleanCount(previous, phone, completedCount, currentPartialCount) {
  const priorCounts = previous && previous.cleanCounts && typeof previous.cleanCounts === "object" ? previous.cleanCounts : {};
  if (!Object.prototype.hasOwnProperty.call(priorCounts, phone)) return null;
  const priorPartial = previous.runDatePartial && typeof previous.runDatePartial === "object"
    ? Math.max(0, Number(previous.runDatePartial[phone]) || 0)
    : 0;
  return Math.max(0, Number(priorCounts[phone]) || 0) +
    Math.max(0, (Number(completedCount) || 0) - priorPartial) +
    Math.max(0, Number(currentPartialCount) || 0);
}

async function auditRecentAgencyActivity(now = Date.now()) {
  const window = agencyRecentAuditWindow(now);
  const auditRef = db.ref("v1/app/agency_recount_audit/latest");
  const paths = window.completedDates.concat(window.runDate);
  const reads = await Promise.all([
    auditRef.once("value"),
    ...paths.map(date => db.ref("v1/app/data_live/" + date + "/agencies").once("value")),
  ]);
  const previous = reads[0].val() || {};
  const completedCounts = {};
  window.completedDates.forEach((date, index) => addAgencyRecentCounts(completedCounts, reads[index + 1].val() || {}));
  const runDatePartial = addAgencyRecentCounts({}, reads[reads.length - 1].val() || {});
  const touchedPhones = [...new Set(Object.keys(completedCounts).concat(Object.keys(runDatePartial)))].sort();
  const cleanCounts = {};
  for (let i = 0; i < touchedPhones.length; i += AGENCY_RECENT_AUDIT_CHUNK) {
    await Promise.all(touchedPhones.slice(i, i + AGENCY_RECENT_AUDIT_CHUNK).map(async phone => {
      const snap = await db.ref("v1/agencies/" + phone + "/cleanCount").once("value");
      cleanCounts[phone] = Math.max(0, Number(snap.val()) || 0);
    }));
  }

  const comparable = String(previous.runDate || "") === String(window.completedDates[0] || "");
  const anomalies = [];
  if (comparable) {
    touchedPhones.forEach(phone => {
      const expected = agencyExpectedCleanCount(previous, phone, completedCounts[phone], runDatePartial[phone]);
      if (expected != null && cleanCounts[phone] !== expected && anomalies.length < 100) {
        anomalies.push({ phone, expected, actual: cleanCounts[phone] });
      }
    });
  }
  const recentCallCount = Object.values(completedCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const partialCallCount = Object.values(runDatePartial).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const result = {
    status: comparable ? (anomalies.length ? "review" : "ok") : "baseline",
    method: "recent_data_live_audit_v1",
    runDate: window.runDate,
    completedDates: window.completedDates,
    recentAgencyCount: Object.keys(completedCounts).length,
    recentCallCount,
    partialAgencyCount: Object.keys(runDatePartial).length,
    partialCallCount,
    cleanCountReadCount: touchedPhones.length,
    anomalyCount: anomalies.length,
    anomalies,
    cleanCounts,
    runDatePartial,
    updatedAt: now,
  };
  await auditRef.set(result);
  return result;
}

exports.agencyRecountTick = functions.region(REGION).runWith({ timeoutSeconds: 540, memory: "512MB" }).pubsub.schedule("0 3 * * 0").timeZone("Asia/Seoul").onRun(async () => {
  const started = Date.now();
  const result = await auditRecentAgencyActivity(started);
  qpBillingLog("agencyRecountTick", {
    readDate: result.runDate,
    ordersReadCount: 0,
    gpsReadCount: 0,
    cache: result.method,
    recentAgencyCount: result.recentAgencyCount,
    recentCallCount: result.recentCallCount,
    cleanCountReadCount: result.cleanCountReadCount,
    anomalyCount: result.anomalyCount,
    durationMs: Date.now() - started,
  });
  console.log("agencyRecountTick recent audit", {
    status: result.status,
    runDate: result.runDate,
    recentAgencyCount: result.recentAgencyCount,
    recentCallCount: result.recentCallCount,
    anomalyCount: result.anomalyCount,
  });
  return null;
});
exports.agencyRecountNow = functions.region(REGION).runWith({ timeoutSeconds: 540, memory: "512MB" }).https.onRequest(async (req, res) => {
  if (req.query.k !== "qpmon610") { res.status(403).send("no"); return; }
  try { const n = await recountAgencies(); res.json({ updated: n }); } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});

// Agency trust/unit-price daily ledger.
// cleanCount is already incremented by orderLive per deduped call. This job only adds
// memo score and won/km samples from the completed previous KST day.
const AGENCY_STATS_MIN_PER_KM = 10;
const AGENCY_VOLUME_MIN_ORDERS = 10;
const AGENCY_VOLUME_METHOD = "phone_clean_count_percentile_v1";
const AGENCY_VOLUME_INDEX_PATH = "v1/app/agency_volume_index";
const AGENCY_VOLUME_META_PATH = "v1/app/agency_volume_meta";
const AGENCY_VOLUME_READ_CHUNK = 50;

function agencyVolumePhone(value) {
  const phone = String(value || "").replace(/\D/g, "");
  return phone.length >= 7 ? phone : "";
}

function agencyVolumeStarForPercentile(percentile) {
  if (percentile <= 0.10) return 5;
  if (percentile <= 0.30) return 4;
  if (percentile <= 0.50) return 3;
  if (percentile <= 0.70) return 2;
  if (percentile <= 0.90) return 1;
  return 0;
}

function agencyVolumeAssignments(index) {
  const candidates = Object.entries(index || {})
    .map(([phone, value]) => ({
      phone: agencyVolumePhone(phone),
      agencyKey: String(value && value.agencyKey || phone),
      count: Math.max(0, Number(value && value.count) || 0),
      previousStar: Math.max(0, Number(value && value.star) || 0),
    }))
    .filter(row => row.phone && row.agencyKey);
  const rows = candidates
    .filter(row => row.count >= AGENCY_VOLUME_MIN_ORDERS)
    .sort((a, b) => b.count - a.count || a.phone.localeCompare(b.phone));
  const ineligibleRows = candidates
    .filter(row => row.count < AGENCY_VOLUME_MIN_ORDERS && row.previousStar > 0)
    .map(row => Object.assign(row, { star: 0 }));

  const distribution = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let firstRankForCount = 0;
  let previousCount = null;
  rows.forEach((row, indexInRows) => {
    if (row.count !== previousCount) {
      firstRankForCount = indexInRows + 1;
      previousCount = row.count;
    }
    row.star = agencyVolumeStarForPercentile(firstRankForCount / Math.max(1, rows.length));
    distribution[row.star] += 1;
  });
  return { rows, ineligibleRows, distribution };
}

function agencyVolumeDateRange(afterDate, throughDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(throughDate)) return [];
  const end = Date.parse(throughDate + "T00:00:00Z");
  if (!Number.isFinite(end)) return [];
  let cursor = /^\d{4}-\d{2}-\d{2}$/.test(afterDate)
    ? Date.parse(afterDate + "T00:00:00Z") + 86400000
    : end;
  const dates = [];
  while (cursor <= end) {
    if (dates.length >= 31) throw new Error("agency volume index gap exceeds 31 days; bootstrap is required");
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86400000;
  }
  return dates;
}

function agencyVolumeBootstrapIndex(agencies) {
  const index = {};
  Object.entries(agencies || {}).forEach(([agencyKey, node]) => {
    if (!node || typeof node !== "object" || !String(node.name || "").trim()) return;
    const phone = agencyVolumePhone(node.phone || agencyKey);
    if (!phone) return;
    const candidate = {
      agencyKey,
      count: Math.max(0, Number(node.cleanCount) || 0),
      star: Math.max(0, Math.min(5, Number(node.volumeStars) || 0)),
    };
    const current = index[phone];
    if (!current || candidate.count > current.count || agencyKey === phone) index[phone] = candidate;
  });
  return index;
}

async function agencyVolumeSyncTouchedCounts(index, dates, dryRun) {
  if (!dates.length) return { datesRead: 0, touchedPhones: 0, countReads: 0 };
  const dailySnaps = await Promise.all(dates.map(date => db.ref("v1/app/data_live/" + date + "/agencies").once("value")));
  const phones = new Set();
  dailySnaps.forEach(snap => {
    Object.keys(snap.val() || {}).forEach(value => {
      const phone = agencyVolumePhone(value);
      if (phone) phones.add(phone);
    });
  });
  const phoneList = Array.from(phones).sort();
  const countUpdates = {};
  for (let offset = 0; offset < phoneList.length; offset += AGENCY_VOLUME_READ_CHUNK) {
    await Promise.all(phoneList.slice(offset, offset + AGENCY_VOLUME_READ_CHUNK).map(async phone => {
      const snap = await db.ref("v1/agencies/" + phone + "/cleanCount").once("value");
      if (!snap.exists()) return;
      const count = Math.max(0, Number(snap.val()) || 0);
      const previous = index[phone] && typeof index[phone] === "object" ? index[phone] : {};
      index[phone] = Object.assign({}, previous, { agencyKey: previous.agencyKey || phone, count });
      countUpdates[phone + "/agencyKey"] = index[phone].agencyKey;
      countUpdates[phone + "/count"] = count;
    }));
  }
  if (!dryRun && Object.keys(countUpdates).length) {
    await db.ref(AGENCY_VOLUME_INDEX_PATH).update(countUpdates);
  }
  return { datesRead: dates.length, touchedPhones: phoneList.length, countReads: phoneList.length };
}

async function refreshAgencyVolumeStars(options = {}) {
  const startedAt = Date.now();
  const dryRun = !!options.dryRun;
  const bootstrap = !!options.bootstrap;
  const throughDate = String(options.throughDate || kstDate(Date.now() - 86400000));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(throughDate)) throw new Error("date=YYYY-MM-DD");
  const [indexSnap, metaSnap] = await Promise.all([
    db.ref(AGENCY_VOLUME_INDEX_PATH).once("value"),
    db.ref(AGENCY_VOLUME_META_PATH).once("value"),
  ]);
  let index = indexSnap.val() || {};
  const previousMeta = metaSnap.val() || {};
  let bootstrapAgencyReads = 0;

  if (bootstrap) {
    const agencies = (await db.ref("v1/agencies").once("value")).val() || {};
    bootstrapAgencyReads = Object.keys(agencies).length;
    index = agencyVolumeBootstrapIndex(agencies);
    if (!dryRun) await db.ref(AGENCY_VOLUME_INDEX_PATH).set(index);
  } else if (!Object.keys(index).length) {
    throw new Error("agency volume index is empty; bootstrap is required");
  }

  const dates = bootstrap ? [] : agencyVolumeDateRange(String(previousMeta.lastDataDate || ""), throughDate);
  const sync = await agencyVolumeSyncTouchedCounts(index, dates, dryRun);
  const assignments = agencyVolumeAssignments(index);
  const updates = {};
  let changed = 0;
  let filled = 0;
  let cleared = 0;
  assignments.rows.concat(assignments.ineligibleRows).forEach(row => {
    if (row.previousStar === row.star) return;
    changed += 1;
    if (row.previousStar < 1 && row.star > 0) filled += 1;
    if (row.previousStar > 0 && row.star === 0) cleared += 1;
    updates["v1/agencies/" + row.agencyKey + "/volumeStars"] = row.star;
    updates[AGENCY_VOLUME_INDEX_PATH + "/" + row.phone + "/star"] = row.star;
  });
  if (!dryRun && Object.keys(updates).length) await db.ref().update(updates);

  const result = {
    ok: true,
    dryRun,
    bootstrap,
    throughDate,
    method: AGENCY_VOLUME_METHOD,
    minOrders: AGENCY_VOLUME_MIN_ORDERS,
    indexedAgencies: Object.keys(index).length,
    eligibleAgencies: assignments.rows.length,
    starsChanged: changed,
    starsFilled: filled,
    starsCleared: cleared,
    distribution: assignments.distribution,
    bootstrapAgencyReads,
    datesRead: sync.datesRead,
    touchedPhones: sync.touchedPhones,
    countReads: sync.countReads,
    durationMs: Date.now() - startedAt,
  };
  if (!dryRun) {
    await db.ref(AGENCY_VOLUME_META_PATH).set(Object.assign({}, result, {
      lastDataDate: throughDate,
      updatedAt: Date.now(),
    }));
  }
  return result;
}

function agencyDailyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function agencyDailySanitizeKey(value) {
  return String(value || "").trim().replace(/[.#$\[\]/]/g, "_");
}

function agencyDailyParseJson(value) {
  if (!value || typeof value !== "string") return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function agencyDailyCleanName(value) {
  const v = String(value || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\d[^)]*\)/g, " ")
    .replace(/\d{2,4}-?\d{3,4}-?\d{4}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!v || /^\d+$/.test(v)) return "";
  return v;
}

function agencyDailyCenterFromRow(row) {
  if (row.center) return row.center;
  const d = agencyDailyParseJson(row.detail_json);
  return d && (d.center || d.tvCenter || d.agency || d.agency_name || "");
}

function agencyDailyParseAgency(rawCenter) {
  const raw = String(rawCenter || "").trim();
  if (!raw) return { name: "", phone: "" };
  const phone = (raw.match(/[\d-]{8,}/) || [""])[0].replace(/-/g, "");
  const name = agencyDailyCleanName(raw
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s*\([^)]*\d[^)]*\)\s*/g, " ")
    .replace(/[\[\(\s-]\d{2,4}-?\d{3,4}-?\d{4}[\]\)\s]?/g, " ")
    .replace(/-?\d{2,4}-\d{3,4}-?\d{0,4}/g, " "));
  return { name, phone };
}

function agencyDailyFromRow(row) {
  const parsed = agencyDailyParseAgency(agencyDailyCenterFromRow(row));
  const nameRaw = agencyDailyCleanName(row.agency_name || parsed.name || "");
  const phoneRaw = agencyDailyDigits(row.agency || parsed.phone || row.agency_phone || "");
  const fallbackRaw = String(row.agency || "").trim();
  const fallbackName = agencyDailyDigits(fallbackRaw) === fallbackRaw.replace(/\D/g, "") ? "" : agencyDailyCleanName(fallbackRaw);
  const name = nameRaw || fallbackName;
  const phone = phoneRaw || parsed.phone;
  return { key: agencyDailySanitizeKey(phone || name.replace(/\s+/g, "")), name, phone };
}

function agencyDailyBuildLookup(agencies) {
  const phoneToName = {};
  const nameToPhones = {};
  Object.entries(agencies || {}).forEach(([key, value]) => {
    if (!value || typeof value !== "object") return;
    const phone = agencyDailyDigits(value.phone || key);
    const name = agencyDailyCleanName(value.name || "");
    if (!phone || !name) return;
    if (!phoneToName[phone]) phoneToName[phone] = name;
    if (!nameToPhones[name]) nameToPhones[name] = new Set();
    nameToPhones[name].add(phone);
  });
  const nameToPhone = {};
  Object.entries(nameToPhones).forEach(([name, phones]) => {
    if (phones.size === 1) nameToPhone[name] = [...phones][0];
  });
  return { phoneToName, nameToPhone };
}

const AGENCY_DAILY_LOOKUP_VERSION = 1;
const AGENCY_DAILY_LOOKUP_MAX_AGE_MS = 7 * 86400000;

async function loadAgencyDailyLookup(options = {}) {
  const now = Number(options.now) || Date.now();
  const dryRun = !!options.dryRun;
  const ref = db.ref("v1/app/insung_agency_stats_meta/lookup");
  const cached = (await ref.once("value")).val() || {};
  const fresh = Number(cached.version) === AGENCY_DAILY_LOOKUP_VERSION &&
    cached.phoneToName && Array.isArray(cached.namePhonePairs) &&
    now - (Number(cached.builtAt) || 0) < AGENCY_DAILY_LOOKUP_MAX_AGE_MS;
  if (fresh) {
    const nameToPhone = {};
    cached.namePhonePairs.forEach(pair => {
      if (pair && pair.name && pair.phone) nameToPhone[String(pair.name)] = String(pair.phone);
    });
    return {
      lookup: { phoneToName: cached.phoneToName, nameToPhone },
      source: "cache",
    };
  }
  const agencies = (await db.ref("v1/agencies").once("value")).val() || {};
  const lookup = agencyDailyBuildLookup(agencies);
  if (!dryRun) {
    await ref.set({
      version: AGENCY_DAILY_LOOKUP_VERSION,
      builtAt: now,
      phoneToName: lookup.phoneToName,
      namePhonePairs: Object.entries(lookup.nameToPhone).map(([name, phone]) => ({ name, phone })),
    });
  }
  return { lookup, source: dryRun ? "root_dry_run" : "root_rebuilt" };
}

async function agencyDailyUserScope(date) {
  const active = (await db.ref("v1/app/data_live_seen/" + date + "/_users").once("value")).val() || {};
  const activeUids = Object.keys(active);
  if (activeUids.length) return { uids: activeUids, source: "data_live_seen" };
  const shadow = (await db.ref("v1/app/agg_shadow/" + date).once("value")).val() || {};
  const shadowUids = Object.keys(shadow).filter(uid => Number(shadow[uid] && shadow[uid].cnt) > 0);
  if (shadowUids.length) return { uids: shadowUids, source: "agg_shadow" };
  return { uids: await listUids(), source: "all_users_fallback" };
}

function agencyStatsWindowFrom(existing, fallback, date) {
  return [existing, fallback, date].map(String).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()[0] || date;
}

function agencyStatsWindowTo(existing, fallback, date) {
  const dates = [existing, fallback, date].map(String).filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
  return dates.length ? dates[dates.length - 1] : date;
}

function agencyDailyMemoFromRow(row) {
  const d = agencyDailyParseJson(row.detail_json) || {};
  return String(row.memo || row.user_memo || d.memo || d.jukyo || d.note || d.detail || "");
}

function agencyDailyScoreMemo(value) {
  const memo = String(value || "").replace(/\s+/g, " ").trim();
  if (!memo) return 0;
  const hasQty = /\d+\s*(개|건|박스|box|BOX|ea|EA|kg|KG|톤|t|T|파렛|빠렛|롤|봉|포대|마대|장|세트|set|SET)/.test(memo);
  const hasSize = /\d+\s*(cm|CM|m|M|mm|MM|kg|KG|톤|t|T)|파렛|빠렛|부피|무게|중량|크기|사이즈/.test(memo);
  const hasItemWord = /박스|서류|의류|식품|부품|자재|샘플|기계|가구|원단|철물|약품|화장품|인쇄|책|문서|행거|봉투|상자|물품|제품|짐/.test(memo);
  const handlingOnly = /선불|착불|현금|카드|계좌|수금|독차|왕복|경유|바로|급송|전화|연락|문자/.test(memo) && !hasItemWord && !hasQty && !hasSize;
  if (hasItemWord && (hasQty || hasSize)) return 100;
  if (hasItemWord) return 75;
  if (hasQty || hasSize) return 50;
  if (handlingOnly) return 25;
  return 25;
}

function agencyDailyCleanPerKm(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 100 || rounded > 20000) return null;
  return rounded;
}

function agencyDailyMedian(values) {
  const nums = (values || []).map(Number).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? Math.round(nums[mid]) : Math.round((nums[mid - 1] + nums[mid]) / 2);
}

function agencyDailyKeyPart(key, idx) {
  const parts = String(key || "").split("|");
  return parts[idx] || "";
}

function agencyDailyNormalizeText(value) {
  return String(value || "").replace(/[\s@!()/.\[\]'",~`*#$%^&-]/g, "").toLowerCase();
}

function agencyDailyDongKey(value) {
  const text = agencyDailyNormalizeText(value);
  const matches = text.match(/[가-힣]+[동읍면리]/g);
  return matches && matches.length ? matches[matches.length - 1] : text;
}

function agencyDailyNormalizeVehicle(value) {
  const v = agencyDailyNormalizeText(value);
  if (!v) return "";
  if (v.includes("승용") && v.includes("소형")) return "승용소형";
  if (v.includes("오토바이")) return "오토바이";
  if (v.includes("다마스")) return "다마스";
  if (v.includes("라보")) return "라보";
  return v;
}

function agencyDailyGlobalOrderKey(date, orderKey, row) {
  const origin = agencyDailyDongKey(row.origin || row.origin_text || agencyDailyKeyPart(orderKey, 2));
  const dest = agencyDailyDongKey(row.dest || row.dest_text || row.destination || agencyDailyKeyPart(orderKey, 3));
  const vehicle = agencyDailyNormalizeVehicle(row.vehicle_type || agencyDailyKeyPart(orderKey, 4));
  const amount = Math.round(Number(row.amount || 0) / 100) * 100;
  const ts = Number(row.detected_at || row.accepted_at || row.updated_at || 0);
  const bucket30m = ts > 0 ? Math.floor(ts / (30 * 60 * 1000)) : "";
  return [date, "인성", origin, dest, vehicle, amount, bucket30m].join("|");
}

function agencyDailyMedianFromBuckets(buckets) {
  const pairs = Object.entries(buckets || {})
    .map(([k, v]) => [Number(k), Number(v)])
    .filter(([k, v]) => Number.isFinite(k) && Number.isFinite(v) && k > 0 && v > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = pairs.reduce((sum, p) => sum + p[1], 0);
  if (!total) return null;
  const leftTarget = Math.floor((total - 1) / 2);
  const rightTarget = Math.floor(total / 2);
  let seen = 0, left = null, right = null;
  for (const [value, count] of pairs) {
    const next = seen + count;
    if (left == null && leftTarget < next) left = value;
    if (right == null && rightTarget < next) { right = value; break; }
    seen = next;
  }
  return left != null && right != null ? Math.round((left + right) / 2) : null;
}

async function buildAgencyDailyDelta(date, options = {}) {
  const [userScope, lookupResult] = await Promise.all([
    agencyDailyUserScope(date),
    loadAgencyDailyLookup({ dryRun: !!options.dryRun }),
  ]);
  const uids = userScope.uids;
  const agencyLookup = lookupResult.lookup;
  const seen = new Map();
  const diagnostics = {
    date,
    usersTotal: uids.length,
    userScope: userScope.source,
    agencyLookupSource: lookupResult.source,
    usersWithOrders: 0,
    rawOrderRows: 0,
    rawInsungRows: 0,
    uniqueOrders: 0,
    skippedNoPhone: 0,
    resolvedNameOnlyRows: 0,
    resolvedPhoneOnlyRows: 0,
    usablePerKmSamples: 0,
    collapsedDuplicateRows: 0,
  };
  const CHUNK = 8;
  for (let i = 0; i < uids.length; i += CHUNK) {
    await Promise.all(uids.slice(i, i + CHUNK).map(async uid => {
      let rows = null;
      try { rows = (await db.ref("v1/users/" + uid + "/orders/" + date).once("value")).val(); } catch (e) {}
      if (!rows) return;
      diagnostics.rawOrderRows += Object.keys(rows).length;
      diagnostics.usersWithOrders += 1;
      for (const orderKey in rows) {
        const row = rows[orderKey];
        if (!row || typeof row !== "object") continue;
        if (String(row.platform || "").trim() !== "인성") continue;
        diagnostics.rawInsungRows += 1;
        const agency = agencyDailyFromRow(row);
        if (!agency.phone && agency.name && agencyLookup.nameToPhone[agency.name]) {
          agency.phone = agencyLookup.nameToPhone[agency.name];
          agency.key = agencyDailySanitizeKey(agency.phone);
          diagnostics.resolvedNameOnlyRows += 1;
        }
        if (agency.phone && !agency.name && agencyLookup.phoneToName[agency.phone]) {
          agency.name = agencyLookup.phoneToName[agency.phone];
          diagnostics.resolvedPhoneOnlyRows += 1;
        }
        if (!agency.phone) { diagnostics.skippedNoPhone += 1; continue; }
        const perKm = agencyDailyCleanPerKm(row.per_km);
        const candidate = {
          agency,
          memoScore: agencyDailyScoreMemo(agencyDailyMemoFromRow(row)),
          perKmSamples: perKm != null ? [perKm] : [],
        };
        const globalKey = agencyDailyGlobalOrderKey(date, orderKey, row);
        const prev = seen.get(globalKey);
        if (prev) {
          diagnostics.collapsedDuplicateRows += 1;
          prev.memoScore = Math.max(prev.memoScore, candidate.memoScore);
          if (!prev.agency.name && candidate.agency.name) prev.agency.name = candidate.agency.name;
          prev.perKmSamples.push(...candidate.perKmSamples);
          return;
        }
        seen.set(globalKey, candidate);
      }
    }));
  }

  const byAgency = {};
  for (const item of seen.values()) {
    const phone = item.agency.phone;
    if (!byAgency[phone]) byAgency[phone] = { phone, name: item.agency.name || "", orderCount: 0, memoScoreSum: 0, perKmSum: 0, perKmCount: 0, perKmBuckets: {} };
    const a = byAgency[phone];
    if (!a.name && item.agency.name) a.name = item.agency.name;
    a.orderCount += 1;
    a.memoScoreSum += item.memoScore;
    const perKm = agencyDailyMedian(item.perKmSamples);
    if (perKm != null) {
      a.perKmSum += perKm;
      a.perKmCount += 1;
      a.perKmBuckets[perKm] = (a.perKmBuckets[perKm] || 0) + 1;
      diagnostics.usablePerKmSamples += 1;
    }
  }
  diagnostics.uniqueOrders = seen.size;
  return { byAgency, diagnostics };
}

async function runAgencyStatsDaily(date, options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date=YYYY-MM-DD");
  const dryRun = !!options.dryRun;
  const force = !!options.force;
  const latestStats = dryRun ? {} : ((await db.ref("v1/app/insung_agency_stats_meta/latest").once("value")).val() || {});
  if (!dryRun && !force) {
    const coveredTo = String(latestStats.statsWindowTo || "");
    if (coveredTo && date <= coveredTo) {
      return { ok: true, skipped: true, reason: "covered_by_full_base", date, coveredTo };
    }
  }
  const runRef = db.ref("v1/app/insung_agency_stats_daily/" + date);
  const prev = (await runRef.once("value")).val();
  if (!force && prev && prev.status === "done") return { ok: true, skipped: true, reason: "already_done", date, previous: prev };

  const now = Date.now();
  const { byAgency, diagnostics } = await buildAgencyDailyDelta(date, { dryRun });
  const phones = Object.keys(byAgency);
  if (dryRun) return { ok: true, dryRun: true, date, agenciesTouched: phones.length, diagnostics };

  await runRef.set({ status: "running", startedAt: now, agenciesTouched: phones.length, diagnostics });
  let updated = 0;
  for (const phone of phones) {
    const delta = byAgency[phone];
    const ref = db.ref("v1/agencies/" + phone);
    const result = await ref.transaction(cur => {
      const node = cur && typeof cur === "object" ? cur : {};
      const oldMemoCount = Number(node.memoScoreCount || node.cleanCount || 0) || 0;
      const oldMemoScore = Number(node.memoScore || node.trustScore || 0) || 0;
      const oldMemoSum = Number(node.memoScoreSum || (oldMemoScore * oldMemoCount)) || 0;
      const newMemoCount = oldMemoCount + delta.orderCount;
      const newMemoSum = oldMemoSum + delta.memoScoreSum;

      const oldPerKmCount = Number(node.wonPerKmSampleCount || 0) || 0;
      const oldAvg = Number(node.avgWonPerKm || 0) || 0;
      const oldPerKmSum = Number(node.perKmSum || (oldAvg * oldPerKmCount)) || 0;
      const buckets = node.perKmBuckets && typeof node.perKmBuckets === "object" ? Object.assign({}, node.perKmBuckets) : {};
      if (!Object.keys(buckets).length && oldPerKmCount > 0 && Number(node.medianWonPerKm || 0) > 0) {
        buckets[Math.round(Number(node.medianWonPerKm))] = oldPerKmCount;
      }
      Object.entries(delta.perKmBuckets).forEach(([k, v]) => {
        buckets[k] = (Number(buckets[k]) || 0) + Number(v);
      });
      const newPerKmCount = oldPerKmCount + delta.perKmCount;
      const newPerKmSum = oldPerKmSum + delta.perKmSum;

      node.phone = node.phone || phone;
      if (!node.name && delta.name) node.name = delta.name;
      if (node.cleanCount == null) node.cleanCount = delta.orderCount;
      node.memoScoreSum = newMemoSum;
      node.memoScoreCount = newMemoCount;
      node.memoScore = Math.round(newMemoSum / Math.max(1, newMemoCount));
      node.trustScore = node.memoScore;
      node.statsMethod = "phone_key_memo_trust_v1";
      node.statsWindowFrom = agencyStatsWindowFrom(node.statsWindowFrom, latestStats.statsWindowFrom, date);
      node.statsWindowTo = agencyStatsWindowTo(node.statsWindowTo, latestStats.statsWindowTo, date);
      node.lastDailyStatsDate = date;
      node.statsUpdatedAt = now;
      node.perKmSum = newPerKmSum;
      node.wonPerKmSampleCount = newPerKmCount;
      node.wonPerKmMinSamples = AGENCY_STATS_MIN_PER_KM;
      node.wonPerKmMethod = "phone_key_per_km_median_v1";
      node.perKmBuckets = buckets;
      if (newPerKmCount >= AGENCY_STATS_MIN_PER_KM) {
        node.avgWonPerKm = Math.round(newPerKmSum / Math.max(1, newPerKmCount));
        node.medianWonPerKm = agencyDailyMedianFromBuckets(buckets);
      }
      return node;
    });
    if (result.committed) updated += 1;
  }

  const done = { status: "done", date, startedAt: now, finishedAt: Date.now(), agenciesTouched: phones.length, agenciesUpdated: updated, diagnostics, method: "daily_increment_v1" };
  await runRef.set(done);
  await db.ref("v1/app/insung_agency_stats_meta/latestIncremental").transaction(current => {
    const currentDate = String(current && current.date || "");
    if (currentDate && currentDate > date) return;
    return done;
  });
  return { ok: true, date, ...done };
}

exports.agencyStatsDailyTick = functions.region(REGION).runWith({ timeoutSeconds: 540, memory: "512MB" }).pubsub.schedule("0 0 * * *").timeZone("Asia/Seoul").onRun(async () => {
  const started = Date.now();
  const date = kstDate(Date.now() - 86400000);
  const result = await runAgencyStatsDaily(date);
  let volumeResult;
  try {
    volumeResult = await refreshAgencyVolumeStars({ throughDate: date });
  } catch (error) {
    volumeResult = { ok: false, error: String(error && error.message || error) };
    console.error("agency volume star refresh failed", volumeResult);
  }
  qpBillingLog("agencyStatsDailyTick", {
    readDate: date,
    ordersReadCount: result && result.diagnostics ? (result.diagnostics.rawOrderRows || result.diagnostics.rawInsungRows || 0) : 0,
    gpsReadCount: 0,
    cache: result && result.skipped ? result.reason : "daily_" + String(result && result.diagnostics && result.diagnostics.agencyLookupSource || "unknown"),
    durationMs: Date.now() - started,
  });
  console.log("agencyStatsDailyTick", { stats: result, volume: volumeResult });
  return null;
});

exports.agencyStatsDailyNow = functions.region(REGION).runWith({ timeoutSeconds: 540, memory: "512MB" }).https.onRequest(async (req, res) => {
  if (req.query.k !== "qpmon610") { res.status(403).send("no"); return; }
  const date = String(req.query.date || kstDate(Date.now() - 86400000));
  try {
    const result = await runAgencyStatsDaily(date, { dryRun: req.query.dry === "1", force: req.query.force === "1" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});

exports.agencyVolumeStarsNow = functions.region(REGION).runWith({ timeoutSeconds: 540, memory: "512MB" }).https.onRequest(async (req, res) => {
  if (req.query.k !== "qpmon610") { res.status(403).send("no"); return; }
  try {
    const result = await refreshAgencyVolumeStars({
      dryRun: req.query.execute !== "1",
      bootstrap: req.query.bootstrap === "1",
      throughDate: String(req.query.date || kstDate(Date.now() - 86400000)),
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});
