// RAEVOLT developer portal (prompt §31): API keys (shown once, hashed at
// rest), quickstart, sandbox scenarios and error reference.
import { useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader, EmptyState } from "@/components/raevolt";
import { KeyRound, Plus, Copy, Ban, Loader2, Terminal, Check } from "lucide-react";
import { toast } from "sonner";

// Convex HTTP surface host derived from VITE_CONVEX_URL (.cloud → .site).
const API_BASE = ((import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "").replace(
  /\.cloud$/,
  ".site",
);

function quickstartFor(key: string | null): string {
  return `curl -X POST ${API_BASE || "https://<your-deployment>.convex.site"}/api/v1/payments \\
  -H "Authorization: Bearer ${key ?? "sk_sandbox_YOUR_KEY"}" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order_12345" \\
  -d '{
    "amountMinor": 250000,
    "currency": "NGN",
    "paymentMethod": "card",
    "reference": "order_12345",
    "customerEmail": "customer@example.com"
  }'`;
}

const ERRORS: { code: string; http: string; meaning: string }[] = [
  { code: "validation_error", http: "400", meaning: "A request field is missing or malformed. Fix the payload before retrying." },
  { code: "unauthorized", http: "401", meaning: "Missing or invalid secret key. Keys are passed as a Bearer token." },
  { code: "forbidden", http: "403", meaning: "The key's environment cannot reach the requested resource." },
  { code: "not_found", http: "404", meaning: "No transaction with that id exists in this organization." },
  { code: "conflict", http: "409", meaning: "Duplicate refund, or an identical request is still in progress." },
  { code: "idempotency_conflict", http: "422", meaning: "This Idempotency-Key was reused with a different request body." },
  { code: "provider_unavailable", http: "503", meaning: "No provider adapter is reachable for this environment. Retry later." },
  { code: "rate_limited", http: "429", meaning: "Too many requests for this key within the rate window." },
];

const SANDBOX_EVENTS = [
  { event: "payment.created", when: "Payment accepted by the engine" },
  { event: "payment.processing", when: "Sent to the provider adapter" },
  { event: "payment.successful", when: "Provider confirmed success" },
  { event: "payment.failed", when: "Provider or risk engine declined" },
  { event: "payment.refunded", when: "Full or partial refund posted" },
  { event: "settlement.created", when: "A settlement batch was built" },
  { event: "settlement.completed", when: "Batch confirmed settled" },
];

export default function Developers() {
  const keys = useQuery(api.services.listApiKeys, {});
  const orgContext = useQuery(api.orgs.getOrgContext, {});

  const createKey = useAction(api.services.createApiKey);
  const revokeKey = useMutation(api.services.revokeApiKey);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyEnv, setKeyEnv] = useState<"sandbox" | "production">("sandbox");
  const [keyMode, setKeyMode] = useState<"secret" | "publishable">("secret");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // When a fresh key exists, embed it in the quickstart for instant testing.
  const quickstart = quickstartFor(newKey);

  async function handleCreate() {
    setCreating(true);
    try {
      const r = await createKey({
        name: keyName.trim() || "Default key",
        environment: keyEnv,
        mode: keyMode,
      });
      setNewKey(r.fullKey);
      setKeyName("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  }

  function copy(text: string) {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1500);
  }

  const environment = orgContext?.org.environment ?? "sandbox";

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Developers"
        description="API keys, quickstart and the sandbox — everything needed to take the first payment programmatically."
      />

      {/* API keys */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">API keys</CardTitle>
            <CardDescription>
              Secret keys are shown once and stored only as a SHA-256 hash. Sandbox
              keys can never touch production providers.
            </CardDescription>
          </div>
          <Dialog
            open={dialogOpen}
            onOpenChange={(o) => {
              setDialogOpen(o);
              if (!o) setNewKey(null);
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="size-4" /> Create key
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-lg">
              {newKey ? (
                <>
                  <DialogHeader>
                    <DialogTitle>Save your key now</DialogTitle>
                    <DialogDescription>
                      This is the only time the full key is visible. It is stored
                      hashed and cannot be retrieved again.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex items-center gap-2 rounded-md border bg-muted p-3">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs">{newKey}</code>
                    <Button size="icon" variant="outline" onClick={() => copy(newKey)}>
                      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    </Button>
                  </div>
                  <DialogFooter>
                    <Button onClick={() => { setDialogOpen(false); setNewKey(null); }}>
                      I've saved it
                    </Button>
                  </DialogFooter>
                </>
              ) : (
                <>
                  <DialogHeader>
                    <DialogTitle>Create an API key</DialogTitle>
                    <DialogDescription>
                      Keys are scoped to this organization and to one environment.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Key name</label>
                      <Input
                        value={keyName}
                        onChange={(e) => setKeyName(e.target.value)}
                        placeholder="Production server"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Environment</label>
                        <Select value={keyEnv} onValueChange={(v) => setKeyEnv(v as typeof keyEnv)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="sandbox">Sandbox</SelectItem>
                            <SelectItem value="production">Production</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm font-medium">Mode</label>
                        <Select value={keyMode} onValueChange={(v) => setKeyMode(v as typeof keyMode)}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="secret">Secret (server-side)</SelectItem>
                            <SelectItem value="publishable">Publishable (client-side)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={handleCreate} disabled={creating}>
                      {creating ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      Generate key
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>
        </CardHeader>
        <CardContent>
          {keys === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : keys.length === 0 ? (
            <EmptyState
              icon={<KeyRound className="size-5" />}
              title="No API keys yet"
              description="Create a sandbox key to take your first test payment through the API."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k._id}>
                    <TableCell className="text-sm font-medium">{k.name}</TableCell>
                    <TableCell>
                      <button
                        className="font-mono text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => copy(k.prefix)}
                        title="Copy prefix"
                      >
                        {k.prefix}••••
                      </button>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          k.environment === "production"
                            ? "border-chart-2 text-chart-2"
                            : "text-muted-foreground"
                        }
                      >
                        {k.environment}
                      </Badge>{" "}
                      <span className="text-xs text-muted-foreground">{k.mode}</span>
                    </TableCell>
                    <TableCell>
                      <span className={k.status === "active" ? "text-sm" : "text-sm text-destructive"}>
                        {k.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}
                    </TableCell>
                    <TableCell className="text-right">
                      {k.status === "active" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            revokeKey({ keyId: k._id }).then(() => toast.success("Key revoked"))
                              .catch((e: unknown) =>
                                toast.error(e instanceof Error ? e.message : "Revoke failed"));
                          }}
                        >
                          <Ban className="size-3.5" /> Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Quickstart */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base">Quickstart</CardTitle>
              <CardDescription>
                Create a payment with one request. Pass an Idempotency-Key so
                retries can never double-charge.
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => copy(quickstart)}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />} Copy
            </Button>
          </CardHeader>
          <CardContent>
            <div className="relative">
              <Terminal className="absolute right-3 top-3 size-4 text-muted-foreground" />
              <pre className="overflow-auto rounded-lg bg-muted p-4 pr-12 text-xs leading-5">
                {quickstart}
              </pre>
            </div>
            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <p className="font-medium">GET /api/v1/payments/:id</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Track the live status pipeline for any transaction.
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="font-medium">GET /api/v1/balance</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Read merchant balances straight from the ledger.
                </p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="font-medium">GET /api/v1/settlements</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  List settlement batches and their state.
                </p>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Current environment: <span className="font-medium capitalize">{environment}</span>.
              {newKey
                ? " The quickstart above embeds your new key — copy and run it now."
                : " Create a key above to embed it in the quickstart."}
            </p>
          </CardContent>
        </Card>

        {/* Webhook events reference */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Webhook events</CardTitle>
            <CardDescription>Signed with your endpoint secret</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {SANDBOX_EVENTS.map((e) => (
                <li key={e.event}>
                  <p className="font-mono text-xs">{e.event}</p>
                  <p className="text-[11px] text-muted-foreground">{e.when}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* Sandbox scenarios */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Sandbox scenarios</CardTitle>
          <CardDescription>
            Reproduce real failure modes from the dashboard payment dialog — every
            scenario posts full lifecycle events, ledger entries and webhooks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["Successful payment", "Clears immediately and posts to the ledger"],
              ["Pending (async rail)", "Stays PENDING to model bank-transfer rails"],
              ["Issuer decline", "Fails with a non-retryable issuer code"],
              ["Insufficient funds", "Retryable failure — safe to reattempt later"],
              ["Provider timeout", "Retryable timeout with retry guidance"],
              ["Provider failure", "Temporary adapter outage simulation"],
              ["Fraud rejection", "Blocked by the risk engine"],
            ].map(([title, desc]) => (
              <div key={title} className="rounded-lg border p-3">
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Error reference */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Error codes</CardTitle>
          <CardDescription>
            Structured, documented failures — never opaque messages.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>HTTP</TableHead>
                <TableHead>Meaning</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ERRORS.map((e) => (
                <TableRow key={e.code}>
                  <TableCell className="font-mono text-xs">{e.code}</TableCell>
                  <TableCell className="tabular-nums">{e.http}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{e.meaning}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
