'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { AdminModal } from '../../components/admin/AdminModal';
import { PANEL_PAGE_SIZES, Pagination, usePagination } from '../../components/admin/Pagination';
import { UsageDetailPanel } from '../../components/admin/UsageDetailPanel';
import { OriginsInput } from '../../components/OriginsInput';
import {
  adminApi,
  type ApiKeyRow,
  type Client,
  type IssuedKey,
  type Plan,
  type UsageRow,
} from '../../lib/admin-api';
import { formatPeriod, formatUtcDate } from '../../lib/format';

/** The dialog's accessible name is the panel's own heading — one id, two users. */
const detailHeadingId = (clientId: string) => `client-detail-heading-${clientId}`;

/** What closing a panel would destroy, so the operator is asked before it does. */
const LOSE_KEY_WARNING =
  'The API key just issued for this client is shown only here, only once. Close this panel and it is gone for good. Continue?';

export default function ClientsPage() {
  const [clients, setClients] = useState<Client[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  /*
   * The one-time secrets, held HERE and not in the panel that renders them.
   * `issueKey` returns the only plaintext copy that will ever exist; keeping it
   * in `ClientDetail` state meant Close — or Manage on any other row — unmounted
   * the component and destroyed it silently. Keyed by client id, dismissed
   * explicitly by the operator once they say they have copied it.
   */
  const [issuedKeys, setIssuedKeys] = useState<Record<string, IssuedKey>>({});

  // create form
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [planKey, setPlanKey] = useState('free');

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([adminApi.listClients(), adminApi.listPlans()]);
      setClients(c);
      setPlans(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The create form's plan, reconciled against what the server actually offers.
   * Its own effect keyed on `plans`, NOT part of `load`: reading `planKey` there
   * put it in the callback's dependency list, so every touch of the select
   * changed `load`'s identity and re-fetched both clients and plans — and the
   * reconcile inside it then scheduled one more round.
   */
  useEffect(() => {
    if (plans.length > 0 && !plans.some((p) => p.key === planKey)) setPlanKey(plans[0].key);
  }, [plans, planKey]);

  /*
   * Dismiss the panel, asking first if it is holding an uncopied key.
   *
   * No `scrollIntoView` any more: the panel is an overlay, so the list behind it
   * never moved and there is nothing to put back in view. `AdminModal` returns
   * focus to the row's own Manage button on unmount, which is what the scroll
   * was standing in for.
   */
  const closeRow = useCallback(
    (id: string) => {
      if (issuedKeys[id] && !confirm(LOSE_KEY_WARNING)) return;
      setSelected(null);
    },
    [issuedKeys],
  );

  /*
   * One panel open at a time: each one fires three requests, it is a write
   * surface with no comparison use case, and it is a modal layer — two of them
   * have nowhere to go. Opening another row therefore dismisses this one, which
   * is the same loss as closing it, so it asks the same question.
   */
  function toggleRow(id: string) {
    if (selected === id) {
      closeRow(id);
      return;
    }
    if (selected && issuedKeys[selected] && !confirm(LOSE_KEY_WARNING)) return;
    setSelected(id);
  }

  /*
   * `GET /admin/clients` takes no `limit` and no `offset` — it returns every
   * client there has ever been — so this list is the one on the panel that grows
   * without a ceiling, and the only one where paging is about the page being
   * unusable rather than merely long.
   *
   * THE GUARD IS THE WHOLE REASON THIS IS NOT A ONE-LINER. It is now a belt on
   * top of braces — while the Manage overlay is open the pager is `inert`, so
   * the page cannot be turned under it — but the stakes are a freshly issued API
   * key whose only plaintext copy lives in `issuedKeys`, and the cost of keeping
   * the question is one comparison. Dropping `selected` on a clean change stays
   * required: a selection pointing at a client the page no longer lists would
   * open a panel for a row that is not on screen.
   *
   * `All` stays in the size list (see Pagination) because this list has no
   * search box: Cmd+F over every client is how an operator finds one, and
   * pagination must not be the change that takes that away.
   */
  const tableRef = useRef<HTMLDivElement>(null);
  const pagedClients = usePagination(clients, {
    guard: () => {
      if (selected && issuedKeys[selected] && !confirm(LOSE_KEY_WARNING)) return false;
      setSelected(null);
      return true;
    },
  });

  /*
   * The client the overlay is for, resolved out of the LIST rather than captured
   * when the row was clicked: `load()` runs after every plan change, so a
   * captured object would keep rendering the plan the operator just replaced.
   * `undefined` if the id no longer exists — a client deleted from another tab
   * simply closes nothing, instead of the panel showing a ghost.
   */
  const selectedClient = selected ? clients.find((c) => c._id === selected) : undefined;

  function dismissIssued(id: string) {
    setIssuedKeys((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function createClient(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await adminApi.createClient({ name, email: email || undefined, planKey });
      setName('');
      setEmail('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    }
  }

  return (
    <div>
      {/* The page title is Tickwise markup; everything below it is still the
          `.admin-*` editor, re-painted by the `tw-bridge` layer. */}
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Clients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Accounts, their plan, and the API keys issued to them.
        </p>
      </div>

      <div className="admin-card">
        <h2 className="admin-h">Create client</h2>
        <form className="admin-row" onSubmit={createClient}>
          <input className="admin-input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="admin-input" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select className="admin-select" value={planKey} onChange={(e) => setPlanKey(e.target.value)}>
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="admin-btn" type="submit" disabled={!name}>
            Create
          </button>
        </form>
      </div>

      {error && <div className="admin-error">{error}</div>}

      <div className="admin-card">
        <h2 className="admin-h">All clients</h2>
        {/* Five columns plus a whole detail panel in one of the cells does not
            fit a phone: measured at 375px the table needs 972px of min-content
            against 293px of card, and `overflow-x: clip` on the body meant Plan,
            Status and the row actions were not merely off-screen but unreachable.
            `cardTable` turns each row into ONE compact card below 720px —
            identity, then plan and status side by side, then the actions. Not
            `stackTable`, which gave every cell its own labelled line and made one
            client 283px tall: five labels to read three facts.

            `max-[721px]:`, not `max-[720px]:`, everywhere on this page — same
            rule as /portal/usage. Tailwind compiles `max-[N]` to `not all and
            (min-width: N)`, i.e. width < N, while the card CSS is a plain
            `max-width: 720px`. At EXACTLY 720px the 720 variant was therefore
            off while the cards were on: the redundant email printed twice, and
            the keys grid's two folded cells stayed visible with no `data-cell`
            of their own and got auto-placed BELOW their card's actions row. */}
        <div className="tableWrap stackTableWrap" ref={tableRef}>
          <table className="admin-table cardTable clientsCards">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Plan</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedClients.pageItems.map((c) => {
                /* The row is still marked while its dialog is up: the overlay
                   covers part of the list, and on close the operator has to find
                   the client they were just on. */
                const open = selected === c._id;
                /* Most accounts sign up with the address as the name, so the
                   card's second line would print the first line again — 45% of
                   its height spent saying nothing. The column still exists on
                   desktop; only the duplicate line is dropped. */
                const emailRedundant = !c.email || c.email === c.name;
                return (
                  <tr
                    key={c._id}
                    id={`client-row-${c._id}`}
                    className={open ? 'admin-detail-open' : undefined}
                  >
                    {/* `data-cell` places the cell in the card's grid — an
                        attribute rather than `nth-child` so a column reorder
                        cannot silently rearrange the card. `data-label` is kept
                        because it names the cell for anyone reading the markup;
                        `cardTable` renders no label pseudo-element from it. */}
                    <td
                      data-cell="identity"
                      data-label="Name"
                      title={c.name}
                      className="max-[721px]:text-sm max-[721px]:font-medium"
                    >
                      {c.name}
                    </td>
                    <td
                      data-cell="sub"
                      data-label="Email"
                      className={
                        emailRedundant
                          ? 'max-[721px]:hidden'
                          : 'max-[721px]:text-[11px] max-[721px]:text-muted-foreground'
                      }
                    >
                      {c.email ?? '—'}
                    </td>
                    <td data-cell="plan" data-label="Plan">
                      <span className="admin-pill">{c.planKey}</span>
                    </td>
                    <td data-cell="status" data-label="Status">
                      <span className="admin-pill">{c.status}</span>
                    </td>
                    {/* No `data-label`: an actions cell has no value to name. */}
                    <td data-cell="actions">
                      <div className="admin-row">
                        <button
                          className="admin-btn ghost max-[721px]:min-w-0 max-[721px]:flex-1"
                          onClick={() => toggleRow(c._id)}
                          /* `aria-haspopup="dialog"`, not `aria-expanded`: the
                             panel is no longer a region disclosed in place, and
                             announcing a row as expanded when a modal layer is
                             what actually opened misdescribes it. The label
                             stays "Manage" throughout — the dialog has its own
                             close controls, and this button is `inert` and
                             unreachable while it is open. */
                          aria-haspopup="dialog"
                        >
                          Manage
                        </button>
                        {/* The read view: the customer document, the money trail and
                            the metered usage detail. `Manage` beside it is the WRITE
                            surface (plan, keys) and stays inline on this page. */}
                        <Link
                          className="admin-btn ghost max-[721px]:min-w-0 max-[721px]:flex-1"
                          href={`/admin/clients/${c._id}`}
                        >
                          Open
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {clients.length === 0 && (
                <tr>
                  {/* `col-span-2` for the card grid's two tracks; inert on the
                      desktop table, where `colSpan` is what spans. */}
                  <td colSpan={5} className="admin-note max-[721px]:col-span-2">
                    No clients yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {/* `px-0`: the control's own gutter is for a table that draws the card
            edge itself (the converted pages), and `.admin-card` already has
            padding of its own. */}
        <Pagination
          state={pagedClients}
          label="clients"
          scrollTo={tableRef}
          divider={false}
          className="px-0"
        />
      </div>

      {/* OUTSIDE the table, and outside the card: a `<div>` inside a `<tbody>`
          is invalid markup that browsers hoist out of the table anyway, and the
          card is a stacking/overflow context the overlay must not be trapped in.
          Keyed by client id so switching rows remounts the panel rather than
          feeding a new client into the old one's fetched state. */}
      {selectedClient && (
        <AdminModal
          key={selectedClient._id}
          labelledBy={detailHeadingId(selectedClient._id)}
          onClose={() => closeRow(selectedClient._id)}
        >
          <ClientDetail
            client={selectedClient}
            plans={plans}
            headingId={detailHeadingId(selectedClient._id)}
            issued={issuedKeys[selectedClient._id] ?? null}
            onIssued={(key) => setIssuedKeys((prev) => ({ ...prev, [selectedClient._id]: key }))}
            onDismissIssued={() => dismissIssued(selectedClient._id)}
            onClose={() => closeRow(selectedClient._id)}
            onChanged={load}
          />
        </AdminModal>
      )}
    </div>
  );
}

function ClientDetail({
  client,
  plans,
  headingId,
  issued,
  onIssued,
  onDismissIssued,
  onClose,
  onChanged,
}: {
  client: Client;
  plans: Plan[];
  headingId: string;
  /** The one-time key, owned by the page so a collapse cannot destroy it. */
  issued: IssuedKey | null;
  onIssued: (key: IssuedKey) => void;
  onDismissIssued: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [planKey, setPlanKey] = useState(client.planKey);
  const [label, setLabel] = useState('');
  const [keyType, setKeyType] = useState<'server' | 'browser'>('server');
  const [originList, setOriginList] = useState<string[]>([]);
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editList, setEditList] = useState<string[]>([]);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const [k, u] = await Promise.all([adminApi.listKeys(client._id), adminApi.getUsage(client._id)]);
      setKeys(k);
      setUsage(u);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [client._id]);

  /*
   * Both of this panel's lists are unbounded: a Pro plan allows 50 active keys
   * and the monthly rollup gains a row every month for as long as the account
   * exists, inside a panel that is ~270px wide on a phone.
   *
   * The keys pager asks before it turns the page ON AN OPEN ORIGINS EDITOR, for
   * the same reason the page-level one asks about an uncopied key — the draft
   * list is local state and the change unmounts it. Weaker stakes than a
   * one-time secret, so a plain confirm and no dwelling on it; on a clean change
   * the editor is closed rather than left pointing at a row that has gone.
   */
  const keysRef = useRef<HTMLDivElement>(null);
  const pagedKeys = usePagination(keys, {
    defaultPageSize: 10,
    pageSizes: PANEL_PAGE_SIZES,
    guard: () => {
      if (
        editingKeyId &&
        !confirm('Discard the unsaved allowed-site changes on this key and turn the page?')
      ) {
        return false;
      }
      cancelEditOrigins();
      return true;
    },
  });
  // No guard and no scroll target: this one is three short read-only columns
  // with nothing open inside it.
  const pagedUsage = usePagination(usage, {
    defaultPageSize: 10,
    pageSizes: PANEL_PAGE_SIZES,
  });

  useEffect(() => {
    void reload();
  }, [reload]);

  async function issue() {
    setError('');
    if (keyType === 'browser' && originList.length === 0) {
      setError('A browser key needs at least one allowed site URL (e.g. https://app.example.com).');
      return;
    }
    try {
      const key = await adminApi.issueKey(client._id, {
        label: label || undefined,
        keyType,
        origins: keyType === 'browser' ? originList : undefined,
      });
      onIssued(key);
      setLabel('');
      setOriginList([]);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Issue failed');
    }
  }

  function startEditOrigins(k: ApiKeyRow) {
    setError('');
    setEditingKeyId(k._id);
    setEditList(k.allowedOrigins ?? []);
  }

  function cancelEditOrigins() {
    setEditingKeyId(null);
    setEditList([]);
  }

  // Save edited origins. An empty list converts the key to a server key (backend).
  async function saveEditOrigins(keyId: string) {
    setError('');
    try {
      await adminApi.setKeyOrigins(keyId, editList);
      cancelEditOrigins();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update origins');
    }
  }

  // Confirmed, like Delete: there is no un-revoke anywhere in `adminApi`, and
  // every call using the key starts failing the moment this lands.
  async function revoke(keyId: string, prefix: string) {
    if (!confirm(`Revoke ${prefix}…? Calls with this key start failing immediately, and it cannot be un-revoked.`)) return;
    setError('');
    try {
      await adminApi.revokeKey(keyId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed');
    }
  }

  async function removeKey(keyId: string) {
    if (!confirm('Permanently delete this API key? This cannot be undone.')) return;
    setError('');
    try {
      await adminApi.deleteKey(keyId);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  /*
   * An EXPLICIT write, not the select's `change` event. Arrowing through a bare
   * `<select>` fires `change` on every step in Chrome and Firefox, so moving
   * from Free to Enterprise with the keyboard POSTed an assignment for each plan
   * in between. The select is local state; Apply is the only thing that writes.
   */
  async function applyPlan() {
    setError('');
    try {
      await adminApi.assignPlan(client._id, planKey);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plan change failed');
      // Snap back: a control still showing the plan the server refused is a lie.
      setPlanKey(client.planKey);
    }
  }

  return (
    <div className="admin-card">
      {/* Whose account this is, at readable weight. `.admin-h` repaints an h2 as
          a 12px muted eyebrow, which is the faintest type on the screen — on the
          one panel where the next click can revoke a key or reassign a plan, and
          with the source row's own name scrolled off.

          The label goes ABOVE the name rather than after it: as a trailing span
          it needed 64px at the end of a 267px line that a typical name — these
          are email addresses — had already spent 251px of, so "— manage" was
          always orphaned onto a second line. `truncate` keeps the name to one
          line: an address has no break opportunity, so at 20 characters it used
          to escape the panel and get swallowed by the body's `overflow-x: clip`.
          NOT `overflow-wrap: anywhere` — that is the "REQUEST / S" defect. */}
      <div style={{ marginBottom: 14 }}>
        <div className="admin-note text-[0.6875rem] uppercase tracking-[0.06em]">Manage client</div>
        <h2
          className="admin-h1 truncate text-lg sm:text-2xl"
          id={headingId}
          title={client.name}
          style={{ margin: '2px 0 0' }}
        >
          {client.name}
        </h2>
      </div>
      {error && <div className="admin-error">{error}</div>}

      <div className="admin-row" style={{ marginBottom: 16 }}>
        <span className="admin-note">Plan</span>
        <select
          className="admin-select"
          value={planKey}
          onChange={(e) => setPlanKey(e.target.value)}
          aria-label="Plan"
        >
          {plans.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name} — {p.monthlyUnits === 0 ? 'unlimited' : p.monthlyUnits.toLocaleString()} units / {p.rateLimitPerMin} rpm
            </option>
          ))}
        </select>
        <button className="admin-btn" onClick={applyPlan} disabled={planKey === client.planKey}>
          Apply
        </button>
      </div>

      {/* `adminPanelSection` marks the top of one of the panel's five jobs. It
          draws a hairline above the block below 720px, where the whole panel is
          a single full-bleed column and margin alone stops reading as a
          boundary; on desktop the class is inert. See app.css. */}
      <div className="admin-row adminPanelSection" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <input className="admin-input" placeholder="Key label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <select
          className="admin-select"
          value={keyType}
          onChange={(e) => setKeyType(e.target.value as 'server' | 'browser')}
        >
          <option value="server">Server key (backend-only)</option>
          <option value="browser">Browser key (frontend, origin-bound)</option>
        </select>
        {keyType === 'browser' && <OriginsInput value={originList} onChange={setOriginList} />}
        <button className="admin-btn" onClick={issue}>
          Issue API key
        </button>
      </div>
      <div className="admin-note" style={{ marginBottom: 12 }}>
        {keyType === 'server'
          ? 'Server keys are rejected from browsers — keep them on your backend.'
          : 'Browser keys work only from the listed site URLs; a leaked key is useless elsewhere. Enter the customer’s website (https assumed if you omit the scheme).'}
      </div>

      {issued && (
        <div style={{ marginBottom: 12 }}>
          <div className="admin-note">Copy this key now — it is shown only once.</div>
          <div className="admin-key">{issued.apiKey}</div>
          {/* Dismissed by hand, and only by hand. Until this is clicked, closing
              the panel or opening another client's asks for confirmation first. */}
          <div className="admin-row" style={{ marginTop: 8 }}>
            <button className="admin-btn ghost sm" onClick={onDismissIssued}>
              I&apos;ve copied it
            </button>
          </div>
        </div>
      )}

      {/* Six columns inside a cell of the clients table — 576px of min-content
          against the 267px this panel gets on a phone, so no table and no
          scroller fits. `cardTable` makes each key one three-line card: prefix
          and type, then label / origins / last-used folded onto a single 11px
          line, then the actions. Below 720px the three folded columns hide their
          own cells and that one line stands in for all of them. */}
      <div className="tableWrap stackTableWrap adminPanelSection" ref={keysRef}>
        <table className="admin-table cardTable keysCards">
          <thead>
            <tr>
              <th>Key</th>
              <th>Label</th>
              <th>Type / origins</th>
              <th>Status</th>
              <th>Last used</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
          {pagedKeys.pageItems.map((k) => {
            const kOrigins = k.allowedOrigins ?? [];
            const kind = k.keyType ?? (kOrigins.length > 0 ? 'browser' : 'server');
            const editing = editingKeyId === k._id;
            /* The whole origin list is one tap away in the Origins editor, so the
               card's folded line names the first and counts the rest. */
            const originSummary =
              kOrigins.length > 0
                ? `${kOrigins[0]}${kOrigins.length > 1 ? ` +${kOrigins.length - 1}` : ''}`
                : '—';
            const lastUsed = k.lastUsedAt ? formatUtcDate(k.lastUsedAt) : 'never';
            return (
              <Fragment key={k._id}>
                <tr className={editing ? 'admin-detail-open' : undefined}>
                  <td
                    data-cell="identity"
                    data-label="Key"
                    className="max-[721px]:flex max-[721px]:items-center max-[721px]:gap-1.5"
                  >
                    <span className="max-[721px]:min-w-0 max-[721px]:truncate max-[721px]:font-mono max-[721px]:text-xs">
                      {k.keyPrefix}…
                    </span>
                    {/* The type stays full size on line 1; the rest of its column
                        folds into line 2. */}
                    <span className="admin-pill hidden shrink-0 max-[721px]:inline-block">{kind}</span>
                  </td>
                  <td data-cell="sub" data-label="Label">
                    <span className="max-[721px]:hidden">{k.label || '—'}</span>
                    <span className="hidden max-[721px]:inline max-[721px]:text-[11px] max-[721px]:text-muted-foreground">
                      {k.label || 'Unlabelled'} · {kind === 'browser' ? originSummary : 'backend-only'}{' '}
                      · used {lastUsed}
                    </span>
                  </td>
                  <td data-label="Type / origins" className="max-[721px]:hidden">
                    <span className="admin-pill">{kind}</span>{' '}
                    {kind === 'browser' ? (
                      <span className="admin-note">{kOrigins.join(', ') || '—'}</span>
                    ) : (
                      <span className="admin-note">backend-only</span>
                    )}
                  </td>
                  <td data-cell="status" data-label="Status">
                    {/* Active is the default and its pill is noise on a 267px
                        card; a revoked key is the whole reason to look. */}
                    <span
                      className={
                        k.status === 'revoked' ? 'admin-pill revoked' : 'admin-pill max-[721px]:hidden'
                      }
                    >
                      {k.status}
                    </span>
                  </td>
                  {/* UTC through the shared helper, like every other date on both
                      admin surfaces — the client page prints this same field that
                      way, and two zones for one value reads as a discrepancy. */}
                  <td data-label="Last used" className="max-[721px]:hidden">
                    {k.lastUsedAt ? formatUtcDate(k.lastUsedAt) : '—'}
                  </td>
                  <td data-cell="actions">
                    <div className="admin-row">
                      {k.status === 'active' && (
                        <>
                          <button
                            className="admin-btn ghost sm max-[721px]:min-w-0 max-[721px]:flex-1"
                            onClick={() => (editing ? cancelEditOrigins() : startEditOrigins(k))}
                          >
                            {editing ? 'Close' : 'Origins'}
                          </button>
                          <button
                            className="admin-btn danger sm max-[721px]:min-w-0 max-[721px]:flex-1"
                            onClick={() => revoke(k._id, k.keyPrefix)}
                          >
                            Revoke
                          </button>
                        </>
                      )}
                      {/* Also `danger`: it is the harder of the two — a revoke
                          leaves the key on the record, a delete does not. */}
                      <button
                        className="admin-btn danger sm max-[721px]:min-w-0 max-[721px]:flex-1"
                        onClick={() => removeKey(k._id)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
                {editing && (
                  /* The same weld the clients list uses for its Manage panel:
                     `admin-detail-row` is what removes the card chrome between a
                     row and the form that belongs to it, and it is already keyed
                     for `cardTable`. A form, not a value row — no `data-cell`. */
                  <tr className="admin-detail-row">
                    <td colSpan={6} className="max-[721px]:col-span-2">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
                        <span className="admin-note">
                          Allowed site URLs for this browser key. Clear all and Save to make it a server-only key.
                          We standardize each entry (https assumed if no scheme).
                        </span>
                        <OriginsInput value={editList} onChange={setEditList} />
                        <div className="admin-row">
                          <button className="admin-btn sm" onClick={() => saveEditOrigins(k._id)}>
                            Save
                          </button>
                          <button className="admin-btn ghost sm" onClick={cancelEditOrigins}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {keys.length === 0 && (
            <tr>
              <td colSpan={6} className="admin-note max-[721px]:col-span-2">
                No keys issued.
              </td>
            </tr>
          )}
          </tbody>
        </table>
      </div>
      {/* OUTSIDE `tableWrap`: that wrapper is the horizontal scroller for the
          six-column grid, and a pager inside it slides off with the table. */}
      <Pagination
        state={pagedKeys}
        label="keys"
        scrollTo={keysRef}
        divider={false}
        className="px-0"
      />

      {/* The metered detail — per day, per endpoint, per key, per response class.
          BELOW the plan control and the keys grid, not above them: this panel is
          reached by clicking "Manage", so the two write surfaces are what the
          operator came for and they stay at the top of the dialog. Same
          component and same endpoint as the standalone client page, so the
          figures here and there cannot disagree. */}
      <div className="adminPanelSection" style={{ marginTop: 18 }}>
        <UsageDetailPanel clientId={client._id} />
      </div>

      {/* Kept BELOW the detail, not replaced by it: a detail read is capped at 92
          days server-side, and this rollup is the only surface anywhere in the
          panel that answers "what did they use last March". */}
      <h3 className="admin-h adminPanelSection" style={{ marginTop: 18 }}>
        Monthly history
      </h3>
      {/* A real table at every width. Three short columns — a month and two
          numbers — measure 242px of max-content against the 267px this panel
          gets on a phone, so it fits with room to spare; stacking it spent 545px
          printing three labels per month for numbers that need none. */}
      <div className="tableWrap stackTableWrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Units consumed</th>
              <th>Requests</th>
            </tr>
          </thead>
          <tbody>
            {pagedUsage.pageItems.map((u) => (
              <tr key={u.period}>
                <td>{formatPeriod(u.period)}</td>
                <td>{u.unitsConsumed.toLocaleString()}</td>
                <td>{u.requestCount.toLocaleString()}</td>
              </tr>
            ))}
            {usage.length === 0 && (
              <tr>
                <td colSpan={3} className="admin-note">
                  No usage recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination state={pagedUsage} label="months" divider={false} className="px-0" />

      {/* An exit at the bottom. The dialog's own close button is pinned to the
          top-right of the card and scrolls away with it — this panel is taller
          than the viewport — so a reader who has worked down to the monthly
          history would otherwise have to scroll back up to leave. */}
      {/* No `adminPanelSection` here: the monthly table above always renders —
          an empty one still prints its "No usage recorded yet." row — and every
          `.admin-table` row carries a bottom hairline, so a rule of our own
          would be a second line 18px under the table's own. */}
      <div className="admin-row" style={{ marginTop: 18 }}>
        <button className="admin-btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
