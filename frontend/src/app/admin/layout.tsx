'use client';

import {
  CreditCard,
  LogOut,
  Menu,
  Package,
  Receipt,
  TrendingUp,
  Users,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/marketing/ThemeToggle';
import { Button } from '@/components/ui/button';
import { adminApi, clearToken, getToken, type ChainMeta } from '@/lib/admin-api';
// panel.css (.admin-* chrome, shared with the customer portal and the auth
// pages) is no longer imported here. It is pulled into app/app.css inside the
// `legacy` cascade layer along with globals.css and site.css — importing it
// from a route file would land it UNLAYERED, where it outranks every Tailwind
// utility on the converted pages. See the header comment in app.css.
//
// The panel's own chrome is Tickwise now (`tw` on the frame below). The pages
// underneath still carry `.admin-card` / `.admin-table` / `.admin-btn` markup
// and are re-painted onto the design tokens by the `tw-bridge` layer, so they
// read as the same product without 1,300 lines of editor being rewritten.

const TABS = [
  // `alsoMatch` exists because the clients LIST is `/admin` (exact) while a
  // single client is `/admin/clients/:id` — without it the tab goes dark on the
  // detail page, which reads as having navigated out of the section.
  { href: '/admin', label: 'Clients', icon: Users, exact: true, alsoMatch: '/admin/clients/' },
  { href: '/admin/subscriptions', label: 'Subscriptions', icon: CreditCard },
  { href: '/admin/payments', label: 'Payments', icon: Receipt },
  { href: '/admin/revenue', label: 'Revenue', icon: TrendingUp },
  { href: '/admin/plans', label: 'Plans', icon: Package },
  { href: '/admin/endpoints', label: 'Pricing', icon: Zap },
];

/** The (chainId, protocol) every ops button targets — one enabled integration. */
interface SyncTarget {
  chainId: number;
  protocol: string;
  label: string;
}

/** Flatten /v1/chains into one option per enabled (chain, protocol) pair. */
function toTargets(chains: ChainMeta[]): SyncTarget[] {
  return chains.flatMap((c) =>
    c.protocols.map((protocol) => ({
      chainId: c.chainId,
      protocol,
      // One protocol per chain today — show just the chain name; disambiguate if that changes.
      label: c.protocols.length > 1 ? `${c.name} · ${protocol}` : c.name,
    })),
  );
}

/**
 * The frame every branch below shares, so the chrome cannot drift between them.
 *
 * Same shape as PortalShell: the public site header is NOT rendered here — the
 * marketing nav is noise on an internal panel that has its own sidebar. The
 * route back out is the "← Back to site" link in the panel's own bar, which
 * also carries the theme toggle the site header used to provide. `tw` is what
 * switches this subtree onto the design system — see the header comment in
 * app/app.css.
 */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="tw flex min-h-screen flex-col bg-background">
      <div className="flex min-h-0 flex-1">{children}</div>
    </div>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === '/admin/login';
  const [ready, setReady] = useState(false);
  const [targets, setTargets] = useState<SyncTarget[]>([]);
  const [target, setTarget] = useState<SyncTarget | null>(null);
  /** Phone-width layout: the nav is a drawer rather than a column. */
  const [menuOpen, setMenuOpen] = useState(false);

  // A drawer that survives the navigation it just performed is a drawer
  // covering the page that was asked for. Keyed on the path so Back closes it
  // too, not only a link press.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const token = getToken();
    if (!token && !isLogin) {
      router.replace('/admin/login');
      return;
    }
    setReady(true);
  }, [isLogin, router]);

  // Load the enabled (chain, protocol) integrations for the ops chain selector.
  useEffect(() => {
    if (!ready || isLogin) return;
    let cancelled = false;
    adminApi
      .listChains()
      .then((chains) => {
        if (cancelled) return;
        const list = toTargets(chains);
        setTargets(list);
        setTarget((cur) => cur ?? list.find((t) => t.chainId === 1) ?? list[0] ?? null);
      })
      .catch(() => {
        // Backend unreachable / no integrations — fall back to mainnet v4 so the
        // buttons keep working like before the selector existed.
        if (cancelled) return;
        const fallback = { chainId: 1, protocol: 'uniswap-v4', label: 'Ethereum Mainnet' };
        setTargets([fallback]);
        setTarget((cur) => cur ?? fallback);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, isLogin]);

  function logOut() {
    clearToken();
    router.replace('/admin/login');
  }

  // Login page: site header on top, bare card below (no guard / no panel chrome).
  if (isLogin) {
    return (
      <Frame>
        <main className="px-gutter flex flex-1 flex-col items-center justify-center py-12">
          {children}
        </main>
      </Frame>
    );
  }

  if (!ready) {
    // Matches the app background so the pre-decision frame reads as loading
    // rather than as a broken page.
    return <Frame>{null}</Frame>;
  }

  /**
   * The nav, defined ONCE and placed in two containers — a column on desktop,
   * the contents of the drawer on a phone. Identical order and copy, so the
   * mobile layout cannot drift into being a different panel.
   */
  const navBody = (
    <>
      <nav className="flex-1 space-y-1 p-3">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = t.exact
            ? pathname === t.href || (t.alsoMatch ? pathname.startsWith(t.alsoMatch) : false)
            : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-sidebar-border p-3">
        <Button variant="ghost" size="sm" className="w-full justify-start" onClick={logOut}>
          <LogOut className="mr-2 h-4 w-4" />
          Log out
        </Button>
      </div>
    </>
  );

  return (
    <Frame>
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border/60 bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-5 font-display font-semibold">
          {/* Destructive-tinted, not the product gradient: the one visual cue
              that this surface is not the customer's. */}
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-destructive/20 font-mono text-[0.625rem] text-destructive">
            AD
          </span>
          Admin panel
        </div>
        {navBody}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
         * The bar's contents sit on the same `container-page` frame as the
         * `main` below, so the label always lines up with the page content.
         */}
        <header className="flex h-14 items-center border-b border-border/60 bg-background/70 backdrop-blur-xl">
          <div className="container-page flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="-ml-1 rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground md:hidden"
                aria-label="Menu"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen(true)}
              >
                <Menu className="h-4 w-4" />
              </button>
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                Internal · Admin
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Link href="/" className="text-xs text-muted-foreground hover:text-foreground">
                ← Back to site
              </Link>
              {/* Carried here from the site header, which no longer renders on
                  this realm — see Frame. */}
              <ThemeToggle />
            </div>
          </div>
        </header>

        {/*
         * The ops strip. It was a row of chips inside the old sub-nav, jammed
         * between the tabs and Log out; the tabs are the sidebar now, so these
         * get a band of their own directly under the bar — still one row, still
         * targeting exactly one (chain, protocol) pair.
         */}
        <div className="border-b border-border/60 bg-surface/40">
          <div className="container-page flex flex-wrap items-center gap-2 py-2.5">
            <span className="mr-1 font-mono text-[0.625rem] uppercase tracking-widest text-muted-foreground">
              Ops
            </span>
            <select
              className="h-8 rounded-md border border-input bg-surface px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={target ? `${target.chainId}:${target.protocol}` : ''}
              onChange={(e) => {
                const [chainId, protocol] = e.target.value.split(':');
                setTarget(
                  targets.find((t) => t.chainId === Number(chainId) && t.protocol === protocol) ??
                    null,
                );
              }}
              title="Chain the sync buttons target"
            >
              {targets.map((t) => (
                <option key={`${t.chainId}:${t.protocol}`} value={`${t.chainId}:${t.protocol}`}>
                  {t.label}
                </option>
              ))}
            </select>
            <OpsButton
              target={target}
              idleLabel="Sync data"
              busyLabel="Syncing…"
              titleBase="Trigger a backfill/refresh sync"
              run={(t) => adminApi.runSync({ chainId: t.chainId, protocol: t.protocol })}
            />
            {/*
             * Full position sync: resets the cursor to zero so the WHOLE
             * indexer is rescanned ascending (fromStart=true) — catches
             * positions missed/zeroed by an earlier run and re-prices every
             * row. Heavier than "Sync data".
             */}
            <OpsButton
              target={target}
              idleLabel="Full sync"
              busyLabel="Full sync…"
              titleBase="Full backfill from the start (fromStart=true) — rescans & re-prices all positions"
              run={(t) =>
                adminApi.runSync({ chainId: t.chainId, protocol: t.protocol, fromStart: true })
              }
            />
            <OpsButton
              target={target}
              idleLabel="Sync pools"
              busyLabel="Syncing…"
              titleBase="Trigger a pool sync (subgraph → Mongo)"
              run={(t) => adminApi.runPoolsSync({ chainId: t.chainId, protocol: t.protocol })}
            />
            {/*
             * Token-security sweep: GoPlus honeypot/blacklist check over the
             * Ponder token universe → {chainId}_token_security. Decoupled from
             * position sync; rate-limit self-throttled, so it runs long but
             * never blocks a resync.
             */}
            <OpsButton
              target={target}
              idleLabel="Scan token security"
              busyLabel="Queuing…"
              titleBase="Trigger a GoPlus token-security sweep (honeypot/blacklist → token_security)"
              run={(t) =>
                adminApi.runTokenSecuritySync({ chainId: t.chainId, protocol: t.protocol })
              }
            />
          </div>
        </div>

        <main className="container-page flex-1 py-6">{children}</main>
      </div>

      {menuOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onMouseDown={() => setMenuOpen(false)}
          />
          <aside className="relative flex w-60 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
            <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4 text-sm font-medium">
              <span>Admin panel</span>
              <button
                type="button"
                aria-label="Close menu"
                className="rounded-md p-1 text-sidebar-foreground/70 hover:text-sidebar-foreground"
                onClick={() => setMenuOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {navBody}
          </aside>
        </div>
      )}
    </Frame>
  );
}

/**
 * One ops trigger: fire-and-forget POST, then a 2.5s/3s label flash.
 *
 * Four near-identical buttons were four near-identical components; they are one
 * component with four sets of copy now. The requests, the disabled rule and the
 * timings are unchanged — only the chrome moved onto the design system.
 */
function OpsButton({
  target,
  idleLabel,
  busyLabel,
  titleBase,
  run,
}: {
  target: SyncTarget | null;
  idleLabel: string;
  busyLabel: string;
  titleBase: string;
  run: (target: SyncTarget) => Promise<unknown>;
}) {
  const [state, setState] = useState<'idle' | 'syncing' | 'done' | 'error'>('idle');

  async function trigger() {
    if (!target) return;
    setState('syncing');
    try {
      await run(target);
      setState('done');
      setTimeout(() => setState('idle'), 2500);
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 3000);
    }
  }

  const label =
    state === 'syncing'
      ? busyLabel
      : state === 'done'
        ? 'Queued ✓'
        : state === 'error'
          ? 'Failed'
          : idleLabel;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={trigger}
      disabled={state === 'syncing' || !target}
      title={`${titleBase}${target ? ` — ${target.label}` : ''}`}
      className={
        state === 'error'
          ? 'border-destructive/45 text-destructive'
          : state === 'done'
            ? 'border-success/45 text-success'
            : undefined
      }
    >
      {label}
    </Button>
  );
}
