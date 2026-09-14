// RAEVOLT provider abstraction (prompt §12, §50) + routing engine (prompt §13).
//
// RAEVOLT owns orchestration; providers are replaceable rail adapters. Adding a
// real provider (Paystack, Flutterwave, a bank rail, or the future RAEVOLT
// Switch) means implementing PaymentProviderAdapter and registering it — the
// payment engine never changes.
//
// The sandbox adapter is a clearly separated simulation (prompt §3, §32). It is
// ONLY reachable with sandbox keys and NEVER pretends to be live processing.

export type FailureCategory =
  | "timeout"
  | "temporary_provider_failure"
  | "network_error"
  | "issuer_decline"
  | "insufficient_funds"
  | "invalid_payment_information"
  | "fraud_rejection"
  | "provider_outage"
  | "customer_cancellation";

export interface FailureInfo {
  category: FailureCategory;
  code: string;
  message: string;
  retryable: boolean;
}

export interface ChargeRequest {
  transactionId: string;
  amountMinor: number;
  currency: string;
  reference: string;
  customerEmail?: string;
  paymentMethod: string;
  metadata?: Record<string, unknown>;
}

export type ChargeResult =
  | { status: "successful"; providerReference: string }
  | { status: "pending"; providerReference: string }
  | { status: "failed"; providerReference: string; failure: FailureInfo };

export interface RefundRequest {
  transactionId: string;
  providerReference?: string;
  amountMinor: number;
  currency: string;
  reason?: string;
}

export type RefundResult =
  | { status: "successful"; providerRefundReference: string }
  | { status: "failed"; failure: FailureInfo };

export interface PaymentProviderAdapter {
  id: string;
  displayName: string;
  /** Whether this adapter can process the given method/currency pair. */
  supports(paymentMethod: string, currency: string): boolean;
  charge(req: ChargeRequest): Promise<ChargeResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
}

// ---------------------------------------------------------------------------
// Sandbox adapter — deterministic failure simulation (prompt §32, §35)
// ---------------------------------------------------------------------------
const SANDBOX_SIMULATIONS: Record<string, FailureInfo> = {
  issuer_decline: {
    category: "issuer_decline",
    code: "sandbox_card_declined",
    message: "The issuer declined this payment (simulated). Do not retry without a new attempt method.",
    retryable: false,
  },
  insufficient_funds: {
    category: "insufficient_funds",
    code: "sandbox_insufficient_funds",
    message: "The account/wallet has insufficient funds (simulated).",
    retryable: false,
  },
  timeout: {
    category: "timeout",
    code: "sandbox_timeout",
    message: "The provider timed out before a decision (simulated). Safe to retry with the same reference.",
    retryable: true,
  },
  provider_failure: {
    category: "temporary_provider_failure",
    code: "sandbox_provider_error",
    message: "The provider returned a temporary error (simulated). Retry may succeed.",
    retryable: true,
  },
  network_error: {
    category: "network_error",
    code: "sandbox_network_error",
    message: "Network error while contacting the provider (simulated).",
    retryable: true,
  },
  fraud_rejection: {
    category: "fraud_rejection",
    code: "sandbox_fraud_rejected",
    message: "Blocked by provider-side fraud screening (simulated).",
    retryable: false,
  },
  invalid_payment_information: {
    category: "invalid_payment_information",
    code: "sandbox_invalid_details",
    message: "The payment details failed validation (simulated).",
    retryable: false,
  },
  customer_cancellation: {
    category: "customer_cancellation",
    code: "sandbox_cancelled",
    message: "The customer cancelled before completing (simulated).",
    retryable: true,
  },
};

export const SANDBOX_SIMULATION_KEYS = Object.keys(SANDBOX_SIMULATIONS);

export const sandboxAdapter: PaymentProviderAdapter = {
  id: "sandbox",
  displayName: "RAEVOLT Sandbox Rail",
  supports: () => true, // the sandbox rail accepts every method/currency pair
  async charge(req) {
    const simulate = (req.metadata?.["simulate"] as string | undefined)?.toLowerCase();
    const providerReference = `sbx_${req.transactionId.slice(-10)}_${Math.floor(Math.random() * 1e6)
      .toString()
      .padStart(6, "0")}`;

    if (simulate && simulate !== "success" && simulate !== "pending") {
      const failure = SANDBOX_SIMULATIONS[simulate] ?? {
        category: "invalid_payment_information" as FailureCategory,
        code: "sandbox_unknown_simulation",
        message: `Unknown simulate directive '${simulate}'.`,
        retryable: false,
      };
      return { status: "failed", providerReference, failure };
    }

    if (simulate === "pending") {
      return { status: "pending", providerReference };
    }

    return { status: "successful", providerReference };
  },
  async refund(req) {
    return {
      status: "successful",
      providerRefundReference: `sbxr_${req.transactionId.slice(-8)}_${Math.floor(Math.random() * 1e6)
        .toString()
        .padStart(6, "0")}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Routing engine (prompt §13)
// ---------------------------------------------------------------------------
// v1 routing: provider availability by environment. The structure (candidate
// list, capability filter, health/fee hooks) is the seam where success-rate,
// latency, cost and merchant-preference routing land in a later stage.
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function routingCandidates(environment: "sandbox" | "production"): PaymentProviderAdapter[] {
  if (environment === "sandbox") return [sandboxAdapter];
  // Production has NO adapters configured yet. RAEVOLT does not pretend to
  // have live processor connectivity (prompt §3). Register real adapters here
  // when they are actually configured.
  return [];
}

export function selectProvider(
  environment: "sandbox" | "production",
  paymentMethod: string,
  currency: string,
): PaymentProviderAdapter {
  const candidates = routingCandidates(environment).filter((p) => p.supports(paymentMethod, currency));
  if (candidates.length === 0) {
    throw new ProviderUnavailableError(
      `No payment provider is configured for environment '${environment}' ` +
        `(method=${paymentMethod}, currency=${currency}).`,
    );
  }
  return candidates[0]; // primary; fallback logic lands with real providers
}
