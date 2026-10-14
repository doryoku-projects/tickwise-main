"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import { useSafeReducedMotion } from "@/components/home/hero/primitives";
import { MarketingShell } from "@/components/marketing/MarketingShell";
import { Button } from "@/components/ui/button";
import { AmbientBackground } from "@/components/home/AmbientBackground";
import { HeroScene } from "@/components/home/hero/HeroScene";
import { APITerminal } from "@/components/home/hero/APITerminal";
import { MARKETED_CHAINS } from "@/lib/chains";

import { LiveStats } from "@/components/home/LiveStats";
import { FeatureCards } from "@/components/home/FeatureCards";
import { QuickstartEditor } from "@/components/home/QuickstartEditor";
import { CoverageNetwork } from "@/components/home/CoverageNetwork";
import { PricingBanner } from "@/components/home/PricingBanner";
import { Reveal, EASE } from "@/components/home/motion-primitives";
import type { ChainMetricsMap, PublicStats, UnitCost } from "@/lib/site-data";
import type { Plan } from "@/lib/site-data";

export function Landing({
  stats,
  chainMetrics,
  plans,
  unitCosts,
}: {
  stats: PublicStats | null;
  chainMetrics: ChainMetricsMap | null;
  plans: Plan[];
  /** Live route costs, so the demo panels quote what their call really charges. */
  unitCosts: UnitCost[];
}) {
  /* `undefined`, not a fallback number: the panels omit the badge entirely
     rather than guess, exactly as `/docs` renders "cost unavailable". */
  const poolsListUnits = unitCosts.find((c) => c.routeKey === 'v1.pools.list')?.units;
  /* Both costs, because the quickstart editor now really switches endpoints:
     `/v1/positions` is metered separately from `/v1/pools`, and quoting the
     pools price over a positions response is quoting the wrong number to
     somebody working out what their integration costs. */
  const quickstartUnits = {
    pools: poolsListUnits,
    positions: unitCosts.find((c) => c.routeKey === 'v1.positions.list')?.units,
  };
  return (
    <MarketingShell>
      <AmbientBackground />
      {/* One fetch, both consumers: the hero panels and the stat cards below read
          the same `getPublicStats()` result, so the page can't state two different
          numbers for the same thing. */}
      <Hero stats={stats} units={poolsListUnits} />
      <Stats stats={stats} />
      <Features />
      <Quickstart units={quickstartUnits} />
      <Coverage metrics={chainMetrics} />
      <CTA plans={plans} />
    </MarketingShell>
  );
}

function Hero({ stats, units }: { stats: PublicStats | null; units?: number }) {
  const reduce = useSafeReducedMotion();
  return (
    <section className="relative">
      <div className="container-page grid grid-cols-1 items-center gap-12 pb-14 pt-16 md:pb-20 md:pt-20 lg:grid-cols-12 lg:gap-10 xl:gap-14">
        <div className="lg:col-span-5">
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 14, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.9, ease: EASE }}
            className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-surface/50 px-3 py-1 text-xs text-muted-foreground backdrop-blur-xl"
          >
            <span className="h-1.5 w-1.5 animate-ping-slow rounded-full bg-success" />
            Uniswap v4 · {MARKETED_CHAINS.map((c) => c.label).join(' · ')} · near-real-time
          </motion.div>

          {/*
           * Ceiling is 3.52rem because that is exactly 4.4vw at 1280 — the width
           * where `container-page` stops growing. The type is sized off the
           * viewport but lives in a column that now caps with the frame, so
           * letting it keep growing past that point is what broke the headline's
           * two-line set into three at 1920. It reaches its ceiling and its
           * column reaches its ceiling at the same width; below 1280 nothing about
           * this changes, which is why 1280 looks exactly as it did before.
           */}
          <h1 className="mt-6 font-display text-[clamp(2.5rem,4.4vw,3.52rem)] font-semibold leading-[1.03] tracking-tight">
            {["Pools & positions", "as one clean API."].map((line, i) => (
              <motion.span
                key={line}
                className="block overflow-hidden"
                initial={reduce ? false : { opacity: 0, y: 26, filter: "blur(12px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 1, delay: 0.08 + i * 0.14, ease: EASE }}
              >
                <span className={i === 0 ? "text-gradient" : undefined}>{line}</span>
              </motion.span>
            ))}
          </h1>

          <motion.p
            initial={reduce ? false : { opacity: 0, y: 18, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 1, delay: 0.18, ease: EASE }}
            className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground"
          >
            We index Uniswap v4 so you don’t have to. Metered endpoints, honest quotas, one header
            of auth. Ship a positions dashboard, a portfolio tracker, or a research tool in an
            afternoon.
          </motion.p>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.28, ease: EASE }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <Button
              asChild
              size="lg"
              className="group relative overflow-hidden bg-gradient-primary shadow-glow transition-transform duration-300 hover:scale-[1.02]"
            >
              <Link href="/signup">
                <span className="relative z-10 inline-flex items-center">
                  Get an API key
                  <ArrowRight className="ml-1 h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                </span>
                <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-border/70 bg-surface/40 backdrop-blur-xl transition-all duration-300 hover:border-primary/50 hover:shadow-glow"
            >
              <Link href="/docs/quickstart">Read the quickstart</Link>
            </Button>
            <Link
              href="/explore"
              className="group ml-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              or try the live data{" "}
              <span className="inline-block transition-transform duration-300 group-hover:translate-x-1">
                →
              </span>
            </Link>
          </motion.div>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 20, filter: "blur(10px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 1, delay: 0.4, ease: EASE }}
            className="mt-9 max-w-xl"
          >
            <APITerminal reduce={!!reduce} units={units} />
          </motion.div>
        </div>

        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.94, filter: "blur(14px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          transition={{ duration: 1.4, delay: 0.12, ease: EASE }}
          className="lg:col-span-7"
        >
          <HeroScene stats={stats} />
        </motion.div>
      </div>
    </section>
  );
}

function Stats({ stats }: { stats: PublicStats | null }) {
  return (
    <section className="container-page py-10">
      <LiveStats stats={stats} />
    </section>
  );
}

/*
 * THE "POWERING DATA TEAMS AT" STRIP IS GONE, not restyled.
 *
 * It rendered six company names — Meridian, Bloomrail, Tesseract, Northwind,
 * Halcyon, Vantage — under a claim that they are customers. They came from the
 * reference design and none of them is one. A fabricated logo wall is a false
 * statement to every visitor, and unlike a placeholder number there is no
 * honest way to degrade it: either the names are real or the section does not
 * belong on the page. `TrustedBy.tsx` is deleted with it; restore from git and
 * pass real names in when there are some.
 */

function Features() {
  return (
    <section className="container-page py-24">
      <Reveal className="max-w-2xl">
        <div className="text-xs uppercase tracking-widest text-primary">
          Why teams pick Tickwise
        </div>
        <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] font-semibold leading-tight tracking-tight">
          Boring where boring matters. Fast where it doesn’t.
        </h2>
      </Reveal>
      <div className="mt-12">
        <FeatureCards />
      </div>
    </section>
  );
}

function Quickstart({ units }: { units: { pools?: number; positions?: number } }) {
  return (
    <section className="container-page py-24">
      <div className="grid gap-12 lg:grid-cols-12 lg:items-center">
        <Reveal className="lg:col-span-5">
          <div className="text-xs uppercase tracking-widest text-primary">
            Five-minute quickstart
          </div>
          <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] font-semibold leading-tight tracking-tight">
            One header. Real data.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            Sign up, create a key in the portal, drop this into your terminal. If the response
            returns pools, you’re done.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button
              asChild
              className="group relative overflow-hidden bg-gradient-primary shadow-glow"
            >
              <Link href="/signup">
                <span className="relative z-10">Get a free key</span>
                <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="border-border/70 bg-surface/40 backdrop-blur hover:border-primary/50"
            >
              <Link href="/docs/quickstart">Full quickstart</Link>
            </Button>
          </div>
        </Reveal>
        <Reveal className="lg:col-span-7" delay={0.1}>
          <QuickstartEditor units={units} />
        </Reveal>
      </div>
    </section>
  );
}

function Coverage({ metrics }: { metrics: ChainMetricsMap | null }) {
  return (
    <Reveal as="section" className="container-page py-24">
      <CoverageNetwork metrics={metrics} />
    </Reveal>
  );
}

function CTA({ plans }: { plans: Plan[] }) {
  return (
    <Reveal as="section" className="container-page pb-24">
      <PricingBanner plans={plans} />
    </Reveal>
  );
}
