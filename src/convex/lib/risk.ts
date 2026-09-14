// RAEVOLT Risk Engine (prompt §15) — deterministic rules scoring.
//
// This is a transparent, auditable rules engine, NOT machine learning. Every
// score is explainable: each rule that fires adds a reason string and a
// weighted contribution. Decisions map to review workflows:
//   ALLOW  → process normally
//   REVIEW → process, flag for operations review (score recorded)
//   HOLD   → decline, may be released by operations
//   BLOCK  → decline, do not retry (fraud signal)
//
// Inputs that require database reads (velocity counters) are supplied by the
// caller, so this module stays pure and unit-testable.

export interface RiskSignals {
  /** Transactions for the same org+customerEmail in the last 10 minutes. */
  customerTxns10m: number;
  /** Failed transactions for the same org+customerEmail in the last 30 min. */
  customerFailed30m: number;
  /** Total transactions for the org in the last 60 seconds (burst). */
  orgTxns1m: number;
}

export interface RiskInput {
  amountMinor: number;
  currency: string;
  paymentMethod: string;
  customerEmail?: string;
  signals: RiskSignals;
}

export interface RiskAssessment {
  score: number; // 0..100
  decision: "ALLOW" | "REVIEW" | "HOLD" | "BLOCK";
  reasons: string[];
}

// Amount thresholds in minor units (kobo/cents). 5,000,000 = ₦50,000.
const HIGH_AMOUNT = 5_000_000;
const VERY_HIGH_AMOUNT = 20_000_000;

// Small, honest disposable-email list — extendable data, not code.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "yopmail.com",
  "trashmail.com",
  "sharklasers.com",
]);

export function evaluatePaymentRisk(input: RiskInput): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];

  // --- Amount-based rules -------------------------------------------------
  if (input.amountMinor >= VERY_HIGH_AMOUNT) {
    score += 45;
    reasons.push("amount_very_high");
  } else if (input.amountMinor >= HIGH_AMOUNT) {
    score += 25;
    reasons.push("amount_high");
  }

  // --- Customer velocity (10-minute window) -------------------------------
  if (input.signals.customerTxns10m > 10) {
    score += 55;
    reasons.push("customer_velocity_extreme");
  } else if (input.signals.customerTxns10m > 5) {
    score += 30;
    reasons.push("customer_velocity_high");
  }

  // --- Failed-payment velocity (card-testing signal) ----------------------
  if (input.signals.customerFailed30m >= 3) {
    score += 35;
    reasons.push("repeated_failures");
  }

  // --- Org-wide burst ------------------------------------------------------
  if (input.signals.orgTxns1m > 30) {
    score += 20;
    reasons.push("org_burst");
  }

  // --- Email signals -------------------------------------------------------
  const email = input.customerEmail?.toLowerCase();
  if (!email) {
    score += 10;
    reasons.push("no_customer_email");
  } else {
    const domain = email.split("@")[1];
    if (domain && DISPOSABLE_DOMAINS.has(domain)) {
      score += 25;
      reasons.push("disposable_email_domain");
    }
  }

  // --- Payment-method weighting -------------------------------------------
  // Card-not-present carries the highest fraud exposure; bank rails are
  // account-verified and effectively pre-authenticated.
  if (input.paymentMethod === "card") {
    score += 5;
  }

  score = Math.min(100, score);

  const decision: RiskAssessment["decision"] =
    score >= 70 ? "BLOCK" : score >= 45 ? "HOLD" : score >= 25 ? "REVIEW" : "ALLOW";

  return { score, decision, reasons };
}
