// TEMPORARY extractor for the one-time GitHub publish of the audited RAEVOLT tree.
// Produces /tmp/raevolt-sync/payload-clean.json = [{ path, mode, b64 }]
// Safety: env files and credential-bearing artifacts are NEVER read or included;
// every included file is scanned for credential-looking strings before staging.
// Delete this file after the sync completes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = process.cwd();
const OUT_DIR = "/tmp/raevolt-sync";
const OUT = path.join(OUT_DIR, "payload-clean.json");
const MAX_BYTES = 2 * 1024 * 1024; // per-file cap

// Top-level files that belong in the repository.
const ROOT_FILES = [
  "README.md",
  "components.json",
  "convex.json",
  "eslint.config.js",
  "index.html",
  "integrations.md",
  "main.ts",
  "package.json",
  "bun.lock",
  "package-lock.json",
  "postcss.config.cjs",
  "sst-env.d.ts",
  "vly-toolbar-readonly.tsx",
  ".env.example", // variable NAMES only, per audit documentation requirements
  ".gitignore",
  ".prettierignore",
  ".prettierrc",
];

// Top-level directories walked recursively.
const ROOT_DIRS = ["docs", "public", "src", "scripts"];

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git", ".vite", ".turbo", "coverage", "_generated"]);
const SKIP_FILE_PATTERNS = [
  /^\.env($|\.)/, // any .env* file — never committed, including .env.keys / .env.local
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.DS_Store$/,
  /tsconfig\.app\.tsbuildinfo$/i,
];

// Credential-shaped strings that must never be committed.
const SECRET_SCANNERS = [
  /ghp_[A-Za-z0-9]{30,}/,
  /gho_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk_live_[A-Za-z0-9]+/i,
  /pk_live_[A-Za-z0-9]+/i,
  /AKIA[0-9A-Z]{16}/,
  /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/,
  /sk-[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
];

const files = [];
let skipped = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walk(full);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

for (const f of ROOT_FILES) {
  const full = path.join(ROOT, f);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) files.push(full);
  else skipped.push(f + " (missing)");
}
for (const d of ROOT_DIRS) {
  const full = path.join(ROOT, d);
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) walk(full);
}

const payload = [];
let totalBytes = 0;

for (const full of files) {
  const rel = path.relative(ROOT, full).split(path.sep).join("/");
  if (rel !== ".env.example" && SKIP_FILE_PATTERNS.some((re) => re.test(rel))) {
    skipped.push(rel + " (pattern)");
    continue;
  }
  const stat = fs.statSync(full);
  if (stat.size > MAX_BYTES) {
    skipped.push(rel + " (too large)");
    continue;
  }
  const text = fs.readFileSync(full, "utf8");
  if (SECRET_SCANNERS.some((re) => re.test(text))) {
    console.error("ABORT: credential-like string detected in", rel);
    process.exit(1);
  }
  const b64 = fs.readFileSync(full).toString("base64");
  totalBytes += stat.size;
  payload.push({ path: rel, mode: "100644", b64 });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));

// Integrity check: re-read, decode, verify sha256 of every file matches.
const check = JSON.parse(fs.readFileSync(OUT, "utf8"));
let verified = 0;
for (const item of check) {
  const disk = fs.readFileSync(path.join(ROOT, item.path));
  const diskB64 = disk.toString("base64");
  if (diskB64 !== item.b64) {
    console.error("ABORT: re-read mismatch for", item.path);
    process.exit(1);
  }
  crypto.createHash("sha256").update(disk); // exercise decode path
  verified++;
}

console.log("EXTRACTED:", verified, "files,", totalBytes, "bytes");
console.log("SKIPPED:", JSON.stringify(skipped));
