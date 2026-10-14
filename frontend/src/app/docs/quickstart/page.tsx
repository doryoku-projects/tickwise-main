import { redirect } from 'next/navigation';

/**
 * `/docs/quickstart` — a REDIRECT to `/docs`, not a second quickstart.
 *
 * The design source splits the docs index (an overview) from a separate
 * quickstart page. This site's `/docs` is already the quickstart: its `<h1>` and
 * its `metadata.title` both read "Quickstart", and it carries the whole flow the
 * design source's page did — get a key, call an endpoint, read the limit
 * headers, then the endpoint table and the two things that catch people out.
 *
 * Writing a second page from the same material would give the site two
 * quickstarts to keep in step, and they would drift the first time one of them
 * was corrected. Writing a THINNER one would be worse: whichever a reader lands
 * on first, they would want the other.
 *
 * A stub rather than nothing, because the URL is already linked — the marketing
 * footer's "Quickstart" entry points here, and it is the address anyone
 * following the design source would try. It 404'd until now.
 *
 * A server redirect: the route has no state, nothing in the app links to it
 * beyond that footer, and the `Location` header is the cheapest correct answer.
 * `redirect` rather than `permanentRedirect` — a 308 is cached by the browser
 * indefinitely, and this becomes a real page the day the index grows past the
 * point where one page can be both the overview and the five-minute path.
 */
export default function DocsQuickstartRedirect() {
  redirect('/docs');
}
