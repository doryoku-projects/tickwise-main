import type { Metadata } from 'next';
import Link from 'next/link';
import { MarketingShell } from '@/components/marketing/MarketingShell';

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'How to reach the people who run the Tickwise Dex API about enterprise plans, additional chains, or anything the docs do not answer.',
  openGraph: {
    title: 'Contact Tickwise',
    description: 'Enterprise plans, chain requests, partnerships.',
  },
};

/**
 * `/contact`, without the form.
 *
 * The design source rendered a five-field enquiry form whose `onSubmit` waited
 * 700ms, reset the fields and raised a success toast. Nothing was sent
 * anywhere, and there is still no endpoint to send it to: the backend exposes
 * `account*`, `admin*`, `billing*`, `health`, `v1*` and `webhooks/payments`,
 * and none of them accepts an enquiry. A form that swallows a message and
 * thanks you for it is worse than no form — the sender believes they have
 * reached us and stops trying.
 *
 * So the page is a routing table instead: for each thing a visitor might want,
 * the channel that actually exists today. The one channel we cannot render from
 * the repo is an email address — nothing in the codebase publishes one, and
 * inventing `hello@…` would send real mail into a black hole. It comes from
 * `NEXT_PUBLIC_CONTACT_EMAIL`, so the day somebody provisions the mailbox this
 * page becomes complete by setting one variable, with no code change and no
 * risk of a stale address shipping in the meantime.
 */
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();

export default function ContactPage() {
  return (
    <MarketingShell>
      <div className="container-page py-16">
        <div className="container-narrow">
          <div className="text-xs uppercase tracking-widest text-primary">Contact</div>
          <h1 className="mt-2 font-display text-4xl font-semibold">Talk to a human</h1>
          <p className="mt-2 text-muted-foreground">
            Enterprise volume, a chain we do not index yet, an integration question the docs leave
            open — all of it goes to the same small team that writes the indexer.
          </p>

          {CONTACT_EMAIL ? (
            <div className="mt-10 rounded-2xl border border-primary/40 bg-primary/5 p-6">
              <div className="font-display text-lg font-semibold">Email us</div>
              <p className="mt-1 text-sm text-muted-foreground">
                One address, read by the team. Include what you are building and the rough monthly
                request volume you expect — it saves a round trip.
              </p>
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="mt-3 inline-block font-mono text-sm text-primary hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
            </div>
          ) : (
            <div className="mt-10 rounded-2xl border border-warning/40 bg-warning/10 p-6">
              <div className="font-display text-lg font-semibold">
                We have not published a contact address yet
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                There is no enquiry form on this page and no inbox behind it. We would rather say so
                than render a form that accepts your message, thanks you, and drops it — which is
                what a contact page with no endpoint behind it actually does.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Almost everything below can be resolved without us. If yours cannot, the account
                you sign up with is a real channel: we can reply to the address on it.
              </p>
            </div>
          )}

          <h2 className="mt-12 font-display text-2xl font-semibold">Try these first</h2>
          <ul className="mt-4 space-y-3">
            {(
              [
                [
                  'Which chains and protocols are served',
                  'Generated from the same registry the API answers from, so it cannot disagree with a request.',
                  '/docs/coverage',
                  'Coverage',
                ],
                [
                  'A call is failing and you want to know why',
                  'Every status code we return, what causes it, and whether retrying will help.',
                  '/docs/errors',
                  'Errors',
                ],
                [
                  'Data looks stale',
                  'Real indexing lag per chain, polled live — not an uptime badge.',
                  '/status',
                  'Status',
                ],
                [
                  'What a plan costs and what a call costs',
                  'Prices and per-endpoint unit costs, both read from the live catalogue.',
                  '/pricing',
                  'Pricing',
                ],
                [
                  'Keys, quota, invoices, changing plan',
                  'Self-serve in the portal. Nothing here needs us in the loop.',
                  '/portal',
                  'Portal',
                ],
              ] as const
            ).map(([subject, detail, href, label]) => (
              <li key={href} className="rounded-xl border border-border/60 bg-surface p-4">
                <div className="text-sm font-medium">{subject}</div>
                <div className="mt-1 text-sm text-muted-foreground">{detail}</div>
                <Link
                  href={href}
                  className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
                >
                  {label} →
                </Link>
              </li>
            ))}
          </ul>

          <h2 className="mt-12 font-display text-2xl font-semibold">Enterprise and new chains</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            We serve <strong>Uniswap v4 on Ethereum, Arbitrum and Avalanche</strong> today, and that is the
            whole list — see{' '}
            <Link href="/docs/coverage" className="text-primary hover:underline">
              coverage
            </Link>
            . Adding a chain is real indexing work rather than a configuration flag, so if you need
            one that is not there, tell us which and what volume it would carry; that is what
            decides the order we do them in.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            There is no published enterprise tier beyond the plans on{' '}
            <Link href="/pricing" className="text-primary hover:underline">
              the pricing page
            </Link>
            . We are not going to advertise a custom SLA we have not yet had to meet.
          </p>
        </div>
      </div>
    </MarketingShell>
  );
}
