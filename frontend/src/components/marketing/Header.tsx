'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { TickwiseMark } from '@/components/brand/TickwiseMark';
import { getPortalToken } from '@/lib/portal-api';
import { ThemeToggle } from './ThemeToggle';

const nav = [
  { to: '/pricing', label: 'Pricing' },
  { to: '/docs', label: 'Docs' },
  { to: '/explore', label: 'Explore' },
  { to: '/status', label: 'Status' },
  { to: '/changelog', label: 'Changelog' },
];

export function MarketingHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  /**
   * Whether this browser holds a portal session.
   *
   * `null` until mounted, and the header renders the signed-OUT controls in
   * that state: the token lives in localStorage, which the server cannot read,
   * so committing to either answer during render would either crash SSR or
   * hydrate a "Dashboard" button for a signed-out visitor and then yank it.
   *
   * This is a CHROME hint, not an authorisation decision — holding a token
   * proves nothing about whether it is still valid. The portal guard and the
   * API remain the things that actually check.
   */
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const read = () => setSignedIn(getPortalToken() !== null);
    read();
    // Signing out in another tab (or the portal client clearing the token on a
    // 401) has to be reflected here, or the header keeps offering a dashboard
    // the visitor can no longer open. `storage` fires only in OTHER tabs;
    // `pathname` covers same-tab sign-in and sign-out, both of which navigate.
    window.addEventListener('storage', read);
    return () => window.removeEventListener('storage', read);
  }, [pathname]);

  return (
    <header
      className={`sticky top-0 z-40 transition-all duration-500 ${
        scrolled
          ? 'border-b border-border/60 bg-background/60 shadow-card backdrop-blur-2xl'
          : 'border-b border-transparent bg-transparent'
      }`}
    >
      <div className="container-page flex h-16 items-center gap-6">
        <Link
          href="/"
          className="group flex items-center gap-2 font-display text-lg font-semibold tracking-tight"
        >
          {/* The mark carries no container badge on purpose: its silhouette is
              the recognition, and a gradient square around it competes with the
              bars instead of framing them. The hover transform stays — it is the
              header's existing interaction language, just moved onto the glyph. */}
          <TickwiseMark
            title=""
            className="h-7 w-7 transition-transform duration-500 group-hover:rotate-[8deg] group-hover:scale-110"
          />
          <span className="transition-colors group-hover:text-primary-glow">Tickwise</span>
          <span className="ml-1 rounded-md border border-border/60 bg-surface/70 px-1.5 py-0.5 font-sans text-[0.625rem] font-medium uppercase tracking-widest text-muted-foreground backdrop-blur">
            Dex API
          </span>
        </Link>
        {/*
         * Desktop bar switches in at lg, not md. Its contents need ~795px and a
         * 768px viewport only offers ~710px inside the gutters, so at md the
         * logo badge wrapped to two lines and "Get an API key" was clipped off
         * the right edge. Holding the mobile menu to 1024 is what makes the
         * 768–1023 band fit.
         */}
        <nav className="ml-4 hidden items-center gap-1 lg:flex">
          {nav.map((n) => {
            const active = pathname === n.to || (n.to !== '/' && pathname.startsWith(n.to));
            return (
              <Link
                key={n.to}
                href={n.to}
                className={`group relative rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {n.label}
                <span
                  className={`pointer-events-none absolute inset-x-3 -bottom-0.5 h-px origin-left bg-gradient-primary transition-transform duration-500 ${
                    active ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
                  }`}
                />
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <ThemeToggle />
          {signedIn ? (
            /* Offering "Sign in" and "Get an API key" to somebody who is already
               signed in with a key is the site telling them to do what they have
               done. One control, straight to the thing they came back for. */
            <Button
              asChild
              size="sm"
              className="group relative overflow-hidden bg-gradient-primary shadow-glow transition-transform duration-300 hover:scale-[1.03]"
            >
              <Link href="/portal">
                <LayoutDashboard className="mr-1.5 h-4 w-4" />
                <span className="relative z-10">Dashboard</span>
              </Link>
            </Button>
          ) : (
            <>
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="transition-colors hover:bg-surface/60"
              >
                <Link href="/login">Sign in</Link>
              </Button>
              <Button
                asChild
                size="sm"
                className="group relative overflow-hidden bg-gradient-primary shadow-glow transition-transform duration-300 hover:scale-[1.03]"
              >
                <Link href="/signup">
                  <span className="relative z-10">Get an API key</span>
                  <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                </Link>
              </Button>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1 lg:hidden">
          <ThemeToggle />
          <button
            className="rounded-md p-2 text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOpen((o) => !o)}
            aria-label="Toggle menu"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {/*
       * The dimmed, blurred backdrop under the mobile menu.
       *
       * Without it the panel floated on the page with content legible right
       * beneath its bottom edge — it read as part of the page rather than over
       * it, and there was nowhere to tap to dismiss. `fixed inset-0` starts
       * below the header (`top-16`) so the logo and the close button stay
       * live, and tapping it closes, which is what a phone user tries first.
       */}
      {open && (
        <div
          className="fixed inset-x-0 bottom-0 top-16 z-30 bg-background/70 backdrop-blur-sm lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}
      {/*
       * ABSOLUTE, not in flow. As a normal child of the sticky <header> the
       * panel grew the header itself, which pushed the whole page down by its
       * height and then yanked it back up on close — the layout jumped every
       * time the menu was touched. Hanging it off `top-full` means it overlays
       * the page, like the dropdown it is.
       */}
      {open && (
        <div className="absolute inset-x-0 top-full z-40 border-t border-border/60 bg-background/90 shadow-card backdrop-blur-2xl lg:hidden">
          <nav className="container-page flex flex-col py-3">
            {nav.map((n) => (
              <Link
                key={n.to}
                href={n.to}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
              >
                {n.label}
              </Link>
            ))}
            <div className="mt-2 flex gap-2 px-1">
              {signedIn ? (
                <Button asChild className="flex-1 bg-gradient-primary">
                  <Link href="/portal">
                    <LayoutDashboard className="mr-1.5 h-4 w-4" />
                    Dashboard
                  </Link>
                </Button>
              ) : (
                <>
                  <Button asChild variant="outline" className="flex-1">
                    <Link href="/login">Sign in</Link>
                  </Button>
                  <Button asChild className="flex-1 bg-gradient-primary">
                    <Link href="/signup">Get key</Link>
                  </Button>
                </>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
