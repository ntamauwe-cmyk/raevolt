import { useAuth } from "@/hooks/use-auth";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  ArrowLeftRight,
  Landmark,
  KeyRound,
  Webhook,
  Github,
  Users,
  ScrollText,
  LogOut,
  ShieldCheck,
  Loader2,
  Link2,
  Send,
  ShieldAlert,
  Contact,
} from "lucide-react";
import { RaevoltLogo } from "@/components/brand";

const NAV = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/dashboard/transactions", label: "Transactions", icon: ArrowLeftRight },
  { to: "/dashboard/customers", label: "Customers", icon: Contact },
  { to: "/dashboard/links", label: "Payment links", icon: Link2 },
  { to: "/dashboard/payouts", label: "Payouts", icon: Send },
  { to: "/dashboard/settlements", label: "Settlements", icon: Landmark },
  { to: "/dashboard/disputes", label: "Disputes", icon: ShieldAlert },
  { to: "/dashboard/developers", label: "Developers", icon: KeyRound },
  { to: "/dashboard/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/dashboard/repositories", label: "Repositories", icon: Github },
  { to: "/dashboard/team", label: "Team", icon: Users },
  { to: "/dashboard/audit", label: "Audit log", icon: ScrollText },
];

export default function DashboardLayout() {
  const { user, signOut, isLoading } = useAuth();
  const navigate = useNavigate();
  const orgContext = useQuery(api.orgs.getOrgContext, {});
  const bootstrap = useMutation(api.orgs.bootstrapOrg);

  // Provision the tenant on first dashboard visit (idempotent).
  useEffect(() => {
    if (!isLoading && user && orgContext === null) {
      void bootstrap({}).catch((err) => console.error("bootstrap failed", err));
    }
  }, [isLoading, user, orgContext, bootstrap]);

  if (isLoading || orgContext === undefined || orgContext === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </main>
    );
  }

  const environment = orgContext.org.environment;

  return (
    <div className="flex min-h-screen bg-background">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
        <div className="flex h-16 items-center gap-2 border-b px-5">
          <a href="/" className="flex items-center gap-2" aria-label="RAEVOLT home">
            <RaevoltLogo />
          </a>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t p-3">
          <div className="rounded-md bg-muted p-3">
            <div className="flex items-center gap-2 text-xs font-medium">
              <ShieldCheck className="size-3.5 text-chart-2" />
              Sandbox environment
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Test keys only. No live money movement is configured in v1.
            </p>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b bg-background/95 px-4 backdrop-blur md:px-8">
          <div className="flex items-center gap-3">
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[10px] uppercase tracking-wider",
                environment === "production" ? "border-chart-2 text-chart-2" : "text-muted-foreground",
              )}
            >
              {environment}
            </Badge>
            <span className="truncate text-sm font-semibold">{orgContext.org.name}</span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="gap-2">
                <span className="flex size-7 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {(user?.name ?? user?.email ?? "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden text-sm sm:inline">{user?.name ?? user?.email}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="text-xs text-muted-foreground">Role</div>
                <div className="text-sm font-medium capitalize">{orgContext.role}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () => {
                  await signOut();
                  navigate("/");
                }}
                className="cursor-pointer text-destructive focus:text-destructive"
              >
                <LogOut className="mr-2 size-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className="flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
