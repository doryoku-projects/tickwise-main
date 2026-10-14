'use client';

import { useState } from 'react';

/**
 * Chip-list editor for a browser key's allowed site URLs (origins). Users type
 * a URL and Add (or press Enter); the backend canonicalizes it (e.g.
 * `app.example.com` → `https://app.example.com`), so we send raw strings and
 * let the caller's reload show the stored form.
 *
 * Shared by the admin client detail and the customer portal's key manager.
 */
export function OriginsInput({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const [draft, setDraft] = useState('');

  function add() {
    const parsed = draft
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length === 0) return;
    const next = [...value];
    for (const o of parsed) if (!next.includes(o)) next.push(o);
    onChange(next);
    setDraft('');
  }

  return (
    /*
     * `min(280px, 100%)`, not a bare 280px. The floor exists for the DESKTOP
     * call sites, where this editor is one item of a wrapping `.admin-row` and
     * would otherwise be squeezed to a stub beside the label and the Add
     * button. A hard floor is wrong below 720px: the narrowest container this
     * is rendered into is the origins editor welded inside the keys CARD table
     * on /admin, which measures 265px once the expanded row takes the card
     * rows' 10px inset — so 280px overflowed it by 15px, into `body`'s
     * `overflow-x: clip`, where it was neither visible nor scrollable.
     * `min()` keeps the desktop floor and yields to the container when the
     * container is the smaller of the two.
     */
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 'min(280px, 100%)' }}>
      {value.length > 0 && (
        <div className="admin-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {value.map((o) => (
            <span key={o} className="admin-pill" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {o}
              <button
                type="button"
                aria-label={`Remove ${o}`}
                onClick={() => onChange(value.filter((x) => x !== o))}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, lineHeight: 1, fontSize: 14 }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="admin-row" style={{ gap: 6 }}>
        <input
          className="admin-input"
          placeholder="Site URL, e.g. https://app.example.com or app.example.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          /* `flex: 1` already gives this the whole line minus the Add button,
             so the 260px floor it used to carry only ever bit inside a
             container narrower than ~310px — the one place it must shrink. */
          style={{ minWidth: 0, flex: 1 }}
        />
        <button type="button" className="admin-btn ghost sm" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
