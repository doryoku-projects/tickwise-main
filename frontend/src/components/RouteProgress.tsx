'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

/**
 * A top progress bar for client-side navigation.
 *
 * WHY: App Router navigations are not instant. A route that has to be compiled
 * (dev), fetched (prod), or that awaits data in a server component takes a few
 * hundred milliseconds during which the browser shows NOTHING — the old page
 * just sits there. Users read that as a dead click and press again.
 *
 * HOW, and why it is a document-level click listener rather than router events:
 * the App Router deliberately exposes no `routeChangeStart`. `useLinkStatus`
 * exists but is per-`Link` and would mean touching every nav in the app. A
 * capture-phase listener on `<a>` catches every internal navigation — the
 * header, the sidebars, the docs pager, in-prose links — with one mount and no
 * changes to the links themselves.
 *
 * The bar is DERIVED, not timed: it starts on a qualifying click and ends when
 * `usePathname` actually changes, so it cannot claim a navigation finished
 * before it did. The one thing it must not do is get stuck, so it also gives up
 * on its own — see `STUCK_MS`.
 */

/** Nothing is shown before this. Most navigations land inside it, and a bar
 *  that flashes for 80ms is more distracting than no bar at all. */
const SHOW_AFTER_MS = 120;

/**
 * Hard stop. A click can be cancelled by the page itself (`preventDefault` in a
 * handler that runs after ours), or land on the same URL, and no `pathname`
 * change would ever follow. A bar left crawling forever is worse than the delay
 * it was covering.
 */
const STUCK_MS = 10_000;

export function RouteProgress() {
  const pathname = usePathname();
  const [active, setActive] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = () => {
      if (showTimer.current) clearTimeout(showTimer.current);
      if (stuckTimer.current) clearTimeout(stuckTimer.current);
      showTimer.current = null;
      stuckTimer.current = null;
    };

    const onClick = (event: MouseEvent) => {
      // Anything the browser handles itself — a new tab, a download, a right
      // click, a modifier click — is not a client navigation and must not
      // start a bar that nothing will ever finish.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (anchor.hasAttribute('download')) return;

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#')) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page — React will not re-render and `pathname` will not change.
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      clear();
      showTimer.current = setTimeout(() => setActive(true), SHOW_AFTER_MS);
      stuckTimer.current = setTimeout(() => {
        setActive(false);
        clear();
      }, STUCK_MS);
    };

    // Capture phase, so a link whose own handler stops propagation is still seen.
    document.addEventListener('click', onClick, { capture: true });
    return () => {
      document.removeEventListener('click', onClick, { capture: true });
      clear();
    };
  }, []);

  // The destination rendered. This is the only thing that ends a navigation
  // legitimately — a timer would be guessing.
  useEffect(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (stuckTimer.current) clearTimeout(stuckTimer.current);
    showTimer.current = null;
    stuckTimer.current = null;
    setActive(false);
  }, [pathname]);

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 transition-opacity duration-200 ${
        active ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/*
       * An indeterminate sweep, not a percentage. We cannot know how far along
       * a navigation is, and a bar that creeps to 90% and waits is a fiction —
       * this one just says "something is happening", which is all the honest
       * signal there is.
       */}
      <div
        className={`h-full w-2/5 bg-gradient-primary shadow-glow ${active ? 'animate-route-sweep' : ''}`}
      />
    </div>
  );
}
