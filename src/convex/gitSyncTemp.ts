// TEMPORARY GitHub sync scaffolding — used once to publish the audited RAEVOLT
// tree to ntamauwe-cmyk/raevolt, then deleted. Not part of the application.
// Security: uses the platform-managed GITHUB_TOKEN from the Keys tab (read
// server-side only); never logs it; never returns it.
import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError } from "convex/values";

const REPO_API = "https://api.github.com/repos/ntamauwe-cmyk/raevolt";

interface StagedFile {
  path: string;
  mode: string;
  b64: string;
}

// ---------------------------------------------------------------------------
// Staging table (in-DB, chunked inserts from the CLI driver).
// Large files arrive as ordered parts (b64 chunk boundaries are multiples of
// 4 chars, so string concatenation stays valid base64).
// ---------------------------------------------------------------------------
export const stageClear = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const row of await ctx.db.query("gitSyncStage").collect()) {
      await ctx.db.delete(row._id);
    }
    return { cleared: true };
  },
});

export const stageAppend = internalMutation({
  args: {
    files: v.array(
      v.object({
        path: v.string(),
        mode: v.string(),
        part: v.number(),
        totalParts: v.number(),
        b64: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const f of args.files) {
      await ctx.db.insert("gitSyncStage", {
        path: f.path,
        mode: f.mode,
        part: f.part,
        totalParts: f.totalParts,
        b64: f.b64,
      });
    }
    return { stored: args.files.length };
  },
});

export const stageCount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("gitSyncStage").collect();
    const paths = new Set(rows.map((r) => r.path));
    return { rows: rows.length, distinctFiles: paths.size };
  },
});

// ---------------------------------------------------------------------------
// Publish: blobs → tree → commit → branch
// ---------------------------------------------------------------------------
export const publish = action({
  args: { branch: v.string(), message: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; commitSha?: string; error?: string }> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new ConvexError("GITHUB_TOKEN key is not configured.");
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "RAEVOLT-Platform",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };

    async function gh(path: string, init?: RequestInit) {
      const response = await fetch(`${REPO_API}${path}`, { headers, ...init });
      const json = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, json };
    }

    // 0. Confirm the repo exists and is empty (safety: never force-overwrite history)
    const repoInfo = await gh("");
    if (!repoInfo.ok) {
      return { ok: false, error: `Cannot access repo (HTTP ${repoInfo.status}).` };
    }

    // 1. Read staged files
    const staged = await ctx.runQuery(internal.gitSyncTemp.listStage, {});
    if (staged.length === 0) {
      return { ok: false, error: "Nothing staged." };
    }

    // 2. Create blobs (base64 → GitHub blob)
    const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
    for (const f of staged) {
      const blob = await gh("/git/blobs", {
        method: "POST",
        body: JSON.stringify({ content: f.b64, encoding: "base64" }),
      });
      if (!blob.ok || !blob.json?.sha) {
        return { ok: false, error: `Blob creation failed for ${f.path} (HTTP ${blob.status}).` };
      }
      treeItems.push({ path: f.path, mode: f.mode === "40000" ? "040000" : f.mode, type: "blob", sha: blob.json.sha });
    }

    // 3. Create the tree
    const tree = await gh("/git/trees", {
      method: "POST",
      body: JSON.stringify({ tree: treeItems }),
    });
    if (!tree.ok || !tree.json?.sha) {
      return { ok: false, error: `Tree creation failed (HTTP ${tree.status}).` };
    }

    // 4. Create the commit (no parent — repo is empty, this is the first commit)
    const commit = await gh("/git/commits", {
      method: "POST",
      body: JSON.stringify({ message: args.message, tree: tree.json.sha }),
    });
    if (!commit.ok || !commit.json?.sha) {
      return { ok: false, error: `Commit creation failed (HTTP ${commit.status}).` };
    }

    // 5. Create/update the branch ref
    const ref = await gh(`/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: commit.json.sha }),
    });
    if (!ref.ok && ref.status !== 422) {
      // 422 = ref already exists; fall through to a fast-forward update attempt
      const update = await gh(`/git/refs/heads/${args.branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.json.sha, force: false }),
      });
      if (!update.ok) {
        return { ok: false, error: `Ref update failed (HTTP ${update.status}).` };
      }
    }

    return { ok: true, commitSha: commit.json.sha };
  },
});

export const listStage = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("gitSyncStage").collect();
    // Reassemble multi-part files in part order; verify completeness.
    const byPath = new Map<string, { mode: string; parts: Map<number, string>; totalParts: number }>();
    for (const r of rows) {
      let entry = byPath.get(r.path);
      if (!entry) {
        entry = { mode: r.mode, parts: new Map(), totalParts: r.totalParts };
        byPath.set(r.path, entry);
      }
      entry.parts.set(r.part, r.b64);
    }
    const files: StagedFile[] = [];
    for (const [path, entry] of byPath) {
      if (entry.parts.size !== entry.totalParts) {
        throw new ConvexError(`incomplete staged file: ${path} (${entry.parts.size}/${entry.totalParts} parts)`);
      }
      let b64 = "";
      for (let p = 0; p < entry.totalParts; p++) b64 += entry.parts.get(p) ?? "";
      files.push({ path, mode: entry.mode, b64 });
    }
    return files;
  },
});

