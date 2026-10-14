'use client';

/**
 * The wallet seam, mounted once at the root so any client component can reach a
 * wallet without importing the stack itself.
 *
 * It is deliberately thin. Web3-Onboard is framework-agnostic and lives behind
 * `lib/wallet.ts`, which loads it with a dynamic `import()` on first use — so
 * this provider holds no wallet state, ships no third-party code in the page's
 * first load, and does nothing at all until a screen calls `prepare()`. Keeping
 * it a component (rather than importing `lib/wallet` everywhere) is what lets
 * the root layout stay a SERVER component and gives the app one place to swap
 * the implementation again.
 *
 * Scope note: a connected wallet is NOT a session. The session is the customer
 * JWT under `tk-portal-token`, minted by the backend after it recovers a
 * signature (see components/auth/SsoPanel.tsx). Nothing here may be read as
 * "signed in".
 */

import { createContext, useContext, type ReactNode } from 'react';
import {
  connectWallet,
  disconnectWallet,
  prepareWallet,
  restoreWallet,
  type ConnectedWallet,
} from '../../lib/wallet';

export interface WalletContextValue {
  /**
   * Warms up the wallet stack ahead of the first click. Call it from a screen
   * that is ABOUT to offer a wallet, never from every page. Safe to repeat.
   */
  prepare: () => void;
  /**
   * Opens the wallet picker and resolves with the connected wallet, or `null`
   * if it was dismissed. `null` is a CANCEL — callers must not raise a banner.
   */
  connect: () => Promise<ConnectedWallet | null>;
  /**
   * Silently re-attaches the wallet used last time, or resolves `null`. NEVER
   * shows a picker or a QR, so it is safe to call from an effect on mount — that
   * is what keeps a connection across a page refresh. `null` means "not now", not
   * a failure; callers must not raise a banner.
   */
  restore: () => Promise<ConnectedWallet | null>;
  /** Detaches every connected wallet. Does not touch the portal session. */
  disconnect: () => Promise<void>;
}

// Module-scope constant: the functions are already module-level, so there is
// nothing per-render to memoise and no way for consumers to see a new identity.
const VALUE: WalletContextValue = {
  prepare: prepareWallet,
  connect: connectWallet,
  restore: restoreWallet,
  disconnect: disconnectWallet,
};

const WalletContext = createContext<WalletContextValue>(VALUE);

export function useWallet(): WalletContextValue {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  return <WalletContext.Provider value={VALUE}>{children}</WalletContext.Provider>;
}
