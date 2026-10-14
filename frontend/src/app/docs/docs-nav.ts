/**
 * The docs table of contents, in reading order.
 *
 * ONE source for three consumers — the desktop sidebar, the mobile picker and
 * the prev/next pager. The pager in particular has to agree with the sidebar
 * about what "next" means, and two hand-maintained lists would drift the first
 * time a page was inserted.
 *
 * Only routes that EXIST are listed: a link to a 404 is worse than a missing
 * link, so add the entry in the same change as the page.
 */
export interface DocsLink {
  href: string;
  label: string;
}

export interface DocsSection {
  section: string;
  items: DocsLink[];
}

export const DOCS_NAV: DocsSection[] = [
  {
    section: 'Getting started',
    items: [
      { href: '/docs', label: 'Overview' },
      { href: '/docs/authentication', label: 'Authentication' },
      { href: '/docs/units-and-limits', label: 'Units & limits' },
    ],
  },
  {
    section: 'Endpoints',
    items: [
      { href: '/docs/endpoints/positions', label: 'Positions' },
      { href: '/docs/endpoints/pools', label: 'Pools' },
      { href: '/docs/endpoints/metadata', label: 'Metadata' },
    ],
  },
  {
    section: 'Reference',
    items: [
      { href: '/docs/errors', label: 'Errors' },
      { href: '/docs/coverage', label: 'Coverage' },
    ],
  },
];

/** Every page, flattened into the order a reader would walk them. */
export const DOCS_ORDER: DocsLink[] = DOCS_NAV.flatMap((s) => s.items);

/**
 * The pages either side of `pathname`, for the pager.
 *
 * Returns `null` on each end rather than wrapping — a "next" on the last page
 * that silently returns to the first reads as a broken link, not a loop.
 * An unknown path (a docs route not in the nav) yields no pager at all.
 */
export function docsNeighbours(pathname: string): { prev: DocsLink | null; next: DocsLink | null } {
  const i = DOCS_ORDER.findIndex((p) => p.href === pathname);
  if (i === -1) return { prev: null, next: null };
  return {
    prev: i > 0 ? DOCS_ORDER[i - 1] : null,
    next: i < DOCS_ORDER.length - 1 ? DOCS_ORDER[i + 1] : null,
  };
}

/** The section a page belongs to, shown above the title on mobile. */
export function docsSectionOf(pathname: string): string | null {
  return DOCS_NAV.find((s) => s.items.some((p) => p.href === pathname))?.section ?? null;
}
