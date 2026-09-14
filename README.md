# RAEVOLT — Payment Infrastructure

**RAEVOLT** is a provider-independent, API-first payment infrastructure platform by **RAE Technologies Limited**. It routes payments across replaceable provider adapters, records every fund movement in an immutable double-entry ledger, and exposes real-time status — pending → processing → cleared/failed — through webhooks, API queries and a merchant dashboard. RAEVOLT is not RAE Pay, RAE Wallet, Heyra, RAE Mind AI or Big Winz; it is an independent infrastructure product.

## What v1 does

v1 targets **merchants accepting payments** and **developers integrating the API**:

- **Merchant dashboard** — overview analytics, transactions, Transaction 360, customers, payment links, payouts, settlements & reconciliation, disputes, developers (API keys), webhooks, team & settings, audit log.
- **Payments engine** — create, process, refund and reverse payments via the dashboard, the public REST API, or a hosted **payment link checkout**. All entry points run through the same engine.
- **Real-time status pipeline** — every state transition (`CREATED → PENDING → PROCESSING → SUCCESSFUL | FAILED | …`) is recorded as an append-only event.
- **Programmatic visibility** — signed webhooks with retries + API queries for every fund movement. Zero opaque holds.
- **Payouts & beneficiaries** — move settled balance to any bank account (0.2% fee, capped); failed payouts automatically return funds and fees via compensating ledger entries.
- **Disputes & chargebacks** — full lifecycle (open → evidence → review → won/lost) with balanced chargeback postings on loss.
- **Customers** — built automatically from payment activity with lifetime volume that refunds reduce.
- **Sandbox** — simulate success, pending rails, issuer declines, insufficient funds, timeouts, provider failures and fraud rejections with full lifecycle events.

Out of scope for v1 (roadmap stages 5–9): subscriptions, split payments, FX engine, provider-initiated dispute webhooks, intelligent routing across live adapters, RAEVOLT Switch.

## Architecture

```
Merchant Apps / Dashboard
        ↓
RAEVOLT API (/api/v1)
        ↓
RAEVOLT Payment Engine  →  Risk Engine  →  Fee Engine
        ↓
RAEVOLT Ledger (double-entry, immutable)
        ↓
Provider Adapters (sandbox | paystack | flutterwave — pluggable)
        ↓
Banks / Processors / Payment Networks
```

Key invariants:

- **Money is integer minor units.** No floats anywhere in financial math.
- **The ledger is the source of truth.** Entries are never edited or deleted; corrections are reversals/adjustments. Balances are computed from entries.
- **Idempotency is mandatory on writes.** Same key + same payload replays the original response; same key + different payload is rejected (`422`).
- **Payment success ≠ settlement confirmed.** Batches move funds through `EXPECTED → PROCESSING → SETTLED` with bank-record reconciliation.
- **Tenant isolation is enforced server-side.** Every query resolves the caller's organization from auth, never from the request.
- **Sandbox and production never mix.** Environment is enforced at the API-key level; sandbox keys cannot reach production providers.

## Project structure

```
src/
  convex/                  # Backend (Convex functions = the RAEVOLT API)
    schema.ts              # Tables: orgs, merchants, transactions, ledger,
                           # idempotency, settlements, webhooks, audit, RBAC
    payments.ts            # Payment engine: lifecycle, retries, refunds
    settlements.ts         # Batch building, settling, reconciliation
    webhooks.ts            # Signed dispatcher with backoff + dead-letter
    api.ts / http.ts       # Public REST surface (/api/v1)
    queries.ts             # Dashboard read/write surface (RBAC-checked)
    services.ts            # API keys, webhook endpoints, audit, settlements
    orgs.ts                # Org bootstrap, team RBAC, merchant config
    lib/                   # fees, ledger, idempotency, apikeys, crypto, rbac
    providers/             # PaymentProviderAdapter interface + sandbox adapter
    crons.ts               # Webhook dispatch scheduler
  pages/
    Landing.tsx            # Public marketing page
    dashboard/             # Overview, Transactions, Transaction 360,
                           # Settlements, Developers, Webhooks, Team, Audit
  lib/money.ts             # Currency registry + minor-unit formatting
```

## Public API (v1)

Base URL: your Convex deployment's HTTP surface (`*.convex.site`). All requests authenticate with `Authorization: Bearer <secret key>`.

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/v1/health` | GET | Public health check (no auth) |
| `/api/v1/payments` | POST | Create + process a payment (supports `Idempotency-Key`) |
| `/api/v1/payments/:transactionId` | GET | Retrieve a payment |
| `/api/v1/payments/:transactionId/refund` | POST | Full or partial refund (`amountMinor` optional) |
| `/api/v1/balance` | GET | Merchant balances from the ledger |
| `/api/v1/settlements` | GET | List settlement batches |
| `/api/v1/payouts` | POST / GET | Create a payout / list recent payouts |
| `/api/v1/customers` | GET | List customers (auto-built from payments) |
| `/api/v1/checkout/:linkId` | GET / POST | Public payment-link preview + checkout (no auth) |

Example:

```bash
curl -X POST https://<deployment>.convex.site/api/v1/payments \
  -H "Authorization: Bearer sk_sandbox_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order_12345" \
  -d '{"amountMinor": 250000, "currency": "NGN", "paymentMethod": "card",
       "reference": "order_12345", "customerEmail": "customer@example.com"}'
```

Errors are structured: `{ "error": { "code": "validation_error", "message": "…" } }` with codes including `validation_error`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `idempotency_conflict`, `provider_unavailable`, `rate_limited`.

## Webhooks

Endpoints are managed in the dashboard. Deliveries are signed with HMAC-SHA256 (`X-RAEVOLT-Signature: t=<ts>,v1=<hex>` over `"<ts>.<payload>"`), retried with exponential backoff (30s → 21.6h, 6 attempts), then dead-lettered with replay from the dashboard. Events include `payment.created`, `payment.processing`, `payment.successful`, `payment.failed`, `payment.refunded`, `settlement.created`, `settlement.completed` and more.

## Setup

```bash
bun install
bun convex dev --once   # generate backend types + deploy functions
bun run dev             # start the frontend (managed by the platform)
```

Environment variables (never commit real secrets; platform-managed or `bunx convex env set KEY value`):

- `VITE_CONVEX_URL` — Convex deployment URL for the frontend (already configured by the platform).

Future provider adapters (documented checklist — add variables only when the adapter code exists, never before):

- `PAYSTACK_SECRET_KEY` / `PAYSTACK_PUBLIC_KEY` — Paystack live rail adapter (not yet implemented)
- `FLW_SECRET_KEY` / `FLW_PUBLIC_KEY` — Flutterwave live rail adapter (not yet implemented)
- `REDIS_URL` — distributed rate limiting and queues at scale (Stage 8+)
- `FX_RATE_PROVIDER_KEY` — live FX rate source (rates are never fabricated)

## Tests

```bash
bun test src/tests/    # 36 unit tests: money, crypto/keys, idempotency, fees, risk
```

Covers integer-money formatting, SHA-256/HMAC (RFC 4231 vector), API-key shape,
idempotency canonicalization, fee rounding and currency normalization, and risk
engine decision bands.

## Development

- **Typecheck:** `bun tsc -b --noEmit`
- **Deploy Convex functions:** `bun convex dev --once` (non-interactive)
- **Sandbox:** the org environment defaults to `sandbox`; the payment provider is the built-in sandbox adapter, which simulates the full lifecycle without touching external rails.

## Security principles

- Secret keys are generated once, shown once, and stored only as SHA-256 hashes with a display prefix.
- RBAC uses permission-level checks (`org:manage`, `payments:create`, `settlement:view`, `keys:manage`, `webhooks:manage`, `audit:view`, `ledger:view`) mapped from roles: owner, admin, finance, developer, operations, viewer.
- All consequential actions (payment state changes, key creation/revocation, settlement builds, webhook changes) are written to an append-only audit log with actor, resource and before/after values.
- No card data is stored; the card-data boundary is designed around provider-hosted collection and tokenization.
- Sandbox and production are separated at the key, environment and adapter levels.

## Financial correctness notes

- Fees are computed by a dedicated fee engine (percentage in basis points + fixed component) with deterministic integer rounding.
- Every financial movement posts a balanced double-entry group (merchant balance, provider clearing, platform fees, settlement payable, payouts payable, reserve). Debits equal credits per currency.
- Refunds post compensating entries; partial refunds accumulate `refundedMinor` and can never exceed the original amount.
- Payouts reserve funds on create; success rails them out, failure returns amount + fee, reversal returns the amount from the rail.
- Lost disputes post a balanced chargeback group (amount back to the rail + dispute fee); won disputes move no money.
- Idempotency records are fingerprinted (SHA-256 over the normalized payload) and expire after 24h.
- Beneficiary account numbers are never stored — masked display plus a SHA-256 hash for duplicate detection only.

## Verification performed

The platform was verified end-to-end against the live deployment:

- Payment lifecycle (success, fee computation, ledger posting), idempotency replay + conflict, partial → over-refund rejection → full refund, settlement build/settle/reconcile (ledger-conservation holding).
- Payment links: public preview, checkout payment through the standard engine, usage counters.
- Payouts: beneficiary creation (masked + hashed), payout with fee, insufficient-balance validation.
- Disputes: provider-style open → lost, with the chargeback ledger group.
- **Ledger conservation audit: 14 entries across 5 posting groups — all balanced, zero unbalanced.**

## Roadmap

1. **Stage 5 — risk deepening:** device/IP signals, rules DSL, provider-initiated dispute webhooks.
2. **Stage 6 — merchant platform:** invoices, subscriptions, split payments.
3. **Stage 7 — developer platform:** API explorer, SDKs, OpenAPI spec publication.
4. **Stage 8 — intelligence:** routing engine over real adapters using recorded provider health, advanced analytics.
5. **Stage 9 — RAEVOLT Switch:** architectural boundary for direct bank/rail connectivity.

## Limitations (v1)

- The only configured provider adapter is the sandbox simulator; Paystack/Flutterwave adapters are architecturally prepared but not wired to live credentials.
- No live bank connectivity, card-network membership or regulatory claims — none are implied.
- Reconciliation compares ledger vs settlement batches and ingested bank records; automated bank-statement ingestion adapters come later.
- Single-currency settlement per batch; multi-currency balances display is supported, FX conversion is not yet implemented.

---

RAEVOLT Payment Infrastructure by RAE Technologies Limited.
