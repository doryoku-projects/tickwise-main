'use client';

import { useEffect, useRef, useState } from 'react';
import {
  portalApi,
  type AuthorizationPayload,
  type OnChainInstructions,
  type PaymentNetworkOption,
} from '../../lib/portal-api';
import { announcePaymentStarted } from '../../lib/payment-events';
import { useWallet } from '../providers/WalletProvider';
import {
  isDeadWalletSession,
  isUserRejection,
  resetWalletConnectSession,
  toEvmAddress,
  type ConnectedWallet,
} from '../../lib/wallet';

/** `0xf85a…484D` — identifies an account without a wall of hex. */
function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * How often the confirming panel asks whether the payment has settled.
 *
 * 4s is comfortably inside the shortest realistic wait (a confirmation depth plus
 * a watcher tick) without hammering the API: the read is cheap, but a 1s poll
 * would make a two-minute confirmation 120 requests for no extra information.
 */
const POLL_EVERY_MS = 4000;

/**
 * When to stop polling and hand the customer a calm message instead.
 *
 * The payment is ON CHAIN by this point, so giving up watching costs nothing —
 * the settled invoice will be there next visit whether this tab saw it or not.
 * Spinning forever, by contrast, reads as a stuck payment.
 */
const MAX_POLL_MS = 4 * 60 * 1000;

/**
 * The sign-to-pay panel for the x402 / EIP-3009 rail.
 *
 * THE CUSTOMER NEVER SENDS A TRANSFER HERE. They sign a message and USDC moves
 * itself into the treasury, so the two ways a plain transfer loses money — wrong
 * network, wrong amount — are structurally impossible: both are inside the thing
 * they sign, and a mismatch simply makes the signature invalid rather than sending
 * funds somewhere unrecoverable. That is worth saying on the panel, because
 * "connect your wallet and sign" reads as riskier than it is next to an address.
 *
 * ── WHAT IS NOT DONE HERE ──────────────────────────────────────────────────
 *
 * The typed data is NOT built in this component. The server composes it, stores
 * what it issued, and verifies the signature against the STORED copy — so this
 * file hands `payload.typedData` to the wallet verbatim. Rebuilding it here would
 * create a second encoder that can silently disagree with the verifier, which is
 * the same trap `siwe.service.ts` avoids by composing its message server-side.
 *
 * ── THE THREE OUTCOMES ─────────────────────────────────────────────────────
 *
 *  `submitted` — we relayed it and paid the gas. Nothing left for them to do.
 *  `authorized` + `selfSubmit` — no relayer is configured, so their wallet sends
 *      the transaction (and pays gas). The calldata comes from the server, again
 *      so there is only one encoder.
 *  `settled` — it already confirmed while they were signing.
 */
export function SignToPay({
  instructions,
  onPaid,
  onBusyChange,
}: {
  instructions: OnChainInstructions;
  onPaid: () => void;
  /**
   * Reports the wallet interaction in flight — the label itself ("Confirm in your
   * wallet…"), empty when idle — so a container can refuse to be dismissed
   * mid-signature AND say why it has gone quiet. The STRING rather than a boolean
   * because the only place that text is otherwise shown is a disabled button
   * label, which no screen reader re-announces. `PayModal` passes its `setBusy`;
   * rendered inline nobody needs it.
   */
  onBusyChange?: (busy: string) => void;
}) {
  // Through the PROVIDER, not by importing `lib/wallet` directly — that is the
  // seam the whole app uses (`SsoPanel` does the same), and it is what keeps the
  // root layout a server component and leaves one place to swap the wallet stack.
  const { prepare, connect, restore, disconnect } = useWallet();
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [payload, setPayload] = useState<AuthorizationPayload | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [slow, setSlow] = useState(false);
  /** Set once the transaction is out; drives the live confirming panel. */
  const [confirming, setConfirming] = useState<{ txHash?: string; since: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /**
   * Confirmations so far, from the billing poll this panel already runs. BLOCKS
   * rather than seconds: the chain does not care how long you have waited, so
   * an elapsed counter answers a question nobody asked, while "12 of 30" is the
   * actual quantity being waited on — and the one a block explorer agrees with.
   * Null until a transaction is mined and readable; the panel then says it is
   * waiting rather than inventing a zero.
   */
  const [progress, setProgress] = useState<{ confirmations: number; minConfirmations: number } | null>(
    null,
  );
  const [networks, setNetworks] = useState<PaymentNetworkOption[]>([]);
  /**
   * The quote AFTER a network switch, held locally.
   *
   * The prop is the page's stored snapshot; a switch re-quotes server-side and
   * returns the new one, so keeping it here means the panel updates itself without
   * the parent needing a refresh hook — and the plans page, which navigates on
   * success, does not have to care.
   */
  const [requoted, setRequoted] = useState<OnChainInstructions | null>(null);
  const quote = requoted ?? instructions;
  /**
   * `onPaid` behind a ref, so the settle poll below does not depend on it.
   *
   * The pages pass an inline arrow (`() => void load({ silent: true })`), which is
   * a NEW FUNCTION on every render — and the page re-renders every 8 seconds from
   * its own poll. With `onPaid` in the effect's deps, each of those tore the
   * interval down and built a new one, so the 4-second tick was cancelled at 8
   * seconds forever and `elapsed` never advanced past its first step.
   */
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  /**
   * WARM THE WALLET STACK ON MOUNT. This is not an optimisation — without it the
   * first click has to dynamically `import()` @web3-onboard's core plus every
   * wallet module before it can even open the picker, and in dev that compile
   * takes long enough that the button sits on "Waiting for your wallet…" with no
   * picker in sight. It reads as a hang, and it is exactly what the
   * `prepare()` contract is for ("call it from a screen that is ABOUT to offer a
   * wallet"). `SsoPanel` does the same thing for the same reason.
   */
  useEffect(() => {
    prepare();
  }, [prepare]);

  /**
   * PUT THE WALLET BACK AFTER A REFRESH.
   *
   * This component's `wallet` lives in component state, and Web3-Onboard's
   * `autoConnectLastWallet` is off (it opened a QR on bare page load), so without
   * this a reload always drops the customer back to an anonymous "Prepare payment"
   * even though their wallet is still connected as far as the wallet is concerned.
   *
   * SAFE IN AN EFFECT because `restore()` cannot prompt: no picker, and for a
   * WalletConnect label it first proves a live session already exists in storage.
   * `null` is the normal answer and means "press the button" — never an error.
   *
   * Deliberately does NOT go on to issue a payload. That mints an authorization
   * server-side, and doing it unasked on every page load would leave a trail of
   * unused ones; the customer presses "Prepare payment" for that. All this buys is
   * that they can see WHICH wallet is about to pay before they press it.
   */
  useEffect(() => {
    let cancelled = false;
    void restore().then((restored) => {
      if (!cancelled && restored) setWallet(restored);
    });
    return () => {
      cancelled = true;
    };
  }, [restore]);

  /**
   * Publish "a wallet prompt is open" upwards.
   *
   * In an effect rather than beside each `setBusy` call: there are eight of them
   * across five handlers, and one missed pairing would let a dialog close while
   * the wallet is waiting. Derived from the single piece of state that already
   * means this, so the two cannot drift.
   */
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  /**
   * Load the payable networks so the customer can choose.
   *
   * Failure is SILENT and leaves the picker hidden: not knowing the alternatives
   * must not block paying on the one already quoted.
   */
  useEffect(() => {
    let cancelled = false;
    void portalApi
      .paymentNetworks()
      .then((options) => {
        if (!cancelled) setNetworks(options);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * POLL UNTIL IT SETTLES. Without this the page is silent from the moment the
   * wallet closes until the customer thinks to reload — and settlement takes a
   * confirmation depth plus a watcher tick, so "nothing happened" is the normal
   * appearance of a payment that is working perfectly.
   *
   * Polls the billing overview rather than a bespoke status route: the thing the
   * customer is waiting for IS their plan changing, so the authority on "is it
   * done" is the same read the rest of the page uses. `onPaid` then refreshes the
   * page for real.
   *
   * BOUNDED. It stops after `MAX_POLL_MS` and says so rather than spinning
   * forever — the payment is on chain either way, and a settled invoice will be
   * there on the next visit whether this tab watched it or not.
   */
  useEffect(() => {
    if (!confirming) return;
    let cancelled = false;

    const tick = window.setInterval(async () => {
      setElapsed(Math.round((Date.now() - confirming.since) / 1000));
      if (Date.now() - confirming.since > MAX_POLL_MS) {
        window.clearInterval(tick);
        if (!cancelled) {
          setConfirming(null);
          setDone(
            'Your payment is on chain and will be applied automatically. It is taking longer than usual ' +
              'to confirm — you can safely leave this page.',
          );
        }
        return;
      }
      try {
        const overview = await portalApi.billing();
        if (!cancelled) {
          setProgress(
            overview.paymentProgress
              ? {
                  confirmations: overview.paymentProgress.confirmations,
                  minConfirmations: overview.paymentProgress.minConfirmations,
                }
              : null,
          );
        }
        // Settled when the invoice we were paying is gone or paid — either way the
        // page's own state is now the truth, so hand back to it.
        const stillDue = overview.openInvoice && overview.openInvoice.status === 'open';
        if (!cancelled && (!stillDue || overview.state === 'active')) {
          window.clearInterval(tick);
          setConfirming(null);
          setDone('Payment confirmed — your plan is active.');
          onPaidRef.current();
        }
      } catch {
        // A failed poll is not a failed payment. Keep waiting.
      }
    }, POLL_EVERY_MS);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
    };
    // `onPaid` deliberately absent — see `onPaidRef`. Including it restarted this
    // interval on every parent render and the tick never fired.
  }, [confirming]);

  /**
   * Put the wallet on the payment's chain, asking it to switch if it is not.
   *
   * THIS IS NOT COSMETIC. `eth_sendTransaction` carries no chain — the wallet
   * sends on WHATEVER NETWORK IT IS CURRENTLY ON. The authorization is bound to
   * one chain (the chain id is inside the signed struct), so a wallet sitting on
   * Ethereum would broadcast our Arbitrum calldata to the Arbitrum USDC ADDRESS ON
   * ETHEREUM — a contract that is not USDC there. Observed exactly that: the
   * wallet quoted 2.1 Gwei / $0.13, which is mainnet pricing, for a transfer that
   * costs about a cent on Arbitrum.
   *
   * Done BEFORE signing as well as before sending, so the customer is asked once,
   * up front, rather than half way through a payment.
   */
  async function ensureChain(provider: ConnectedWallet['provider'], chainId: number): Promise<boolean> {
    const want = `0x${chainId.toString(16)}`;
    let current: string | undefined;
    try {
      current = (await provider.request({ method: 'eth_chainId' })) as string;
    } catch (err) {
      // A dead session here must not read as "wrong network" — let the caller's
      // `withLiveWallet` retry deal with it on the next real call.
      if (isDeadWalletSession(err)) return true;
      throw err;
    }
    if (typeof current === 'string' && current.toLowerCase() === want) return true;

    setBusy('Switch network in your wallet…');
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
      return true;
    } catch (err) {
      // A DEAD SESSION FIRST, before anything is blamed on the network. The switch
      // is often the first call made after a long pause on the panel, so it is
      // where an expired mobile session surfaces — and reporting that as "switch
      // your wallet to Arbitrum" sends the customer to fix a setting that is
      // already correct, while `return false` aborts the caller so
      // `withLiveWallet` never gets its chance to re-attach. Treated as "on the
      // right chain" so the flow continues to a real call that can retry.
      if (isDeadWalletSession(err)) return true;
      // 4902 = the wallet does not know this chain. Adding it needs RPC details we
      // will not invent on the customer's behalf, so say what to do instead.
      const code = (err as { code?: number }).code;
      if (code === 4902) {
        setError(
          `Your wallet does not have ${quote.chainName} configured. Add that network in your ` +
            'wallet, then try again.',
        );
        return false;
      }
      if (!isUserRejection(err)) {
        setError(`Switch your wallet to ${quote.chainName} to pay, then try again.`);
      }
      return false;
    }
  }

  /**
   * Detach the current wallet and pick another.
   *
   * `disconnect()` alone is not enough: Web3-Onboard remembers the last wallet and
   * re-attaches it with no picker, so "use a different wallet" would silently hand
   * back the same account. `lib/wallet.disconnectWallet` clears that memory too,
   * which is why this goes through the provider rather than calling the module.
   *
   * Everything derived from the old account is cleared — the payload is BOUND to
   * an address (it is inside the signed struct), so keeping it would let somebody
   * sign with account B a message that says account A pays.
   */
  async function useAnotherWallet() {
    setError('');
    setBusy('Disconnecting…');
    try {
      await disconnect();
      setWallet(null);
      setPayload(null);
      const next = await connect();
      const address = toEvmAddress(next?.address);
      if (!next || !address) return;
      setWallet(next);
      if (!(await ensureChain(next.provider, quote.chainId))) return;
      setBusy('Preparing your payment…');
      setPayload(await portalApi.authorizePayment(address));
    } catch (err) {
      if (!isUserRejection(err)) {
        setError(err instanceof Error ? err.message : 'Could not switch wallet');
      }
    } finally {
      setBusy('');
    }
  }

  /**
   * Run a wallet call, re-attaching once if the session turns out to be dead.
   *
   * The retry re-reads the wallet from the provider rather than reusing the handle
   * we were holding — that handle IS the thing that went stale.
   */
  async function withLiveWallet<T>(fn: (w: ConnectedWallet) => Promise<T>): Promise<T> {
    const first = wallet ?? (await connect());
    if (!first) throw new Error('No wallet connected');
    try {
      return await fn(first);
    } catch (err) {
      if (!isDeadWalletSession(err)) throw err;
      setBusy('Reconnecting your wallet…');
      // CLEAR IT BEFORE RECONNECTING. `connect()` on its own restores the same
      // dead session out of IndexedDB, so the retry fails identically and the
      // library keeps throwing on the orphaned topic. This makes it a new pairing.
      await resetWalletConnectSession();
      setWallet(null);
      const fresh = await connect();
      if (!fresh) throw err;
      setWallet(fresh);
      return fn(fresh);
    }
  }

  /**
   * Move the invoice to another network.
   *
   * Clears any payload already issued: it was bound to the OLD chain (the chain id
   * is inside the signed struct), so a signature over it could only ever be
   * refused. The customer prepares again on the new network.
   */
  async function switchNetwork(chainId: number) {
    if (chainId === quote.chainId) return;
    setError('');
    setBusy('Switching network…');
    try {
      const { instructions: next } = await portalApi.switchPaymentNetwork(chainId);
      setRequoted(next);
      setPayload(null);
      setNetworks((prev) => prev.map((n) => ({ ...n, current: n.chainId === chainId })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch network');
    } finally {
      setBusy('');
    }
  }

  /** Connect a wallet and ask the server for a payload bound to it. */
  async function preparePayment() {
    setError('');
    setSlow(false);
    setBusy('Waiting for your wallet…');
    // If the picker has not appeared in a few seconds something is wrong with it
    // rather than with us — say so instead of spinning silently.
    const hint = setTimeout(() => setSlow(true), 6000);
    try {
      const connected = await connect();
      const address = toEvmAddress(connected?.address);
      if (!connected || !address) {
        // `null` is a DISMISS, not a failure — the provider's contract says not to
        // raise a banner for it.
        return;
      }
      setWallet(connected);
      // On the right network BEFORE anything is signed — see `ensureChain`.
      if (!(await ensureChain(connected.provider, quote.chainId))) return;
      setBusy('Preparing your payment…');
      setPayload(await portalApi.authorizePayment(address));
    } catch (err) {
      if (!isUserRejection(err)) {
        setError(err instanceof Error ? err.message : 'Could not prepare the payment');
      }
    } finally {
      clearTimeout(hint);
      setSlow(false);
      setBusy('');
    }
  }

  /** Sign the server's payload, hand back the signature, and report the outcome. */
  async function sign() {
    if (!payload) return;
    setError('');
    setBusy('Confirm in your wallet…');
    try {
      // Fetched through `withLiveWallet` so a dead WalletConnect session is
      // re-attached rather than surfaced. `connect()` returns the ALREADY-ATTACHED
      // wallet without a picker, so this is cheap even on the happy path.
      const connected = await withLiveWallet(async (w) => w);
      const address = toEvmAddress(connected.address);
      if (!address) return;
      // The wallet MUST still be the one the payload was issued for — the address
      // is inside the signed struct, so signing from a different account produces
      // a signature the server correctly refuses. Catching it here turns a
      // confusing rejection into a clear instruction.
      if (address.toLowerCase() !== String(payload.typedData.message.from).toLowerCase()) {
        setError('Your wallet changed. Press "Prepare payment" again to sign from this account.');
        setPayload(null);
        setWallet(null);
        return;
      }

      // `eth_signTypedData_v4` takes the payload as a JSON STRING. Passing the
      // object works in some wallets and not others; the string form is what the
      // spec says and what every wallet accepts.
      const signature = (await withLiveWallet((w) =>
        w.provider.request({
          method: 'eth_signTypedData_v4',
          params: [address, JSON.stringify(payload.typedData)],
        }),
      )) as string;

      setBusy('Submitting…');
      const result = await portalApi.confirmAuthorization(signature);

      let txHash = result.txHash;
      const selfSubmit = result.selfSubmit;
      if (selfSubmit) {
        // No relayer: their wallet sends it and pays the gas. RE-CHECK the chain —
        // the wallet can be switched between signing and sending, and this call
        // carries no chain of its own, so it would go out on the wrong one.
        if (!(await ensureChain(connected.provider, selfSubmit.chainId))) {
          setError(
            `Your signature is saved. Switch your wallet to ${quote.chainName} and press ` +
              '"Sign and pay" again to finish — you will not be asked to sign twice.',
          );
          return;
        }
        setBusy('Confirm the transaction in your wallet…');
        txHash = (await withLiveWallet((w) =>
          w.provider.request({
            method: 'eth_sendTransaction',
            params: [{ from: address, to: selfSubmit.to, data: selfSubmit.data }],
          }),
        )) as string;

        // Tell the server the hash so it survives a reload and gives support
        // something to search with if this transaction never confirms. Best-effort
        // on purpose: settlement does not depend on it, so a failure here must not
        // turn a sent payment into an error.
        if (typeof txHash === 'string') {
          await portalApi.recordSubmittedTx(txHash).catch(() => undefined);
        }
      }

      if (result.status === 'settled') {
        setDone('Payment confirmed — your plan is active.');
        onPaid();
        return;
      }
      // The transaction is out. Hand over to the live poller rather than telling
      // them it is done (it is not) or leaving the page silent (it was).
      setConfirming({ txHash, since: Date.now() });
      // Tell the portal-wide strip immediately. Without this it only learns of
      // a payment on its next mount or navigation, so closing the dialog left
      // the customer on a page with no sign anything was happening.
      announcePaymentStarted();
    } catch (err) {
      if (!isUserRejection(err)) {
        setError(err instanceof Error ? err.message : 'Could not complete the payment');
      }
    } finally {
      setBusy('');
    }
  }

  // ── THE LIVE PANEL. The whole point: from here until it settles the customer
  // watches something move instead of a silent page they have to reload.
  if (confirming) {
    const txUrl = payload?.explorerUrl && confirming.txHash
      ? `${payload.explorerUrl}/tx/${confirming.txHash}`
      : '';
    return (
      <div className="admin-card payInstr">
        <h2 className="admin-h">Confirming your payment</h2>
        <p>
          <strong>{quote.amountDisplay}</strong> is on its way on{' '}
          <strong>{quote.chainName}</strong>. We are waiting for{' '}
          {quote.minConfirmations} confirmations, then your plan starts automatically.
        </p>

        {/* A moving number is the difference between "working" and "stuck". */}
        <dl className="payInstrGrid">
          <dt>Status</dt>
          <dd>
            {progress ? (
              <>
                <span className="mono">
                  {progress.confirmations} of {progress.minConfirmations}
                </span>{' '}
                confirmations
                {progress.minConfirmations > progress.confirmations ? (
                  <span className="admin-note">
                    {' '}
                    — {progress.minConfirmations - progress.confirmations} to go
                  </span>
                ) : null}
              </>
            ) : (
              <>
                Waiting for the transaction to appear on chain…{' '}
                <span className="mono">{elapsed}s</span>
              </>
            )}
          </dd>

          {txUrl ? (
            <>
              <dt>Transaction</dt>
              <dd>
                <a href={txUrl} target="_blank" rel="noreferrer noopener">
                  View on the block explorer
                </a>
              </dd>
            </>
          ) : null}
        </dl>

        <p className="admin-note">
          You do not need to stay here or pay again — this page updates itself, and the payment applies
          on its own either way.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="admin-card">
        <h2 className="admin-h">Payment sent</h2>
        <p>{done}</p>
        <p className="admin-note">
          Confirmation takes a few minutes. You can leave this page — nothing is lost, and you will not
          need to pay again.
        </p>
      </div>
    );
  }

  return (
    <div className="admin-card payInstr">
      <h2 className="admin-h">Pay with {quote.tokenSymbol}</h2>

      {/* THE INSTRUCTION IS ITS OWN PARAGRAPH, and the reassurance is a separate
          one. They were a single `<p>` with the explanation as an inline
          `.admin-note` span, so the muted text continued mid-line from the bold
          sentence and the whole thing read as one eight-line block on a phone
          with a colour change in the middle of it. Same words; the sentence you
          must read to act is now the only thing on the first line. */}
      <p className="payLead">
        Pay <strong>{quote.amountDisplay}</strong> on <strong>{quote.chainName}</strong> by
        signing a message in your wallet.
      </p>

      {/* The reassurance is the point: signing is safer than sending. */}
      <p className="admin-note">
        You are not sending a transfer — you authorize this exact amount, once, and the token moves it.
        The amount and the destination are inside what you sign, so neither can be changed afterwards.
      </p>

      {/* The one real constraint, stated before they try. */}
      <p className="admin-note">
        This needs a self-custody wallet (MetaMask, Coinbase Wallet, Ledger…). It cannot be paid from an
        exchange balance — a withdrawal carries no signature, so there would be nothing to match it to
        your account.
      </p>

      {/* THE NETWORK PICKER. Only when there is a real choice — a single option is
          not a decision, and a dropdown with one entry just asks the customer to
          confirm something they cannot change. With USDC on several chains, this is
          the difference between paying and being told you have no funds on a chain
          you never picked. */}
      {networks.length > 1 ? (
        <div className="payInstrGrid">
          <dt>Pay on</dt>
          <dd>
            <select
              className="admin-input"
              value={quote.chainId}
              disabled={Boolean(busy)}
              onChange={(e) => void switchNetwork(Number(e.target.value))}
            >
              {networks.map((n) => (
                <option key={n.chainId} value={n.chainId}>
                  {n.tokenSymbol} on {n.chainName}
                </option>
              ))}
            </select>
            {/* A DIV, not the inline span it was. Beside a `<select>` the hint
                flowed as inline text around it, so the line broke wherever the
                select happened to end — "…you hold USDC" next to the control and
                a dangling "on." on the line below it. Below the control it is a
                caption, which is what it is. */}
            <div className="admin-note">Choose the network you hold {quote.tokenSymbol} on.</div>
          </dd>
        </div>
      ) : null}

      {/* WHICH WALLET. Without this the panel reads "this wallet holds 0 USDC" for
          an account the customer cannot identify — they may have several, and the
          browser chose one for them. Shown as label + short address, with the way
          out right next to it. */}
      {wallet ? (
        <div className="payInstrGrid">
          <dt>Wallet</dt>
          <dd>
            {wallet.label} · <span className="mono">{shortAddress(wallet.address)}</span>
            <button
              className="admin-btn"
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void useAnotherWallet()}
              style={{ marginLeft: '0.75rem' }}
            >
              Use a different wallet
            </button>
          </dd>
        </div>
      ) : null}

      {error ? <p className="payInstrWarn">{error}</p> : null}

      {!payload ? (
        <>
          <button
            className="admin-btn primary"
            disabled={Boolean(busy)}
            onClick={() => void preparePayment()}
          >
            {busy || 'Prepare payment'}
          </button>
          {slow ? (
            <p className="admin-note">
              Still waiting for the wallet picker. If nothing opened, check that your wallet extension is
              unlocked and that no other wallet popup is already waiting behind this window.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <dl className="payInstrGrid">
            <dt>Amount</dt>
            <dd className="payInstrAmount">{payload.amountDisplay}</dd>

            <dt>Network</dt>
            <dd>{payload.chainName}</dd>

            <dt>Paying from</dt>
            <dd className="mono">{payload.typedData.message.from}</dd>

            {payload.balanceDisplay ? (
              <>
                <dt>Wallet balance</dt>
                <dd>{payload.balanceDisplay}</dd>
              </>
            ) : null}

            <dt>Paying to</dt>
            <dd className="mono">{payload.treasuryAddress}</dd>
          </dl>

          {!payload.relayed ? (
            <p className="admin-note">
              Your wallet will ask you to sign, then to send the transaction — you pay the network fee.
            </p>
          ) : (
            <p className="admin-note">You only need to sign. We cover the network fee.</p>
          )}

          <button className="admin-btn primary" disabled={Boolean(busy)} onClick={() => void sign()}>
            {busy || `Sign and pay ${payload.amountDisplay}`}
          </button>
        </>
      )}
    </div>
  );
}
