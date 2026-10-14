import type { Metadata } from 'next';
import { DocsShell } from './docs-shell';

export const metadata: Metadata = {
  title: { default: 'Docs', template: '%s · Tickwise docs' },
  description:
    'Quickstart, authentication, endpoint reference and error codes for the Tickwise Dex API.',
};

/**
 * Customer-facing API docs.
 *
 * Server components throughout apart from the shell (which needs `usePathname`
 * to mark the active link) — no hooks, no client bundle in the pages
 * themselves. These are read by people deciding whether to buy, so they must
 * render for a crawler and on a bad connection.
 *
 * ONE EDITORIAL RULE, and it is the one worth enforcing: the coverage claim
 * stays honest. This API serves **Uniswap v4 on Ethereum, Arbitrum One and Avalanche**, and
 * nothing else. `uniswap-v3` appears in no example, because it is not served —
 * it was accepted by the query validators and then rejected by the services,
 * which is exactly the sort of thing docs are supposed to stop, not repeat.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <DocsShell>{children}</DocsShell>;
}
