const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sources = [
  "public/column-1-ordermap.html",
  "public/column-2-worktime.html",
  "public/column-3-crowd.html",
  "public/column-4-longhaul.html",
  "public/column-5-cargo-load.html",
  "public/special-memo.html",
  "public/column-6-memo-rules.html",
  "public/column-7-destination-origin.html",
  "public/drafts/column-3-night.html",
  "public/drafts/column-3-weekend.html",
  "public/special-longhaul-report-20260709.html",
];
const drafts = Object.fromEntries(sources.map((source) => [
  source.replace(/^public\//, ""),
  fs.readFileSync(path.join(root, source), "utf8"),
]));
const serialized = JSON.stringify(drafts).replace(/<\/script/gi, "<\\/script");
const block = `<!-- REPORT_DRAFT_DATA_START -->\n<script>window.REPORT_DRAFTS = ${serialized};</script>\n<!-- REPORT_DRAFT_DATA_END -->`;
const editorPath = path.join(root, "public/report-editor-edit.html");
const editor = fs.readFileSync(editorPath, "utf8");
if (!editor.includes("<!-- REPORT_DRAFT_DATA_START -->") || !editor.includes("<!-- REPORT_DRAFT_DATA_END -->")) {
  throw new Error("editor data markers not found");
}
const updated = editor.replace(/<!-- REPORT_DRAFT_DATA_START -->[\s\S]*?<!-- REPORT_DRAFT_DATA_END -->/, block);
fs.writeFileSync(editorPath, updated, "utf8");
console.log(`Embedded ${sources.length} report drafts into report-editor-edit.html.`);
