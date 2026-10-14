import type { Metadata } from 'next';
import Link from 'next/link';
import { getCoverage } from '@/lib/site-data';

export const metadata: Metadata = {
  title: 'Coverage',
  description: 'Which chains and protocols the Tickwise Dex API serves today.',
};

/**
 * The coverage matrix, read from `GET /v1/chains` rather than authored.
 *
 * A hand-written table on this page is the single most likely thing on the site
 * to go quietly stale — enabling a chain is one env var in the backend, and
 * nobody remembers to edit a docs page for it. Deriving it means the docs
 * cannot claim a chain the deployment does not actually serve, in either
 * direction.
 */
export default async function CoveragePage() {
  const rows = await getCoverage();
  const servable = rows.filter((r) => r.servable);

  return (
    <>
      <div>
        <div className="text-xs uppercase tracking-widest text-primary">Reference</div>
        <h1 className="font-display text-4xl font-semibold">Coverage</h1>
        <p className="text-muted-foreground">
          What the API serves right now. This table is generated from the same registry the API
          answers from, so it cannot disagree with what a request will do.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-muted-foreground">
          We can’t reach the API from here, so there is no coverage list to show. We don’t keep a
          copy in the page — a hard-coded matrix is exactly how docs come to claim a chain that
          isn’t served.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-surface">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2 font-medium">Chain</th>
                <th className="px-4 py-2 font-medium">Protocol</th>
                <th className="px-4 py-2 font-medium">chainId</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((r) => (
                <tr key={r.label}>
                  <td className="px-4 py-2">{r.chain}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.protocol || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.chainId}</td>
                  <td className="px-4 py-2">
                    {r.servable ? (
                      <span className="rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-[0.625rem] text-success">
                        servable
                      </span>
                    ) : (
                      <span className="rounded-full border border-border/60 bg-surface-2 px-2 py-0.5 text-[0.625rem] text-muted-foreground">
                        coming soon
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        {servable.length > 0 && (
          <>
            Pass <code className="text-foreground">chainId</code> to scope a request to one chain,
            or omit it to merge every servable chain in one response.{' '}
          </>
        )}
        Live indexing freshness for each of these is on the{' '}
        <Link href="/status" className="text-primary hover:underline">
          status page
        </Link>
        .
      </p>
    </>
  );
}
