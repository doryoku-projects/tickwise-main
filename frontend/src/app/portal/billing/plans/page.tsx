import { redirect } from 'next/navigation';

/**
 * `/portal/billing/plans` — kept as a REDIRECT, not deleted.
 *
 * The catalogue moved inline onto `/portal/billing` (see `PlanPicker`), which
 * left this route with nothing of its own: the same table, the same `choose()`
 * behaviour, its own copy of the notice state and its own `PayModal` — a second
 * surface to keep correct for no reader benefit.
 *
 * It is a stub rather than a deletion because the URL is LIVE and shareable. It
 * shipped in the billing release, it is the sort of link that ends up in a
 * support reply or a bookmark, and a 404 on a billing path reads as "my account
 * is broken" rather than "that page moved". No backend string points here —
 * every `portalBaseUrl` link in `payment-apply`, `subscriptions` and
 * `subscription-sweep` targets `/portal/billing` — so this exists purely for
 * humans holding the old address.
 *
 * A SERVER redirect on purpose: it carries the `#plans` fragment in the
 * `Location` header, and the only way to reach this route now is a direct hit
 * (nothing in the app links to it), which is exactly the case a server redirect
 * handles. `/portal/billing` scrolls to the section itself — see its hash
 * effect, without which this lands at the top of the page and the fragment is
 * decorative.
 */
export default function PortalPlansPage() {
  redirect('/portal/billing#plans');
}
