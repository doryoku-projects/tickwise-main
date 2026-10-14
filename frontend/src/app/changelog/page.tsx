import type { Metadata } from 'next';
import { EmptyState } from '@/components/DataState';
import { MarketingShell } from '@/components/marketing/MarketingShell';
import { CHANGELOG } from '@/lib/content';

export const metadata: Metadata = {
  title: 'Changelog',
  description: 'API changes, new chains, new endpoints.',
  openGraph: {
    title: 'Tickwise changelog',
    description: 'What shipped, when.',
  },
};

export default function ChangelogPage() {
  return (
    <MarketingShell>
      <div className="container-page py-16">
        <div className="container-narrow">
          <div className="text-xs uppercase tracking-widest text-primary">Changelog</div>
          <h1 className="mt-2 font-display text-4xl font-semibold">What shipped</h1>
          {CHANGELOG.length === 0 ? (
            <div className="mt-10">
              <EmptyState
                title="Nothing published yet"
                body="Changes will be listed here as we ship them."
              />
            </div>
          ) : (
            <ol className="mt-10 space-y-8 border-l border-border/60 pl-6">
              {CHANGELOG.map((e) => (
                <li key={`${e.date}-${e.title}`} className="relative">
                  <span className="absolute -left-[1.8125rem] top-1.5 h-2 w-2 rounded-full bg-gradient-primary shadow-glow" />
                  <div className="font-mono text-xs text-muted-foreground">{e.date}</div>
                  <div className="mt-1 font-display text-xl font-semibold">{e.title}</div>
                  <p className="mt-1 text-sm text-muted-foreground">{e.body}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </MarketingShell>
  );
}
