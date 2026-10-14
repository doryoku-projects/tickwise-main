"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { Button } from "@/components/ui/button";
import type { Plan, UnitCost } from "@/lib/site-data";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useState } from "react";

/*
 * The plan catalog and the unit table arrive as props from the server component
 * that owns this route's metadata — see the note in page.tsx. This view keeps only
 * the billing-cycle toggle, which is what it needed to be a client component for.
 */
/** 0 means unlimited in the plan schema, and "0" reads as none at all. */
function limitLabel(value: number): string {
  return value === 0 ? "Unlimited" : value.toLocaleString();
}

/**
 * The biggest annual discount actually on offer, as a whole percent, or null.
 *
 * The design source printed a flat "Annual · save 16%" on the toggle. That is a
 * price claim, and this catalog's annual prices are whatever an operator set in
 * the admin plan editor — so the label is computed from them, and the toggle
 * does not appear at all when no plan has an annual price. A saving nobody is
 * offered is the one thing a pricing toggle must not advertise.
 */
function annualSavingPct(plans: Plan[]): number | null {
  let best = 0;
  for (const p of plans) {
    if (p.monthlyPrice <= 0 || p.annualPrice <= 0) continue;
    const saving = 1 - p.annualPrice / (p.monthlyPrice * 12);
    if (saving > best) best = saving;
  }
  return best > 0 ? Math.round(best * 100) : null;
}

export function Pricing({ plans, unitCosts }: { plans: Plan[]; unitCosts: UnitCost[] }) {
  const [cycle, setCycle] = useState<"monthly" | "annual">("monthly");
  const saving = annualSavingPct(plans);
  const paidCount = plans.filter((p) => p.monthlyPrice > 0).length;
  // Nothing to toggle between if no plan is sold annually.
  const cycles = saving === null ? (["monthly"] as const) : (["monthly", "annual"] as const);

  return (
    <MarketingShell>
      <section className="container-page pt-20 pb-10 text-center">
        <div className="text-xs uppercase tracking-widest text-primary">Pricing</div>
        <h1 className="mt-2 font-display text-5xl font-semibold tracking-tight">
          {/*
            Counts PAID plans, not every card. Free is on the page but granted at
            signup rather than bought, so including it would advertise "3 price
            points" for two prices and a giveaway. Falls back to "Simple pricing."
            when the catalogue is unreachable — never a hardcoded number.
          */}
          One API. {paidCount > 0 ? `${paidCount} price point${paidCount === 1 ? "" : "s"}.` : "Simple pricing."}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
          Metered by units. Different endpoints cost different amounts — see the unit table below.
          Quotas reset the 1st of each month, UTC.
        </p>
        {cycles.length > 1 && (
          <div className="mt-8 inline-flex rounded-full border border-border/60 bg-surface p-1 text-sm">
            {cycles.map((c) => (
              <button
                key={c}
                onClick={() => setCycle(c)}
                className={`rounded-full px-4 py-1.5 transition-colors ${
                  cycle === c
                    ? "bg-gradient-primary text-primary-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {c === "monthly" ? "Monthly" : `Annual · save ${saving}%`}
              </button>
            ))}
          </div>
        )}
      </section>

      {plans.length === 0 && (
        <section className="container-page pb-16">
          <div className="container-narrow rounded-2xl border border-warning/40 bg-warning/10 p-6 text-sm text-muted-foreground">
            We can’t reach the plan catalog from here, so there are no prices to show. Nothing is
            cached from an earlier load — we’d rather show none than a price that may have changed.
            Try again in a moment, or{" "}
            <Link href="/contact" className="text-primary hover:underline">
              get in touch
            </Link>
            .
          </div>
        </section>
      )}

      {/* One gap at every width. An earlier revision widened it at 2xl because
          content kept growing to 1760px there and the four cards were reading as
          stretched; content now caps at 1440px and the gap scales with the root
          font size, so the cards land ~5% wider than at 1280 in proportional
          terms and there is nothing left to compensate for.

          Wrapping flex rather than a 2/4-column grid: the catalog is whatever the
          admin plan editor holds, so a row is routinely short of a full four —
          three plans in a four-track grid left the cards hugging the left edge
          with a dead track beside them. The widths below are the same tracks the
          grid produced (50% and 25% of the frame minus each card's share of the
          1rem gap), so a full row is pixel-identical and any short row — the last
          one of five, or the three we ship today — centres in the frame. */}
      <section className="container-page flex flex-wrap justify-center gap-4 pb-16">
        {plans.map((p) => (
          <div
            key={p.id}
            className={`relative flex w-full flex-col rounded-2xl border p-6 shadow-card md:w-[calc(50%-0.5rem)] lg:w-[calc(25%-0.75rem)] ${
              p.featured
                ? "border-primary/60 bg-surface shadow-glow"
                : "border-border/60 bg-surface"
            }`}
          >
            {p.featured && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gradient-primary px-3 py-1 text-[0.625rem] font-semibold uppercase tracking-widest text-primary-foreground">
                Most popular
              </div>
            )}
            <div className="font-display text-lg font-semibold">{p.name}</div>
            {/* Falls back to the monthly figure when a plan has no annual
                price rather than dividing zero by twelve — the design source
                did, and a plan sold monthly-only would have advertised $0/mo
                the moment the annual toggle was pressed. */}
            <div className="mt-3 flex items-baseline gap-1">
              <span className="font-display text-4xl font-semibold">
                $
                {cycle === "annual" && p.annualPrice > 0
                  ? Math.round(p.annualPrice / 12)
                  : p.monthlyPrice}
              </span>
              <span className="text-sm text-muted-foreground">/mo</span>
            </div>
            <div className="text-xs text-muted-foreground">
              {p.monthlyPrice === 0
                ? "No card needed"
                : cycle === "annual" && p.annualPrice > 0
                  ? `Billed $${p.annualPrice.toLocaleString()}/yr`
                  : cycle === "annual"
                    ? "Billed monthly · no annual price"
                    : "Billed monthly"}
            </div>
            <div className="mt-5 space-y-1 border-y border-border/60 py-4 text-sm">
              <Row label="Units / month" value={limitLabel(p.quota)} />
              <Row label="Rate limit" value={p.rateLimit} />
              <Row label="API keys" value={limitLabel(p.maxKeys)} />
              <Row label="Browser keys" value={p.allowBrowserKeys ? "Yes" : "No"} />
            </div>
            <ul className="mt-4 flex-1 space-y-2 text-sm">
              {p.features.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  {f}
                </li>
              ))}
            </ul>
            <Button
              asChild
              className={`mt-6 ${p.featured ? "bg-gradient-primary" : ""}`}
              variant={p.featured ? "default" : "outline"}
            >
              <Link href={`/signup?plan=${p.id}`}>{p.cta}</Link>
            </Button>
          </div>
        ))}
      </section>

      {/* Spans the full frame so its panel edges line up with the plan cards
          above it, which is the alignment the three-different-max-widths version
          of this page never had. */}
      <section className="container-page py-10">
        <div className="rounded-2xl border border-border/60 bg-surface shadow-card">
          <div className="border-b border-border/60 p-6">
            <div className="text-xs uppercase tracking-widest text-primary">Unit costs</div>
            <h2 className="mt-1 font-display text-2xl font-semibold">What each endpoint costs</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A “unit” is our metering token. Simple lists are cheap, computed responses cost more.
            </p>
          </div>
          {unitCosts.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              The unit table couldn’t be loaded. It comes from the same live pricing the API meters
              against, so we don’t keep a copy here to fall back on.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                    <th className="px-6 py-3 font-medium">Endpoint</th>
                    <th className="px-6 py-3 font-medium">Units</th>
                    <th className="px-6 py-3 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {unitCosts.map((u) => (
                    <tr key={u.routeKey}>
                      <td className="px-6 py-3 font-mono text-xs whitespace-nowrap">{u.endpoint}</td>
                      <td className="px-6 py-3 font-mono">{u.units}</td>
                      <td className="px-6 py-3 text-muted-foreground">{u.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Centred rather than left-aligned like the other narrow blocks in the
          site: this section's heading is `text-center`, so centring is the
          existing design intent here, not a spacing accident. */}
      <section className="container-page py-16">
        <div className="container-narrow mx-auto">
          <h2 className="mb-6 text-center font-display text-3xl font-semibold">Frequently asked</h2>
          <Accordion type="single" collapsible>
            {[
              /*
               * Rewritten against what the billing code actually does. The
               * design source said "a hosted checkout page … you pay to a
               * one-time address", which describes only one of the two rails:
               * the native rail asks the wallet to SIGN an EIP-3009 transfer
               * authorization and never quotes an address at all. Both are
               * described, because a customer picking a plan on the strength of
               * the first sentence should not meet a signature request.
               */
              [
                "How do I pay?",
                "In USDC, on a network you choose at checkout. Depending on the rail you either sign a transfer authorization from your own wallet, or send the exact amount to the address we quote. Either way the transfer settles on-chain and your plan activates once it confirms — we never hold your keys or move funds ourselves.",
              ],
              [
                "What happens when I hit my quota?",
                "Requests over quota return 429 with an X-RateLimit-Reason header saying whether you hit the rate limit or the monthly quota, plus X-Quota-Remaining and X-Quota-Reset so you can see where you stand. Your keys keep working next month, or as soon as you upgrade — nothing is destroyed.",
              ],
              [
                "Do you rate-limit per key or per account?",
                "Rate limits are per account. Quota is per account. Keys are just credentials.",
              ],
              [
                "Can I cancel any time?",
                "Yes. Your plan runs to the end of the current period and then drops to Free. Keys keep working at free-tier limits.",
              ],
              [
                "Is there an SLA?",
                "Not yet. We won’t claim uptime numbers we can’t back up. See the status page for indexing lag.",
              ],
            ].map(([q, a], i) => (
              <AccordionItem value={`i${i}`} key={q}>
                <AccordionTrigger className="text-left">{q}</AccordionTrigger>
                <AccordionContent className="text-muted-foreground">{a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>
    </MarketingShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}
