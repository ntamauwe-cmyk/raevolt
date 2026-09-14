// Internal queries backing the public API actions (tenant-scoped, engine-side).

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

export const orgPrimaryMerchantInternal = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    return ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();
  },
});

export const transactionForOrgInternal = internalQuery({
  args: { orgId: v.id("organizations"), transactionId: v.string() },
  handler: async (ctx, args) => {
    const txn = await ctx.db
      .query("transactions")
      .withIndex("by_transaction_id", (q) => q.eq("transactionId", args.transactionId))
      .unique();
    if (!txn || txn.orgId !== args.orgId) return null; // tenant isolation
    return txn;
  },
});

export const orgBalancesInternal = internalQuery({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const merchants = await ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const out: { merchantName: string; currency: string; balanceMinor: number; kind: string }[] = [];
    for (const m of merchants) {
      const accounts = await ctx.db
        .query("ledgerAccounts")
        .withIndex("by_org_kind", (q) => q.eq("orgId", args.orgId).eq("kind", "merchant_balance"))
        .collect();
      for (const account of accounts) {
        if (!account.code.startsWith(`merch_${m._id}_`)) continue;
        const entries = await ctx.db
          .query("ledgerEntries")
          .withIndex("by_account_at", (q) => q.eq("accountId", account._id))
          .collect();
        let balanceMinor = 0;
        for (const e of entries) balanceMinor += e.direction === "credit" ? e.amountMinor : -e.amountMinor;
        out.push({
          merchantName: m.name,
          currency: account.currency,
          balanceMinor,
          kind: "merchant_balance",
        });
      }
    }
    return out;
  },
});

export const listBatchesInternal = internalQuery({
  args: { orgId: v.id("organizations"), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("settlementBatches")
      .withIndex("by_org_created", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(args.limit);
  },
});

// --- Payouts API support ---
export const listPayoutsInternal = internalQuery({
  args: { orgId: v.id("organizations"), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("payouts")
      .withIndex("by_org_created", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(args.limit);
  },
});

export const beneficiaryByIdInternal = internalQuery({
  args: { beneficiaryId: v.id("beneficiaries") },
  handler: async (ctx, args) => ctx.db.get(args.beneficiaryId),
});

export const payoutByPayoutIdInternal = internalQuery({
  args: { payoutId: v.string() },
  handler: async (ctx, args) => {
    const p = await ctx.db
      .query("payouts")
      .withIndex("by_payout_id", (q) => q.eq("payoutId", args.payoutId))
      .unique();
    return p ?? null;
  },
});

// --- Customers API support ---
export const listCustomersInternal = internalQuery({
  args: { orgId: v.id("organizations"), limit: v.number() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("customers")
      .withIndex("by_org_created", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(args.limit);
  },
});

// --- Checkout (payment links) support ---
export const linkForCheckoutInternal = internalQuery({
  args: { linkId: v.string() },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("paymentLinks")
      .withIndex("by_link_id", (q) => q.eq("linkId", args.linkId))
      .unique();
    if (!link) return null;
    const merchant = await ctx.db.get(link.merchantId);
    return { link, merchantName: merchant?.name ?? "Merchant" };
  },
});
