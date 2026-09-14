// RAEVOLT — currency + money primitives.
// Money is ALWAYS integer minor units (kobo/cents). Never floats. (Prompt §47)

export interface CurrencyInfo {
  code: string;
  decimals: number;
  symbol: string;
  name: string;
}

// v1 registry — global by architecture (prompt §27, §52). Adding a currency is
// data, not code.
export const CURRENCIES: Record<string, CurrencyInfo> = {
  NGN: { code: "NGN", decimals: 2, symbol: "₦", name: "Nigerian Naira" },
  USD: { code: "USD", decimals: 2, symbol: "$", name: "US Dollar" },
  EUR: { code: "EUR", decimals: 2, symbol: "€", name: "Euro" },
  GBP: { code: "GBP", decimals: 2, symbol: "£", name: "Pound Sterling" },
  GHS: { code: "GHS", decimals: 2, symbol: "GH₵", name: "Ghanaian Cedi" },
  KES: { code: "KES", decimals: 2, symbol: "KSh", name: "Kenyan Shilling" },
  ZAR: { code: "ZAR", decimals: 2, symbol: "R", name: "South African Rand" },
  XOF: { code: "XOF", decimals: 0, symbol: "CFA", name: "West African CFA Franc" },
};

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

export function currencyDecimals(code: string): number {
  return CURRENCIES[code]?.decimals ?? 2;
}

function currencySymbol(code: string): string {
  return CURRENCIES[code]?.symbol ?? "";
}

/** Format minor units into a display string, e.g. 125000 NGN -> "₦1,250.00". */
export function formatMoney(amountMinor: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  const value = amountMinor / 10 ** decimals;
  const formatted = value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${currencySymbol(currency)}${formatted}`;
}

/** Signed variant for ledger-style tables (credits positive, debits negative). */
export function formatMoneySigned(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? "−" : "+";
  return `${sign} ${formatMoney(Math.abs(amountMinor), currency)}`;
}

/** "₦1,250.00 NGN" — display amount with explicit ISO code for tables. */
export function formatMoneyWithCode(amountMinor: number, currency: string): string {
  return `${formatMoney(amountMinor, currency)} ${currency}`;
}

/** Compact axis label for charts: 1_250_000 kobo -> "₦12.5k" */
export function formatMoneyCompact(amountMinor: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  const value = amountMinor / 10 ** decimals;
  const symbol = currencySymbol(currency);
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${symbol}${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${symbol}${(value / 1_000).toFixed(1)}k`;
  return `${symbol}${value.toFixed(decimals === 0 ? 0 : 0)}`;
}
