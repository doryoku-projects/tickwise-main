'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, ArrowRight, ChevronDown } from 'lucide-react';
import { MarketingShell } from '@/components/marketing/MarketingShell';
import { DOCS_NAV, docsNeighbours, docsSectionOf } from './docs-nav';

export function DocsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '';
  const { prev, next } = docsNeighbours(pathname);
  const section = docsSectionOf(pathname);
  const current = DOCS_NAV.flatMap((s) => s.items).find((p) => p.href === pathname);

  /*
   * The mobile table of contents.
   *
   * A themed panel rather than a native `<select>`: the OS picker is drawn by
   * the platform in its own chrome, so it arrived grey and system-fonted in the
   * middle of a dark page and could not be styled at all. This overlays the
   * page (absolute, with a blurred scrim) instead of pushing it, which is what
   * made the first expanding version shove the article off screen.
   */
  const [open, setOpen] = useState(false);

  // Closing on route change matters here because the panel is `absolute`
  // inside a shell that does NOT remount between docs pages — without this it
  // would still be open, covering the page it just navigated to.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const links = (onNavigate?: () => void) =>
    DOCS_NAV.map((g) => (
      <div key={g.section}>
        <div className="mb-2 text-[0.625rem] font-semibold uppercase tracking-widest text-muted-foreground">
          {g.section}
        </div>
        <ul className="space-y-0.5">
          {g.items.map((p) => (
            <li key={p.href}>
              <Link
                href={p.href}
                onClick={onNavigate}
                aria-current={pathname === p.href ? 'page' : undefined}
                className={`block rounded-md px-2 py-1 text-sm ${
                  pathname === p.href
                    ? 'bg-surface text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {p.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    ));

  return (
    <MarketingShell>
      <div className="container-page grid gap-8 py-10 md:grid-cols-[13.75rem_1fr]">
        <aside className="hidden md:block">
          <nav className="sticky top-24 space-y-6">{links()}</nav>
        </aside>

        <article className="docsProse container-prose min-w-0 space-y-6">
          {/* Mobile table of contents — see the note on `open` above. */}
          <div className="relative z-30 md:hidden">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-haspopup="menu"
              /*
               * `relative z-50` so the trigger sits ABOVE its own scrim.
               * Without it the scrim (z-40, inside this same stacking context)
               * painted over the button, dimming and blurring it — the control
               * you had just pressed vanished, so the panel read as a block
               * that had replaced the page rather than a menu hanging off a
               * button.
               */
              className="relative z-50 flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-surface px-4 py-3 text-left text-sm"
            >
              <span className="min-w-0">
                {section && (
                  <span className="block text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                    {section}
                  </span>
                )}
                <span className="font-medium">{current?.label ?? 'Documentation'}</span>
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                  open ? 'rotate-180' : ''
                }`}
              />
            </button>

            {open && (
              <>
                {/* Scrim first, so a tap anywhere off the panel closes it and
                    the page behind reads as inert rather than merely covered. */}
                <div
                  className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm"
                  onClick={() => setOpen(false)}
                  aria-hidden
                />
                {/* ABSOLUTE, not in flow: the list overlays the page instead of
                    pushing it down, which is what made the earlier expanding
                    version shove the article off the bottom of the screen. */}
                {/*
                 * Two columns on a phone, three from `sm`.
                 *
                 * Stacked, the three sections ran ~700px — most of a phone
                 * screen, so reaching Coverage meant scrolling a menu that was
                 * supposed to save you scrolling. Two columns halves it and
                 * still leaves ~160px per column at 375px, which fits the
                 * longest label ("Authentication") without wrapping. Three
                 * columns at that width would not.
                 */}
                <nav
                  className="absolute inset-x-0 top-full z-50 mt-2 grid max-h-[60vh] grid-cols-2 gap-x-4 gap-y-5 overflow-y-auto rounded-lg border border-border/60 bg-popover/95 p-4 shadow-card backdrop-blur-xl sm:grid-cols-3"
                  aria-label="Documentation pages"
                >
                  {links(() => setOpen(false))}
                </nav>
              </>
            )}
          </div>

          {children}

          {/*
           * Prev/next pager. Rendered on every page that is IN the nav, so the
           * docs read as a sequence rather than a set of islands — which is
           * the only way through them on a phone.
           */}
          {(prev || next) && (
            <nav
              aria-label="Documentation pages"
              className="grid gap-3 border-t border-border/60 pt-6 sm:grid-cols-2"
            >
              {prev ? (
                <Link
                  href={prev.href}
                  rel="prev"
                  className="group flex flex-col gap-1 rounded-lg border border-border/60 bg-surface p-4 transition-colors hover:border-primary/50"
                >
                  <span className="flex items-center gap-1.5 text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                    <ArrowLeft className="h-3 w-3" /> Previous
                  </span>
                  <span className="font-medium transition-colors group-hover:text-primary">
                    {prev.label}
                  </span>
                </Link>
              ) : (
                // Keeps `next` in the right-hand column on the first page
                // instead of letting it slide left.
                <span aria-hidden className="hidden sm:block" />
              )}
              {next && (
                <Link
                  href={next.href}
                  rel="next"
                  className="group flex flex-col gap-1 rounded-lg border border-border/60 bg-surface p-4 text-right transition-colors hover:border-primary/50 sm:col-start-2"
                >
                  <span className="flex items-center justify-end gap-1.5 text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                    Next <ArrowRight className="h-3 w-3" />
                  </span>
                  <span className="font-medium transition-colors group-hover:text-primary">
                    {next.label}
                  </span>
                </Link>
              )}
            </nav>
          )}
        </article>
      </div>
    </MarketingShell>
  );
}
