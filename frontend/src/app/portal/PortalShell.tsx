'use client';

import {
  BarChart3,
  CreditCard,
  PlayCircle,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { PaymentInFlightBar } from '../../components/portal/PaymentInFlightBar';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { SkeletonRows } from '@/components/DataState';
import { Card } from '@/components/portal/Card';
import { ConfirmDialog } from '@/components/portal/ConfirmDialog';
import { VerifyEmailGate } from '@/components/portal/VerifyEmailGate';
import { useWallet } from '@/components/providers/WalletProvider';
import { ThemeToggle } from '@/components/marketing/ThemeToggle';
import { Button } from '@/components/ui/button';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  clearPortalToken,
  getPortalToken,
  isVerificationLockout,
  portalApi,
  type Customer,
} from '@/lib/portal-api';

const TABS = [
  { href: '/portal', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/portal/keys', label: 'API keys', icon: KeyRound },
  { href: '/portal/usage', label: 'Usage', icon: BarChart3 },
  { href: '/portal/billing', label: 'Billing', icon: CreditCard },
  { href: '/portal/playground', label: 'Playground', icon: PlayCircle },
  { href: '/portal/settings', label: 'Settings', icon: Settings },
];

/**
 * Routes under /portal that must render WITHOUT the session guard.
 *
 * The checkout return page is reached from the payment rail, and for a crypto
 * rail that is very often a wallet's in-app browser — a separate browsing
 * context holding no `tk-portal-token`. It authenticates on the invoice's own
 * capability token instead. Guarding it would redirect somebody who has just
 * paid to a login form, which reads as the payment having failed.
 *
 * An EXACT-MATCH list, not a prefix: a prefix would silently un-guard anything
 * added below one of these paths later. It is also mirrored in
 * `PORTAL_PUBLIC_PATHS`, which stops a stale token's 401 doing the same bounce
 * from the other direction — both are needed, they cover different causes.
 */
const UNGUARDED_PORTAL_PATHS = ['/portal/checkout/return'];

/**
 * The frame every branch below shares, so the chrome cannot drift between them.
 *
 * The public site header is NOT rendered here: inside the portal it is a second
 * navigation competing with the sidebar, and the marketing links are not what
 * a signed-in customer came for. The route back to the public site is the
 * "Home" breadcrumb in the portal's own bar, and the theme toggle the site
 * header used to carry now lives there too.
 */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="tw flex min-h-screen flex-col bg-background">
      <div className="flex min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** Guard + chrome for every /portal route. Client-only: the JWT lives in
 *  localStorage, so there is nothing a server component could check. */
export function PortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  /**
   * Decided before any hook that could redirect. Hooks still run — React
   * requires a stable order — but every one of them checks this first, so an
   * unguarded route never reads a token, never probes `/account/auth/me` and
   * never bounces.
   */
  const unguarded = UNGUARDED_PORTAL_PATHS.includes(pathname);
  const [ready, setReady] = useState(false);
  const [customer, setCustomer] = useState<Customer | null>(null);
  /**
   * True when the customer holds a valid session that every `/account/*` route
   * refuses until the address is proved. The whole portal is closed, not one
   * page, which is why the decision lives up here and not on any one of them.
   */
  const [locked, setLocked] = useState(false);
  /** Undecided. Children are withheld until this clears — see `load`. */
  const [checking, setChecking] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  // Signing out has to tear the WALLET down too — see `signOut` below.
  const { disconnect: disconnectWallet } = useWallet();
  /** Open once the customer has pressed Log out and not yet confirmed. */
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  /** Phone-width layout: the nav is a drawer rather than a column. */
  const compact = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);

  // A drawer that survives the navigation it just performed is a drawer covering
  // the page the customer asked for. Keyed on the path so it closes for a
  // browser Back too, not only for a link press.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Client-side guard, exactly like the admin realm: the token lives in
  // localStorage, which middleware can't read, so there is no middleware.ts.
  useEffect(() => {
    if (unguarded) return;
    const token = getPortalToken();
    if (!token) {
      router.replace('/login');
      return;
    }
    setReady(true);
  }, [router, unguarded]);

  /**
   * Sidebar identity, and the one place that decides whether the portal opens.
   *
   * `GET /account/auth/me` is `@AllowUnverified`, so it answers even from behind
   * the gate — that is what makes the customer's address knowable on a screen
   * where nothing else loads. A 401 here is already handled by the portal client
   * (clears the portal token only, then lands on /login).
   *
   * The gated PROBE only runs for an account that has not proved its address.
   * A verified customer — the overwhelming majority — costs exactly the one
   * request the shell always made, and only an unverified one pays for a second.
   * Whether this deployment enforces verification at all is not knowable from
   * `me` (that flag rides on `/account/overview`, which is itself gated), so the
   * probe is the only honest way to ask: an unverified account on a deployment
   * that does not enforce it must still get the normal portal, not a demand.
   */
  const load = useCallback(async () => {
    setChecking(true);
    try {
      const me = await portalApi.me();
      setCustomer(me);
      if (me.emailVerifiedAt) {
        setLocked(false);
        return;
      }
      try {
        await portalApi.overview();
        setLocked(false);
      } catch (err) {
        // Anything that is NOT the verification lockout leaves the portal open
        // so the page below can surface its own error in its own words.
        setLocked(isVerificationLockout(err, me));
      }
    } catch {
      // `me` itself failed — a 401 is already redirecting, anything else is
      // transient. `locked` is deliberately LEFT AS IT WAS rather than reset:
      // on a first load that is `false`, so the page below surfaces its own
      // error in its own words; on a retry from the gate it holds the gate,
      // which beats swapping in a portal that is about to fail too.
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void load();
  }, [ready, load]);

  /**
   * Clearing the JWT is only half of signing out of a WALLET session.
   *
   * Web3-Onboard keeps the connected wallet attached and remembers its label in
   * localStorage, and `autoConnectLastWallet` re-attaches it on the next boot.
   * Left alone, the next click on "Wallet" found a provider already connected
   * and went straight to the signature prompt — the picker never appeared, and
   * there was no way to sign in as anyone else. Detaching it here, at the one
   * control that means "end my session", is what makes the picker come back.
   *
   * The wallet teardown can never block the sign-out: the token goes either way.
   */
  async function signOut() {
    setSigningOut(true);
    try {
      await disconnectWallet();
    } catch {
      /* a wallet that misbehaves on teardown must not trap anyone in a session */
    }
    clearPortalToken();
    router.replace('/login');
  }

  /**
   * An unguarded route renders bare — no sidebar, no session probe, no guard.
   *
   * Placed AFTER every hook so the hook order is unconditional, and before the
   * `!ready` branch because `ready` never becomes true here (the guard effect
   * returns early), which would otherwise leave this page stuck on an empty
   * shell forever.
   */
  if (unguarded) {
    return (
      <Frame>
        <main className="container-page flex-1 py-10">{children}</main>
      </Frame>
    );
  }

  if (!ready) {
    // Matches the app background so the pre-decision frame reads as loading
    // rather than as a broken page.
    return <Frame>{null}</Frame>;
  }

  /**
   * Nothing is rendered into the content column until the lock is decided.
   *
   * The alternative — render the page and swap it out a moment later — is what
   * produces two competing screens: the page's own "Failed to load / Try again"
   * flashing up before the screen that can actually fix it. The cost is one
   * cheap, indexed `me` request ahead of the page's own fetch, and it buys the
   * guarantee that a locked-out customer is shown exactly one thing.
   */
  if (checking || locked) {
    return (
      <Frame>
        <main className="container-page flex-1 py-10">
          {checking ? (
            <Card>
              <SkeletonRows rows={4} />
            </Card>
          ) : (
            <VerifyEmailGate
              customer={customer}
              onVerified={load}
              onLogOut={() => void signOut()}
              loggingOut={signingOut}
            />
          )}
        </main>
      </Frame>
    );
  }

  /**
   * The nav, defined ONCE and placed in two containers.
   *
   * A column on desktop, the contents of the drawer on a phone — identical
   * order and identical copy, so the mobile layout cannot drift into being a
   * different product. `Link` handles its own navigation; the drawer closes off
   * `pathname` rather than off the click, so Back closes it too.
   *
   * `showIdentity` is the ONE difference, and it is not drift. On desktop the
   * account address lives in the header bar, top right, where it belongs; the
   * sidebar keeps only Log out. In the phone drawer there is no header bar to
   * put it in — the bar there holds the menu button and the breadcrumb — so the
   * drawer carries it instead.
   */
  const navBody = (showIdentity: boolean) => (
    <>
      <nav className="flex-1 space-y-1 p-3">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
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
      {/*
       * The whole account block — identity AND log out — is drawer-only now.
       * On desktop both live in the header bar, top right, so the sidebar is
       * navigation and nothing else. Rendering an empty bordered footer there
       * would just be a rule across the bottom of an empty box.
       */}
      {showIdentity && (
        <div className="border-t border-sidebar-border p-3">
          <div className="mb-2 px-2 text-xs text-sidebar-foreground/60">
            signed in as
            {/* A wallet-only account has no email — a bare dash reads as broken. */}
            <div className="truncate font-mono text-sidebar-foreground">
              {customer?.email || 'Your account'}
            </div>
            <div className="mt-0.5 uppercase tracking-widest">
              {customer?.planKey ?? 'plan pending'}
            </div>
          </div>
          {/* LAST, and visually separated. It sat flush against Settings, one
              mis-click away from ending a session that takes a wallet handshake
              to restore. Now it is the bottom of the list with a rule above it,
              and it CONFIRMS. */}
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            disabled={signingOut}
            onClick={() => {
              // Close the drawer as the dialog opens — two stacked modals would
              // both handle Escape, so one press would dismiss the confirmation
              // and the menu together.
              setMenuOpen(false);
              setConfirmSignOut(true);
            }}
          >
            <LogOut className="mr-2 h-4 w-4" />
            {signingOut ? 'Logging out…' : 'Log out'}
          </Button>
        </div>
      )}
    </>
  );

  return (
    <Frame>
      {/*
       * No brand block at the top of this column.
       *
       * The site header directly above already carries the TW mark and the
       * wordmark, so a second identical lockup 16px below it read as the logo
       * having been pasted in twice rather than as structure. The sidebar's job
       * here is the portal's own navigation; the header's is identity. (The
       * admin panel keeps its header block, because "AD Admin panel" is a realm
       * marker rather than a duplicate of the brand.)
       */}
      {!compact && (
        <aside className="flex w-64 shrink-0 flex-col border-r border-border/60 bg-sidebar pt-3 text-sidebar-foreground">
          {navBody(false)}
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/*
         * The bar's contents sit on the same `container-page` frame as the
         * `main` below, so the breadcrumb always lines up with the page
         * content. A bare gutter is not enough: once the frame is capped it
         * centres in the column, and only an identical frame follows it.
         */}
        <header className="flex h-14 items-center border-b border-border/60 bg-background/70 backdrop-blur-xl">
          <div className="container-page flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {compact && (
                <button
                  type="button"
                  className="-ml-1 rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground"
                  aria-label="Menu"
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  onClick={() => setMenuOpen(true)}
                >
                  <Menu className="h-4 w-4" />
                </button>
              )}
              <Link href="/" className="hover:text-foreground">
                Home
              </Link>
              <span>/</span>
              <span className="text-foreground">Portal</span>
            </div>
            {/* The theme toggle lives here now. It used to sit in the public
                site header directly above; with that header gone from the
                portal, this bar is the only chrome left to carry it, and
                dropping a working control would be a regression. */}
            <div className="flex min-w-0 items-center gap-3">
              {/* The signed-in address, moved here from the sidebar's footer.
                  `truncate` with a cap rather than wrapping: a long address
                  must not push the plan chip off the bar, and the full value is
                  on /portal/settings. Hidden below `md`, where the drawer
                  carries it instead — see `navBody`. */}
              {customer?.email && (
                <span
                  className="hidden max-w-[16rem] truncate font-mono text-xs text-muted-foreground md:inline"
                  title={customer.email}
                >
                  {customer.email}
                </span>
              )}
              {/* The plan the account is actually on, from the session — the
                  design source hard-coded "Starter" here for every customer. */}
              {customer?.planKey && (
                <span className="hidden shrink-0 items-center gap-1 rounded-full border border-border/60 bg-surface px-2 py-1 text-xs text-muted-foreground sm:inline-flex">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                  {customer.planKey}
                </span>
              )}
              {/*
               * Desktop only — on a phone this lives in the nav drawer, and two
               * log-outs on one screen is the duplication we removed elsewhere.
               *
               * The visibility lives on a WRAPPER, not on the Button's own
               * className, and that is load-bearing. `Button`'s base class sets
               * `inline-flex`, and this repo's `cn()` has no conflict group for
               * `display` (see lib/utils.ts) — so `hidden` and `inline-flex`
               * BOTH survive the merge and stylesheet order decides, which put
               * the control on screen at every width. A wrapper has no base
               * display class to fight with.
               *
               * Still routed through the confirmation: coming back costs an
               * email code, a password or a wallet signature.
               */}
              <ThemeToggle />
              <div className="hidden shrink-0 md:block">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  disabled={signingOut}
                  onClick={() => setConfirmSignOut(true)}
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  {signingOut ? 'Logging out…' : 'Log out'}
                </Button>
              </div>
            </div>
          </div>
        </header>
        {/* Ambient, above the page content and below the header, so a payment in
            flight is visible on EVERY portal page rather than only the one the
            customer signed on. Renders nothing when there is nothing to say. */}
        <PaymentInFlightBar />
        <main className="container-page flex-1 space-y-6 py-6">{children}</main>
      </div>

      {compact && menuOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
            onMouseDown={() => setMenuOpen(false)}
          />
          <aside className="relative flex w-64 max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
            <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4 text-sm font-medium">
              <span>Menu</span>
              <button
                type="button"
                aria-label="Close menu"
                className="rounded-md p-1 text-sidebar-foreground/70 hover:text-sidebar-foreground"
                onClick={() => setMenuOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {navBody(true)}
          </aside>
        </div>
      )}

      {/* Signing out is cheap to do and expensive to undo on this product:
          coming back means an email code, a password, or a wallet signature.
          Worth one question. */}
      {confirmSignOut && (
        <ConfirmDialog
          title="Log out?"
          confirmLabel="Log out"
          cancelLabel="Stay signed in"
          body={
            <p>
              You will need to sign in again to reach your API keys, usage and billing. Your keys
              keep working while you are signed out — nothing stops.
            </p>
          }
          onConfirm={() => signOut()}
          onCancel={() => setConfirmSignOut(false)}
        />
      )}
    </Frame>
  );
}
