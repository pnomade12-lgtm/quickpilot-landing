const fs = require("fs");
const path = require("path");

const rootFile = path.join(__dirname, "..", "monitor-all.html");
const publicFile = path.join(__dirname, "..", "public", "monitor-all.html");
const root = fs.readFileSync(rootFile, "utf8");
const published = fs.readFileSync(publicFile, "utf8");

if (root !== published) throw new Error("root and public monitor files must match");

const start = root.indexOf("async function openAgencies()");
const end = root.indexOf("async function openAddrs()", start);
if (start < 0 || end < 0) throw new Error("agency monitor section not found");
const section = root.slice(start, end);

const required = [
  "const byPhone = new Map()",
  "Object.entries(o)",
  "String(a.phone || key)",
  ".filter(a => a.phone.length >= 7 && a.cnt >= 10)",
  "byPhone.set(a.phone, a)",
  "agencyList = Array.from(byPhone.values())",
  'return count > 0 ? "⭐️".repeat(count) : "-"',
  'const trust = a.trust == null ? "-"',
];
required.forEach(value => {
  if (!section.includes(value)) throw new Error(`missing agency monitor contract: ${value}`);
});

if (section.includes("a.trust != null")) throw new Error("trust score must not gate the 10-order directory");
if (section.includes("insung_agency_stats_meta")) throw new Error("stats window must not gate the 10-order directory");

console.log("verify-agency-monitor-volume-list: PASS");
