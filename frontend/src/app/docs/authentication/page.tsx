import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';

export const metadata: Metadata = {
  title: 'Authentication',
  description:
    'Server keys, browser keys and origin binding for the Tickwise API. How to call /v1 from a backend, and how to call it safely from a website.',
};

export default function DocsAuthenticationPage() {
  return (
    <>
      <div>
        <div className="text-xs uppercase tracking-widest text-primary">Getting started</div>
        <h1 className="font-display text-4xl font-semibold">Authentication</h1>
        <p className="text-muted-foreground">One header on every metered request:</p>
      </div>

      <CodeBlock lang="http" code={`KC-APIKey: kc_live_…`} />

      <p className="text-muted-foreground">
        No <code>Authorization: Bearer</code>, and never a query parameter. A key in a URL is written to
        browser history, to intermediate proxy logs and to the <code>Referer</code> of whatever the page links
        to next.
      </p>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Two kinds of key</h2>
        <p className="text-muted-foreground">
          Every key is either a <strong>server</strong> key or a <strong>browser</strong> key, chosen when you
          issue it. This is not a label — the two are enforced differently, and picking the wrong one fails
          loudly rather than quietly.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="font-display text-xl font-semibold">Server keys (the default)</h3>
        <p className="text-muted-foreground">
          Backend-only. A request carrying an <code>Origin</code> header — which is to say, a request from a
          browser — is <strong>rejected with 403</strong>, even though the key itself is valid.
        </p>
        <p className="text-muted-foreground">
          That is deliberate. Pasting a server key into frontend JavaScript ships your secret to every visitor,
          and the failure would otherwise be invisible: the code works, and the key is public. Instead it stops
          working the moment it reaches a browser, which is a bug you find in five minutes rather than in a
          billing statement.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="font-display text-xl font-semibold">Browser keys</h3>
        <p className="text-muted-foreground">
          For calling the API directly from your own site. A browser key must be issued with{' '}
          <strong>at least one allowed origin</strong> — issuing one with an empty list is refused, because a
          browser key with no origins is just a public secret.
        </p>
        <p className="text-muted-foreground">
          Only the origins you list may use it from a browser. A leaked browser key is worth nothing on any
          other site, and we send CORS headers to your registered origins so the call works from your frontend
          without a proxy.
        </p>
        <p className="text-muted-foreground">
          Origins are stored canonically as <code>scheme://host[:port]</code>. You can paste{' '}
          <code>app.example.com</code> and we will standardise it to <code>https://app.example.com</code>; for
          local development type the scheme and port explicitly (<code>http://localhost:3000</code>). Paths and
          wildcards are rejected.
        </p>
        <p className="text-muted-foreground">
          Browser keys are available on paid plans. On Free, issue a server key and call the API from your
          backend.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Choosing</h2>
        <div className="overflow-x-auto rounded-xl border border-border/60">
          <table className="w-full text-sm">
            <thead className="bg-surface">
              <tr className="text-left text-xs uppercase tracking-widest text-muted-foreground">
                <th className="px-4 py-2 font-medium">Where the call is made</th>
                <th className="px-4 py-2 font-medium">Key type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              <tr>
                <td className="px-4 py-2">Your backend, a cron job, a script, a notebook</td>
                <td className="px-4 py-2">
                  <strong>Server</strong>
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2">Your website&rsquo;s JavaScript, a browser extension</td>
                <td className="px-4 py-2">
                  <strong>Browser</strong>, with your origins listed
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2">A mobile app</td>
                <td className="px-4 py-2">
                  <strong>Server</strong>, called through your own backend — an app binary is not a secret store
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">Rotating a key</h2>
        <p className="text-muted-foreground">
          Issue the new key first, deploy it, then revoke the old one. Revocation takes effect within about a
          minute; keys are cached briefly on our side to keep the hot path off the database.
        </p>
        <p className="text-muted-foreground">
          <strong>Changing your account password does not revoke your API keys.</strong> A password change ends
          your portal sessions and nothing else — <code>/v1</code> resolves a key against that key&rsquo;s own
          status and never looks at your password. If you are recovering from a compromise, revoke the keys
          explicitly from <Link href="/portal/keys">API keys</Link>.
        </p>
      </div>

      <div className="space-y-3">
        <h2 className="font-display text-2xl font-semibold">What is not authenticated</h2>
        {/*
          This paragraph used to say `/v1/chains` and `/v1/protocols` "need a key
          but cost zero units". They need no key: `V1MetadataController` carries
          no guard at all, which is how a free route is declared in this codebase
          — there is no `@Public()` flag, the ABSENCE of `@UseGuards` is the
          mechanism. Verified against a running backend: both answer 200 with no
          header, while `/v1/positions` answers 401. Documenting a key
          requirement that does not exist sends people hunting for a 401 they
          will never see.
        */}
        <p className="text-muted-foreground">
          Five routes take no key at all. <code>GET /v1/plans</code>,{' '}
          <code>GET /v1/pricing/units</code> and <code>GET /v1/stats</code> are the pricing table and
          the corpus size — both things we publish anyway. <code>GET /v1/chains</code> and{' '}
          <code>GET /v1/protocols</code> are metadata: which chains and protocols are servable, which
          you need in order to build a valid request in the first place.
        </p>
        <p className="text-muted-foreground">
          They are unmetered as well as unauthenticated, so they cost nothing against your quota and
          do not appear in your usage. Everything under <code>/v1/positions</code> and{' '}
          <code>/v1/pools</code> requires the header and is metered.
        </p>
      </div>
    </>
  );
}
