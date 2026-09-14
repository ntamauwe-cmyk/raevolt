// RAEVOLT Transaction 360 (prompt §38) — one complete view of a transaction:
// identity, live pipeline, timeline, ledger postings, webhook deliveries,
// failure intelligence and refund actions.
import { useState } from "react";
import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useParams, Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PageHeader, StatusPill, KeyValue } from "@/components/raevolt";
import { formatMoney, formatMoneySigned } from "@/lib/money";
import {
  Loader2,
  ArrowLeft,
  AlertTriangle,
  RotateCcw,
  Check,
  Webhook as WebhookIcon,
  BookLock,
  Clock,
} from "lucide-react";
import { toast } from "sonner";

function eventTypeLabel(type: string): string {
  return type.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function TransactionDetail() {
  const { transactionId = "" } = useParams();
  const data = useQuery(api.queries.getTransaction360, { transactionId });
  const refund = useAction(api.queries.refundDashboardPayment);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundBusy, setRefundBusy] = useState(false);

  if (data === undefined) {
    return (
      <div className="flex justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="mx-auto max-w-3xl py-16 text-center">
        <p className="text-sm font-semibold">Transaction not found</p>
        <p className="mt-1 text-sm text-muted-foreground">
          It may belong to a different organization, or the id is wrong.
        </p>
        <Button variant="outline" size="sm" className="mt-4" asChild>
          <Link to="/dashboard/transactions">
            <ArrowLeft className="size-4" /> Back to transactions
          </Link>
        </Button>
      </div>
    );
  }

  const t = data.transaction;
  const canRefund =
    (t.status === "SUCCESSFUL" || t.status === "PARTIALLY_REFUNDED") &&
    (t.refundedMinor ?? 0) < t.amountMinor;

  async function handleRefund(full: boolean, amountInput: string, reason: string) {
    setRefundBusy(true);
    try {
      const amountMinor = full
        ? undefined
        : Math.round(Number(amountInput) * 100);
      if (!full && (!Number.isFinite(amountMinor) || (amountMinor ?? 0) <= 0)) {
        toast.error("Enter a valid refund amount.");
        return;
      }
      await refund({
        transactionId: t.transactionId,
        amountMinor,
        reason: reason || undefined,
      });
      toast.success("Refund accepted — ledger entries posted and webhook queued.");
      setRefundOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refund failed");
    } finally {
      setRefundBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6">
        <Link
          to="/dashboard/transactions"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Transactions
        </Link>
      </div>
      <PageHeader
        title={t.reference}
        description={`RAEVOLT id ${t.transactionId}`}
        actions={
          canRefund ? (
            <Dialog open={refundOpen} onOpenChange={setRefundOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">
                  <RotateCcw className="size-4" /> Refund
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Refund payment</DialogTitle>
                  <DialogDescription>
                    Refunds post compensating ledger entries — they never edit the
                    original transaction. Partial refunds can be repeated up to the
                    original amount.
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="space-y-4"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    void handleRefund(
                      fd.get("mode") === "full",
                      String(fd.get("amount") ?? ""),
                      String(fd.get("reason") ?? ""),
                    );
                  }}
                >
                  <div className="space-y-1.5">
                    <Label htmlFor="mode">Refund type</Label>
                    <select
                      id="mode"
                      name="mode"
                      defaultValue="partial"
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                    >
                      <option value="partial">Partial — specify amount</option>
                      <option value="full">Full — {formatMoney(t.amountMinor, t.currency)}</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="refund-amount">Amount (major units)</Label>
                    <Input
                      id="refund-amount"
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      placeholder={String(t.amountMinor / 100)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="refund-reason">Reason</Label>
                    <Input id="refund-reason" name="reason" placeholder="Customer request" />
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={refundBusy} className="w-full">
                      {refundBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      Submit refund
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          ) : undefined
        }
      />

      {/* Failure intelligence banner (prompt §35) — explain, don't just report */}
      {t.status === "FAILED" && t.failureCategory && (
        <Card className="mb-6 border-destructive/40 bg-destructive/5">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <AlertTriangle className="size-4" /> Payment failed — {t.failureCategory.replace(/_/g, " ")}
            </CardTitle>
            <CardDescription>{t.failureMessage}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 text-sm sm:grid-cols-4">
            <KeyValue label="Code">{t.failureCode ?? "—"}</KeyValue>
            <KeyValue label="Stage">Provider processing</KeyValue>
            <KeyValue label="Retry recommendation">
              {t.failureRetryable ? "Safe to retry" : "Do not retry — resolve first"}
            </KeyValue>
            <KeyValue label="Provider">{t.provider}</KeyValue>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: pipeline + identity */}
        <div className="space-y-6 lg:col-span-2">
          {/* Status pipeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Status pipeline</CardTitle>
              <CardDescription>
                Pending → processing → cleared/failed. Every state change is
                recorded — payment success and settlement confirmation are
                separate milestones.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={t.status} className="px-3 py-1 text-xs" />
                {t.settlementBatchId && (
                  <StatusPill status="SETTLED" className="px-3 py-1 text-xs" />
                )}
                <span className="text-xs text-muted-foreground">
                  {t.status === "SUCCESSFUL" && !t.settlementBatchId
                    ? "Awaiting settlement batch — funds not yet paid out"
                    : `Last updated ${new Date(t.updatedAt).toLocaleString()}`}
                </span>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <KeyValue label="Amount">
                  <span className="tabular-nums">{formatMoney(t.amountMinor, t.currency)}</span>
                </KeyValue>
                <KeyValue label="Fee">
                  <span className="tabular-nums">
                    {t.feeMinor != null ? formatMoney(t.feeMinor, t.currency) : "—"}
                  </span>
                </KeyValue>
                <KeyValue label="Net">
                  <span className="tabular-nums">
                    {t.netMinor != null ? formatMoney(t.netMinor, t.currency) : "—"}
                  </span>
                </KeyValue>
                <KeyValue label="Refunded">
                  <span className="tabular-nums">{formatMoney(t.refundedMinor ?? 0, t.currency)}</span>
                </KeyValue>
                <KeyValue label="Risk">
                  {t.riskDecision
                    ? `${t.riskDecision} · score ${t.riskScore ?? "—"}`
                    : "Not evaluated"}
                </KeyValue>
                <KeyValue label="Environment">{t.environment}</KeyValue>
              </div>
            </CardContent>
          </Card>

          {/* Timeline */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="size-4" /> Timeline
              </CardTitle>
              <CardDescription>
                Merchant request → RAEVOLT engine → provider → ledger → webhooks
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="relative space-y-5 border-l pl-6">
                {data.events.map((e) => (
                  <li key={e._id} className="relative">
                    <span className="absolute -left-[1.72rem] top-1 flex size-3 items-center justify-center rounded-full border-2 border-background bg-primary" />
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-semibold">{eventTypeLabel(e.type)}</span>
                      {e.toStatus && <StatusPill status={e.toStatus} />}
                      <span className="text-xs text-muted-foreground">
                        {new Date(e.at).toLocaleTimeString()} · {e.actor}
                      </span>
                    </div>
                    {e.data != null && Object.keys(e.data as object).length > 0 && (
                      <pre className="mt-1.5 max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-4 text-muted-foreground">
                        {JSON.stringify(e.data, null, 2)}
                      </pre>
                    )}
                  </li>
                ))}
                {data.events.length === 0 && (
                  <li className="text-sm text-muted-foreground">No events recorded.</li>
                )}
              </ol>
            </CardContent>
          </Card>

          {/* Ledger postings */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <BookLock className="size-4" /> Ledger postings
              </CardTitle>
              <CardDescription>
                Immutable double-entry records — debits and credits balance per
                currency. Corrections happen through reversals, never edits.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data.ledger.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No ledger postings yet for this transaction.
                </p>
              ) : (
                <div className="space-y-4">
                  {Object.entries(
                    data.ledger.reduce<Record<string, typeof data.ledger>>((acc, entry) => {
                      (acc[entry.ledgerRef] ??= []).push(entry);
                      return acc;
                    }, {}),
                  ).map(([ledgerRef, entries]) => (
                    <div key={ledgerRef} className="rounded-lg border p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-mono text-[11px] text-muted-foreground">{ledgerRef}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(entries[0].at).toLocaleString()}
                        </span>
                      </div>
                      <table className="w-full text-sm">
                        <tbody>
                          {entries.map((e) => (
                            <tr key={e._id}>
                              <td className="py-1 pr-2 text-muted-foreground">{e.accountCode}</td>
                              <td className="py-1 pr-2">
                                <span className={e.direction === "debit" ? "text-chart-4" : "text-chart-2"}>
                                  {e.direction}
                                </span>
                              </td>
                              <td className="py-1 text-right font-medium tabular-nums">
                                {formatMoneySigned(e.amountMinor, e.currency)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {entries.map((e) => e.description).filter((d, i, a) => a.indexOf(d) === i).join(" · ")}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: identity + webhooks */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <KeyValue label="Merchant">{data.merchantName}</KeyValue>
              <KeyValue label="Customer">{t.customerEmail ?? "—"}</KeyValue>
              <KeyValue label="Payment method">
                <span className="capitalize">{t.paymentMethod.replace(/_/g, " ")}</span>
              </KeyValue>
              <KeyValue label="Provider">{t.provider}</KeyValue>
              <KeyValue label="Provider reference">
                <span className="font-mono text-xs">{t.providerReference ?? "—"}</span>
              </KeyValue>
              <KeyValue label="Idempotency key">
                <span className="break-all font-mono text-xs">{t.idempotencyKey ?? "—"}</span>
              </KeyValue>
              <KeyValue label="Created">{new Date(t.createdAt).toLocaleString()}</KeyValue>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <WebhookIcon className="size-4" /> Webhook deliveries
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.webhooks.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No webhook endpoints configured for this organization.
                </p>
              ) : (
                <ul className="space-y-3">
                  {data.webhooks.map((w) => (
                    <li key={w._id} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs">{w.event}</span>
                        <StatusPill status={w.status} />
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>attempts {w.attempts}</span>
                        {w.responseStatus != null && <span>· HTTP {w.responseStatus}</span>}
                        {w.lastError && <span className="truncate text-destructive">· {w.lastError}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {canRefund && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Quick actions</CardTitle>
              </CardHeader>
              <CardContent>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() =>
                    handleRefund(true, "", "Full refund from transaction view")
                  }
                  disabled={refundBusy}
                >
                  {refundBusy ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Check className="size-4" />
                  )}
                  Refund full amount ({formatMoney(t.amountMinor, t.currency)})
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
