/**
 * The Tickwise mark: nine bars whose tops trace a tick.
 *
 * It is a concentrated-liquidity depth histogram AND a checkmark AND the
 * in-range/out-of-range split, which is why the bar heights are not arbitrary
 * decoration — they are the mark. Reordering or re-heighting them destroys the
 * tick silhouette and the whole idea with it.
 *
 * COLOURS COME FROM THE THEME, NOT FROM CONSTANTS. The five short bars are
 * `fill-current`, so they inherit whatever text colour the call site sits in
 * (ink on light, near-white on dark). The four rising bars are `fill-primary`,
 * which resolves through `--color-primary` → `--primary` and therefore follows
 * the runtime accent the Tweaks panel writes. Hardcoding hexes here would fork
 * the brand from the accent the customer actually picked.
 *
 * The accent belongs on the RISING bars specifically. Accenting the falling
 * three inverts the reading from "verified / in range" to "decline".
 *
 * For the favicon, see `src/app/icon.svg` — that one carries static colours
 * because browser chrome supplies no CSS custom properties, and it drops the
 * corner radius because a 2-unit radius on an 8-unit bar turns to mush at 16px.
 */
export function TickwiseMark({
  className = '',
  title = 'Tickwise',
}: {
  className?: string;
  /** Accessible name. Pass an empty string when an adjacent text label already names the link. */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 120 120"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {/* Falling stroke — three bars, out-of-range tone. */}
      <rect x="8" y="66" width="8" height="38" rx="2" className="fill-current" />
      <rect x="20" y="80" width="8" height="24" rx="2" className="fill-current" />
      <rect x="32" y="92" width="8" height="12" rx="2" className="fill-current" />
      {/* Two more in the base tone so the accent stays a minority and the
          pivot at bar 3 stays legible as the low point of the tick. */}
      <rect x="44" y="82" width="8" height="22" rx="2" className="fill-current" />
      <rect x="56" y="70" width="8" height="34" rx="2" className="fill-current" />
      {/* Rising stroke — the accent, and the "in range" half of the reading. */}
      <rect x="68" y="57" width="8" height="47" rx="2" className="fill-primary" />
      <rect x="80" y="44" width="8" height="60" rx="2" className="fill-primary" />
      <rect x="92" y="30" width="8" height="74" rx="2" className="fill-primary" />
      <rect x="104" y="16" width="8" height="88" rx="2" className="fill-primary" />
    </svg>
  );
}
