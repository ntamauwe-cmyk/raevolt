// RAEVOLT fee engine (prompt §29). Separate from payment logic.
// All arithmetic in integer minor units — never floats.

import { merchants } from "../schema";
import { currencyDecimals } from "../../lib/money";
import type { Doc } from "../_generated/dataModel";

export interface FeeBreakdown {
  feeMinor: number;
  currency: string;
  netMinor: number;
  /** Parts of the fee, for display / audit. */
  parts: { label: string; amountMinor: number }[];
}

/**
 * fee = round(amount * feeBps / 10_000) + feeFixedMinor
 * Rounding is half-up on integers so fees are deterministic and auditable.
 */
export function computeFees(merchant: Doc<"merchants">, amountMinor: number, currency: string): FeeBreakdown {
  const feeCurrency = merchant.feeCurrency ?? currency;
  const parts: { label: string; amountMinor: number }[] = [];

  // Percentage component. If the fee currency differs from the transaction
  // currency, the percentage still applies to the amount; the fixed component
  // is charged in the fee currency. (FX-aware pricing is a later stage.)
  const pctMinor = Math.round((amountMinor * merchant.feeBps) / 10_000);
  if (pctMinor > 0) {
    parts.push({ label: `${(merchant.feeBps / 100).toFixed(2)}%`, amountMinor: pctMinor });
  }

  let fixedMinor = 0;
  if (merchant.feeFixedMinor > 0) {
    // If fee currency has different decimals than txn currency, normalize the
    // fixed fee into the transaction currency's minor units for net math.
    const feeDec = currencyDecimals(feeCurrency);
    const txnDec = currencyDecimals(currency);
    const scale = 10 ** (feeDec - txnDec);
    fixedMinor = feeDec === txnDec ? merchant.feeFixedMinor : Math.round(merchant.feeFixedMinor / scale);
    parts.push({ label: "fixed", amountMinor: fixedMinor });
  }

  const feeMinor = pctMinor + fixedMinor;
  return {
    feeMinor,
    currency: feeCurrency,
    netMinor: amountMinor - feeMinor,
    parts,
  };
}
