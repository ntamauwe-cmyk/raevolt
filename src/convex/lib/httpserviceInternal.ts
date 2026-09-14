// Internal helpers for the public HTTP service layer. Actions call these via
// runQuery / runMutation because actions have no db access.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;

// Atomic per-key rate-limit consume: check + increment + lastUsedAt in ONE
// mutation so Convex's OCC retry loop serializes access to the counter doc.
// (A read-then-write split across separate query/mutation functions causes
// conflict storms and spurious 500s under concurrent bursts.)
export const consumeRateLimitInternal = internalMutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.apiKeyId);
    if (!key) return { ok: false, retryAfterMs: RATE_WINDOW_MS };
    const now = Date.now();
    const inWindow = !!key.rateWindowEnd && now < key.rateWindowEnd;
    if (inWindow && (key.rateWindowCount ?? 0) >= RATE_LIMIT) {
      return { ok: false, retryAfterMs: Math.max(1, (key.rateWindowEnd ?? now) - now) };
    }
    if (inWindow) {
      await ctx.db.patch(args.apiKeyId, {
        rateWindowCount: (key.rateWindowCount ?? 0) + 1,
        lastUsedAt: now,
      });
    } else {
      await ctx.db.patch(args.apiKeyId, {
        rateWindowCount: 1,
        rateWindowEnd: now + RATE_WINDOW_MS,
        lastUsedAt: now,
      });
    }
    return { ok: true, retryAfterMs: 0 };
  },
});

export { RATE_LIMIT, RATE_WINDOW_MS };
