import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// ---------------------------------------------------------------------------
// RBAC — permission-level access control (prompt §7)
// ---------------------------------------------------------------------------
export const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  FINANCE: "finance",
  DEVELOPER: "developer",
  OPERATIONS: "operations",
  VIEWER: "viewer",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.OWNER),
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.FINANCE),
  v.literal(ROLES.DEVELOPER),
  v.literal(ROLES.OPERATIONS),
  v.literal(ROLES.VIEWER),
);
export type Role = Infer<typeof roleValidator>;

// Permission catalog. Roles map to permission sets; checks are permission-based
// so new roles can be introduced without rewriting checks (prompt §7).
export const PERMISSIONS = {
  ORG_MANAGE: "org:manage",
  TEAM_INVITE: "team:invite",
  KEYS_MANAGE: "keys:manage",
  PAYMENTS_CREATE: "payments:create",
  SETTLEMENT_VIEW: "settlement:view",
  LEDGER_VIEW: "ledger:view",
  AUDIT_VIEW: "audit:view",
  WEBHOOKS_MANAGE: "webhooks:manage",
} as const;

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  owner: Object.values(PERMISSIONS),
  admin: [
    PERMISSIONS.ORG_MANAGE,
    PERMISSIONS.TEAM_INVITE,
    PERMISSIONS.KEYS_MANAGE,
    PERMISSIONS.PAYMENTS_CREATE,
    PERMISSIONS.SETTLEMENT_VIEW,
    PERMISSIONS.LEDGER_VIEW,
    PERMISSIONS.AUDIT_VIEW,
    PERMISSIONS.WEBHOOKS_MANAGE,
  ],
  finance: [
    PERMISSIONS.SETTLEMENT_VIEW,
    PERMISSIONS.LEDGER_VIEW,
    PERMISSIONS.AUDIT_VIEW,
  ],
  developer: [
    PERMISSIONS.KEYS_MANAGE,
    PERMISSIONS.WEBHOOKS_MANAGE,
    PERMISSIONS.PAYMENTS_CREATE,
  ],
  operations: [PERMISSIONS.SETTLEMENT_VIEW, PERMISSIONS.LEDGER_VIEW],
  viewer: [],
};

// ---------------------------------------------------------------------------
// Tenancy: organizations → members → merchants (prompt §6)
// ---------------------------------------------------------------------------
export const organizations = defineTable({
  name: v.string(),
  slug: v.string(), // unique, used in API keys + urls
  environment: v.optional(v.string()), // "sandbox" | "production" (prompt §32)
  settings: v.optional(v.object({ currency: v.optional(v.string()) })),
  createdByUserId: v.optional(v.id("users")),
})
  .index("by_slug", ["slug"])
  .index("by_creator", ["createdByUserId"]);

export const orgMembers = defineTable({
  orgId: v.id("organizations"),
  userId: v.id("users"),
  role: roleValidator,
  permissions: v.optional(v.array(v.string())), // extra grants beyond role
  joinedAt: v.number(),
})
  .index("by_org", ["orgId"])
  .index("by_user", ["userId"])
  .index("by_org_user", ["orgId", "userId"]);

// A merchant = settlement + fee + balance boundary inside an org. One org can
// hold many merchants (platform / sub-merchant model, prompt §6, §20, §24).
export const merchants = defineTable({
  orgId: v.id("organizations"),
  name: v.string(),
  status: v.union(
    v.literal("active"),
    v.literal("onboarding"),
    v.literal("suspended"),
  ),
  // default currency for display/settlement (ISO 4217 — prompt §27)
  defaultCurrency: v.string(),
  // fee plan, basis points + fixed minor units (prompt §29)
  feeBps: v.number(), // e.g. 150 = 1.5%
  feeFixedMinor: v.number(),
  feeCurrency: v.optional(v.string()),
  // reserve held back from settlements, basis points (prompt §18, §59.9)
  reserveBps: v.optional(v.number()),
  createdByUserId: v.optional(v.id("users")),
})
  .index("by_org", ["orgId"])
  .index("by_org_name", ["orgId", "name"]);

// ---------------------------------------------------------------------------
// API keys — hashed at rest, prefix for lookup, publishable/secret split,
// rotation + revocation (prompt §7, §31, §40)
// ---------------------------------------------------------------------------
export const apiKeys = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.optional(v.id("merchants")),
  environment: v.union(v.literal("sandbox"), v.literal("production")),
  mode: v.union(v.literal("secret"), v.literal("publishable")),
  name: v.string(),
  prefix: v.string(), // "sk_sandbox_abc123" — first 12 chars, shown in UI
  hash: v.string(), // sha256(full key) — the full key is never stored
  status: v.union(v.literal("active"), v.literal("revoked")),
  lastUsedAt: v.optional(v.number()),
  // Per-key rate limiting window (prompt §40)
  rateWindowCount: v.optional(v.number()),
  rateWindowEnd: v.optional(v.number()),
  createdAt: v.number(),
  createdByUserId: v.optional(v.id("users")),
})
  .index("by_hash", ["hash"])
  .index("by_org", ["orgId"]);

// ---------------------------------------------------------------------------
// Transactions + payment lifecycle (prompt §8)
// States: CREATED → PENDING → PROCESSING → SUCCESSFUL | FAILED | CANCELLED
//         → REFUNDED / PARTIALLY_REFUNDED / REVERSED / DISPUTED
// Money is stored as integer minor units. Never floats (prompt §47).
// ---------------------------------------------------------------------------
export const transactions = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  environment: v.union(v.literal("sandbox"), v.literal("production")),
  status: v.union(
    v.literal("CREATED"),
    v.literal("PENDING"),
    v.literal("PROCESSING"),
    v.literal("SUCCESSFUL"),
    v.literal("FAILED"),
    v.literal("CANCELLED"),
    v.literal("REVERSED"),
    v.literal("REFUNDED"),
    v.literal("PARTIALLY_REFUNDED"),
    v.literal("DISPUTED"),
  ),
  amountMinor: v.number(),
  currency: v.string(),
  reference: v.string(), // merchant-supplied reference (unique per org)
  transactionId: v.string(), // RAEVOLT id e.g. txn_...
  idempotencyKey: v.optional(v.string()),
  provider: v.string(), // "sandbox" | "paystack" | "flutterwave" (adapter id)
  providerReference: v.optional(v.string()),
  paymentMethod: v.string(), // card | bank_transfer | mobile_money | ...
  customerEmail: v.optional(v.string()),
  customerName: v.optional(v.string()),
  metadata: v.optional(v.any()),
  // Failure intelligence (prompt §35)
  failureCategory: v.optional(
    v.union(
      v.literal("timeout"),
      v.literal("temporary_provider_failure"),
      v.literal("network_error"),
      v.literal("issuer_decline"),
      v.literal("insufficient_funds"),
      v.literal("invalid_payment_information"),
      v.literal("fraud_rejection"),
      v.literal("provider_outage"),
      v.literal("customer_cancellation"),
    ),
  ),
  failureCode: v.optional(v.string()),
  failureMessage: v.optional(v.string()),
  failureRetryable: v.optional(v.boolean()),
  // Fees, computed by the fee engine in minor units
  feeMinor: v.optional(v.number()),
  feeCurrency: v.optional(v.string()),
  netMinor: v.optional(v.number()),
  // Cumulative refunded amount in minor units (prompt §17)
  refundedMinor: v.optional(v.number()),
  // Risk
  riskScore: v.optional(v.number()), // 0..100
  riskDecision: v.optional(
    v.union(v.literal("ALLOW"), v.literal("REVIEW"), v.literal("HOLD"), v.literal("BLOCK")),
  ),
  // Settlement linkage
  settledAt: v.optional(v.number()),
  settlementBatchId: v.optional(v.id("settlementBatches")),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_org_status_created", ["orgId", "status", "createdAt"])
  .index("by_merchant_created", ["merchantId", "createdAt"])
  .index("by_reference", ["orgId", "reference"])
  .index("by_transaction_id", ["transactionId"])
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_org_email_created", ["orgId", "customerEmail", "createdAt"]);

// Every state transition, append-only (prompt §8, §34: one timeline)
export const transactionEvents = defineTable({
  transactionId: v.id("transactions"),
  type: v.string(), // created, processing, successful, failed, refund.*, settlement.*
  fromStatus: v.optional(v.string()),
  toStatus: v.optional(v.string()),
  data: v.optional(v.any()),
  actor: v.string(), // "api", "system", "webhook", user id
  at: v.number(),
}).index("by_transaction", ["transactionId", "at"]);

// ---------------------------------------------------------------------------
// Double-entry ledger — immutable source of truth (prompt §10)
// Debit sum must equal credit sum per currency. Entries are never edited or
// deleted; corrections happen through reversals/adjustments.
// ---------------------------------------------------------------------------
export const ledgerAccounts = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.optional(v.id("merchants")),
  currency: v.string(),
  kind: v.string(),
  // kind: merchant_balance | provider_clearing | platform_fees |
  //       settlement_payable | reserve | suspense
  code: v.string(), // e.g. "merch_<id>_NGN"
  name: v.string(),
  createdAt: v.number(),
}).index("by_code", ["code"]).index("by_org_kind", ["orgId", "kind"]);

export const ledgerEntries = defineTable({
  orgId: v.id("organizations"),
  transactionId: v.optional(v.id("transactions")),
  settlementBatchId: v.optional(v.id("settlementBatches")),
  // Each posting shares a ledgerRef: one immutable balanced group of entries
  ledgerRef: v.string(),
  accountId: v.id("ledgerAccounts"),
  accountCode: v.string(),
  direction: v.union(v.literal("debit"), v.literal("credit")),
  amountMinor: v.number(),
  currency: v.string(),
  description: v.string(),
  at: v.number(),
})
  .index("by_ledger_ref", ["ledgerRef"])
  .index("by_account_at", ["accountId", "at"])
  .index("by_transaction", ["transactionId"])
  .index("by_org_at", ["orgId", "at"]);

// ---------------------------------------------------------------------------
// Idempotency — financial correctness first (prompt §9)
// ---------------------------------------------------------------------------
export const idempotencyKeys = defineTable({
  orgId: v.id("organizations"),
  key: v.string(),
  fingerprint: v.string(), // hash of normalized request body
  status: v.union(v.literal("processing"), v.literal("completed"), v.literal("failed")),
  responseBody: v.optional(v.any()), // replayed on retries
  statusCode: v.optional(v.number()),
  transactionId: v.optional(v.id("transactions")),
  createdAt: v.number(),
  expiresAt: v.number(),
})
  .index("by_org_key", ["orgId", "key"])
  .index("by_expiry", ["expiresAt"]);

// ---------------------------------------------------------------------------
// Settlement — PAYMENT SUCCESS ≠ SETTLEMENT CONFIRMED (prompt §18)
// ---------------------------------------------------------------------------
export const settlementBatches = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  currency: v.string(),
  status: v.union(
    v.literal("EXPECTED"),
    v.literal("PROCESSING"),
    v.literal("SETTLED"),
    v.literal("PARTIALLY_SETTLED"),
    v.literal("FAILED"),
    v.literal("HELD"),
  ),
  grossMinor: v.number(),
  feeMinor: v.number(),
  reserveMinor: v.number(),
  netMinor: v.number(),
  transactionCount: v.number(),
  reference: v.string(), // stl_...
  settledAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_merchant_created", ["merchantId", "createdAt"]);

// Settlement as seen by the bank — feeds the reconciliation engine (prompt §19)
export const bankRecords = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  batchReference: v.string(), // matches settlementBatches.reference
  bankReference: v.string(),
  amountMinor: v.number(),
  currency: v.string(),
  direction: v.union(v.literal("credit"), v.literal("debit")),
  valueDate: v.number(),
  source: v.string(), // which bank statement/statement adapter produced it
  status: v.union(v.literal("unmatched"), v.literal("matched"), v.literal("exception")),
  createdAt: v.number(),
})
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_batch_reference", ["batchReference"]);

// Reconciliation exceptions (prompt §19)
export const reconExceptions = defineTable({
  orgId: v.id("organizations"),
  batchReference: v.optional(v.string()),
  type: v.union(
    v.literal("missing_settlement"),
    v.literal("amount_mismatch"),
    v.literal("ledger_vs_bank_mismatch"),
    v.literal("unexplained_bank_entry"),
    v.literal("duplicate"),
  ),
  severity: v.union(v.literal("low"), v.literal("medium"), v.literal("high")),
  detail: v.string(),
  ledgerAmountMinor: v.optional(v.number()),
  bankAmountMinor: v.optional(v.number()),
  currency: v.optional(v.string()),
  status: v.union(v.literal("open"), v.literal("resolved"), v.literal("acknowledged")),
  createdAt: v.number(),
  resolvedAt: v.optional(v.number()),
})
  .index("by_org_status_created", ["orgId", "status", "createdAt"]);

// ---------------------------------------------------------------------------
// Webhooks — signed, retried, observable (prompt §30)
// ---------------------------------------------------------------------------
export const webhookEndpoints = defineTable({
  orgId: v.id("organizations"),
  url: v.string(),
  events: v.array(v.string()),
  secret: v.string(), // signing secret, whsec_...
  status: v.union(v.literal("active"), v.literal("disabled")),
  createdAt: v.number(),
})
  .index("by_org", ["orgId"]);

export const webhookDeliveries = defineTable({
  orgId: v.id("organizations"),
  endpointId: v.id("webhookEndpoints"),
  transactionId: v.optional(v.id("transactions")),
  event: v.string(),
  payload: v.any(),
  status: v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed"), v.literal("dead")),
  attempts: v.number(),
  responseStatus: v.optional(v.number()),
  lastError: v.optional(v.string()),
  nextAttemptAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_status_next", ["status", "nextAttemptAt"])
  .index("by_transaction", ["transactionId"]);

// ---------------------------------------------------------------------------
// Audit — actor, action, resource, before/after (prompt §39)
// ---------------------------------------------------------------------------
export const auditLogs = defineTable({
  orgId: v.optional(v.id("organizations")),
  actor: v.string(), // user id, api key prefix, or "system"
  action: v.string(), // e.g. "transaction.created", "key.created"
  resource: v.string(),
  resourceId: v.optional(v.string()),
  before: v.optional(v.any()),
  after: v.optional(v.any()),
  requestId: v.optional(v.string()),
  at: v.number(),
})
  .index("by_org_at", ["orgId", "at"])
  .index("by_actor_at", ["actor", "at"]);

// ---------------------------------------------------------------------------
// Customers (prompt §20) — lightweight CRM keyed by org + email. Payment
// engine upserts customers automatically on every transaction with an email.
// ---------------------------------------------------------------------------
export const customers = defineTable({
  orgId: v.id("organizations"),
  email: v.string(),
  name: v.optional(v.string()),
  name_search: v.optional(v.string()),
  phone: v.optional(v.string()),
  metadata: v.optional(v.any()),
  status: v.union(v.literal("active"), v.literal("blocked")),
  transactionCount: v.number(),
  successfulCount: v.number(),
  // Per-currency lifetime volume map — never mix currencies into one number
  // (audit fix). Shape: { [ISO currency code]: minor units }.
  lifetimeVolumeByCurrency: v.optional(v.any()),
  lastTransactionAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_org_email", ["orgId", "email"])
  .index("by_org_created", ["orgId", "createdAt"]);

// ---------------------------------------------------------------------------
// Payment links (prompt §21) — shareable checkout. linkId is public.
// ---------------------------------------------------------------------------
export const paymentLinks = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  linkId: v.string(), // pl_... public identifier
  title: v.string(),
  description: v.optional(v.string()),
  // Fixed amount, or null = customer chooses at checkout ("open amount")
  amountMinor: v.optional(v.number()),
  currency: v.string(),
  status: v.union(v.literal("active"), v.literal("disabled")),
  expiresAt: v.optional(v.number()),
  maxUses: v.optional(v.number()),
  useCount: v.number(),
  successCount: v.number(),
  createdByUserId: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_link_id", ["linkId"])
  .index("by_org_created", ["orgId", "createdAt"]);

// ---------------------------------------------------------------------------
// Beneficiaries (prompt §26) — payout destinations. Full account numbers are
// NEVER stored; masked display + sha-256 hash for duplicate detection only.
// ---------------------------------------------------------------------------
export const beneficiaries = defineTable({
  orgId: v.id("organizations"),
  name: v.string(), // account holder name
  bankName: v.string(),
  bankCode: v.optional(v.string()),
  accountMasked: v.string(), // e.g. "••••4832"
  accountHash: v.string(), // sha256(accountNumber+bankCode) — duplicate detection
  currency: v.string(),
  status: v.union(v.literal("verified"), v.literal("pending_verification"), v.literal("rejected")),
  verifiedAt: v.optional(v.number()),
  createdByUserId: v.optional(v.id("users")),
  createdAt: v.number(),
})
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_org_hash", ["orgId", "accountHash"]);

// ---------------------------------------------------------------------------
// Payouts (prompt §25) — merchant payouts to beneficiaries.
// PENDING → PROCESSING → SUCCESSFUL | FAILED | REVERSED
// ---------------------------------------------------------------------------
export const payouts = defineTable({
  orgId: v.id("organizations"),
  merchantId: v.id("merchants"),
  beneficiaryId: v.id("beneficiaries"),
  payoutId: v.string(), // po_...
  reference: v.string(), // idempotent merchant reference (unique per org)
  amountMinor: v.number(),
  feeMinor: v.number(),
  currency: v.string(),
  status: v.union(
    v.literal("PENDING"),
    v.literal("PROCESSING"),
    v.literal("SUCCESSFUL"),
    v.literal("FAILED"),
    v.literal("REVERSED"),
  ),
  provider: v.optional(v.string()),
  providerReference: v.optional(v.string()),
  failureCategory: v.optional(v.string()),
  failureCode: v.optional(v.string()),
  failureMessage: v.optional(v.string()),
  failureRetryable: v.optional(v.boolean()),
  narration: v.optional(v.string()),
  completedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_payout_id", ["payoutId"])
  .index("by_org_reference", ["orgId", "reference"])
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_org_status_created", ["orgId", "status", "createdAt"]);

// ---------------------------------------------------------------------------
// Disputes (prompt §16) — chargeback lifecycle per transaction.
// ---------------------------------------------------------------------------
export const disputes = defineTable({
  orgId: v.id("organizations"),
  transactionId: v.id("transactions"),
  disputeId: v.string(), // dsp_...
  status: v.union(
    v.literal("OPEN"),
    v.literal("AWAITING_EVIDENCE"),
    v.literal("UNDER_REVIEW"),
    v.literal("WON"),
    v.literal("LOST"),
    v.literal("CANCELLED"),
  ),
  reasonCode: v.string(), // e.g. fraudulent, product_not_received, duplicate
  reasonDetails: v.optional(v.string()),
  amountMinor: v.number(),
  currency: v.string(),
  evidence: v.optional(
    v.array(
      v.object({
        note: v.string(),
        addedBy: v.string(),
        addedAt: v.number(),
      }),
    ),
  ),
  resolution: v.optional(v.string()),
  resolvedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_dispute_id", ["disputeId"])
  .index("by_transaction", ["transactionId"])
  .index("by_org_created", ["orgId", "createdAt"])
  .index("by_org_status_created", ["orgId", "status", "createdAt"]);

export const disputeEvents = defineTable({
  disputeId: v.id("disputes"),
  type: v.string(), // opened, evidence_added, resolved, cancelled
  data: v.optional(v.any()),
  actor: v.string(),
  at: v.number(),
}).index("by_dispute", ["disputeId", "at"]);

// ---------------------------------------------------------------------------
// Provider health (prompt §36) — per provider/environment/day aggregates that
// feed the routing engine and the dashboard.
// ---------------------------------------------------------------------------
export const providerHealth = defineTable({
  provider: v.string(),
  environment: v.union(v.literal("sandbox"), v.literal("production")),
  day: v.string(), // UTC YYYY-MM-DD
  charges: v.number(),
  successful: v.number(),
  failed: v.number(),
  pending: v.number(),
  latencySumMs: v.number(),
  lastErrorAt: v.optional(v.number()),
  lastErrorMessage: v.optional(v.string()),
  updatedAt: v.number(),
}).index("by_provider_env_day", ["provider", "environment", "day"]);

// ---------------------------------------------------------------------------
// GitHub integration — org-scoped connection for repository visibility in the
// developer platform. The PAT is stored only as a SHA-256 hash (see github.ts).
// ---------------------------------------------------------------------------
// TEMPORARY staging table for the one-time GitHub publish (see gitSyncTemp.ts).
// Dropped from use immediately after; harmless if left defined.
export const gitSyncStage = defineTable({
  path: v.string(),
  mode: v.string(),
  part: v.number(),
  totalParts: v.number(),
  b64: v.string(),
});

export const githubConnections = defineTable({
  orgId: v.id("organizations"),
  /** GitHub user/org the token belongs to (from /user endpoint). */
  accountLogin: v.string(),
  accountType: v.string(), // "User" | "Organization"
  /** Bare PAT never stored — kept only as SHA-256 hash; last 4 chars for UI. */
  tokenHash: v.string(),
  tokenHint: v.string(),
  scopes: v.optional(v.string()),
  connectedByUserId: v.optional(v.id("users")),
  status: v.union(v.literal("active"), v.literal("revoked")),
  createdAt: v.number(),
  updatedAt: v.number(),
  lastVerifiedAt: v.optional(v.number()),
})
  .index("by_org", ["orgId"])
  .index("by_org_login", ["orgId", "accountLogin"]);

const schema = defineSchema(
  {
    ...authTables, // do not remove or modify

    users: defineTable({
      name: v.optional(v.string()),
      image: v.optional(v.string()),
      email: v.optional(v.string()),
      emailVerificationTime: v.optional(v.number()),
      isAnonymous: v.optional(v.boolean()),
      role: v.optional(roleValidator),
    }).index("email", ["email"]),

    organizations,
    orgMembers,
    merchants,
    apiKeys,
    transactions,
    transactionEvents,
    ledgerAccounts,
    ledgerEntries,
    idempotencyKeys,
    settlementBatches,
    bankRecords,
    reconExceptions,
    webhookEndpoints,
    webhookDeliveries,
    auditLogs,
    customers,
    paymentLinks,
    beneficiaries,
    payouts,
    disputes,
    disputeEvents,
    providerHealth,
  githubConnections,
  gitSyncStage,
  },
  {
    schemaValidation: false,
  },
);

export default schema;
