import Link from 'next/link';
import { TickwiseMark } from '@/components/brand/TickwiseMark';

import { marketedChainsProse, marketedShortNames } from '@/lib/chains';

export function MarketingFooter() {
  return (
    <footer className="mt-24 border-t border-border/60 bg-background/60">
      {/*
       * The three link columns sit SIDE BY SIDE on a phone.
       *
       * Stacked one per row they ran past 900px, so a visitor who scrolled to
       * the bottom for a Terms link had to scroll a screen and a half further
       * to find it. Two columns at 375px (~160px each, enough for "Units &
       * limits" on one line), three from `sm`, and the original five-column
       * layout from `md`. The brand blurb spans the full width at every size
       * below that, so it never competes with the links for a column.
       */}
      <div className="container-page grid grid-cols-2 gap-x-6 gap-y-10 py-14 sm:grid-cols-3 md:grid-cols-5">
        {/* `col-span-2` at the base, NOT 3: the base grid has two columns, and
            spanning three makes CSS Grid create an IMPLICIT third track. That
            measured 114px / 114px / 67px at 375px — three uneven columns with
            the last one too narrow to hold "Units & limits" — instead of the
            two even ones the layout is designed around. Each span must match
            the column count at its own breakpoint. */}
        <div className="col-span-2 sm:col-span-3 md:col-span-2">
          <div className="flex items-center gap-2 font-display font-semibold">
            <TickwiseMark title="" className="h-6 w-6" />
            <span>Tickwise</span>
            <span className="ml-1 rounded-md border border-border/60 bg-surface px-1.5 py-0.5 font-sans text-[0.625rem] font-medium uppercase tracking-widest text-muted-foreground">
              Dex API
            </span>
          </div>
          <p className="mt-3 max-w-sm text-sm text-muted-foreground">
            The metered API for Uniswap v4 pools and positions on {marketedChainsProse()}.
            Near-real-time. Built for teams that would rather build product than index chains.
          </p>
        </div>
        <FooterCol
          title="Product"
          links={[
            ['Pricing', '/pricing'],
            ['Explore', '/explore'],
            ['Status', '/status'],
            ['Changelog', '/changelog'],
          ]}
        />
        <FooterCol
          title="Developers"
          links={[
            ['Docs', '/docs'],
            ['Quickstart', '/docs/quickstart'],
            ['Units & limits', '/docs/units-and-limits'],
            ['Errors', '/docs/errors'],
          ]}
        />
        <FooterCol
          title="Company"
          links={[
            ['Contact', '/contact'],
            ['Support', '/support'],
            ['Terms', '/legal/terms'],
            ['Privacy', '/legal/privacy'],
            ['DPA', '/legal/dpa'],
          ]}
        />
      </div>
      <div className="border-t border-border/60">
        <div className="container-page flex flex-wrap items-center justify-between gap-2 py-6 text-xs text-muted-foreground">
          <div>© {new Date().getFullYear()} Doryoku Labs · Tickwise Dex API</div>
          <div className="font-mono">
            Uniswap v4 · {marketedShortNames().join(' · ')} · near-real-time
          </div>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <ul className="space-y-2 text-sm">
        {links.map(([label, to]) => (
          <li key={to}>
            <Link href={to} className="text-foreground/80 transition-colors hover:text-foreground">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
