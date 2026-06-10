// monitorSummary — 1분마다 날것(v1/users/<uid>)을 읽어 모니터 목록용 요약을
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
function snapMaxTs(snap) {
  let mx = 0; snap.forEach(c => { const t = Number((c.val() && c.val().ts) || c.key) || 0; if (t > mx) mx = t; return false; });
  return mx;
}

async function summarizeUser(uid, now) {
  const base = "v1/users/" + uid;
  const bucket = Math.floor(now / 86400000);   // 앱 epoch-day 버킷
  const date = kstDate(now);
  const dayStart = dayStartMs(now);

  // 상태(커서+버퍼) 포함, GPS 외 자료를 먼저 병렬로. GPS는 커서가 정해진 뒤 2단계로 읽음(증분).
  const [profSnap, verSnap, ordSnap, crashSnap, actLastSnap, stateSnap, shadowSnap] = await Promise.all([
    db.ref(base + "/profile").once("value"),
    db.ref(base + "/app_version").once("value"),
    db.ref(base + "/orders/" + date).once("value"),
    db.ref(base + "/crash_logs").once("value"),
    db.ref(base + "/user_actions/" + bucket).orderByKey().limitToLast(1).once("value"),
    db.ref("v1/app/agg_state/" + uid).once("value"),
    db.ref("v1/app/agg_shadow/" + date + "/" + uid).once("value"),   // [shadow] 증분 카운트 대조용
  ]);

  const p = profSnap.val() || {};
  const orders = ordSnap.val() || {};
  const crashes = crashSnap.val() || {};
  const os = ordStats(orders);

  // 크래시: 오늘(KST 0시 이후)만
  let crCnt = 0, lastCrashTs = 0;
  Object.keys(crashes).forEach(k => {
    const t = Number((crashes[k] && crashes[k].ts) || k) || 0;
    if (t >= dayStart) crCnt++;
    if (t > lastCrashTs) lastCrashTs = t;
  });

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
  const seenTs = Math.max(gpsTs, snapMaxTs(actLastSnap));

  // 상태 저장 — 다음 실행은 이 커서 이후만 읽음
  const newCur = newPts.length ? newPts[newPts.length - 1].t : now;
  await db.ref("v1/app/agg_state/" + uid).set({ cur: newCur, buf, last: lastPt || null });

  return {
    nick: p.nickname || "", name: p.name || "", phone: p.phone || "", region: p.region || "",
    vt: p.vehicle_type || "", email: p.email || "", ver: verSnap.val() || "",
    ordCnt: os.cnt, shadowOrdCnt: Number(shadowSnap.val()) || 0, plat: os.plat, lastOrderTs: lastOrderTs(orders),
    crCnt, lastCrashTs,
    seenTs, lastMoveTs, gpsTs,
    lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null,
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

async function buildSummary() {
  const now = Date.now();
  const uids = await listUids();

  const out = {};
  await Promise.all(uids.map(async uid => {
    try { out[uid] = await summarizeUser(uid, now); } catch (e) { /* 한 명 실패가 전체를 막지 않음 */ }
  }));
  out._meta = { ts: now, n: Object.keys(out).length };
  await db.ref("v1/app/monitor_summary").set(out);
  return out._meta;
}

const RUN = { timeoutSeconds: 120, memory: "256MB" };

// 5분 스케줄 (Blaze 필요) — 비용 절감. 실시간성 불필요(활성=30분 기준)·증분 읽기로 비용 추가 절감.
exports.monitorSummary = functions.region(REGION).runWith(RUN).pubsub.schedule("every 5 minutes").onRun(async () => {
  const meta = await buildSummary();
  console.log("monitor_summary updated", meta);
  return null;
});

// 수동 트리거(검증용) — 배포 후 한 번 호출해 노드 채우고 결과 확인.
exports.monitorSummaryNow = functions.region(REGION).runWith(RUN).https.onRequest(async (req, res) => {
  const meta = await buildSummary();
  res.json({ ok: true, meta });
});

// ===== 데이터 탭 (앱) — 전날 기준 전체 집계 + 본인 운행. server.html(통계 페이지)과 같은 그림. =====
// 집계는 날짜별 캐시(/v1/app/data_cache/<date>) — 첫 호출 때 계산(느림), 이후 캐시. 개인 운행은 매 호출 서버 계산.
const h3 = require("h3-js");
const PAL = ["#FFF176", "#FFD54F", "#FFB300", "#FB8C00", "#F4511E", "#D32F2F"];   // 우버식 노랑→빨강
let _geoCache = null;
async function geoCache() {
  if (_geoCache) return _geoCache;
  try { const r = await fetch("https://quickpilot-39d72.web.app/geo_cache.json"); _geoCache = (await r.json()) || {}; } catch (e) { _geoCache = {}; }
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

async function computeAggregate(y, mo, d) {
  const ds = dateKey(y, mo, d);
  const dayStart = Date.UTC(y, mo - 1, d) - 9 * 3600000, dayEnd = dayStart + 86400000;
  const uids = await listUids();
  const hours = new Array(24).fill(0);
  const plat = {}, originCnt = {}; let totalOrd = 0, activeUsers = 0;
  const allSigs = new Set();         // 유저 교차 중복제거 — 같은 콜을 여러 유저가 감지해도 시장 distinct는 1
  await Promise.all(uids.map(async uid => {
    try {
      const arr = dedupBySig(Object.values((await db.ref("v1/users/" + uid + "/orders/" + ds).once("value")).val() || {}));   // 유저별 sig 중복제거(전환기 이중키·재팝 흡수)
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

// 개인 운행 — monitor-all loadDetail과 동일 산식(작업 윈도우·속도적분·트립시간). 서버값으로 통일.
async function computePersonal(uid, y, mo, d) {
  const ds = dateKey(y, mo, d);
  const dayStart = Date.UTC(y, mo - 1, d) - 9 * 3600000, dayEnd = dayStart + 86400000;
  const bk0 = Math.floor(dayStart / 86400000), bk1 = Math.floor((dayEnd - 1) / 86400000);
  let gps = {}, orders = {};
  try {
    const reads = [];
    for (let bk = bk0; bk <= bk1; bk++) reads.push(db.ref("v1/users/" + uid + "/gps_track/main/" + bk).once("value"));
    reads.push(db.ref("v1/users/" + uid + "/orders/" + ds).once("value"));
    const snaps = await Promise.all(reads);
    orders = snaps.pop().val() || {};
    snaps.forEach(s => { gps = Object.assign(gps, s.val() || {}); });
  } catch (e) {}
  const inWin = Object.values(gps).filter(o => o && o.ts && Number(o.ts) >= dayStart && Number(o.ts) < dayEnd && (o.accuracy_m == null || Number(o.accuracy_m) < 30));
  const sec = inWin.filter(o => o.device === "second");
  const gv = (sec.length ? sec : inWin).sort((a, b) => a.ts - b.ts);
  const gTotal = gv.length;
  if (!gTotal) return { km: 0, durMin: 0, runPct: 0, workStartMs: 0, workEndMs: 0 };
  const lastTs = Number(gv[gTotal - 1].ts), now = Date.now();
  const moveTs = gv.filter(o => { const s = o.speed_kmh != null ? Number(o.speed_kmh) : null; return s != null ? (s > 3 && !o.is_stop) : !o.is_stop; }).map(o => Number(o.ts));
  const ordTs = Object.values(orders || {}).map(o => Number(o && o.detected_at) || 0).filter(t => t >= dayStart && t < dayEnd).sort((a, b) => a - b);
  const COW = 30 * 60000; let workStart = null;
  for (const t of ordTs) { if (moveTs.some(mm => Math.abs(mm - t) <= COW)) { workStart = t; break; } }
  if (workStart == null) workStart = moveTs.length ? moveTs[0] : Number(gv[0].ts);
  const lastMoveTsV = moveTs.length ? moveTs[moveTs.length - 1] : 0, lastOrderTs = ordTs.length ? ordTs[ordTs.length - 1] : 0;
  const lastWorkTs = Math.max(lastMoveTsV, lastOrderTs);
  const ongoing = lastWorkTs && (now - lastWorkTs < 30 * 60000);
  const workEnd = ongoing ? now : (lastWorkTs || lastTs);
  const workMs = workStart && workEnd > workStart ? workEnd - workStart : 0;
  let distM = 0, tripMs = 0, tripStart = null, lastMv = null, prev = null;
  gv.forEach(o => {
    const t = Number(o.ts);
    if (t < workStart || t > workEnd) { prev = null; return; }
    const sp = o.speed_kmh != null ? Number(o.speed_kmh) : null;
    const moving = sp != null ? (sp > 3 && !o.is_stop) : !o.is_stop;
    if (prev) { const dt = t - Number(prev.ts); if (dt > 0 && dt < 15 * 60000) { if (sp != null) { if (sp > 3 && sp < 150) distM += sp / 3.6 * (dt / 1000); } else if (o.lat && o.lng && prev.lat && prev.lng) { const dseg = haversineM(prev.lat, prev.lng, o.lat, o.lng); if (dseg / (dt / 1000) < 42 && !o.is_stop) distM += dseg; } } }
    if (moving) { if (tripStart == null) tripStart = t; lastMv = t; }
    else if (tripStart != null && lastMv != null && t - lastMv > 5 * 60000) { tripMs += lastMv - tripStart; tripStart = null; }
    prev = o;
  });
  if (tripStart != null && lastMv != null) tripMs += lastMv - tripStart;
  const runPct = workMs ? Math.min(100, Math.round(tripMs / workMs * 100)) : 0;
  return { km: +(distM / 1000).toFixed(1), durMin: Math.round(tripMs / 60000), runPct, workStartMs: workStart, workEndMs: workEnd };
}

// onCall(callable) — 앱은 getHttpsCallable("dataTab").call({date}). uid는 인증 컨텍스트에서(개인=호출자 본인).
// data.uid 폴백은 디버그/미인증 호출용. 반환 객체가 클라이언트 result.data 로 옴.
exports.dataTab = functions.region(REGION).runWith({ timeoutSeconds: 300, memory: "512MB" }).https.onCall(async (data, context) => {
  const date = String((data && data.date) || "");
  const uid = (context && context.auth && context.auth.uid) || (data && data.uid) || "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new functions.https.HttpsError("invalid-argument", "date=YYYY-MM-DD 필요");
  const y = +m[1], mo = +m[2], d = +m[3];
  const n = Date.now(), todayKstStart = n - ((n + 9 * 3600000) % 86400000);
  // 6/9 — 오늘은 전체 집계(aggregate, 전 기사 무거움)만 미집계. 본인 운행(personal.drive)은 라이브로 계산해 반환(앱 데이터탭 실시간 표시).
  if (Date.UTC(y, mo - 1, d) - 9 * 3600000 >= todayKstStart) {
    const personal = uid ? { drive: await computePersonal(uid, y, mo, d) } : null;
    return { date, available: false, reason: "오늘은 집계 전(전날까지 조회)", personal };
  }
  let aggregate;
  const cacheRef = db.ref("v1/app/data_cache/" + date);
  const cached = (await cacheRef.once("value")).val();
  if (cached && cached.aggregate) aggregate = cached.aggregate;
  else { aggregate = await computeAggregate(y, mo, d); await cacheRef.set({ aggregate, builtAt: Date.now() }); }
  const personal = uid ? { drive: await computePersonal(uid, y, mo, d) } : null;
  const available = (aggregate.orders.total > 0) || (aggregate.heat && aggregate.heat.length > 0);
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
async function computeMaps(y, mo, d) {
  const ds = dateKey(y, mo, d);
  const dayStart = Date.UTC(y, mo - 1, d) - 9 * 3600000, dayEnd = dayStart + 86400000;
  const uids = await listUids();
  const originCnt = {};
  await Promise.all(uids.map(async uid => {
    try {
      const arr = Object.values((await db.ref("v1/users/" + uid + "/orders/" + ds).once("value")).val() || {}).filter(Boolean);
      arr.forEach(r => { const og = parseOrigin(r); if (og) originCnt[og] = (originCnt[og] || 0) + 1; });
    } catch (e) {}
  }));
  const cache = await geoCache(); const cells = new Map();
  Object.entries(originCnt).forEach(([tok, n]) => {
    const c = resolveGeo(tok, cache);
    if (c && c.lat) { const h = h3.latLngToCell(c.lat, c.lng, 6); let cell = cells.get(h); if (!cell) { cell = { n: 0, top: "", topN: 0 }; cells.set(h, cell); } cell.n += n; if (n > cell.topN) { cell.topN = n; cell.top = tok; } }
  });
  const maxN = cells.size ? Math.max(...[...cells.values()].map(c => c.n)) : 1;
  const hex = [...cells.entries()].sort((a, b) => a[1].n - b[1].n).map(([h, c]) => {
    const idx = Math.min(PAL.length - 1, Math.floor(Math.sqrt(c.n / maxN) * PAL.length));
    return { boundary: h3.cellToBoundary(h), count: c.n, area: c.top, color: PAL[idx] };
  });
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
exports.dataMapsTick = functions.region(REGION).runWith({ timeoutSeconds: 300, memory: "512MB" }).pubsub.schedule("every 30 minutes").onRun(async () => {
  const n = Date.now(), k = new Date(n + 9 * 3600000), y = k.getUTCFullYear(), mo = k.getUTCMonth() + 1, d = k.getUTCDate();
  const maps = await computeMaps(y, mo, d);
  await db.ref("v1/app/data_maps/" + dateKey(y, mo, d)).set(Object.assign(maps, { updatedAt: n }));
  console.log("data_maps updated", dateKey(y, mo, d), "hex", maps.hex.length, "heat", maps.heat.length);
  return null;
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

// [shadow] 야간 정합성 대조(3층) — 매일 새벽1시(KST) 어제 orders 전수를 signature dedup으로 다시 세어 진실 count 산출,
// agg_shadow 증분값과 비교해 드리프트(콜드스타트·재시도 누락)를 원본 기준으로 교정. diff는 agg_shadow_recon에 기록.
// 취소 반영은 status 정의(AS) 후 추가. 현재는 '감지 개수'만 대조.
exports.reconcileShadow = functions.region(REGION).runWith({ timeoutSeconds: 540, memory: "512MB" }).pubsub.schedule("0 1 * * *").timeZone("Asia/Seoul").onRun(async () => {
  const date = kstDate(Date.now() - 86400000);   // 어제(완료된 날)
  const uids = await listUids();
  const diffs = {};
  await Promise.all(uids.map(async uid => {
    try {
      const orders = (await db.ref("v1/users/" + uid + "/orders/" + date).once("value")).val() || {};
      const seen = new Set();
      for (const oid of Object.keys(orders)) { if (orders[oid]) seen.add(shadowKey(orders[oid].signature, oid)); }
      const trueCnt = seen.size;
      const shadowCnt = Number((await db.ref("v1/app/agg_shadow/" + date + "/" + uid).once("value")).val()) || 0;
      if (trueCnt !== shadowCnt) {
        diffs[uid] = { t: trueCnt, s: shadowCnt };
        if (trueCnt > 0) await db.ref("v1/app/agg_shadow/" + date + "/" + uid).set(trueCnt);
        else await db.ref("v1/app/agg_shadow/" + date + "/" + uid).remove();
      }
    } catch (e) {}
  }));
  await db.ref("v1/app/agg_shadow_recon/" + date).set({ at: Date.now(), nDiff: Object.keys(diffs).length, nUsers: uids.length, diffs });
  await db.ref("v1/app/agg_shadow_seen/" + date).remove().catch(() => {});   // 어제 seen은 대조 끝나 불필요 — 누적 방지(HQ 6번)
  console.log("reconcileShadow", date, "diffs", Object.keys(diffs).length, "/", uids.length);
  return null;
});

// 오더 쓰기마다 증분(라이브) — race-safe 클레임(transaction)으로 유저 교차 동시감지도 1콜만.
exports.orderLive = functions.region(REGION).database.instance("quickpilot-39d72-default-rtdb")
  .ref("/v1/users/{uid}/orders/{date}/{orderId}").onWrite(async (change, ctx) => {
    const after = change.after.val(); if (!after) return null;   // 삭제는 무시
    const date = ctx.params.date;
    // [shadow] 감지 카운트 — liveKeyParts 게이트 앞(파싱실패 오더도 reconcile dedup엔 포함되므로 정의 일치). 별도 노드, 기존 동작 무관.
    {
      const sk = shadowKey(after.signature, ctx.params.orderId);
      const sc = await db.ref("v1/app/agg_shadow_seen/" + date + "/" + ctx.params.uid + "/" + sk).transaction(c => c ? undefined : 1);
      if (sc.committed) await db.ref("v1/app/agg_shadow/" + date + "/" + ctx.params.uid).transaction(c => (c || 0) + 1);
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
      if (aRes.committed) await liveRef.update({ ["agencies/" + p.agency]: admin.database.ServerValue.increment(1) });
    }
    return null;
  });
