// RAEVOLT payment engine (prompt §8, §12, §17, §35).
//
// State machine (append-only, every transition recorded):
//   CREATED → PENDING → PROCESSING → SUCCESSFUL | FAILED | CANCELLED
//   SUCCESSFUL → REFUNDED | PARTIALLY_REFUNDED | REVERSED | DISPUTED
//
// Money is integer minor units. Financial correctness before features.

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { computeFees } from "./lib/fees";
import { evaluatePaymentRisk } from "./lib/risk";
import {
  postDoubleEntry,
  merchantAccountCode,
  providerClearingCode,
  feesAccountCode,
  ACCOUNT_KINDS,
} from "./lib/ledger";
import { logAudit } from "./lib/audit";
import { selectProvider, ProviderUnavailableError } from "./providers/index";
import { isSupportedCurrency } from "../lib/money";
import { withIdempotency, fingerprint } from "./lib/idempotency";

// ---------------------------------------------------------------------------
// Internal queries used by the HTTP layer
// ---------------------------------------------------------------------------

/** Load an API key by SHA-256 hash. The hash itself is never returned. */
export const apiKeyByHash = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash))
      .unique();
    if (!key || key.status !== "active") return null;
    return {
      _id: key._id,
      orgId: key.orgId,
      merchantId: key.merchantId,
      environment: key.environment,
      mode: key.mode,
      prefix: key.prefix,
    };
  },
});

export const transactionByTransactionId = internalQuery({
  args: { transactionId: v.string() },
  handler: async (ctx, args) => {
    return (
      (await ctx.db
        .query("transactions")
        .withIndex("by_transaction_id", (q) => q.eq("transactionId", args.transactionId))
        .unique()) ?? null
    );
  },
});

/** Flat, serializable transaction summary returned by engine mutations. */
export interface TransactionSummary {
  transactionId: string;
  status: string;
  amountMinor: number;
  currency: string;
  feeMinor: number | null;
  netMinor: number | null;
  provider: string;
  providerReference: string | null;
  failure: {
    category: string;
    code: string;
    message: string;
    retryable: boolean;
  } | null;
}

function summarize(t: Doc<"transactions">): TransactionSummary {
  return {
    transactionId: t.transactionId,
    status: t.status,
    amountMinor: t.amountMinor,
    currency: t.currency,
    feeMinor: t.feeMinor ?? null,
    netMinor: t.netMinor ?? null,
    provider: t.provider,
    providerReference: t.providerReference ?? null,
    failure:
      t.failureCategory && t.failureCode
        ? {
            category: t.failureCategory,
            code: t.failureCode,
            message: t.failureMessage ?? "",
            retryable: t.failureRetryable ?? false,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Transaction creation (called from the HTTP action)
// ---------------------------------------------------------------------------
export const createTransactionInternal = internalMutation({
  args: {
    orgId: v.id("organizations"),
    merchantId: v.id("merchants"),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    amountMinor: v.number(),
    currency: v.string(),
    reference: v.string(),
    paymentMethod: v.string(),
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
    metadata: v.optional(v.any()),
    idempotencyKey: v.optional(v.string()),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    if (!Number.isInteger(args.amountMinor) || args.amountMinor <= 0) {
      throw new ConvexError("VALIDATION_ERROR: amount must be a positive integer of minor units");
    }
    if (!isSupportedCurrency(args.currency)) {
      throw new ConvexError(`VALIDATION_ERROR: unsupported currency '${args.currency}'`);
    }

    // Duplicate merchant reference protection (prompt §9).
    const dup = await ctx.db
      .query("transactions")
      .withIndex("by_reference", (q) =>
        q.eq("orgId", args.orgId).eq("reference", args.reference),
      )
      .first();
    if (dup) {
      throw new ConvexError(
        `CONFLICT: reference '${args.reference}' already used by transaction ${dup.transactionId}`,
      );
    }

    const transactionId = `txn_${now.toString(36)}${Math.floor(Math.random() * 1e6)
      .toString(36)
      .padStart(4, "0")}`;

    const docId = await ctx.db.insert("transactions", {
      orgId: args.orgId,
      merchantId: args.merchantId,
      environment: args.environment,
      status: "CREATED",
      amountMinor: args.amountMinor,
      currency: args.currency,
      reference: args.reference,
      transactionId,
      idempotencyKey: args.idempotencyKey,
      provider: "unassigned",
      paymentMethod: args.paymentMethod,
      customerEmail: args.customerEmail,
      customerName: args.customerName,
      metadata: args.metadata,
      createdAt: now,
      updatedAt: now,
    });

    await recordEvent(ctx, docId, { type: "created", actor: "api", toStatus: "CREATED" });
    await logAudit(ctx, {
      orgId: args.orgId,
      actor: "api",
      action: "transaction.created",
      resource: "transaction",
      resourceId: transactionId,
      after: { amountMinor: args.amountMinor, currency: args.currency, reference: args.reference },
      requestId: args.requestId,
    });

    return { internalId: docId, transactionId };
  },
});

async function recordEvent(
  ctx: MutationCtx,
  txInternalId: Id<"transactions">,
  ev: { type: string; fromStatus?: string; toStatus?: string; data?: unknown; actor?: string },
) {
  await ctx.db.insert("transactionEvents", {
    transactionId: txInternalId,
    type: ev.type,
    fromStatus: ev.fromStatus,
    toStatus: ev.toStatus,
    data: ev.data,
    actor: ev.actor ?? "system",
    at: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Risk evaluation hook — called by the engine after transaction creation.
// Records score + decision on the transaction and as an event, and enforces
// the decision: BLOCK/HOLD fail the transaction with a fraud_rejection-style
// error (no money moves); REVIEW is recorded but the payment proceeds.
// ---------------------------------------------------------------------------
export const riskDecisionInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    score: v.number(),
    decision: v.union(v.literal("ALLOW"), v.literal("REVIEW"), v.literal("HOLD"), v.literal("BLOCK")),
    reasons: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.internalId, { riskScore: args.score, riskDecision: args.decision });
    await recordEvent(ctx, args.internalId, {
      type: "risk_evaluated",
      toStatus: undefined,
      data: { score: args.score, decision: args.decision, reasons: args.reasons },
      actor: "risk_engine",
    });
    return { blocked: args.decision === "BLOCK" || args.decision === "HOLD" };
  },
});

// ---------------------------------------------------------------------------
// Processing — runs in an ACTION so the provider call can be a real network
// request later. The sandbox adapter is pure simulation, but it flows through
// the identical lifecycle that real adapters will use.
// ---------------------------------------------------------------------------
export const processPaymentInternal = internalAction({
  args: {
    orgId: v.id("organizations"),
    merchantId: v.id("merchants"),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    amountMinor: v.number(),
    currency: v.string(),
    reference: v.string(),
    paymentMethod: v.string(),
    customerEmail: v.optional(v.string()),
    customerName: v.optional(v.string()),
    metadata: v.optional(v.any()),
    idempotencyKey: v.optional(v.string()),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    kind: "done" | "no_provider";
    transaction?: TransactionSummary;
    error?: { code: string; message: string; category: string };
  }> => {
    // Provider selection happens BEFORE any financial record is created: if no
    // adapter can take this payment, nothing is persisted.
    let adapter;
    try {
      adapter = selectProvider(args.environment, args.paymentMethod, args.currency);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        return {
          kind: "no_provider" as const,
          error: {
            code: "provider_unavailable",
            message: err.message,
            category: "provider_outage" as const,
          },
        };
      }
      throw err;
    }

    const { internalId, transactionId } = await ctx.runMutation(internal.payments.createTransactionInternal, {
      orgId: args.orgId,
      merchantId: args.merchantId,
      environment: args.environment,
      amountMinor: args.amountMinor,
      currency: args.currency,
      reference: args.reference,
      paymentMethod: args.paymentMethod,
      customerEmail: args.customerEmail,
      customerName: args.customerName,
      metadata: args.metadata,
      idempotencyKey: args.idempotencyKey,
      requestId: args.requestId,
    });

    // ---- Risk engine (prompt §15): deterministic rules + velocity signals ----
    // Runs after the record exists (the score must be auditable) but BEFORE
    // any provider call: BLOCK/HOLD never reach a rail. A risk rejection is a
    // real, final outcome — recorded as such, and never retried blindly.
    const signals = await ctx.runQuery(internal.customers.riskSignalsInternal, {
      orgId: args.orgId,
      customerEmail: args.customerEmail,
    });
    const assessment = evaluatePaymentRisk({
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      customerEmail: args.customerEmail,
      signals: signals as { customerTxns10m: number; customerFailed30m: number; orgTxns1m: number },
    });
    const riskVerdict = await ctx.runMutation(internal.payments.riskDecisionInternal, {
      internalId,
      score: assessment.score,
      decision: assessment.decision,
      reasons: assessment.reasons,
    });
    if (riskVerdict.blocked) {
      const failure = {
        category: "fraud_rejection" as const,
        code: "risk_blocked",
        message: `Blocked by risk engine (score ${assessment.score}: ${assessment.reasons.join(", ") || "policy"}). Contact support if this is unexpected.`,
        retryable: false,
      };
      const final = await ctx.runMutation(internal.payments.markFailedInternal, {
        internalId,
        provider: "risk_engine",
        providerReference: "",
        failure,
      });
      return { kind: "done" as const, transaction: final };
    }

    await ctx.runMutation(internal.payments.transitionInternal, {
      internalId,
      toStatus: "PROCESSING",
      actor: "api",
      data: { provider: adapter.id },
    });

    const result = await adapter.charge({
      transactionId,
      amountMinor: args.amountMinor,
      currency: args.currency,
      reference: args.reference,
      customerEmail: args.customerEmail,
      paymentMethod: args.paymentMethod,
      metadata: args.metadata,
    });

    if (result.status === "successful") {
      const final = await ctx.runMutation(internal.payments.markSuccessfulInternal, {
        internalId,
        provider: adapter.id,
        providerReference: result.providerReference,
        requestId: args.requestId,
      });
      return { kind: "done" as const, transaction: final };
    }

    if (result.status === "pending") {
      const final = await ctx.runMutation(internal.payments.markPendingInternal, {
        internalId,
        provider: adapter.id,
        providerReference: result.providerReference,
      });
      return { kind: "done" as const, transaction: final };
    }

    const final = await ctx.runMutation(internal.payments.markFailedInternal, {
      internalId,
      provider: adapter.id,
      providerReference: result.providerReference,
      failure: result.failure,
    });
    return { kind: "done" as const, transaction: final };
  },
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------
async function transition(
  ctx: MutationCtx,
  internalId: Id<"transactions">,
  toStatus: string,
  actor: string,
  data?: unknown,
) {
  const txn = await ctx.db.get(internalId);
  if (!txn) throw new ConvexError("transaction not found");
  const from = txn.status;
  await ctx.db.patch(internalId, { status: toStatus as never, updatedAt: Date.now() });
  await recordEvent(ctx, internalId, {
    type: toStatus.toLowerCase(),
    fromStatus: from,
    toStatus,
    data,
    actor,
  });
  return { from, transactionId: txn.transactionId, orgId: txn.orgId };
}

const transitionArgs = {
  internalId: v.id("transactions"),
  toStatus: v.string(),
  actor: v.string(),
  data: v.optional(v.any()),
};

export const transitionInternal = internalMutation({
  args: transitionArgs,
  handler: async (ctx, args) => {
    await transition(ctx, args.internalId, args.toStatus, args.actor, args.data);
  },
});

// ---------------------------------------------------------------------------
// SUCCESS: fee computation + ledger posting + webhook enqueue + audit
// ---------------------------------------------------------------------------
export const markSuccessfulInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    provider: v.string(),
    providerReference: v.string(),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.internalId);
    if (!txn) throw new ConvexError("transaction not found");
    if (txn.status === "SUCCESSFUL") return summarize(txn); // idempotent transition guard

    const merchant = await ctx.db.get(txn.merchantId);
    if (!merchant) throw new ConvexError("merchant not found");

    const fees = computeFees(merchant, txn.amountMinor, txn.currency);
    const now = Date.now();

    await ctx.db.patch(args.internalId, {
      status: "SUCCESSFUL",
      provider: args.provider,
      providerReference: args.providerReference,
      feeMinor: fees.feeMinor,
      feeCurrency: fees.currency,
      netMinor: fees.netMinor,
      updatedAt: now,
    });
    await recordEvent(ctx, args.internalId, {
      type: "successful",
      fromStatus: txn.status,
      toStatus: "SUCCESSFUL",
      data: { provider: args.provider, providerReference: args.providerReference },
      actor: "system",
    });

    // ---- Ledger posting: provider_clearing → merchant_balance + fees ----
    await postDoubleEntry(ctx, {
      orgId: txn.orgId,
      ledgerRef: `LED-${txn.transactionId}`,
      transactionId: args.internalId,
      postings: [
        {
          account: {
            orgId: txn.orgId,
            currency: txn.currency,
            kind: ACCOUNT_KINDS.PROVIDER_CLEARING,
            code: providerClearingCode(args.provider, txn.currency),
            name: `Provider clearing — ${args.provider} ${txn.currency}`,
          },
          direction: "debit",
          amountMinor: txn.amountMinor,
          description: `Payment received ${txn.transactionId}`,
        },
        {
          account: {
            orgId: txn.orgId,
            merchantId: txn.merchantId,
            currency: txn.currency,
            kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
            code: merchantAccountCode(txn.merchantId, txn.currency),
            name: `${merchant.name} balance ${txn.currency}`,
          },
          direction: "credit",
          amountMinor: fees.netMinor,
          description: `Net of fees ${txn.transactionId}`,
        },
        ...(fees.feeMinor > 0
          ? [
              {
                account: {
                  orgId: txn.orgId,
                  currency: txn.currency,
                  kind: ACCOUNT_KINDS.PLATFORM_FEES,
                  code: feesAccountCode(txn.currency),
                  name: `RAEVOLT fees ${txn.currency}`,
                },
                direction: "credit" as const,
                amountMinor: fees.feeMinor,
                description: `Platform fee ${txn.transactionId}`,
              },
            ]
          : []),
      ],
    });

    // ---- Customer upsert (prompt §20) ----
    if (txn.customerEmail) {
      await ctx.runMutation(internal.customers.upsertCustomerInternal, {
        orgId: txn.orgId,
        email: txn.customerEmail,
        name: txn.customerName,
        successful: true,
        volumeMinor: txn.amountMinor,
        currency: txn.currency,
      });
    }

    // ---- Provider health (prompt §36) ----
    await ctx.runMutation(internal.providerhealth.recordChargeInternal, {
      provider: args.provider,
      environment: txn.environment,
      outcome: "successful",
      latencyMs: Date.now() - txn.createdAt,
    });

    // ---- Webhook events (prompt §30) ----
    await enqueueWebhooks(ctx, txn.orgId, args.internalId, "payment.successful", {
      event: "payment.successful",
      data: {
        id: txn.transactionId,
        reference: txn.reference,
        amount: txn.amountMinor,
        currency: txn.currency,
        status: "SUCCESSFUL",
        fee: fees.feeMinor,
        net: fees.netMinor,
        provider: args.provider,
        provider_reference: args.providerReference,
      },
    });

    await logAudit(ctx, {
      orgId: txn.orgId,
      actor: "system",
      action: "transaction.successful",
      resource: "transaction",
      resourceId: txn.transactionId,
      after: { provider: args.provider, providerReference: args.providerReference, feeMinor: fees.feeMinor },
      requestId: args.requestId,
    });

    const updated = await ctx.db.get(args.internalId);
    if (!updated) throw new ConvexError("transaction not found");
    return summarize(updated);
  },
});

// ---------------------------------------------------------------------------
// PENDING — async rails (e.g. bank transfer) wait for provider confirmation
// ---------------------------------------------------------------------------
export const markPendingInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    provider: v.string(),
    providerReference: v.string(),
  },
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.internalId);
    if (!txn) throw new ConvexError("transaction not found");
    await ctx.db.patch(args.internalId, {
      status: "PENDING",
      provider: args.provider,
      providerReference: args.providerReference,
      updatedAt: Date.now(),
    });
    await recordEvent(ctx as never, args.internalId, {
      type: "pending",
      fromStatus: txn.status,
      toStatus: "PENDING",
      data: { provider: args.provider, providerReference: args.providerReference },
      actor: "system",
    });
    await enqueueWebhooks(ctx, txn.orgId, args.internalId, "payment.processing", {
      event: "payment.processing",
      data: { id: txn.transactionId, reference: txn.reference, status: "PENDING" },
    });
    const updated = await ctx.db.get(args.internalId);
    if (!updated) throw new ConvexError("transaction not found");
    return summarize(updated);
  },
});

// ---------------------------------------------------------------------------
// FAILED — with structured failure intelligence (prompt §35)
// ---------------------------------------------------------------------------
export const markFailedInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    provider: v.string(),
    providerReference: v.string(),
    failure: v.object({
      category: v.string(),
      code: v.string(),
      message: v.string(),
      retryable: v.boolean(),
    }),
  },
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.internalId);
    if (!txn) throw new ConvexError("transaction not found");
    await ctx.db.patch(args.internalId, {
      status: "FAILED",
      provider: args.provider,
      providerReference: args.providerReference,
      failureCategory: args.failure.category as never,
      failureCode: args.failure.code,
      failureMessage: args.failure.message,
      failureRetryable: args.failure.retryable,
      updatedAt: Date.now(),
    });
    await recordEvent(ctx as never, args.internalId, {
      type: "failed",
      fromStatus: txn.status,
      toStatus: "FAILED",
      data: { ...args.failure, provider: args.provider, stage: "provider_charge" },
      actor: "system",
    });

    // ---- Customer upsert (failed attempts count toward transaction history) ----
    if (txn.customerEmail) {
      await ctx.runMutation(internal.customers.upsertCustomerInternal, {
        orgId: txn.orgId,
        email: txn.customerEmail,
        name: txn.customerName,
        successful: false,
        volumeMinor: 0,
        currency: txn.currency,
      });
    }

    // ---- Provider health ----
    await ctx.runMutation(internal.providerhealth.recordChargeInternal, {
      provider: args.provider,
      environment: txn.environment,
      outcome: "failed",
      latencyMs: Date.now() - txn.createdAt,
      errorMessage: args.failure.message,
    });
    await enqueueWebhooks(ctx, txn.orgId, args.internalId, "payment.failed", {
      event: "payment.failed",
      data: {
        id: txn.transactionId,
        reference: txn.reference,
        status: "FAILED",
        failure: {
          category: args.failure.category,
          code: args.failure.code,
          message: args.failure.message,
          retryable: args.failure.retryable,
        },
      },
    });
    await logAudit(ctx, {
      orgId: txn.orgId,
      actor: "system",
      action: "transaction.failed",
      resource: "transaction",
      resourceId: txn.transactionId,
      after: args.failure,
    });
    const updated = await ctx.db.get(args.internalId);
    if (!updated) throw new ConvexError("transaction not found");
    return summarize(updated);
  },
});

// ---------------------------------------------------------------------------
// Refunds (prompt §17) — full or partial, ledger-consistent, duplicate-safe
// ---------------------------------------------------------------------------
export const refundInternal = internalAction({
  args: {
    transactionId: v.string(),
    amountMinor: v.optional(v.number()),
    reason: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    kind: "error" | "done";
    code?: string;
    message?: string;
    transaction?: TransactionSummary;
  }> => {
    const txn = await ctx.runQuery(internal.payments.transactionByTransactionId, {
      transactionId: args.transactionId,
    });
    if (!txn) {
      return { kind: "error" as const, code: "not_found", message: "Transaction not found." };
    }
    if (txn.status !== "SUCCESSFUL" && txn.status !== "PARTIALLY_REFUNDED") {
      return {
        kind: "error" as const,
        code: "not_refundable",
        message: `Transaction in status ${txn.status} cannot be refunded.`,
      };
    }

    const refundedSoFar = txn.refundedMinor ?? 0;
    const refundable = txn.amountMinor - refundedSoFar;
    const amountMinor = args.amountMinor ?? refundable;
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      return {
        kind: "error" as const,
        code: "validation_error",
        message: "Refund amount must be a positive integer of minor units.",
      };
    }
    if (amountMinor > refundable) {
      return {
        kind: "error" as const,
        code: "exceeds_refundable",
        message: `Refund of ${amountMinor} exceeds refundable ${refundable} (already refunded ${refundedSoFar}).`,
      };
    }

    // Duplicate-refund prevention (prompt §9, §17): the whole money-moving
    // sequence runs inside the idempotency engine. A retried refund with the
    // same key replays the original response instead of double-refunding.
    const run = async (): Promise<{ statusCode: number; body: TransactionSummary }> => {
      const provider = await ctx.runMutation(internal.payments.beginRefundInternal, {
        internalId: txn._id,
        amountMinor,
        reason: args.reason,
      });

      const adapter = selectProvider(txn.environment, txn.paymentMethod, txn.currency);
      const result = await adapter.refund({
        transactionId: txn.transactionId,
        providerReference: txn.providerReference ?? undefined,
        amountMinor,
        currency: txn.currency,
        reason: args.reason,
      });

      if (result.status !== "successful") {
        await ctx.runMutation(internal.payments.abortRefundInternal, {
          internalId: txn._id,
          refundRef: provider.refundRef,
          failure: result.failure,
        });
        throw new Error(`PROVIDER_REFUND_FAILED: ${result.failure.message}`);
      }

      const updated = await ctx.runMutation(internal.payments.completeRefundInternal, {
        internalId: txn._id,
        amountMinor,
        refundRef: provider.refundRef,
        providerRefundReference: result.providerRefundReference,
        reason: args.reason,
      });
      return { statusCode: 200, body: updated };
    };

    if (args.idempotencyKey) {
      const fp = await fingerprint({ transactionId: args.transactionId, amountMinor, kind: "refund" });
      try {
        const r = await withIdempotency<TransactionSummary>(
          ctx,
          { orgId: txn.orgId, key: `refund_${args.idempotencyKey}`, fp },
          run,
        );
        return { kind: "done" as const, transaction: r.body };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Refund failed";
        if (msg.startsWith("IDEMPOTENCY_CONFLICT")) {
          return { kind: "error" as const, code: "idempotency_conflict", message: msg.replace("IDEMPOTENCY_CONFLICT: ", "") };
        }
        if (msg.startsWith("CONFLICT:")) {
          return { kind: "error" as const, code: "conflict", message: msg.replace("CONFLICT: ", "") };
        }
        if (msg.startsWith("PROVIDER_REFUND_FAILED")) {
          return { kind: "error" as const, code: "provider_refund_failed", message: msg.replace("PROVIDER_REFUND_FAILED: ", "") };
        }
        return { kind: "error" as const, code: "processing_error", message: msg };
      }
    }

    try {
      const r = await run();
      return { kind: "done" as const, transaction: r.body };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Refund failed";
      if (msg.startsWith("PROVIDER_REFUND_FAILED")) {
        return { kind: "error" as const, code: "provider_refund_failed", message: msg.replace("PROVIDER_REFUND_FAILED: ", "") };
      }
      return { kind: "error" as const, code: "processing_error", message: msg };
    }
  },
});

export const beginRefundInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    amountMinor: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.internalId);
    if (!txn) throw new ConvexError("transaction not found");
    const refundRef = `RFD-${txn.transactionId}-${Date.now().toString(36)}`;
    await recordEvent(ctx as never, args.internalId, {
      type: "refund.started",
      fromStatus: txn.status,
      data: { amountMinor: args.amountMinor, reason: args.reason, refundRef },
      actor: "api",
    });
    return { refundRef };
  },
});

export const abortRefundInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    refundRef: v.string(),
    failure: v.object({ category: v.string(), code: v.string(), message: v.string(), retryable: v.boolean() }),
  },
  handler: async (ctx, args) => {
    await recordEvent(ctx as never, args.internalId, {
      type: "refund.failed",
      data: { ...args.failure, refundRef: args.refundRef },
      actor: "system",
    });
  },
});

export const completeRefundInternal = internalMutation({
  args: {
    internalId: v.id("transactions"),
    amountMinor: v.number(),
    refundRef: v.string(),
    providerRefundReference: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.internalId);
    if (!txn) throw new ConvexError("transaction not found");

    const refundedSoFar = txn.refundedMinor ?? 0;
    const totalRefunded = refundedSoFar + args.amountMinor;
    const newStatus = totalRefunded >= txn.amountMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";

    await ctx.db.patch(args.internalId, {
      status: newStatus as never,
      refundedMinor: totalRefunded,
      updatedAt: Date.now(),
    });
    await recordEvent(ctx as never, args.internalId, {
      type: "refund.completed",
      fromStatus: txn.status,
      toStatus: newStatus,
      data: {
        amountMinor: args.amountMinor,
        totalRefundedMinor: totalRefunded,
        refundRef: args.refundRef,
        providerRefundReference: args.providerRefundReference,
        reason: args.reason,
      },
      actor: "system",
    });

    // ---- Customer volume reduction (per currency, bounded at 0) ----
    await ctx.runMutation(internal.customers.refundCustomerVolumeInternal, {
      orgId: txn.orgId,
      email: txn.customerEmail,
      refundedMinor: args.amountMinor,
      currency: txn.currency,
    });

    // Ledger: money returns from merchant balance to the provider clearing
    // account. Platform fees are retained in v1 (documented policy).
    await postDoubleEntry(ctx, {
      orgId: txn.orgId,
      ledgerRef: args.refundRef,
      transactionId: args.internalId,
      postings: [
        {
          account: {
            orgId: txn.orgId,
            merchantId: txn.merchantId,
            currency: txn.currency,
            kind: ACCOUNT_KINDS.MERCHANT_BALANCE,
            code: merchantAccountCode(txn.merchantId, txn.currency),
            name: `merchant balance ${txn.currency}`,
          },
          direction: "debit",
          amountMinor: args.amountMinor,
          description: `Refund ${args.refundRef}`,
        },
        {
          account: {
            orgId: txn.orgId,
            currency: txn.currency,
            kind: ACCOUNT_KINDS.PROVIDER_CLEARING,
            code: providerClearingCode(txn.provider, txn.currency),
            name: `provider clearing ${txn.provider} ${txn.currency}`,
          },
          direction: "credit",
          amountMinor: args.amountMinor,
          description: `Refund ${args.refundRef}`,
        },
      ],
    });

    await enqueueWebhooks(ctx, txn.orgId, args.internalId, "payment.refunded", {
      event: "payment.refunded",
      data: {
        id: txn.transactionId,
        reference: txn.reference,
        status: newStatus,
        refunded_amount: totalRefunded,
        refund: { amount: args.amountMinor, provider_reference: args.providerRefundReference },
      },
    });

    await logAudit(ctx, {
      orgId: txn.orgId,
      actor: "api",
      action: "transaction.refunded",
      resource: "transaction",
      resourceId: txn.transactionId,
      after: { amountMinor: args.amountMinor, totalRefunded, newStatus },
    });

    const updated = await ctx.db.get(args.internalId);
    if (!updated) throw new ConvexError("transaction not found");
    return summarize(updated);
  },
});

// ---------------------------------------------------------------------------
// Webhook enqueue helper — deliveries are processed by the dispatcher action
// ---------------------------------------------------------------------------
async function enqueueWebhooks(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  transactionId: Id<"transactions">,
  event: string,
  payload: unknown,
) {
  const endpoints = await ctx.db
    .query("webhookEndpoints")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .collect();

  for (const ep of endpoints) {
    if (ep.status !== "active") continue;
    if (!ep.events.includes(event) && !ep.events.includes("*")) continue;
    await ctx.db.insert("webhookDeliveries", {
      orgId,
      endpointId: ep._id,
      transactionId,
      event,
      payload,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
      nextAttemptAt: Date.now(),
    });
  }
}
