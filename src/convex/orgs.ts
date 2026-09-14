// RAEVOLT org bootstrap + tenant context (prompt §6).
//
// The dashboard session is scoped to exactly one organization. On first
// sign-in an org + merchant are provisioned automatically, so a merchant can
// take their first payment within seconds. All dashboard queries resolve
// tenant context through requireOrgMember — data isolation is enforced
// server-side, never by the UI.

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireOrgMember, getOrgForMember } from "./lib/rbac";
import { ROLE_PERMISSIONS } from "./schema";
import { generateApiKey, hashApiKey } from "./lib/apikeys";
import { logAudit } from "./lib/audit";
import { CURRENCIES, isSupportedCurrency } from "../lib/money";

// ---------------------------------------------------------------------------
// Bootstrap: get-or-create the caller's organization + default merchant
// ---------------------------------------------------------------------------
export const bootstrapOrg = mutation({
  args: {
    orgName: v.optional(v.string()),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("UNAUTHENTICATED");

    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("UNAUTHENTICATED");

    const existing = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) {
      const org = await ctx.db.get(existing.orgId);
      return { orgId: existing.orgId, role: existing.role, created: false };
    }

    const orgName = args.orgName?.trim() || user.name || "My Organization";
    const currency =
      args.currency && isSupportedCurrency(args.currency) ? args.currency : "NGN";

    const orgId = await ctx.db.insert("organizations", {
      name: orgName,
      slug: `org_${userId.slice(-8)}_${Date.now().toString(36)}`,
      environment: "sandbox",
      settings: { currency },
      createdByUserId: userId,
    });

    await ctx.db.insert("orgMembers", {
      orgId,
      userId,
      role: "owner",
      joinedAt: Date.now(),
    });

    const merchantId = await ctx.db.insert("merchants", {
      orgId,
      name: orgName,
      status: "active",
      defaultCurrency: currency,
      feeBps: 150, // 1.5% default — configurable per merchant later
      feeFixedMinor: 0,
      createdByUserId: userId,
    });

    await logAudit(ctx, {
      orgId,
      actor: userId,
      action: "org.created",
      resource: "organization",
      resourceId: orgId,
      after: { name: orgName, merchantId },
    });

    return { orgId, role: "owner" as const, created: true };
  },
});

// ---------------------------------------------------------------------------
// Context for the dashboard shell
// ---------------------------------------------------------------------------
export const getOrgContext = query({
  args: {},
  handler: async (ctx) => {
    const oc = await getOrgForMember(ctx);
    if (!oc) return null;
    return {
      org: {
        _id: oc.org._id,
        name: oc.org.name,
        environment: oc.org.environment ?? "sandbox",
        settings: oc.org.settings,
      },
      role: oc.role,
      permissions: Array.from(oc.permissions),
      member: { _id: oc.member._id, role: oc.member.role },
    };
  },
});

export const listMembers = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    const members = await ctx.db
      .query("orgMembers")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .collect();
    return Promise.all(
      members.map(async (m) => {
        const u = await ctx.db.get(m.userId);
        return {
          _id: m._id,
          userId: m.userId,
          name: u?.name ?? u?.email ?? "Member",
          email: u?.email ?? null,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// Team management (RBAC, prompt §7)
// ---------------------------------------------------------------------------
export const updateMemberRole = mutation({
  args: { memberId: v.id("orgMembers"), role: v.string() },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has("org:manage")) {
      throw new ConvexError("FORBIDDEN: missing permission 'org:manage'");
    }
    const validRoles = Object.keys(ROLE_PERMISSIONS);
    if (!validRoles.includes(args.role)) {
      throw new ConvexError(`VALIDATION_ERROR: unknown role '${args.role}'`);
    }
    const member = await ctx.db.get(args.memberId);
    if (!member || member.orgId !== oc.orgId) {
      throw new ConvexError("NOT_FOUND: member does not belong to this organization");
    }
    if (member.role === "owner" && args.role !== "owner") {
      const owners = await ctx.db
        .query("orgMembers")
        .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
        .collect();
      if (owners.filter((m) => m.role === "owner").length <= 1) {
        throw new ConvexError("CONFLICT: an organization must keep at least one owner");
      }
    }
    const before = member.role;
    await ctx.db.patch(args.memberId, { role: args.role as never });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "member.role_changed",
      resource: "orgMember",
      resourceId: args.memberId,
      before: { role: before },
      after: { role: args.role },
    });
  },
});

// ---------------------------------------------------------------------------
// Merchant configuration
// ---------------------------------------------------------------------------
export const listMerchants = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requireOrgMember(ctx);
    return ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .collect();
  },
});

export const updateMerchantFees = mutation({
  args: {
    merchantId: v.id("merchants"),
    feeBps: v.number(),
    feeFixedMinor: v.number(),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has("org:manage")) {
      throw new ConvexError("FORBIDDEN: missing permission 'org:manage'");
    }
    const merchant = await ctx.db.get(args.merchantId);
    if (!merchant || merchant.orgId !== oc.orgId) {
      throw new ConvexError("NOT_FOUND");
    }
    if (args.feeBps < 0 || args.feeBps > 10_000 || !Number.isInteger(args.feeBps)) {
      throw new ConvexError("VALIDATION_ERROR: feeBps must be an integer between 0 and 10000");
    }
    await ctx.db.patch(args.merchantId, {
      feeBps: args.feeBps,
      feeFixedMinor: Math.max(0, Math.round(args.feeFixedMinor)),
    });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "merchant.fees_updated",
      resource: "merchant",
      resourceId: args.merchantId,
      before: { feeBps: merchant.feeBps, feeFixedMinor: merchant.feeFixedMinor },
      after: { feeBps: args.feeBps, feeFixedMinor: args.feeFixedMinor },
    });
  },
});

export const updateOrgEnvironment = mutation({
  args: { environment: v.union(v.literal("sandbox"), v.literal("production")) },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    if (!oc.permissions.has("org:manage")) {
      throw new ConvexError("FORBIDDEN: missing permission 'org:manage'");
    }
    await ctx.db.patch(oc.orgId, { environment: args.environment });
    await logAudit(ctx, {
      orgId: oc.orgId,
      actor: oc.userId,
      action: "org.environment_changed",
      resource: "organization",
      resourceId: oc.orgId,
      after: { environment: args.environment },
    });
  },
});

export const supportedCurrencies = query({
  args: {},
  handler: async () => Object.values(CURRENCIES),
});
