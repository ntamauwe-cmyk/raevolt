// RAEVOLT landing page — payment infrastructure for merchants, platforms and
// the developers who build on them. Deep-navy financial infrastructure theme.
import { useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import {
  Zap,
  ArrowRight,
  ArrowLeftRight,
  Route,
  ShieldCheck,
  BookLock,
  Terminal,
  Webhook,
  Landmark,
  CheckCircle2,
  Loader2,
  CircleAlert,
  Route as RouteIcon,
} from "lucide-react";

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.55, ease: "easeOut" as const },
};

const FEATURES = [
  {
    icon: Route,
    title: "Intelligent routing",
    body: "Every payment is matched to the healthiest, cheapest available rail — with automatic failover when a provider degrades. You are never locked to one processor.",
  },
  {
    icon: BookLock,
    title: "True double-entry ledger",
    body: "Every movement of money is posted as immutable debits and credits. Balances are computed from the ledger itself — never a stored counter that can drift.",
  },
  {
    icon: CircleAlert,
    title: "Failure intelligence",
    body: "When a payment fails, you get the category, provider code, human explanation and whether retrying is safe. Not just 'payment failed'.",
  },
  {
    icon: ShieldCheck,
    title: "Risk, built in",
    body: "Velocity checks, amount thresholds and configurable rules score every transaction before it reaches a provider — ALLOW, REVIEW, HOLD or BLOCK.",
  },
  {
    icon: Landmark,
    title: "Settlement + reconciliation",
    body: "Payment success and money-in-the-bank are tracked as separate milestones, with a reconciliation engine that flags mismatches before finance does.",
  },
  {
    icon: Terminal,
    title: "Developer-first API",
    body: "One versioned REST surface, idempotency keys on every write, signed webhooks with replay, and a sandbox that reproduces real failure modes.",
  },
];

const PIPELINE = ["CREATED", "PENDING", "PROCESSING", "CLEARED"];

const EVENTS = [
  "payment.created",
  "payment.processing",
  "payment.successful",
  "settlement.completed",
];

const SNIPPET = `curl -X POST https://api.raevolt.com/v1/payments \\
  -H "Authorization: Bearer sk_sandbox_…" \\
  -H "Idempotency-Key: order_84921" \\
  -d '{
    "amountMinor": 250000,
    "currency": "NGN",
    "paymentMethod": "card",
    "customerEmail": "customer@shop.ng"
  }'`;

const RESPONSE = `{
  "payment": {
    "id": "txn_01J9F3…",
    "status": "SUCCESSFUL",
    "amount": 250000,
    "currency": "NGN",
    "fee": 3750,
    "net": 246250,
    "risk": { "decision": "ALLOW", "score": 8 },
    "failure": null
  }
}`;

// Live sandbox probe against the deployed API. The Convex HTTP surface lives
// on the deployment's .site host — derived from VITE_CONVEX_URL (.cloud).
function HealthProbe() {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "down">("idle");
  const [detail, setDetail] = useState<string>("");

  async function probe() {
    setState("loading");
    setDetail("");
    try {
      const base = ((import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "").replace(
        /\.cloud$/,
        ".site",
      );
      if (!base) throw new Error("no api url");
      const res = await fetch(`${base}/api/v1/health`);
      const body = (await res.json()) as { service?: string; version?: string };
      if (res.ok && body.service === "raevolt-api") {
        setState("ok");
        setDetail(`v${body.version} responding`);
      } else {
        setState("down");
      }
    } catch {
      setState("down");
    }
  }

  return (
    <div className="inline-flex items-center gap-3 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-sm text-zinc-300">
      <span className={`size-2 rounded-full ${state === "ok" ? "bg-emerald-400" : state === "down" ? "bg-red-400" : "bg-zinc-500"}`} />
      API status
      {state === "idle" && (
        <button onClick={probe} className="text-white underline-offset-2 hover:underline">
          Check
        </button>
      )}
      {state === "loading" && <Loader2 className="size-3.5 animate-spin" />}
      {state === "ok" && <span className="text-emerald-300">{detail}</span>}
      {state === "down" && <span className="text-red-300">unreachable</span>}
    </div>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-[#07090f] text-zinc-100 antialiased">
      {/* Subtle grid texture */}
      <div
        className="pointer-events-none fixed inset-0 opacity-[0.13]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(148,163,184,0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.35) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 40%, transparent 100%)",
          WebkitMaskImage: "radial-gradient(ellipse 90% 60% at 50% 0%, black 40%, transparent 100%)",
        }}
      />

      {/* Nav */}
      <header className="relative z-10 border-b border-white/10">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-md bg-gradient-to-br from-indigo-400 to-blue-600 text-white">
              <Zap className="size-4" />
            </span>
            <span className="text-sm font-bold tracking-[0.2em]">RAEVOLT</span>
          </a>
          <nav className="hidden items-center gap-8 text-sm text-zinc-400 md:flex">
            <a href="#platform" className="hover:text-white">Platform</a>
            <a href="#pipeline" className="hover:text-white">Status pipeline</a>
            <a href="#developers" className="hover:text-white">Developers</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="text-zinc-300 hover:bg-white/10 hover:text-white" asChild>
              <Link to="/dashboard">Sign in</Link>
            </Button>
            <Button className="bg-white text-zinc-900 hover:bg-zinc-200" asChild>
              <Link to="/auth">Start building</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto max-w-7xl px-6 pb-20 pt-20 text-center md:pt-28">
        <motion.div {...fadeUp}>
          <Badge variant="outline" className="border-white/15 bg-white/5 text-zinc-300">
            Payment infrastructure by RAE Technologies
          </Badge>
          <h1 className="mx-auto mt-6 max-w-4xl text-4xl font-bold leading-[1.1] tracking-tight md:text-6xl">
            Payment infrastructure that{" "}
            <span className="bg-gradient-to-r from-indigo-300 via-blue-300 to-cyan-200 bg-clip-text text-transparent">
              shows its work
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-400">
            RAEVOLT routes payments across providers, posts every movement to a
            double-entry ledger, and streams real-time status — pending,
            processing, cleared or failed — through webhooks and API queries.
            Zero opaque holds.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" className="bg-white text-zinc-900 hover:bg-zinc-200" asChild>
              <Link to="/auth">
                Create your account <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
              asChild
            >
              <Link to="/dashboard">Open the dashboard</Link>
            </Button>
          </div>
          <div className="mt-6">
            <HealthProbe />
          </div>
        </motion.div>

        {/* Pipeline visualization */}
        <motion.div {...fadeUp} className="mx-auto mt-16 max-w-3xl">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 backdrop-blur">
            <div className="flex flex-wrap items-center justify-center gap-3">
              {PIPELINE.map((step, i) => (
                <div key={step} className="flex items-center gap-3">
                  <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5">
                    <span
                      className={`size-2 rounded-full ${
                        step === "CLEARED"
                          ? "bg-emerald-400"
                          : step === "PROCESSING"
                            ? "bg-blue-400 animate-pulse"
                            : step === "PENDING"
                              ? "bg-amber-400"
                              : "bg-zinc-500"
                      }`}
                    />
                    <span className="font-mono text-xs tracking-wide">{step}</span>
                  </div>
                  {i < PIPELINE.length - 1 && <ArrowRight className="size-3.5 text-zinc-600" />}
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-zinc-500">
              Every transaction reports through this pipeline in real time — via
              webhooks, API queries and the dashboard. Cleared means the money
              settled; success and settlement are never conflated.
            </p>
          </div>
        </motion.div>
      </section>

      {/* Platform features */}
      <section id="platform" className="relative z-10 border-t border-white/5 py-24">
        <div className="mx-auto max-w-7xl px-6">
          <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
              Infrastructure, not just checkout
            </h2>
            <p className="mt-4 text-zinc-400">
              RAEVOLT owns orchestration, ledger, risk and settlement — providers
              are replaceable adapters behind a single API.
            </p>
          </motion.div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                {...fadeUp}
                transition={{ ...fadeUp.transition, delay: i * 0.06 }}
              >
                <Card className="h-full border-white/10 bg-white/[0.03] text-zinc-100 backdrop-blur transition-colors hover:border-white/20">
                  <CardContent className="p-6">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500/25 to-blue-500/25 text-indigo-300">
                      <f.icon className="size-5" />
                    </div>
                    <h3 className="mt-4 font-semibold">{f.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">{f.body}</p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* Developer experience */}
      <section id="developers" className="relative z-10 border-t border-white/5 py-24">
        <div className="mx-auto grid max-w-7xl gap-12 px-6 lg:grid-cols-2 lg:items-center">
          <motion.div {...fadeUp}>
            <Badge variant="outline" className="border-white/15 bg-white/5 text-zinc-300">
              Developer platform
            </Badge>
            <h2 className="mt-4 text-3xl font-bold tracking-tight md:text-4xl">
              First payment in one request
            </h2>
            <p className="mt-4 text-zinc-400">
              Versioned from day one, idempotent by design, with signed webhooks
              and structured failure codes. The sandbox reproduces declines,
              timeouts and outages — so your integration survives production.
            </p>
            <ul className="mt-6 space-y-3 text-sm text-zinc-300">
              {[
                "Idempotency keys on every write — retries can never double-charge",
                "Signed webhooks with exponential backoff, replay and dead-letter visibility",
                "Balances, refunds and settlements over the same REST surface",
              ].map((point) => (
                <li key={point} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                  {point}
                </li>
              ))}
            </ul>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button className="bg-white text-zinc-900 hover:bg-zinc-200" asChild>
                <Link to="/auth">Get sandbox keys</Link>
              </Button>
              <Button
                variant="outline"
                className="border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
                asChild
              >
                <Link to="/dashboard/developers">Explore the API</Link>
              </Button>
            </div>
          </motion.div>

          <motion.div {...fadeUp} className="space-y-4">
            <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0a0d16]">
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
                <span className="size-2.5 rounded-full bg-red-400/70" />
                <span className="size-2.5 rounded-full bg-amber-400/70" />
                <span className="size-2.5 rounded-full bg-emerald-400/70" />
                <span className="ml-2 text-xs text-zinc-500">create-payment.sh</span>
              </div>
              <pre className="overflow-auto p-4 text-[12px] leading-6 text-zinc-300">
                {SNIPPET}
              </pre>
            </div>
            <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0a0d16]">
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
                <Webhook className="size-3.5 text-zinc-500" />
                <span className="text-xs text-zinc-500">201 Created</span>
              </div>
              <pre className="overflow-auto p-4 text-[12px] leading-6 text-emerald-200/90">
                {RESPONSE}
              </pre>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Webhook events strip */}
      <section id="pipeline" className="relative z-10 border-t border-white/5 py-20">
        <div className="mx-auto max-w-7xl px-6">
          <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
              Every fund movement, visible
            </h2>
            <p className="mt-4 text-zinc-400">
              From initiation through settlement — one event stream, one ledger,
              one complete transaction view.
            </p>
          </motion.div>
          <motion.div {...fadeUp} className="mt-12 grid gap-5 lg:grid-cols-3">
            <Card className="border-white/10 bg-white/[0.03] backdrop-blur">
              <CardContent className="p-6">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Event stream
                </p>
                <ul className="mt-4 space-y-2.5">
                  {EVENTS.map((e) => (
                    <li key={e} className="flex items-center gap-2 font-mono text-xs text-zinc-300">
                      <span className="size-1.5 rounded-full bg-indigo-400" />
                      {e}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-white/[0.03] backdrop-blur">
              <CardContent className="p-6">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Example settlement day
                </p>
                <div className="mt-4 space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-400">Successful volume</span>
                    <span className="font-medium tabular-nums">{formatMoney(4_820_000, "NGN")}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-400">RAEVOLT fee (1.5%)</span>
                    <span className="font-medium tabular-nums text-zinc-300">{formatMoney(72_300, "NGN")}</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-white/10 pt-3">
                    <span className="text-zinc-400">Net to merchant</span>
                    <span className="font-semibold tabular-nums text-emerald-300">
                      {formatMoney(4_747_700, "NGN")}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="border-white/10 bg-white/[0.03] backdrop-blur">
              <CardContent className="p-6">
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                  Guarantees
                </p>
                <ul className="mt-4 space-y-3 text-sm text-zinc-300">
                  <li className="flex items-start gap-2">
                    <ArrowLeftRight className="mt-0.5 size-4 shrink-0 text-indigo-300" />
                    Debits equal credits, per currency, always
                  </li>
                  <li className="flex items-start gap-2">
                    <RouteIcon className="mt-0.5 size-4 shrink-0 text-indigo-300" />
                    Providers fail over without merchant code changes
                  </li>
                  <li className="flex items-start gap-2">
                    <BookLock className="mt-0.5 size-4 shrink-0 text-indigo-300" />
                    Financial history is immutable — corrections are new entries
                  </li>
                </ul>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative z-10 border-t border-white/5 py-24">
        <motion.div
          {...fadeUp}
          className="mx-auto max-w-4xl px-6 text-center"
        >
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Build on rails you can inspect
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-zinc-400">
            Create an organization, get sandbox keys in seconds, and take your
            first payment through the same engine that will carry your live
            volume.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" className="bg-white text-zinc-900 hover:bg-zinc-200" asChild>
              <Link to="/auth">
                Start building <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
              asChild
            >
              <Link to="/dashboard">Sign in</Link>
            </Button>
          </div>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-white/10 py-10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 text-sm text-zinc-500 md:flex-row">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded bg-gradient-to-br from-indigo-400 to-blue-600 text-white">
              <Zap className="size-3" />
            </span>
            <span>RAEVOLT — payment infrastructure by RAE Technologies Limited</span>
          </div>
          <p className="text-xs">
            Sandbox environment. No live money movement is configured in v1.
          </p>
        </div>
      </footer>
    </div>
  );
}
