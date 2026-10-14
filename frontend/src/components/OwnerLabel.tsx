"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import { compactAddress } from "../lib/format";

/**
 * Owners no one controls, lowercase. A position held by one of these can never
 * be withdrawn or have its fees collected, which is how launchpads and teams
 * "lock" liquidity — the LP NFT is sent somewhere with no private key:
 *   - 0x…dEaD — the conventional burn address.
 *   - 0xdead…2069 — a vanity burn address, equally keyless.
 * NOT the zero address (`ZERO_ADDRESS`, below): the position managers refuse a
 * transfer to it, so no one can lock liquidity there.
 * Product decision (2026-10-06): such positions stay listed, sorted and
 * filtered exactly like any other — only labelled, so a big "whale" row that is
 * really permanently locked liquidity is not mistaken for a live LP.
 */
export const BURN_ADDRESSES: readonly string[] = [
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000042069420694206942069",
];

/**
 * The zero address as an owner means the position's NFT was BURNED: v3's and
 * v4's position managers both revert a transfer to address(0), so the only
 * Transfer that ever names it is the burn's (the indexer takes `owner` from
 * the Transfer's `to`). And a burn leaves nothing behind — v3 `burn` requires
 * zero liquidity and zero fees owed, v4's withdraws the liquidity and the
 * fees to the owner in the same call. So these rows hold nothing and were
 * emptied by their owner: calling them "locked" (as the first cut did) told
 * the opposite of what happened. They get a note of their own ("Burned
 * position"), and only a burn address reads "Locked LP".
 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isBurnAddress(address: string | undefined): boolean {
  return typeof address === "string" && BURN_ADDRESSES.includes(address.toLowerCase());
}

/** What the owner note says, or undefined for an ordinary owner. */
export function ownerNote(owner: string | undefined): { label: string; note: string } | undefined {
  const text = compactAddress(owner);
  if (isBurnAddress(owner)) {
    return {
      label: "Locked LP",
      note: `Locked LP — this position is owned by a burn address (${text}) that no one controls, so no one can withdraw it or collect its fees. Its liquidity stays in the pool permanently.`,
    };
  }
  if (typeof owner === "string" && owner.toLowerCase() === ZERO_ADDRESS) {
    return {
      label: "Burned position",
      note: `Burned position — its NFT was burned, which is why the owner shows as the zero address (${text}). A position is only burned once its liquidity and fees have been withdrawn, so it holds nothing and nothing is locked. The wallet that owned it is not recorded here.`,
    };
  }
  return undefined;
}

/**
 * A position's owner as the tables and detail panel show it: the compact
 * address, plus — for a burn address or the zero address — an info button
 * that explains it (`ownerNote`). Informational, not a warning: nothing is
 * wrong with the position.
 *
 * The explanation is a BUTTON that opens the note under the address, because
 * a `title` tooltip only ever shows on mouse hover: on a phone (the card
 * layouts of /explore and the pool modal) a tap on the icon fell through to
 * the row and opened the detail panel, which showed the same unexplained
 * icon, and a keyboard user could not reach it at all. The tap stops at the
 * button (the row's `onClick` must not also fire); Escape, a tap anywhere
 * else and moving focus away close it. `title` stays for mouse hover, and the
 * note stays in the DOM (visually hidden when closed) for screen readers.
 */
export function OwnerLabel({ owner }: { owner: string | undefined }) {
  const [open, setOpen] = useState(false);
  const noteId = useId();
  const pill = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    // A CLICK elsewhere, in the capture phase — not pointerdown: closing on
    // pointerdown collapses the note before the pointer comes back up, so the
    // rows below shift and the click lands on whatever moved under it (another
    // row's address, which opens that row). By the click, its target is fixed.
    const close = (e: MouseEvent) => {
      if (!pill.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("click", close, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", close, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const text = compactAddress(owner);
  const about = ownerNote(owner);
  if (!about) return <>{text}</>;
  return (
    <>
      <span className="ownerLocked" ref={pill} title={about.note}>
        {text}
        <button
          type="button"
          className="ownerLockedButton"
          aria-label={`${about.label}: what this means`}
          aria-expanded={open}
          aria-controls={noteId}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
          onBlur={() => setOpen(false)}
        >
          <Info aria-hidden="true" size={12} strokeWidth={2.5} />
        </button>
      </span>
      {/* Leading space: without it a screen reader runs the address into the note. */}
      <span
        id={noteId}
        className={open ? "ownerLockedNote" : "ownerLockedText"}
        onClick={open ? (e) => e.stopPropagation() : undefined}
      >
        {` ${about.note}`}
      </span>
    </>
  );
}
