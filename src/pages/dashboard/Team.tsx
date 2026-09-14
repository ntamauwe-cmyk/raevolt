// RAEVOLT team + settings page (prompt §6, §7, §29): RBAC role management,
// merchant fee plan and sandbox/production environment control.
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader, EmptyState, KeyValue } from "@/components/raevolt";
import { Users, Loader2, ShieldCheck, Percent } from "lucide-react";
import { toast } from "sonner";

const ROLES: { value: string; label: string; description: string }[] = [
  { value: "owner", label: "Owner", description: "Full control including org settings" },
  { value: "admin", label: "Administrator", description: "Everything except ownership transfer" },
  { value: "finance", label: "Finance", description: "Settlements, ledger, audit visibility" },
  { value: "developer", label: "Developer", description: "API keys, webhooks, payments" },
  { value: "operations", label: "Operations", description: "Settlement and ledger visibility" },
  { value: "viewer", label: "Viewer", description: "Read-only transaction access" },
];

export default function Team() {
  const orgContext = useQuery(api.orgs.getOrgContext, {});
  const members = useQuery(api.orgs.listMembers, {});
  const merchants = useQuery(api.orgs.listMerchants, {});

  const updateRole = useMutation(api.orgs.updateMemberRole);
  const updateFees = useMutation(api.orgs.updateMerchantFees);
  const updateEnv = useMutation(api.orgs.updateOrgEnvironment);

  const [feeBps, setFeeBps] = useState<string>("");
  const [feeFixed, setFeeFixed] = useState<string>("");
  const [savingFees, setSavingFees] = useState(false);

  const canManage = orgContext?.permissions.includes("org:manage") ?? false;
  const merchant = merchants?.[0];

  async function handleSaveFees() {
    if (!merchant) return;
    const bps = Number(feeBps);
    const fixed = Number(feeFixed);
    if (!Number.isFinite(bps) || bps < 0 || bps > 10000) {
      toast.error("Percentage fee must be between 0 and 10000 basis points (0–100%).");
      return;
    }
    if (!Number.isFinite(fixed) || fixed < 0) {
      toast.error("Fixed fee must be a non-negative number.");
      return;
    }
    setSavingFees(true);
    try {
      await updateFees({
        merchantId: merchant._id,
        feeBps: Math.round(bps),
        feeFixedMinor: Math.round(fixed),
      });
      toast.success("Fee plan updated.");
      setFeeBps("");
      setFeeFixed("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    } finally {
      setSavingFees(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Team & settings"
        description="Roles and permissions, merchant fee plan and environment controls."
      />

      {/* Team members */}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Team members</CardTitle>
            <CardDescription>
              Permission-level access control — roles map to explicit permission sets.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {members === undefined ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : members.length === 0 ? (
            <EmptyState icon={<Users className="size-5" />} title="No members" description="Invite teammates to collaborate." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((m) => (
                  <TableRow key={m._id}>
                    <TableCell>
                      <div className="text-sm font-medium">{m.name}</div>
                      <div className="text-xs text-muted-foreground">{m.email ?? "—"}</div>
                    </TableCell>
                    <TableCell>
                      {canManage && m.role !== "owner" ? (
                        <Select
                          value={m.role}
                          onValueChange={(role) =>
                            updateRole({ memberId: m._id, role })
                              .then(() => toast.success("Role updated"))
                              .catch((e: unknown) =>
                                toast.error(e instanceof Error ? e.message : "Update failed"))
                          }
                        >
                          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {ROLES.filter((r) => r.value !== "owner").map((r) => (
                              <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-sm capitalize">{m.role}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(m.joinedAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Merchant fee plan */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Percent className="size-4" /> Fee plan
            </CardTitle>
            <CardDescription>
              Per-transaction pricing charged by RAEVOLT — separate from provider
              costs, configured per merchant.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {merchant === undefined ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : merchant == null ? (
              <EmptyState icon={<Percent className="size-5" />} title="No merchant" description="A merchant is provisioned with your organization." />
            ) : (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <KeyValue label="Percentage fee">
                    {(merchant.feeBps / 100).toFixed(2)}%
                  </KeyValue>
                  <KeyValue label="Fixed fee">
                    {(merchant.feeFixedMinor / 100).toFixed(2)} {merchant.defaultCurrency}
                  </KeyValue>
                  <KeyValue label="Status">
                    <span className="capitalize">{merchant.status}</span>
                  </KeyValue>
                  <KeyValue label="Default currency">{merchant.defaultCurrency}</KeyValue>
                </div>
                {canManage && (
                  <div className="mt-4 space-y-3 rounded-lg border p-4">
                    <p className="text-sm font-medium">Update plan</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <label className="text-sm text-muted-foreground">Percentage (basis points)</label>
                        <Input
                          value={feeBps}
                          onChange={(e) => setFeeBps(e.target.value)}
                          placeholder={String(merchant.feeBps)}
                          inputMode="numeric"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-sm text-muted-foreground">Fixed fee (minor units)</label>
                        <Input
                          value={feeFixed}
                          onChange={(e) => setFeeFixed(e.target.value)}
                          placeholder={String(merchant.feeFixedMinor)}
                          inputMode="numeric"
                        />
                      </div>
                    </div>
                    <Button onClick={handleSaveFees} disabled={savingFees} size="sm">
                      {savingFees ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                      Save fee plan
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Environment */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4" /> Environment
            </CardTitle>
            <CardDescription>
              Sandbox and production are strictly separated. Sandbox keys never
              reach production providers and vice versa.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {orgContext === undefined ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : orgContext ? (
              <div className="space-y-4">
                <KeyValue label="Current environment">
                  <span className="capitalize">{orgContext.org.environment}</span>
                </KeyValue>
                {canManage && (
                  <div className="flex items-center gap-2">
                    {(["sandbox", "production"] as const).map((env) => (
                      <Button
                        key={env}
                        size="sm"
                        variant={orgContext.org.environment === env ? "default" : "outline"}
                        onClick={() =>
                          updateEnv({ environment: env })
                            .then(() => toast.success(`Environment switched to ${env}.`))
                            .catch((e: unknown) =>
                              toast.error(e instanceof Error ? e.message : "Switch failed"))
                        }
                      >
                        {env}
                      </Button>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Production mode requires production API keys and a configured
                  provider adapter. Test keys are rejected outside sandbox.
                </p>
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-muted-foreground">
                Sign in to view environment settings.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
