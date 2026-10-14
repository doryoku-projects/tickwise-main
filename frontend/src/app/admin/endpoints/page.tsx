'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi, type EndpointCost } from '../../../lib/admin-api';

export default function EndpointsPage() {
  const [rows, setRows] = useState<EndpointCost[]>([]);
  const [draft, setDraft] = useState<Record<string, EndpointCost>>({});
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await adminApi.listEndpointCosts();
      setRows(r);
      setDraft(Object.fromEntries(r.map((x) => [x.routeKey, { ...x }])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function edit(routeKey: string, patch: Partial<EndpointCost>) {
    setDraft((d) => ({ ...d, [routeKey]: { ...d[routeKey], ...patch } }));
  }

  async function save(routeKey: string) {
    setError('');
    try {
      const { unitCost, enabled } = draft[routeKey];
      await adminApi.updateEndpointCost(routeKey, { unitCost, enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  return (
    <div>
      {/* Title in Tickwise markup; the table below is still the `.admin-table`
          editor, re-painted by the `tw-bridge` layer. */}
      <div className="mb-6">
        <h1 className="font-display text-3xl font-semibold">Endpoint pricing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Units charged per request. 0 = free. Changes apply to live metering immediately.
        </p>
      </div>

      <div className="admin-card">
        {error && <div className="admin-error">{error}</div>}
        {/* Five columns, three of them controls, in a 293px card at 375px: the
            Enabled box and Save button were past the fold, and with no wrapper
            here and `overflow-x: clip` on the body they were unreachable rather
            than merely off-screen. `cardTable` makes each route one compact
            card below 720px (see `pricingCards` in panel.css); `stackTableWrap`
            turns the wrapper's own scroll OFF once the cards take over, so
            there is no phantom sideways drag over nothing. */}
        <div className="tableWrap stackTableWrap">
          <table className="admin-table cardTable pricingCards">
          <thead>
            <tr>
              <th>Route</th>
              <th>Endpoint</th>
              <th>Unit cost</th>
              <th>Enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = draft[r.routeKey] ?? r;
              return (
                <tr key={r.routeKey}>
                  {/* `data-cell` places the cell in the card's grid — an
                      attribute rather than `nth-child` so a column reorder
                      cannot silently rearrange the card. `data-label` names it
                      for anyone reading the markup; `cardTable` renders no
                      label pseudo-element from it. */}
                  <td data-cell="identity" data-label="Route" title={r.routeKey}>
                    {r.routeKey}
                  </td>
                  <td data-cell="sub" data-label="Endpoint" className="max-[721px]:text-[11px]">
                    {r.label}
                  </td>
                  <td data-cell="figure" data-label="Unit cost">
                    <input
                      className="admin-input"
                      type="number"
                      style={{ width: 90 }}
                      value={d.unitCost}
                      onChange={(e) => edit(r.routeKey, { unitCost: Number(e.target.value) })}
                    />
                  </td>
                  <td data-cell="status" data-label="Enabled">
                    <input type="checkbox" checked={d.enabled} onChange={(e) => edit(r.routeKey, { enabled: e.target.checked })} />
                  </td>
                  {/* No `data-label`: an actions cell has no value to name. */}
                  <td data-cell="actions">
                    <button className="admin-btn max-[721px]:w-full" onClick={() => save(r.routeKey)}>
                      Save
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
