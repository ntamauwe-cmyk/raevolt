// Driver: stage the extracted RAEVOLT tree into Convex for the GitHub publish.
// Ephemeral tooling — safe to delete after the sync.
import fs from "node:fs";
import { execSync } from "node:child_process";

const clean = JSON.parse(fs.readFileSync("/tmp/raevolt-sync/payload-clean.json", "utf8"));

function runConvex(fn, argsObj) {
  const json = JSON.stringify(argsObj);
  const out = execSync(`bunx convex run ${fn} '${json.replace(/'/g, `'\\''`)}'`, {
    encoding: "utf8",
    timeout: 100_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.trim();
}

runConvex("gitSyncTemp:stageClear", {});
console.log("stage cleared");

const PART_BYTES = 60 * 1024;
let rows = [];
let sentRows = 0;
let filesDone = 0;

function flush() {
  if (!rows.length) return;
  runConvex("gitSyncTemp:stageAppend", { files: rows });
  sentRows += rows.length;
  rows = [];
}

for (const f of clean) {
  const totalParts = Math.max(1, Math.ceil(f.b64.length / PART_BYTES));
  for (let p = 0; p < totalParts; p++) {
    rows.push({
      path: f.path,
      mode: f.mode,
      part: p,
      totalParts,
      b64: f.b64.slice(p * PART_BYTES, (p + 1) * PART_BYTES),
    });
  }
  filesDone++;
  // POSIX arg limit is 128KB per argument — flush well below it.
  const pendingBytes = rows.reduce((a, r) => a + r.b64.length, 0);
  if (pendingBytes > 80_000 || rows.length > 8) flush();
  if (filesDone % 25 === 0) console.log("queued", filesDone, "files");
}
flush();
console.log("STAGING COMPLETE:", filesDone, "files queued");
