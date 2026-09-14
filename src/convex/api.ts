// RAEVOLT public API v1 (prompt §31, §33).
// Base path /api/v1 — versioned from day one. All endpoints authenticate with
// secret keys, enforce the key's environment, and support Idempotency-Key
// replay for POST /payments.

import { v } from "convex/values";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  authenticateRequest,
  readJsonBody,
  requestIdFrom,
  jsonOk,
  handleApiError,
  corsPreflight,
  ApiError,
} from "./lib/httpservice";
import { fingerprint } from "./lib/idempotency";

const VALID_METHODS = new Set(["card", "bank_transfer", "mobile_money", "ussd", "wallet", "qr", "account_to_account"]);

// ---------------------------------------------------------------------------
// POST /api/v1/payments — create + process a payment
// ---------------------------------------------------------------------------
export const createPayment = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const key = await authenticateRequest(ctx, request);
    const body = await readJsonBody(request);

    const amountMinor = body.amountMinor;
    const currency = typeof body.currency === "string" ? body.currency.toUpperCase() : "";
    const paymentMethod = typeof body.paymentMethod === "string" ? body.paymentMethod : "";
    const reference =
      typeof body.reference === "string" && body.reference.trim()
        ? body.reference.trim()
        : `ref_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;

    if (!Number.isInteger(amountMinor) || (amountMinor as number) <= 0) {
      throw new ApiError("validation_error", "amountMinor must be a positive integer (minor units).");
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ApiError("validation_error", "currency must be a 3-letter ISO 4217 code.");
    }
    if (!VALID_METHODS.has(paymentMethod)) {
      throw new ApiError(
        "validation_error",
        `paymentMethod must be one of: ${Array.from(VALID_METHODS).join(", ")}.`,
      );
    }
    if (body.customerEmail !== undefined && (typeof body.customerEmail !== "string" || !body.customerEmail.includes("@"))) {
      throw new ApiError("validation_error", "customerEmail must be a valid email address.");
    }

    // Environment isolation (prompt §32, §56): the key's environment decides
    // which adapters are reachable. Sandbox keys can never hit live rails.
    const environment = key.environment;

    // Idempotency (prompt §9): replay completed responses for the same
    // key + fingerprint; reject same key with a different payload.
    // The fingerprint covers CLIENT-supplied fields only — the server never
    // injects generated values (like a random reference) into it, otherwise
    // identical retries would always look like different requests.
    const idemKey = request.headers.get("Idempotency-Key");
    if (idemKey) {
      const fp = await fingerprint({
        amountMinor, currency, paymentMethod,
        reference: body.reference ?? null,
        customerEmail: body.customerEmail ?? null,
        metadata: body.metadata ?? null,
      });
      const acquired = await ctx.runMutation(internal.lib.idempotency.acquireInternal, {
        orgId: key.orgId as Id<"organizations">,
        key: idemKey,
        fp,
      });
      if (acquired.type === "replay") {
        return jsonOk(acquired.responseBody, acquired.statusCode, requestId);
      }
      if (acquired.type === "conflict") {
        throw new ApiError(
          "idempotency_conflict",
          "This Idempotency-Key was already used with a different request body.",
        );
      }
      if (acquired.type === "in_progress") {
        throw new ApiError("conflict", "An identical request is currently in progress. Retry shortly.", true);
      }
      // new: proceed, and complete/fail the record below.
      try {
        const result = await ctx.runAction(internal.payments.processPaymentInternal, {
          orgId: key.orgId as Id<"organizations">,
          merchantId: await resolvePrimaryMerchant(ctx, key.orgId as Id<"organizations">),
          environment,
          amountMinor: amountMinor as number,
          currency,
          reference,
          paymentMethod,
          customerEmail: typeof body.customerEmail === "string" ? body.customerEmail : undefined,
          customerName: typeof body.customerName === "string" ? body.customerName : undefined,
          metadata: (body.metadata as Record<string, unknown> | undefined) ?? undefined,
          idempotencyKey: idemKey,
          requestId,
        });
        if (result.kind === "no_provider") {
          throw new ApiError("provider_unavailable", result.error?.message ?? "No provider configured.", true);
        }
        await ctx.runMutation(internal.lib.idempotency.completeInternal, {
          recordId: acquired.recordId as Id<"idempotencyKeys">,
          response: { statusCode: 201, body: { payment: result.transaction } },
          transactionId: undefined,
        });
        return jsonOk({ payment: result.transaction }, 201, requestId);
      } catch (err) {
        await ctx.runMutation(internal.lib.idempotency.failInternal, {
          recordId: acquired.recordId as Id<"idempotencyKeys">,
        });
        throw err;
      }
    }

    // No idempotency key: process directly.
    const result = await ctx.runAction(internal.payments.processPaymentInternal, {
      orgId: key.orgId as Id<"organizations">,
      merchantId: await resolvePrimaryMerchant(ctx, key.orgId as Id<"organizations">),
      environment,
      amountMinor: amountMinor as number,
      currency,
      reference,
      paymentMethod,
      customerEmail: typeof body.customerEmail === "string" ? body.customerEmail : undefined,
      customerName: typeof body.customerName === "string" ? body.customerName : undefined,
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? undefined,
      requestId,
    });
    if (result.kind === "no_provider") {
      throw new ApiError("provider_unavailable", result.error?.message ?? "No provider configured.", true);
    }
    return jsonOk({ payment: result.transaction }, 201, requestId);
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

async function resolvePrimaryMerchant(ctx: ActionCtx, orgId: Id<"organizations">): Promise<Id<"merchants">> {
  const merchant = await ctx.runQuery(internal.apiInternal.orgPrimaryMerchantInternal, { orgId });
  if (!merchant) {
    throw new ApiError("validation_error", "No merchant is configured for this organization. Create one in the dashboard.");
  }
  return merchant._id;
}

// ---------------------------------------------------------------------------
// GET /api/v1/payments/:transactionId — transaction lookup
// ---------------------------------------------------------------------------
export const getPayment = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const key = await authenticateRequest(ctx, request);
    const url = new URL(request.url);
    const transactionId = url.pathname.split("/").pop() ?? "";
    const txn = (await ctx.runQuery(internal.apiInternal.transactionForOrgInternal, {
      orgId: key.orgId as Id<"organizations">,
      transactionId,
    })) as {
      transactionId: string;
      status: string;
      amountMinor: number;
      currency: string;
      reference: string;
      provider: string;
      providerReference?: string;
      feeMinor?: number;
      netMinor?: number;
      refundedMinor?: number;
      failureCategory?: string;
      failureCode?: string;
      failureMessage?: string;
      failureRetryable?: boolean;
      paymentMethod: string;
      customerEmail?: string;
      createdAt: number;
      updatedAt: number;
    } | null;
    if (!txn) throw new ApiError("not_found", `No transaction '${transactionId}' in this organization.`);
    return jsonOk(
      {
        payment: {
          id: txn.transactionId,
          reference: txn.reference,
          status: txn.status,
          amount: txn.amountMinor,
          currency: txn.currency,
          payment_method: txn.paymentMethod,
          customer_email: txn.customerEmail ?? null,
          provider: txn.provider,
          provider_reference: txn.providerReference ?? null,
          fee: txn.feeMinor ?? null,
          net: txn.netMinor ?? null,
          refunded_amount: txn.refundedMinor ?? 0,
          failure:
            txn.failureCategory && txn.failureCode
              ? {
                  category: txn.failureCategory,
                  code: txn.failureCode,
                  message: txn.failureMessage ?? "",
                  retryable: txn.failureRetryable ?? false,
                }
              : null,
          created_at: new Date(txn.createdAt).toISOString(),
          updated_at: new Date(txn.updatedAt).toISOString(),
        },
      },
      200,
      requestId,
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/payments/:transactionId/refund — full or partial refund
// ---------------------------------------------------------------------------
export const refundPayment = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const key = await authenticateRequest(ctx, request);
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const transactionId = parts[parts.length - 2]; // [..., "payments", ":id", "refund"]
    let amountMinor: number | undefined;
    let reason: string | undefined;
    try {
      const body = await readJsonBody(request);
      if (body.amountMinor !== undefined) {
        if (!Number.isInteger(body.amountMinor) || (body.amountMinor as number) <= 0) {
          throw new ApiError("validation_error", "amountMinor must be a positive integer (minor units).");
        }
        amountMinor = body.amountMinor as number;
      }
      if (typeof body.reason === "string") reason = body.reason;
    } catch {
      // empty body = full refund
    }

    const result = await ctx.runAction(internal.payments.refundInternal, {
      transactionId,
      amountMinor,
      reason,
      idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
      requestId,
    });
    if (result.kind === "error") {
      const code =
        result.code === "not_found"
          ? "not_found"
          : result.code === "validation_error" || result.code === "not_refundable"
            ? "validation_error"
            : result.code === "exceeds_refundable"
              ? "conflict"
              : result.code === "idempotency_conflict"
                ? "idempotency_conflict"
                : result.code === "conflict"
                  ? "conflict"
                  : result.code === "provider_refund_failed"
                    ? "provider_unavailable"
                    : "processing_error";
      throw new ApiError(code, result.message ?? "Refund failed.", code === "provider_unavailable");
    }
    return jsonOk({ refund: result.transaction }, 200, requestId);
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/balance — merchant balances straight from the ledger
// ---------------------------------------------------------------------------
export const getBalance = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const key = await authenticateRequest(ctx, request);
    const balances = (await ctx.runQuery(internal.apiInternal.orgBalancesInternal, {
      orgId: key.orgId as Id<"organizations">,
    })) as { merchantName: string; currency: string; balanceMinor: number; kind: string }[];
    return jsonOk(
      {
        balances: balances.map((b) => ({
          account: b.kind,
          merchant: b.merchantName,
          currency: b.currency,
          balance: b.balanceMinor,
        })),
      },
      200,
      requestId,
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/settlements — settlement batches
// ---------------------------------------------------------------------------
export const listSettlements = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const key = await authenticateRequest(ctx, request);
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
    const batches = (await ctx.runQuery(internal.apiInternal.listBatchesInternal, {
      orgId: key.orgId as Id<"organizations">,
      limit,
    })) as {
      reference: string;
      status: string;
      currency: string;
      grossMinor: number;
      feeMinor: number;
      reserveMinor: number;
      netMinor: number;
      settledAt?: number;
      createdAt: number;
    }[];
    return jsonOk(
      {
        settlements: batches.map((b) => ({
          reference: b.reference,
          status: b.status,
          currency: b.currency,
          gross: b.grossMinor,
          fee: b.feeMinor,
          reserve: b.reserveMinor,
          net: b.netMinor,
          settled_at: b.settledAt ? new Date(b.settledAt).toISOString() : null,
          created_at: new Date(b.createdAt).toISOString(),
        })),
      },
      200,
      requestId,
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/health — public, unauthenticated
// ---------------------------------------------------------------------------
export const health = httpAction(async () => {
  return jsonOk({
    service: "raevolt-api",
    version: "v1",
    time: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/checkout/:linkId — public link preview (safe fields only)
// ---------------------------------------------------------------------------
export const getLinkPublic = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const linkId = new URL(request.url).pathname.split("/").filter(Boolean)[3] ?? "";
    const resolved = (await ctx.runQuery(internal.apiInternal.linkForCheckoutInternal, {
      linkId,
    })) as {
      link: {
        linkId: string;
        title: string;
        description?: string;
        amountMinor?: number;
        currency: string;
        status: string;
        expiresAt?: number;
        maxUses?: number;
        useCount: number;
      };
      merchantName: string;
    } | null;
    if (!resolved) throw new ApiError("not_found", "Unknown payment link.");
    const { link } = resolved;
    return jsonOk(
      {
        linkId: link.linkId,
        title: link.title,
        description: link.description ?? null,
        amountMinor: link.amountMinor ?? null,
        currency: link.currency,
        status: link.status,
        expired: link.expiresAt !== undefined && link.expiresAt < Date.now(),
        usesExhausted: link.maxUses !== undefined && link.useCount >= link.maxUses,
        merchantName: resolved.merchantName,
      },
      200,
      requestId,
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/checkout/:linkId — pay a payment link (public, link-scoped)
// ---------------------------------------------------------------------------
export const checkoutWithLink = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const linkId = new URL(request.url).pathname.split("/").filter(Boolean)[3] ?? ""; // [api,v1,checkout,:linkId]
    if (!linkId.startsWith("pl_")) {
      throw new ApiError("not_found", "Unknown payment link.");
    }
    const resolved = (await ctx.runQuery(internal.apiInternal.linkForCheckoutInternal, {
      linkId,
    })) as {
      link: {
        linkId: string;
        orgId: Id<"organizations">;
        merchantId: Id<"merchants">;
        title: string;
        amountMinor?: number;
        currency: string;
        status: string;
        expiresAt?: number;
        maxUses?: number;
        useCount: number;
      };
      merchantName: string;
    } | null;
    if (!resolved) throw new ApiError("not_found", "Unknown payment link.");

    const { link } = resolved;
    if (link.status !== "active") throw new ApiError("conflict", "This payment link is disabled.");
    if (link.expiresAt !== undefined && link.expiresAt < Date.now()) {
      throw new ApiError("conflict", "This payment link has expired.");
    }
    if (link.maxUses !== undefined && link.useCount >= link.maxUses) {
      throw new ApiError("conflict", "This payment link has reached its usage limit.");
    }

    const body = await readJsonBody(request);
    const amountMinor =
      typeof body.amountMinor === "number" ? body.amountMinor : link.amountMinor;
    const customerEmail = typeof body.customerEmail === "string" ? body.customerEmail : undefined;
    const customerName = typeof body.customerName === "string" ? body.customerName : undefined;

    if (!Number.isInteger(amountMinor) || (amountMinor as number) <= 0) {
      throw new ApiError("validation_error", "amountMinor is required for open-amount links.");
    }
    if (!customerEmail || !customerEmail.includes("@")) {
      throw new ApiError("validation_error", "customerEmail is required at checkout.");
    }

    const reference = `link_${link.linkId.slice(3, 11)}_${Date.now().toString(36)}`;
    const result = await ctx.runAction(internal.payments.processPaymentInternal, {
      orgId: link.orgId,
      merchantId: link.merchantId,
      environment: "sandbox",
      amountMinor: amountMinor as number,
      currency: link.currency,
      reference,
      paymentMethod: typeof body.paymentMethod === "string" ? body.paymentMethod : "card",
      customerEmail,
      customerName,
      metadata: { source: "payment_link", linkId },
      requestId,
    });
    if (result.kind === "no_provider") {
      throw new ApiError("provider_unavailable", result.error?.message ?? "No provider configured.", true);
    }
    await ctx.runMutation(internal.paylinks.recordLinkAttemptInternal, {
      linkId,
      successful: result.transaction?.status === "SUCCESSFUL",
    });
    return jsonOk({ payment: result.transaction, link: { linkId, title: link.title } }, 201, requestId);
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/payouts — create a payout to a beneficiary
// ---------------------------------------------------------------------------
export const createPayout = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const key = await authenticateRequest(ctx, request);
    const body = await readJsonBody(request);
    if (!Number.isInteger(body.amountMinor) || (body.amountMinor as number) <= 0) {
      throw new ApiError("validation_error", "amountMinor must be a positive integer (minor units).");
    }
    if (typeof body.beneficiaryId !== "string" || !body.beneficiaryId) {
      throw new ApiError("validation_error", "beneficiaryId is required.");
    }
    const beneficiary = await ctx.runQuery(internal.apiInternal.beneficiaryByIdInternal, {
      beneficiaryId: body.beneficiaryId as Id<"beneficiaries">,
    });
    if (!beneficiary || beneficiary.orgId !== key.orgId) {
      throw new ApiError("not_found", "Beneficiary not found in this organization.");
    }
    const result = await ctx.runAction(internal.payouts.payoutInternal, {
      orgId: key.orgId as Id<"organizations">,
      beneficiaryId: body.beneficiaryId as Id<"beneficiaries">,
      amountMinor: body.amountMinor as number,
      narration: typeof body.narration === "string" ? body.narration : undefined,
      idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
      actor: key.prefix,
      requestId,
    });
    if (result.kind === "error") {
      const msg = result.message ?? "Payout failed.";
      throw new ApiError(
        msg.startsWith("VALIDATION_ERROR")
          ? "validation_error"
          : msg.startsWith("NOT_FOUND")
            ? "not_found"
            : "processing_error",
        msg.replace(/^(VALIDATION_ERROR|NOT_FOUND|CONFLICT): /, ""),
      );
    }
    const payout = await ctx.runQuery(internal.apiInternal.payoutByPayoutIdInternal, {
      payoutId: result.payoutId!,
    });
    return jsonOk(
      {
        payout: payout
          ? {
              id: payout.payoutId,
              status: payout.status,
              amount: payout.amountMinor,
              fee: payout.feeMinor,
              currency: payout.currency,
              beneficiary: { name: beneficiary.name, account: beneficiary.accountMasked, bank: beneficiary.bankName },
              provider_reference: payout.providerReference ?? null,
              failure:
                payout.failureCode && payout.failureMessage
                  ? { code: payout.failureCode, message: payout.failureMessage, retryable: payout.failureRetryable ?? false }
                  : null,
            }
          : { id: result.payoutId, status: result.status },
      },
      201,
      requestId,
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/payouts — list recent payouts
// ---------------------------------------------------------------------------
export const listPayouts = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const key = await authenticateRequest(ctx, request);
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100);
    const payouts = (await ctx.runQuery(internal.apiInternal.listPayoutsInternal, {
      orgId: key.orgId as Id<"organizations">,
      limit,
    })) as {
      payoutId: string;
      status: string;
      amountMinor: number;
      feeMinor: number;
      currency: string;
      beneficiaryId: Id<"beneficiaries">;
      providerReference?: string;
      failureCode?: string;
      failureMessage?: string;
      createdAt: number;
    }[];
    return jsonOk(
      {
        payouts: payouts.map((p) => ({
          id: p.payoutId,
          status: p.status,
          amount: p.amountMinor,
          fee: p.feeMinor,
          currency: p.currency,
          beneficiary_id: p.beneficiaryId,
          provider_reference: p.providerReference ?? null,
          failure:
            p.failureCode && p.failureMessage
              ? { code: p.failureCode, message: p.failureMessage }
              : null,
          created_at: new Date(p.createdAt).toISOString(),
        })),
      },
      200,
      requestId,
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/customers — list customers (upserted from payment activity)
// ---------------------------------------------------------------------------
export const listCustomers = httpAction(async (ctx, request) => {
  const requestId = requestIdFrom(request);
  try {
    const key = await authenticateRequest(ctx, request);
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
    const customers = (await ctx.runQuery(internal.apiInternal.listCustomersInternal, {
      orgId: key.orgId as Id<"organizations">,
      limit,
    })) as {
      email: string;
      name?: string;
      transactionCount: number;
      successfulCount: number;
      lifetimeVolumeByCurrency?: Record<string, number>;
      status: string;
      lastTransactionAt?: number;
      createdAt: number;
    }[];
    return jsonOk(
      {
        customers: customers.map((c) => ({
          email: c.email,
          name: c.name ?? null,
          transactions: c.transactionCount,
          successful: c.successfulCount,
          // Per-currency lifetime volume in minor units — never summed across
          // currencies, which would be a financial misstatement.
          lifetime_volume_by_currency: c.lifetimeVolumeByCurrency ?? {},
          status: c.status,
          last_seen: c.lastTransactionAt ? new Date(c.lastTransactionAt).toISOString() : null,
        })),
      },
      200,
      requestId,
    );
  } catch (err) {
    return handleApiError(err, requestId);
  }
});

// Shared CORS preflight handler
export const corsHandler = httpAction(async () => corsPreflight());

// Args validators (unused directly; documents the shapes)
export const _args = { v };
