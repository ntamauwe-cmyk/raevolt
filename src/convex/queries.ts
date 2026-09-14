// RAEVOLT dashboard read/write surface. Every query resolves tenant context
// server-side via requireOrgMember so data isolation holds regardless of UI.

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { requireOrgMember, requirePermissionFor, getOrgForMember } from "./lib/rbac";
import { PERMISSIONS } from "./schema";
import { logAudit } from "./lib/audit";
import type { TransactionSummary } from "./payments";

// ---------------------------------------------------------------------------
// Transactions list — filters + cursor pagination
// ---------------------------------------------------------------------------
export const listTransactions = query({
  args: {
    status: v.optional(v.string()),
    search: v.optional(v.string()),
    currency: v.optional(v.string()),
    paginationOpts: v.object({
      numItems: v.number(),
      cursor: v.union(v.string(), v.null()),
    }),
  },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);

    const search = args.search?.trim().toLowerCase();
    if (search) {
      // Search across reference / transactionId / customer email. Index-backed
      // lookups; merge results in createdAt order client-safe.
      const byRef = await ctx.db
        .query("transactions")
        .withIndex("by_reference", (q) => q.eq("orgId", oc.orgId).eq("reference", search))
        .take(args.paginationOpts.numItems);
      const byTxnIdAll = await ctx.db
        .query("transactions")
        .withIndex("by_transaction_id", (q) => q.eq("transactionId", search))
        .take(args.paginationOpts.numItems);
      // Tenant isolation: transactionId is globally unique; filter post-fetch.
      const byTxnId = byTxnIdAll.filter((t) => t.orgId === oc.orgId);
      const byEmail = await ctx.db
        .query("transactions")
        .withIndex("by_org_email_created", (q) =>
          q.eq("orgId", oc.orgId).eq("customerEmail", search),
        )
        .order("desc")
        .take(args.paginationOpts.numItems);

      const seen = new Set<string>();
      const merged = [...byRef, ...byTxnId, ...byEmail]
        .filter((t) => {
          if (seen.has(t._id)) return false;
          seen.add(t._id);
          return true;
        })
        .sort((a, b) => b.createdAt - a.createdAt);

      return {
        page: merged,
        isDone: true,
        continueCursor: args.paginationOpts.cursor ?? "",
      };
    }

    if (args.status) {
      return ctx.db
        .query("transactions")
        .withIndex("by_org_status_created", (q) =>
          q
            .eq("orgId", oc.orgId)
            .eq("status", args.status as never)
            .gt("createdAt", 0),
        )
        .order("desc")
        .paginate(args.paginationOpts);
    }

    return ctx.db
      .query("transactions")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// ---------------------------------------------------------------------------
// Transaction 360 — one complete view (prompt §38)
// ---------------------------------------------------------------------------
export const getTransaction360 = query({
  args: { transactionId: v.string() },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);

    const txn = await ctx.db
      .query("transactions")
      .withIndex("by_transaction_id", (q) => q.eq("transactionId", args.transactionId))
      .unique();
    if (!txn || txn.orgId !== oc.orgId) return null; // tenant isolation

    const events = await ctx.db
      .query("transactionEvents")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .collect();
    events.sort((a, b) => a.at - b.at);

    const ledger = await ctx.db
      .query("ledgerEntries")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .collect();
    ledger.sort((a, b) => a.at - b.at);

    const webhooks = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
      .collect();

    const merchant = await ctx.db.get(txn.merchantId);

    return {
      transaction: txn,
      merchantName: merchant?.name ?? "Merchant",
      events: events.map((e) => ({
        _id: e._id,
        type: e.type,
        fromStatus: e.fromStatus ?? null,
        toStatus: e.toStatus ?? null,
        data: (e.data ?? null) as unknown,
        actor: e.actor,
        at: e.at,
      })),
      ledger: ledger.map((e) => ({
        _id: e._id,
        ledgerRef: e.ledgerRef,
        accountCode: e.accountCode,
        direction: e.direction,
        amountMinor: e.amountMinor,
        currency: e.currency,
        description: e.description,
        at: e.at,
      })),
      webhooks: webhooks.map((w) => ({
        _id: w._id,
        event: w.event,
        status: w.status,
        attempts: w.attempts,
        responseStatus: w.responseStatus ?? null,
        lastError: w.lastError ?? null,
        createdAt: w.createdAt,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Overview stats — computed from transactions for the signed-in org
// ---------------------------------------------------------------------------
export const getOverviewStats = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const oc = await requireOrgMember(ctx);
    const days = args.days ?? 30;
    const since = Date.now() - days * 86_400_000;

    const txns = await ctx.db
      .query("transactions")
      .withIndex("by_org_created", (q) => q.eq("orgId", oc.orgId).gte("createdAt", since))
      .collect();

    const byDay = new Map<string, { volume: number; count: number; successful: number; failed: number }>();
    let volume = 0;
    let fees = 0;
    let successful = 0;
    let failed = 0;
    let refunded = 0;
    let pending = 0;
    const currencyCounts = new Map<string, number>();
    const methodCounts = new Map<string, number>();
    const failureCategories = new Map<string, number>();

    for (const t of txns) {
      const d = new Date(t.createdAt);
      const dayKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const bucket = byDay.get(dayKey) ?? { volume: 0, count: 0, successful: 0, failed: 0 };
      bucket.count += 1;
      if (t.status === "SUCCESSFUL" || t.status === "PARTIALLY_REFUNDED" || t.status === "REFUNDED") {
        bucket.successful += 1;
        bucket.volume += t.amountMinor;
        volume += t.amountMinor;
        fees += t.feeMinor ?? 0;
      } else if (t.status === "FAILED") {
        bucket.failed += 1;
        failed += 1;
        if (t.failureCategory) {
          failureCategories.set(t.failureCategory, (failureCategories.get(t.failureCategory) ?? 0) + 1);
        }
      } else if (t.status === "PENDING" || t.status === "PROCESSING" || t.status === "CREATED") {
        pending += 1;
      }
      if (t.status === "REFUNDED" || t.status === "PARTIALLY_REFUNDED") {
        refunded += t.refundedMinor ?? 0;
      }
      currencyCounts.set(t.currency, (currencyCounts.get(t.currency) ?? 0) + 1);
      methodCounts.set(t.paymentMethod, (methodCounts.get(t.paymentMethod) ?? 0) + 1);
      byDay.set(dayKey, bucket);
    }

    const series = Array.from(byDay.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, v]) => ({ day, ...v }));

    const total = txns.length;
    const settled = successful; // attempts that reached SUCCESS
    const topMethod = Array.from(methodCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
      volume,
      fees,
      refunded,
      successful,
      failed,
      pending,
      total,
      successRate: total > 0 ? Math.round((settled / Math.max(successful + failed, 1)) * 100) : 0,
      series,
      currencyCounts: Array.from(currencyCounts.entries()).map(([currency, count]) => ({ currency, count })),
      methodCounts: Array.from(methodCounts.entries()).map(([method, count]) => ({ method, count })),
      failureCategories: Array.from(failureCategories.entries())
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      primaryCurrency: txns[0]?.currency ?? oc.org.settings?.currency ?? "NGN",
      topMethod,
    };
  },
});

// ---------------------------------------------------------------------------
// Dashboard-initiated payments — same engine as the API (prompt §5).
// Actions (not mutations) because the provider adapter call is async.
// ---------------------------------------------------------------------------
export const resolvePaymentContext = query({
  args: {},
  handler: async (ctx) => {
    const oc = await requirePermissionFor(ctx, PERMISSIONS.PAYMENTS_CREATE);
    const merchant = await ctx.db
      .query("merchants")
      .withIndex("by_org", (q) => q.eq("orgId", oc.orgId))
      .first();
    if (!merchant) throw new ConvexError("No merchant configured for this organization");
    if (merchant.status !== "active") {
      throw new ConvexError(`Merchant is ${merchant.status}; payments are disabled.`);
    }
    return {
      orgId: oc.orgId,
      merchantId: merchant._id,
      environment: (oc.org.environment ?? "sandbox") as "sandbox" | "production",
      currency: merchant.defaultCurrency,
    };
  },
});

export const createDashboardPayment = action({
  args: {
    amountMinor: v.number(),
    currency: v.string(),
    reference: v.optional(v.string()),
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
    paymentMethod: v.string(),
    simulate: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TransactionSummary> => {
    const pc = await ctx.runQuery(api.queries.resolvePaymentContext, {});

    if (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0) {
      throw new ConvexError("Amount must be a positive integer of minor units");
    }

    const reference =
      args.reference?.trim() || `dash_${Date.now().toString(36)}`;

    // Route through the same payment action as the HTTP API so behavior is
    // identical across entry points.
    const result = await ctx.runAction(internal.payments.processPaymentInternal, {
      orgId: pc.orgId,
      merchantId: pc.merchantId,
      environment: pc.environment,
      amountMinor: args.amountMinor,
      currency: args.currency,
      reference,
      paymentMethod: args.paymentMethod,
      customerEmail: args.customerEmail,
      customerName: args.customerName,
      metadata: args.simulate || args.description
        ? { simulate: args.simulate, description: args.description }
        : undefined,
    });

    if (result.kind === "no_provider") {
      throw new ConvexError(result.error?.message ?? "No payment provider is configured for this environment.");
    }
    if (!result.transaction) {
      throw new ConvexError("Payment processing failed");
    }
    return result.transaction;
  },
});

export const refundDashboardPayment = action({
  args: { transactionId: v.string(), amountMinor: v.optional(v.number()), reason: v.optional(v.string()) },
  handler: async (ctx, args): Promise<TransactionSummary> => {
    await ctx.runQuery(api.queries.resolvePaymentContext, {});
    const result = await ctx.runAction(internal.payments.refundInternal, {
      transactionId: args.transactionId,
      amountMinor: args.amountMinor,
      reason: args.reason,
    });
    if (result.kind === "error") {
      throw new ConvexError(result.message ?? "Refund failed");
    }
    if (!result.transaction) {
      throw new ConvexError("Refund failed");
    }
    return result.transaction;
  },
});
