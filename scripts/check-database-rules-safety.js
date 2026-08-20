const fs = require("fs");
const path = require("path");

const rulesPath = path.resolve(__dirname, "..", "database.rules.json");
const storageRulesPath = path.resolve(__dirname, "..", "storage.rules");
const updateSignalScriptPath = path.resolve(__dirname, "publish-qp-update-signal.ps1");
const raw = fs.readFileSync(rulesPath, "utf8");
const storageRaw = fs.readFileSync(storageRulesPath, "utf8");
const parsed = JSON.parse(raw);
const root = parsed.rules || {};

const failures = [];
const OWNER_OR_ADMIN_WRITE = "auth != null && (auth.uid === $uid || (auth.token.email_verified === true && auth.token.email == 'pnomade12@gmail.com'))";
const RELEASE_ADMIN_WRITE = "auth != null && auth.token.email_verified === true && auth.token.email == 'pnomade12@gmail.com'";
const CONTENT_ADMIN_WRITE = "auth != null && auth.token.email_verified === true && (auth.token.email == 'pnomade12@gmail.com' || auth.token.email == 'pnomade13@gmail.com')";
const SYSTEM_EVENT_FIELDS = ["event", "eventType", "type"];
const NOISY_SYSTEM_EVENT_EXACT = [
  "order_toast_perf_trace",
  "order_toast_stale_on_navigation",
  "ui_state_render",
  "ui_render_after",
];
const NOISY_SYSTEM_EVENT_SAMPLES = [
  "order_toast_perf_trace",
  "order_toast_stale_on_navigation",
  "toast_layout_render",
  "ui_state_render",
  "ui_render_after",
  "settlement_calendar_render",
  "unpaid_candidate_eval",
  "order_card_list_render",
];
const CORE_SYSTEM_EVENT_SAMPLES = [
  "order_attempt",
  "visible_result_signal",
  "state_result",
  "state_sync_no_matching_item",
  "state_sync_applied",
  "manual_edit_apply",
  "manual_edit_submit",
  "totalcall_progress_result_orphaned",
  "totalcall_confirm_result_missing",
  "agency_directory_heart_sync_failed",
];

function get(pathParts) {
  let cur = root;
  for (const part of pathParts) {
    cur = cur && cur[part];
  }
  return cur;
}

function writeRuleAt(pathParts) {
  const node = get(pathParts);
  return node && node[".write"];
}

function requireOwnerOrAdminWrite(pathParts, label) {
  const rule = writeRuleAt(pathParts);
  if (rule !== OWNER_OR_ADMIN_WRITE) {
    failures.push(`${label} write must be limited to owner uid or pnomade12 admin`);
  }
}

function requireBlockedWrite(pathParts, label) {
  const rule = writeRuleAt(pathParts);
  if (rule !== false) {
    failures.push(`${label} write must be blocked in cost-control rules`);
  }
}

function requireAdminAppWrite(pathParts, label) {
  const rule = writeRuleAt(pathParts);
  if (rule !== RELEASE_ADMIN_WRITE) {
    failures.push(`${label} write must stay pnomade12 release-admin-only`);
  }
}

function requireContentAdminWrite(pathParts, label) {
  const rule = writeRuleAt(pathParts);
  if (rule !== CONTENT_ADMIN_WRITE) {
    failures.push(`${label} write must stay verified pnomade12/pnomade13 content-admin-only`);
  }
}

function isNoisySystemEventName(eventName) {
  return NOISY_SYSTEM_EVENT_EXACT.includes(eventName) ||
    eventName.startsWith("toast_") ||
    eventName.startsWith("settlement_") ||
    eventName.startsWith("unpaid_") ||
    /^order_card_.*_render$/.test(eventName);
}

function candidateAllowsSystemEvent(payload) {
  const eventName = SYSTEM_EVENT_FIELDS
    .map((field) => payload[field])
    .find((value) => typeof value === "string");
  if (!eventName) return true;
  if (eventName === "order_sync_pair_audit") {
    return typeof payload.version_code === "number" && payload.version_code >= 193;
  }
  return !isNoisySystemEventName(eventName);
}

function requireSystemEventsNoisyGuard() {
  const node = get(["v1", "users", "$uid", "system_events", "$bucket", "$eventId"]) || {};
  const validate = node[".validate"] || "";
  if (!validate) {
    failures.push("system_events/$bucket/$eventId validate must reject noisy routine events");
    return;
  }
  for (const field of SYSTEM_EVENT_FIELDS) {
    if (!validate.includes(`child('${field}')`)) {
      failures.push(`system_events noisy guard must inspect ${field}`);
    }
  }
  for (const exact of NOISY_SYSTEM_EVENT_EXACT) {
    if (!validate.includes(exact)) {
      failures.push(`system_events noisy guard must reject exact ${exact}`);
    }
  }
  if (!validate.includes("order_sync_pair_audit")) {
    failures.push("system_events legacy audit guard must inspect order_sync_pair_audit");
  }
  if (!validate.includes("version_code") || !validate.includes("< 193")) {
    failures.push("system_events legacy audit guard must block missing or pre-193 version_code");
  }
  for (const marker of ["^toast_", "^settlement_", "^unpaid_", "^order_card_.*_render$"]) {
    if (!validate.includes(marker)) {
      failures.push(`system_events noisy guard must include ${marker}`);
    }
  }
  for (const field of SYSTEM_EVENT_FIELDS) {
    for (const eventName of NOISY_SYSTEM_EVENT_SAMPLES) {
      if (candidateAllowsSystemEvent({ [field]: eventName })) {
        failures.push(`local noisy check must reject ${field}=${eventName}`);
      }
    }
  }
  for (const eventName of CORE_SYSTEM_EVENT_SAMPLES) {
    if (!candidateAllowsSystemEvent({ event: eventName })) {
      failures.push(`local core check must allow event=${eventName}`);
    }
  }
  for (const field of SYSTEM_EVENT_FIELDS) {
    if (candidateAllowsSystemEvent({ [field]: "order_sync_pair_audit" })) {
      failures.push(`local legacy audit check must reject ${field}=order_sync_pair_audit without version_code`);
    }
    if (candidateAllowsSystemEvent({ [field]: "order_sync_pair_audit", version_code: 192 })) {
      failures.push(`local legacy audit check must reject ${field}=order_sync_pair_audit version_code=192`);
    }
    if (!candidateAllowsSystemEvent({ [field]: "order_sync_pair_audit", version_code: 193 })) {
      failures.push(`local legacy audit check must allow ${field}=order_sync_pair_audit version_code=193`);
    }
  }
}

const applicationValidate = ((((root.applications || {}).$id || {})[".validate"]) || "");
if (!applicationValidate.includes("auth != null") || !applicationValidate.includes("pnomade12@gmail.com")) {
  failures.push("applications/$id validate must allow admin status changes");
}
for (const status of ["pending", "approved", "rejected", "deleted"]) {
  if (!applicationValidate.includes(`newData.child('status').val() === '${status}'`)) {
    failures.push(`applications/$id validate must allow ${status} status`);
  }
}

const licenseRead = (((root.licenses || {}).$phone || {})[".read"]) || "";
if (!licenseRead.includes("auth != null")) {
  failures.push("licenses/$phone read must require auth != null");
}
if (!licenseRead.includes("data.child('status').val() === 'active'")) {
  failures.push("licenses/$phone read must allow active licenses without uid");
}
if (!licenseRead.includes("data.child('uid').val() === auth.uid")) {
  failures.push("licenses/$phone read must keep uid-owner read fallback");
}
if (!licenseRead.includes("pnomade12@gmail.com") || !licenseRead.includes("pnomade13@gmail.com")) {
  failures.push("licenses/$phone read must keep admin monitor emails");
}

const userRules = (((root.v1 || {}).users || {}).$uid) || {};
if (Object.prototype.hasOwnProperty.call(userRules, ".write")) {
  failures.push("v1/users/$uid must not keep broad parent .write; child paths must opt in");
}

for (const path of [
  "profile",
  "orders",
  "earnings",
  "expenses",
  "manual_edits",
  "order_edits",
  "status",
  "app_version",
  "gps_track",
  "geo_trace",
  "geo_misses",
  "crash_logs",
  "global_memos",
  "social_feed",
]) {
  requireOwnerOrAdminWrite(["v1", "users", "$uid", path], `v1/users/$uid/${path}`);
}

for (const path of ["window_dumps", "order_logs", "diag"]) {
  requireBlockedWrite(["v1", "users", "$uid", path], `v1/users/$uid/${path}`);
}

for (const path of ["system_events", "user_actions"]) {
  requireOwnerOrAdminWrite(["v1", "users", "$uid", path], `v1/users/$uid/${path}`);
}
requireSystemEventsNoisyGuard();

const orderValidate = get(["v1", "users", "$uid", "orders", "$date"]) || {};
const orderIdValidate = ((orderValidate.$orderId || {})[".validate"]) || "";
if (!orderIdValidate.includes("newData.hasChildren(['platform'])") || !orderIdValidate.includes("newData.child('platform').isString()")) {
  failures.push("orders/$date/$orderId validate must keep platform string requirement");
}

const agencyRules = (((root.v1 || {}).agencies) || {});
const indexOn = agencyRules[".indexOn"] || [];
for (const field of ["phone", "trustScore", "volumeStars"]) {
  if (!Array.isArray(indexOn) || !indexOn.includes(field)) {
    failures.push(`v1/agencies must index ${field}`);
  }
}
const socialFeedRules = (((root.v1 || {}).social_feed) || {});
const socialFeedIndexOn = socialFeedRules[".indexOn"] || [];
if (!Array.isArray(socialFeedIndexOn) || !socialFeedIndexOn.includes("ts")) {
  failures.push("v1/social_feed must index ts for orderByChild(\"ts\").limitToLast reads");
}
const heartWrite = (((agencyRules.$agencyKey || {}).hearts || {}).$uid || {})[".write"] || "";
const heartValidate = (((agencyRules.$agencyKey || {}).hearts || {}).$uid || {})[".validate"] || "";
if (!heartWrite.includes("auth.uid === $uid") || !heartWrite.includes("newData.val() === true") || !heartWrite.includes("!newData.exists()")) {
  failures.push("v1/agencies/$agencyKey/hearts/$uid must allow only own true/delete writes");
}
if (!heartValidate.includes("newData.val() === true") || !heartValidate.includes("!newData.exists()")) {
  failures.push("v1/agencies/$agencyKey/hearts/$uid validate must allow only true/delete");
}
const dislikeWrite = (((agencyRules.$agencyKey || {}).dislikes || {}).$uid || {})[".write"] || "";
const dislikeValidate = (((agencyRules.$agencyKey || {}).dislikes || {}).$uid || {})[".validate"] || "";
if (!dislikeWrite.includes("auth.uid === $uid") || !dislikeWrite.includes("newData.val() === true") || !dislikeWrite.includes("!newData.exists()")) {
  failures.push("v1/agencies/$agencyKey/dislikes/$uid must allow only own true/delete writes");
}
if (!dislikeValidate.includes("newData.val() === true") || !dislikeValidate.includes("!newData.exists()")) {
  failures.push("v1/agencies/$agencyKey/dislikes/$uid validate must allow only true/delete");
}

requireAdminAppWrite(["landing"], "landing");
for (const path of [
  "notice",
  "update_notes_override",
  "update_notes_title_override",
  "update_notes_added",
  "board",
  "board_list",
]) {
  requireContentAdminWrite(["v1", "app", path], `v1/app/${path}`);
}

const boardImagesStart = storageRaw.indexOf("match /board_images/{imageId}");
const boardImagesRule = boardImagesStart >= 0 ? storageRaw.slice(boardImagesStart) : "";
for (const marker of [
  "allow read: if true",
  "request.auth != null",
  "request.auth.token.email_verified == true",
  "pnomade12@gmail.com",
  "pnomade13@gmail.com",
  "request.resource != null",
  "request.resource.size < 2 * 1024 * 1024",
  "request.resource.contentType.matches('image/.*')",
]) {
  if (!boardImagesRule.includes(marker)) {
    failures.push(`storage board_images rule must include ${marker}`);
  }
}

const updateSignalRules = get(["v1", "app", "update_signal"]) || {};
if (updateSignalRules[".read"] !== true) {
  failures.push("v1/app/update_signal read must stay public so every installed app can receive release events");
}
requireAdminAppWrite(["v1", "app", "update_signal"], "v1/app/update_signal");
const updateSignalChannelRules = updateSignalRules.$channel || {};
const updateSignalValidate = updateSignalChannelRules[".validate"] || "";
for (const marker of ["$channel === 'beta'", "$channel === 'gwanje'", "versionCode", "versionName", "apk"]) {
  if (!updateSignalValidate.includes(marker)) {
    failures.push(`v1/app/update_signal/$channel validate must include ${marker}`);
  }
}
const updateSignalApkValidate = ((updateSignalChannelRules.apk || {})[".validate"]) || "";
for (const apk of ["qp-beta.apk", "qp-gwanje.apk"]) {
  if (!updateSignalApkValidate.includes(apk)) {
    failures.push(`v1/app/update_signal/$channel apk validation must bind ${apk}`);
  }
}

if (!fs.existsSync(updateSignalScriptPath)) {
  failures.push("publish-qp-update-signal.ps1 must exist for event-driven update badges");
} else {
  const updateSignalScript = fs.readFileSync(updateSignalScriptPath, "utf8");
  for (const marker of [
    "[switch]$Execute",
    "DRY_RUN",
    "aapt",
    "Get-FileHash",
    "database:set",
    "/v1/app/update_signal/$Channel",
    "--instance",
  ]) {
    if (!updateSignalScript.includes(marker)) {
      failures.push(`publish-qp-update-signal.ps1 must include ${marker}`);
    }
  }
}

if (failures.length) {
  console.error("database.rules.json safety check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("database.rules.json safety check passed");
console.log("cost-control guard: window_dumps/order_logs/diag blocked; system_events noisy routine events rejected; core system_events/user_actions/global_memos/social_feed remain writable");
console.log("system_events noisy guard: event/eventType/type checked; noisy samples rejected; legacy order_sync_pair_audit blocked only when version_code is missing or <193; core samples allowed");
console.log("batch-risk guard: before rules deploy, verify that updateChildren batches never mix blocked paths with core writes");
