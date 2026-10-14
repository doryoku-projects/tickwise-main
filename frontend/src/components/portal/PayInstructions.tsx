'use client';

import { useState } from 'react';
import type { OnChainInstructions } from '../../lib/portal-api';

/**
 * The pay-to-this-address panel for the native crypto rail.
 *
 * A self-custody transfer has TWO ways to lose the money, and both get top
 * billing here rather than fine print:
 *
 *  1. WRONG NETWORK. USDC exists on a dozen chains at different addresses;
 *     sending on the wrong one is unrecoverable. The chain is stated first and
 *     loudest.
 *  2. WRONG AMOUNT. The watcher matches an exact amount; a short transfer does
 *     not settle (it waits for a top-up) and an over-transfer credits the
 *     excess, but either way the customer should send exactly what is shown.
 *
 * Everything shown is display-only. `amountBaseUnits` — the integer the watcher
 * actually matches — is deliberately NOT rendered: it would only invite someone
 * to type 19000000 into a wallet that wants 19.
 */
export function PayInstructions({ instructions }: { instructions: OnChainInstructions }) {
  // RENDERS THE DEPOSIT SHAPE ONLY. The backend's instructions are a union
  // (`deposit` | `authorization`, with absent `kind` meaning `deposit` for rows
  // written before the union existed), and the sign-to-pay `authorization` shape
  // has no `payToAddress` at all — its panel is a wallet-signing flow, not an
  // address to copy. Rendering one here produced a "Send to" row containing an
  // empty string on a money screen: worse than showing nothing, because a
  // customer can copy blank, paste it into a wallet, and conclude the product is
  // broken. Fail closed until that panel exists.
  if (instructions.kind === 'authorization' || !instructions.payToAddress) {
    return null;
  }

  return (
    <div className="admin-card payInstr">
      <h2 className="admin-h">Pay with {instructions.tokenSymbol}</h2>

      {/* The network warning is the single most important line on the page. */}
      <p className="payInstrWarn">
        Send on <strong>{instructions.chainName}</strong> only. {instructions.tokenSymbol} sent on any other
        network is lost and cannot be recovered.
      </p>

      <dl className="payInstrGrid">
        <dt>Network</dt>
        <dd>{instructions.chainName}</dd>

        <dt>Token</dt>
        <dd>
          {instructions.tokenSymbol}
          <CopyField label="token contract" value={instructions.tokenAddress} mono small />
        </dd>

        <dt>Amount</dt>
        <dd className="payInstrAmount">
          {instructions.amountDisplay}
          <span className="admin-note"> — send this exact amount</span>
        </dd>

        <dt>Send to</dt>
        <dd>
          <CopyField label="deposit address" value={instructions.payToAddress} mono />
        </dd>
      </dl>

      <p className="admin-note">
        We confirm on-chain after {instructions.minConfirmations} block
        {instructions.minConfirmations === 1 ? '' : 's'}, then your plan activates automatically — you do not
        need to keep this page open. An overpayment is credited to your account; an underpayment waits for the
        rest.
      </p>
    </div>
  );
}

/** A value with a copy button — an address typed by hand is an address typo. */
function CopyField({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context, permissions) — the value is still visible to select */
    }
  }
  return (
    <span className={`copyField${small ? ' copyFieldSmall' : ''}`}>
      <code className={mono ? 'mono' : undefined}>{value}</code>
      <button type="button" className="copyBtn" onClick={() => void copy()} aria-label={`Copy ${label}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
