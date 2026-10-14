import Link from 'next/link';
import { MarketingShell } from '@/components/marketing/MarketingShell';

/**
 * The shell the three `/legal` routes render into.
 *
 * All three documents are STUBS, and this component's job is to make that
 * unmissable rather than leave it to a sentence a reader skims. The design
 * source printed a single line — "these are placeholder terms, replace with
 * counsel-reviewed copy" — set in the same body type a real clause would use.
 * That is the failure mode worth designing against: legal-shaped prose nobody
 * reviewed is worse than an obvious gap, because a customer can rely on it and
 * we would have no position to argue from.
 *
 * So the placeholder is a warning panel, `subject` says what the finished
 * document will cover without asserting any of its terms, and no page here
 * contains a numbered clause, a governing-law line or a liability cap.
 *
 * The routes exist at all because the footer already links to them — a 404 on
 * `/legal/terms` from a company asking for a card is a worse first impression
 * than an honest "not published yet".
 */
export function LegalPage({ title, subject }: { title: string; subject: string }) {
  return (
    <MarketingShell>
      <div className="container-page py-16">
        {/* Running text, so this takes the reading measure rather than the
            wider `container-narrow` used for panels and forms. */}
        <div className="container-prose">
          <div className="text-xs uppercase tracking-widest text-primary">Legal</div>
          <h1 className="mt-2 font-display text-4xl font-semibold">{title}</h1>
          <p className="mt-2 text-muted-foreground">{subject}</p>

          <div className="mt-8 rounded-xl border border-warning/40 bg-warning/10 p-5">
            <div className="font-display text-base font-semibold">
              Not published yet — placeholder
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              This document has not been drafted or reviewed by counsel, so there is nothing here to
              read. We would rather show you an empty page than a paragraph of plausible-looking
              legal text that no lawyer has seen and that we could not stand behind.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Nothing on this page forms an agreement, and no earlier version of it did either.
            </p>
          </div>

          <p className="mt-8 text-sm text-muted-foreground">
            If you need this document before it is published — a procurement review, a security
            questionnaire, a data-protection sign-off —{' '}
            <Link href="/contact" className="text-primary hover:underline">
              get in touch
            </Link>{' '}
            and say which one, so we can prioritise it rather than guess.
          </p>
        </div>
      </div>
    </MarketingShell>
  );
}
