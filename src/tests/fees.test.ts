// Unit tests: fee engine — deterministic integer rounding and cross-currency
// fixed-fee normalization. Financial math must be exact.
import { describe, expect, test } from "bun:test";
import { computeFees } from "../convex/lib/fees";
import type { Doc } from "../convex/_generated/dataModel";

function merchant(over: Partial<Doc<"merchants">> = {}): Doc<"merchants"> {
  return {
    _id: "m1" as never,
    _creationTime: 0,
    orgId: "o1" as never,
    name: "Fee Test Merchant",
    environment: "sandbox",
    status: "active",
    feeBps: 150, // 1.5%
    feeFixedMinor: 0,
    feeCurrency: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Doc<"merchants">;
}

describe("fee engine", () => {
  test("percentage-only fee, exact half-up rounding", () => {
    // 2500 * 150 / 10000 = 37.5 -> round half-up = 38
    const f = computeFees(merchant(), 2500, "NGN");
    expect(f.feeMinor).toBe(38);
    expect(f.netMinor).toBe(2500 - 38);
    expect(f.currency).toBe("NGN");
    expect(f.parts).toHaveLength(1);
  });

  test("exact percentage has no rounding drift", () => {
    // 150000 * 150 / 10000 = 2250 exactly
    const f = computeFees(merchant(), 150_000, "NGN");
    expect(f.feeMinor).toBe(2250);
    expect(f.netMinor).toBe(147_750);
  });

  test("percentage + fixed fee sum", () => {
    const f = computeFees(merchant({ feeFixedMinor: 100 }), 10_000, "NGN");
    // 10_000 * 150/10000 = 150, + 100 fixed = 250
    expect(f.feeMinor).toBe(250);
    expect(f.parts.map((p) => p.label)).toEqual(["1.50%", "fixed"]);
  });

  test("tiny amounts: exact math, no hidden clamping", () => {
    // 100 * 150/10000 = 1.5 -> rounds to 2; + 5000 fixed = 5002.
    // Net can go negative if merchant pricing is misconfigured — the engine
    // must stay exact (fee parts remain auditable), never silently clamp,
    // because the ledger must reconcile against provider statements.
    const f = computeFees(merchant({ feeFixedMinor: 5000 }), 100, "NGN");
    expect(f.feeMinor).toBe(5002);
    expect(f.netMinor).toBe(100 - 5002);
    expect(f.parts.map((p) => p.amountMinor)).toEqual([2, 5000]);
  });

  test("fee currency normalization across equal-decimal currencies", () => {
    // Merchant priced in USD fixed 50 cents, transaction in NGN.
    const f = computeFees(merchant({ feeCurrency: "USD", feeFixedMinor: 50 }), 10_000, "NGN");
    // USD and NGN both 2 decimals -> scale 1 -> fixed stays 50 minor units
    expect(f.feeMinor).toBe(200); // 150 + 50
    expect(f.currency).toBe("USD");
  });

  test("zero-fee merchant yields zero fee and full net", () => {
    const f = computeFees(merchant({ feeBps: 0 }), 99_999, "NGN");
    expect(f.feeMinor).toBe(0);
    expect(f.netMinor).toBe(99_999);
    expect(f.parts).toHaveLength(0);
  });
});
