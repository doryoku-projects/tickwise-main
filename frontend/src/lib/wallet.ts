/**
 * The wallet half of the sign-in handshake, on Web3-Onboard (MIT, no account).
 *
 * Scope note: this module decides WHICH WALLETS CAN CONNECT and hands back the
 * EIP-1193 provider they answered on. It authenticates nobody. The session is
 * the customer JWT the backend mints after recovering a signature over its OWN
 * stored message (see components/auth/SsoPanel.tsx) — a connected wallet only
 * means an extension replied, not that anyone proved they hold the key.
 *
 * Framework-free on purpose: React reaches it through
 * components/providers/WalletProvider.tsx. Every Web3-Onboard import is a
 * dynamic `import()` inside a function, which keeps the whole stack (svelte
 * views, wallet SDKs, icons) out of the static graph — no page pays for it
 * until someone actually asks for a wallet, and nothing touches `window` or
 * `indexedDB` during the server render.
 */

import type {
  EIP1193Provider,
  InitOptions,
  OnboardAPI,
  WalletState,
} from '@web3-onboard/core';

/** One entry of the `wallets` array Web3-Onboard is initialised with. */
type WalletModule = InitOptions['wallets'][number];

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Optional, and inlined at build time. WalletConnect is the ONE module in this
 * stack that still needs a hosted account (cloud.walletconnect.com, i.e. Reown),
 * so it is opt-in rather than required. Empty is a fully supported build:
 * browser-extension and Coinbase wallets connect with no configuration at all
 * and the sign-in button behaves identically. Setting it later adds mobile
 * wallets (QR / deep link) and Ledger, which routes over WalletConnect v2.
 */
const WALLETCONNECT_PROJECT_ID = (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '').trim();

/**
 * The chains a connected wallet may be asked to operate on.
 *
 * TWO SETS, and the distinction matters even though they now OVERLAP. Ethereum,
 * Arbitrum One and Avalanche are the chains this product INDEXES. The rest are
 * the chains it is PAID on — every chain in the backend's
 * `PAYMENT_TOKEN_REGISTRY`, where USDC implements EIP-3009. Keep them in step
 * with that table. Arbitrum One (42161) has been BOTH since 2026-08-19, so
 * removing it from the payment set on the strength of it being indexed, or the
 * reverse, breaks the other use.
 *
 * Payment chains cannot be omitted just because the API has no data for them.
 * This array is what the WalletConnect module turns into `optionalChains`, i.e.
 * the session namespace it negotiates — and a chain outside that namespace is one
 * a strict wallet will refuse to switch to or send on. The pay panel then asks
 * for a switch that cannot be granted, having already been quoted on that chain.
 *
 * These RPCs serve the connect UI alone (chain labels, the "switch network"
 * prompt, the balance Web3-Onboard shows beside an account). Neither sign-in nor
 * paying touches them: `personal_sign` and `eth_signTypedData_v4` are answered by
 * the wallet, and every read the payment rail depends on is made server-side
 * against the backend's own `EVM_RPC_URLS`. All keyless public infrastructure on
 * purpose — demanding an Infura/Alchemy key here would reintroduce exactly the
 * hosted dependency this stack exists to avoid.
 */
const CHAINS: InitOptions['chains'] = [
  // Indexed.
  { id: '0x1', token: 'ETH', label: 'Ethereum', rpcUrl: 'https://ethereum-rpc.publicnode.com' },
  { id: '0xa86a', token: 'AVAX', label: 'Avalanche', rpcUrl: 'https://api.avax.network/ext/bc/C/rpc' },
  // Paid on. Mirrors PAYMENT_TOKEN_REGISTRY / PAYMENT_CHAIN_NAMES in the backend.
  { id: '0x2105', token: 'ETH', label: 'Base', rpcUrl: 'https://mainnet.base.org' },
  // Indexed AND paid on.
  { id: '0xa4b1', token: 'ETH', label: 'Arbitrum One', rpcUrl: 'https://arb1.arbitrum.io/rpc' },
  { id: '0xa', token: 'ETH', label: 'Optimism', rpcUrl: 'https://mainnet.optimism.io' },
  { id: '0x89', token: 'POL', label: 'Polygon', rpcUrl: 'https://polygon-rpc.com' },
];

/**
 * Rendered inline by Web3-Onboard's modal and base64'd into a data URI by the
 * Coinbase SDK, so it has to be a self-contained SVG string. `currentColor` is
 * the only paint it names — inline it inherits the modal's text colour (our own
 * `--text`, set below), and inside the data URI it degrades to the sheet's own
 * default rather than pinning a hex that would fight one of the two themes.
 */
const APP_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="9" r="5.2"/><circle cx="15" cy="15" r="5.2"/></svg>';

/**
 * Elements the wallet stack appends to `<body>` and paints its own UI in.
 *
 * Exported because ANY overlay of ours has to know about them. Two ways to break
 * paying, both found the hard way:
 *
 *  - Z-ORDER. Web3-Onboard mounts `<onboard-v2>` on `document.body` with
 *    `style="all: initial"` and renders the picker inside a shadow root at
 *    `z-index: var(--onboard-modal-z-index, var(--modal-z-index))`, where
 *    `--modal-z-index` defaults to **10**. Nothing between it and the root creates
 *    a stacking context, so a dialog of ours at a higher z-index buries the picker
 *    under its own backdrop and swallows every click on it. See
 *    `--onboard-modal-z-index` in site.css.
 *  - `inert`. An overlay that walks up to `<body>` marking off-path siblings inert
 *    will mark these too if they already exist — and `inert` crosses into the
 *    shadow root, so the picker paints on top and still cannot be clicked.
 *
 * WalletConnect's own QR modal (`<w3m-modal>`, from @walletconnect/modal) is here
 * for the same reasons; it is a sibling of `<onboard-v2>`, not a child.
 */
export const WALLET_OVERLAY_TAGS: readonly string[] = ['ONBOARD-V2', 'W3M-MODAL', 'WCM-MODAL'];

/** A wallet that answered, narrowed to the shape the handshake needs. */
export interface ConnectedWallet {
  address: `0x${string}`;
  /** The raw EIP-1193 provider — `personal_sign` goes straight down this. */
  provider: EIP1193Provider;
  /** Human name of the wallet ("MetaMask", "Coinbase Wallet"). */
  label: string;
}

/** Set once the stack has booted, so `disconnect` needn't boot it to tear down. */
let api: OnboardAPI | null = null;
let booting: Promise<OnboardAPI> | null = null;

/**
 * Where Web3-Onboard persists the label(s) of the wallet it last connected.
 *
 * Now only ever CLEARED, never relied on: with `autoConnectLastWallet` off (see
 * `boot`) core neither writes nor reads it, so this exists to erase what earlier
 * builds left behind — a browser still holding `["WalletConnect"]` from before
 * that change must not be able to resurrect the unprompted-QR behaviour.
 *
 * Mirrors `STORAGE_KEYS.LAST_CONNECTED_WALLET` in @web3-onboard/core; the module
 * does not export it, and a key we fail to clear is now inert anyway.
 */
const LAST_WALLET_KEY = 'onboard.js:last_connected_wallet';

/**
 * The wallet modules offered in the picker.
 *
 * Everything in the default set is account-free. WalletConnect is added only
 * when a project id is configured — and Ledger rides along with it, because
 * `@web3-onboard/ledger` v2 is a WalletConnect v2 client and THROWS on init
 * without a project id. With no id a Ledger still connects through the Ledger
 * browser extension, which `injected` picks up like any other provider.
 */
async function walletModules(): Promise<WalletModule[]> {
  const [injected, coinbase] = await Promise.all([
    import('@web3-onboard/injected-wallets'),
    import('@web3-onboard/coinbase'),
  ]);

  const modules: WalletModule[] = [
    injected.default(),
    // `eoaOnly`, NOT `all`. `all` also offers Coinbase SMART WALLET, which is a
    // contract account (ERC-4337): it has no private key, so it signs via
    // ERC-1271/6492 and produces a signature that plain `ecrecover` cannot
    // verify. Our SIWE verifier is viem's ROOT `verifyMessage` — pure ecrecover,
    // no contract call — so every Smart Wallet sign-in would fail verification
    // AFTER the user approved it, which reads as "the site is broken" rather than
    // as an unsupported wallet.
    //
    // Supporting it for real is a project, not a flag: a viem public client, the
    // client-based `verifyMessage`, a much larger signature size cap, per-chain
    // configuration, and this backend's FIRST outbound RPC dependency on the
    // login path. Offering only what we can verify is the honest state until then.
    coinbase.default({ supportedWalletType: 'eoaOnly' }),
  ];

  if (WALLETCONNECT_PROJECT_ID) {
    const [walletConnect, ledger] = await Promise.all([
      import('@web3-onboard/walletconnect'),
      import('@web3-onboard/ledger'),
    ]);
    const chainIds = CHAINS.map((chain) => Number(chain.id));
    modules.push(
      walletConnect.default({
        projectId: WALLETCONNECT_PROJECT_ID,
        dappUrl: window.location.origin,
        optionalChains: chainIds,
      }),
      ledger.default({
        walletConnectVersion: 2,
        projectId: WALLETCONNECT_PROJECT_ID,
        requiredChains: chainIds,
      }),
    );
  }

  return modules;
}

/**
 * Web3-Onboard resolves an ENS name for the connected account whenever the
 * wallet sits on a chain ENS supports. Nothing in this product uses that name —
 * the handshake needs the address and nothing else — and @web3-onboard/core
 * 2.24 has no init option to turn the lookup off: `getEns()` fires for any
 * ENS-capable id present in the `chains` array, and buries the failure in a
 * bare `console.error` inside its own catch, where no caller can reach it.
 *
 * The lookup cannot succeed either. `getEns` builds its viem client with
 * `http()` and NO url, so it ignores the `rpcUrl` configured above and talks to
 * viem's own default mainnet endpoint against a universal-resolver address that
 * reverts there — every mainnet connect logs
 * `ContractFunctionExecutionError: contract "reverse" reverted`.
 *
 * Dropping `0x1` from `chains` would stop it at the source, but that same array
 * is what the Coinbase module turns into `appChainIds`, so it would quietly
 * declare this app Avalanche-only to Coinbase Wallet.
 *
 * So the message is dropped where it is emitted, by signature and nothing else:
 * a single `console.error` call carrying a viem contract error for the ENS
 * `reverse` call. Every other argument — including every other viem error — is
 * forwarded untouched. This is deliberately NOT a blanket error swallow: it can
 * only ever discard a value the library itself has already thrown away.
 */
let ensNoiseSilenced = false;

function isEnsReverseFailure(value: unknown): boolean {
  if (!(value instanceof Error)) return false;
  return /^ContractFunction/.test(value.name) && /\breverse\b/.test(value.message);
}

/**
 * `console.error({})` — an argument that carries NO INFORMATION AT ALL.
 *
 * The WalletConnect stack emits these while a session is being torn down or
 * restored. There is nothing in one to read, log or act on: a plain object with no
 * own enumerable keys.
 *
 * Dropping them matters more than it looks, because of what wrapping
 * `console.error` costs us. Next.js's dev overlay counts EVERY `console.error`
 * (measured: the badge goes 0 → 1 → 2 for two calls) and decides where to point
 * by the first non-ignore-listed stack frame. A library error normally has none —
 * every frame is in `node_modules`. Forwarded through the wrapper below, OUR frame
 * is the app frame, so each one is surfaced as a "Console Error" attributed to
 * this file. Six of them turned into six issues reading `{}` at `wallet.ts`.
 *
 * NARROW BY CONSTRUCTION. An `Error` is excluded even though its own enumerable
 * keys are also empty — its `message` is exactly the information this test is
 * looking for the absence of. So is anything with a prototype other than
 * `Object.prototype`: a class instance may look empty and still have getters.
 */
function isInformationFree(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (value instanceof Error) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.keys(value).length === 0;
}

function silenceEnsLookupNoise(): void {
  if (ensNoiseSilenced || typeof window === 'undefined') return;
  ensNoiseSilenced = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (args.length === 1) {
      if (isEnsReverseFailure(args[0])) return;
      if (isInformationFree(args[0])) return;
      // WalletConnect logs its dead-session failures here as well as rejecting
      // with them. Same value, same verdict — see `isDeadWalletSession`.
      if (isDeadWalletSession(args[0])) return;
    }
    original(...args);
  };
}

/**
 * Whether an error is a WalletConnect session that is no longer usable.
 *
 * RECOVERABLE, and that is the whole reason it has a name: the cure is to
 * re-attach (or re-pair) and try again, so it must be told apart from a real
 * failure rather than shown to a customer. It happens routinely on MOBILE —
 * a provider handle outlives the session, so a `request()` made minutes later, at
 * signing time, hits a socket that is gone.
 *
 * The last pattern is a TYPE ERROR, not a message, and it belongs here:
 * @walletconnect/universal-protocol's accessor is
 * `getProvider(e) { return this.rpcProviders[e] || this.rpcProviders[GENERIC] }` —
 * it returns `undefined` rather than throwing, and `request()` then does
 * `await this.getProvider(n).request(…)` guarded only by a truthy `this.session`.
 * A session that is present but has no rpcProvider for its namespace therefore
 * fails as `Cannot read properties of undefined (reading 'request')`. That is the
 * same half-alive session in a different costume, and left unmatched it reaches a
 * paying customer as raw JavaScript.
 */
export function isDeadWalletSession(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    /call connect\(\) before request\(\)/i.test(message) ||
    /no matching key/i.test(message) ||
    /session topic (doesn't exist|does not exist)/i.test(message) ||
    /record was recently deleted/i.test(message) ||
    /reading 'request'/.test(message)
  );
}

/**
 * Stops WalletConnect's OWNERLESS dead-session rejections from surfacing as
 * application errors.
 *
 * These are not our errors and no caller can catch them. Two library paths fire an
 * async call and drop the promise:
 *
 *   @walletconnect/sign-client's `onSessionEventRequest` calls the ASYNC
 *   `isValidEmit(…)` with no `await` inside its own try block, so when an inbound
 *   relay message arrives on a topic with no session row, `isValidSessionTopic`
 *   throws "No matching key. session topic doesn't exist: …" past the catch.
 *
 *   @walletconnect/ethereum-provider's `switchEthereumChain(t) {
 *   this.request({ method: 'wallet_switchEthereumChain', … }) }` — no `await`, no
 *   `.catch` — so anything it rejects with, including the `undefined.request`
 *   TypeError above, is unhandled by construction.
 *
 * Both reach the browser as `unhandledrejection`.
 *
 * WHAT THIS DOES NOT DO, measured: it does NOT remove the entry from Next.js's dev
 * overlay. Next registers its own `unhandledrejection` listener when the app
 * bootstraps — long before `boot()` runs — and `preventDefault()` suppresses the
 * BROWSER's default reporting, not other listeners; `stopImmediatePropagation()`
 * cannot help either, since it only blocks listeners added after ours. Verified by
 * probe: our handler runs and `defaultPrevented` is true, and the overlay's issue
 * count still goes up. What it does buy is a quiet browser console and, in
 * production, an error reporter that is not fed a library's discarded rejection.
 * The only real cure for the overlay entry is not having a stale session — see
 * `resetWalletConnectSession`.
 *
 * NARROW, and in the same spirit as `silenceEnsLookupNoise`: it discards only a
 * rejection the library ITSELF already threw away, it requires the message to
 * match `isDeadWalletSession`, and — because that last TypeError pattern is
 * generic enough to belong to somebody else's bug — it additionally requires a
 * WalletConnect frame in the stack. Anything else propagates untouched. It never
 * suppresses a rejection from a promise we awaited: those are returned to our own
 * `catch` blocks and never become `unhandledrejection` at all.
 */
let deadSessionNoiseSilenced = false;

function looksLikeWalletConnectFrame(err: unknown): boolean {
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  return /walletconnect|universal-provider|ethereum-provider|sign-client/i.test(stack);
}

function silenceDeadSessionNoise(): void {
  if (deadSessionNoiseSilenced || typeof window === 'undefined') return;
  deadSessionNoiseSilenced = true;
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    if (!isDeadWalletSession(reason)) return;
    // A bare message match is enough for the WalletConnect-specific wordings; the
    // generic TypeError has to prove where it came from.
    const message = reason instanceof Error ? reason.message : String(reason ?? '');
    if (/reading 'request'/.test(message) && !looksLikeWalletConnectFrame(reason)) return;
    event.preventDefault();
    console.warn('[wallet] discarded a dead WalletConnect session rejection:', message);
  });
}

/** Loads and initialises Web3-Onboard. Called once; see `onboard()`. */
async function boot(): Promise<OnboardAPI> {
  // Installed with the stack, not with the app: a page that never offers a
  // wallet never touches `console` or `unhandledrejection`.
  silenceEnsLookupNoise();
  silenceDeadSessionNoise();
  const [{ init }, wallets] = await Promise.all([import('@web3-onboard/react'), walletModules()]);

  api = init({
    wallets,
    chains: CHAINS,
    appMetadata: {
      name: 'Tickwise',
      icon: APP_ICON,
      description: 'Uniswap v4 liquidity position data API',
      // Shown instead of an empty list when no extension is detected. Web3-Onboard
      // would otherwise fall back to a generic ethereum.org link.
      recommendedInjectedWallets: [
        { name: 'MetaMask', url: 'https://metamask.io' },
        { name: 'Rabby', url: 'https://rabby.io' },
      ],
    },
    // The modal lives in a shadow root inside <body>, and custom properties
    // inherit into it — so pointing these at our own tokens makes the picker
    // follow the site's light/dark toggle with no theme plumbing of our own.
    theme: {
      '--w3o-background-color': 'var(--panel)',
      '--w3o-foreground-color': 'var(--panel-2)',
      '--w3o-text-color': 'var(--text)',
      '--w3o-border-color': 'var(--line)',
      '--w3o-action-color': 'var(--tk-accent)',
      '--w3o-border-radius': '12px',
      '--w3o-font-family': 'var(--mono)',
    },
    // Don't fetch Inter from a CDN: a third-party request on the sign-in page,
    // for a font the line above already overrides.
    disableFontDownload: true,
    // No floating account widget. This app has exactly one wallet interaction —
    // signing in — and a persistent balance bubble on every screen isn't it.
    accountCenter: { desktop: { enabled: false }, mobile: { enabled: false } },
    connect: {
      // `autoConnectLastWallet` IS DELIBERATELY OFF. DO NOT TURN IT BACK ON.
      //
      // It opened a WalletConnect QR modal ON PAGE LOAD, with no click. Confirmed
      // by loading /login with nothing but `onboard.js:last_connected_wallet` set
      // to `["WalletConnect"]`: a full-screen "Scan this QR Code with your phone"
      // appeared over the page.
      //
      // The mechanism is in @web3-onboard/core's `init`, which FIRES AND FORGETS
      // `connectWallet({ autoSelect: { label, disableModals: true } })`. That flag
      // suppresses ONBOARD's picker; it has no reach into the wallet module, and
      // @web3-onboard/walletconnect hardcodes `showQrModal: true`. So when the
      // stored label is WalletConnect and the WC session is gone — expired, or the
      // customer never finished pairing — the module starts a fresh pairing and
      // WalletConnect shows its own QR, unprompted.
      //
      // It is also a RACE, which is the shape the bug was reported in: that
      // auto-connect is un-awaited, so a customer clicking "Prepare payment"
      // before it settles gets a SECOND `connectWallet` — a second
      // `EthereumProvider.init`, a second pairing, and a second QR that appears
      // right after they finished scanning the first one.
      //
      // Persistence across a refresh is NOT lost by turning this off — it is
      // provided by `restoreWallet()` instead, which does the same job under
      // conditions that make an unprompted QR impossible. Re-enabling this would
      // add a second, uncontrolled restorer alongside it.
      autoConnectLastWallet: false,
      // Drop Web3-Onboard's explainer sidebar. It carries a third-party "powered
      // by" badge we are not going to put on our own sign-in screen, and its
      // copy is aimed at someone's first ever wallet — not at the audience for a
      // liquidity-data API. Without it the modal is just the wallet list.
      showSidebar: false,
      // The "Why don't I see my wallet?" notice is painted in a fixed cream and
      // amber that belongs to neither of our themes and cannot be re-themed
      // through the seven variables Web3-Onboard exposes. The recommended-wallet
      // list above covers the same case on palette.
      removeWhereIsMyWalletWarning: true,
    },
  });

  return api;
}

/**
 * The initialised stack, booting it on first use. Idempotent; a failed boot is
 * NOT cached, so one bad chunk load can't disable the button for the session.
 */
function onboard(): Promise<OnboardAPI> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('A wallet can only be reached in the browser'));
  }
  if (!booting) {
    booting = boot().catch((err: unknown) => {
      booting = null;
      throw err;
    });
  }
  return booting;
}

/**
 * Loads the wallet stack ahead of the first click so the picker opens without a
 * spinner. Call it from a screen that is ABOUT to offer a wallet, not from every
 * page. Safe to call repeatedly, and never throws — a warm-up failure surfaces
 * on the click that needs it.
 */
export function prepareWallet(): void {
  if (typeof window === 'undefined') return;
  void onboard().catch(() => {});
}

/** In-flight `connectWallet()`, so overlapping callers share one attempt. */
let connecting: Promise<ConnectedWallet | null> | null = null;

/**
 * Opens the wallet picker and resolves with the connected wallet, or `null` if
 * it was dismissed. `null` is a CANCEL, not an error — callers must not raise a
 * banner for it.
 *
 * SINGLE-FLIGHT, and not merely as an optimisation. Two overlapping connects mean
 * two `EthereumProvider.init` calls inside @web3-onboard/walletconnect, which is
 * two SEPARATE PAIRINGS and two QR modals — the customer scans one and is handed
 * another. Overlap is easy to reach: `SignToPay` connects from "Prepare payment",
 * from "Use a different wallet", and again from `withLiveWallet` when a dead
 * WalletConnect session has to be re-attached at signing time.
 */
export function connectWallet(): Promise<ConnectedWallet | null> {
  if (!connecting) {
    // BOUNDED, because @web3-onboard/core can leave `connectWallet()` PENDING
    // FOREVER and a latch on a promise that never settles wedges every later
    // attempt. In `index-6ae5acf7.js` around line 8039 the connect flow does
    // `const [connectedAddress] = await requestAccounts(provider); if
    // (!connectedAddress) { return }` — that early return happens BEFORE
    // `addWallet`/`trackWallet` and without pushing `inProgress: false`, while
    // core's `connect()` ends in `return firstValueFrom(result$)` waiting for
    // exactly that push. An empty account list therefore hangs, and
    // WalletConnect produces one: `loadPersistedSession` trusts the persisted
    // chainId and `setAccounts` filters the session's accounts down to it, so a
    // restored session whose approved chains no longer include that chain
    // resolves `eth_requestAccounts` with `[]`.
    //
    // Without the cap the panel sits on "Waiting for your wallet…" with every
    // button disabled until a reload — the latch hands the same pending promise
    // to the next "Prepare payment", to "Use a different wallet", and to
    // `withLiveWallet`'s retry. The cap is deliberately long: a real customer is
    // scanning a QR on a phone and then approving in a wallet app.
    connecting = withTimeout(openWallet(), CONNECT_TIMEOUT_MS);
    // Releases the latch once it settles WITHOUT replacing the shared promise,
    // so every caller still sees the same result (or the same rejection).
    void connecting
      .catch(() => {
        // A connect that FAILED — not one the customer dismissed, which resolves
        // `null` — is the signature of a half-alive WalletConnect session: the
        // timeout above fires precisely when a restored session yields no
        // accounts. Leaving it in storage means the next attempt restores it and
        // fails the same way, so drop it and let the retry re-pair.
        void resetWalletConnectSession();
      })
      .then(() => {
        connecting = null;
      });
  }
  return connecting;
}

/**
 * How long a single connect attempt may hang before we give the customer an
 * error they can act on. Long enough for a QR scan plus a wallet approval.
 */
const CONNECT_TIMEOUT_MS = 3 * 60 * 1000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          'Your wallet did not finish connecting. If you were reconnecting a mobile wallet, ' +
            'its saved session may have expired — use "Use a different wallet" to start a fresh ' +
            'connection.',
        ),
      );
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

async function openWallet(): Promise<ConnectedWallet | null> {
  // NEVER RACE A RESTORE. `restoreWallet()` may already be re-attaching silently;
  // starting a second `connectWallet()` alongside it is two `EthereumProvider.init`
  // calls, two pairings and two QR modals. Waiting costs nothing on the happy path
  // — if the restore succeeds, the `attached` check below returns its wallet with
  // no picker at all.
  if (restoring) await restoring.catch(() => undefined);
  const onboardApi = await onboard();
  // Reuse a wallet that is already attached rather than putting a picker in front
  // of someone who has already chosen — `connectWallet()` opens the modal either
  // way, and for WalletConnect "opens the modal" can mean a new pairing QR.
  const attached = firstEvmWallet(onboardApi.state.get().wallets);
  if (attached) return attached;
  return rememberLabel(firstEvmWallet(await onboardApi.connectWallet()));
}

/** In-flight `restoreWallet()`, so an explicit connect can wait rather than race. */
let restoring: Promise<ConnectedWallet | null> | null = null;

/**
 * How long a SILENT re-attach may take before we stop waiting.
 *
 * Far shorter than `CONNECT_TIMEOUT_MS`, because nobody is scanning anything: this
 * path either finds a live session and resolves in milliseconds, or it is stuck and
 * the customer should be looking at "Prepare payment" instead of a spinner.
 */
const RESTORE_TIMEOUT_MS = 8 * 1000;

/**
 * Re-attach the wallet used last time, WITHOUT ever showing a picker or a QR.
 *
 * Why this exists rather than Web3-Onboard's `autoConnectLastWallet`: that option
 * is global and, for a WalletConnect label with no live session, opens a QR on bare
 * page load (see the `connect` block in `boot`). This does the same job under our
 * own conditions, and the conditions are the entire point:
 *
 *  - We persist the label ourselves (`LAST_LABEL_KEY`), because with the option off
 *    core does not write its own — the persist at `index-6ae5acf7.js:8049` is gated
 *    on exactly that flag.
 *  - For a wallet that pairs over WalletConnect we FIRST prove a usable session is
 *    already in storage (`hasLiveWalletConnectSession`). The QR appears precisely
 *    when the module finds `connector.session` falsy, and that value comes from the
 *    same storage we are reading — so no stored session means no attempt.
 *  - Nothing here is triggered by a user gesture, so it must never be able to
 *    prompt. `disableModals` keeps Onboard's own picker shut; the session check is
 *    what keeps WalletConnect's shut.
 *
 * Resolves `null` for every "not now" — no label, no live session, an unusable
 * account — and never throws. A failed restore is not an error state; it just means
 * the customer presses the button.
 */
export function restoreWallet(): Promise<ConnectedWallet | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (connecting) return connecting;
  if (!restoring) {
    restoring = withTimeout(reattachLastWallet(), RESTORE_TIMEOUT_MS).catch(() => {
      // A restore that THREW or timed out was working from state the library will
      // not accept. Forget it on both sides, because otherwise every later page
      // load repeats the same doomed attempt — and each one delays the customer's
      // first click by the whole timeout, since `openWallet` waits for an in-flight
      // restore rather than racing it. Dropping a session that might merely have
      // been slow costs one QR scan; leaving this in costs every load.
      forgetLabel();
      void resetWalletConnectSession();
      return null;
    });
    void restoring.then(() => {
      restoring = null;
    });
  }
  return restoring;
}

async function reattachLastWallet(): Promise<ConnectedWallet | null> {
  const label = readLabel();
  if (!label) return null;

  if (QR_PAIRING_LABELS.has(label) && !(await hasLiveWalletConnectSession())) {
    // Stale label, no session to stand it up. Forget it so we stop trying, and let
    // the customer's next click do a clean pairing.
    forgetLabel();
    return null;
  }

  const onboardApi = await onboard();
  const attached = firstEvmWallet(onboardApi.state.get().wallets);
  if (attached) return attached;
  const restored = firstEvmWallet(
    await onboardApi.connectWallet({ autoSelect: { label, disableModals: true } }),
  );
  if (!restored) forgetLabel();
  return restored;
}

/**
 * Wallets whose "reconnect" can start a NEW PAIRING and put a QR on screen.
 *
 * `@web3-onboard/ledger` v2 is a WalletConnect v2 client, which is why it is here
 * next to WalletConnect itself. Labels are the strings the modules report.
 */
const QR_PAIRING_LABELS = new Set(['WalletConnect', 'Ledger']);

/**
 * Whether WalletConnect already holds a session worth re-attaching to.
 *
 * Read straight out of its IndexedDB rather than by booting the provider, because
 * booting it IS the thing that can show a QR. Three conditions, and the third is
 * the one that matters:
 *
 *  - unexpired, with a minute of headroom so we do not restore something that dies
 *    mid-payment (`engine.init`'s `cleanup()` deletes expired rows, which would
 *    leave `connector.session` falsy → QR);
 *  - `acknowledged`, which is false for a session that was proposed and approved
 *    but never SETTLED — exactly the orphan that produces "No matching key. session
 *    topic doesn't exist", and exactly what we must not try to restore;
 *  - its topic present in the KEYCHAIN, because `engine.init` → `cleanup()` deletes
 *    any session whose topic is not there. A session row that passes the first two
 *    tests and fails this one is deleted during init, which lands us right back at
 *    `!connector.session` and a QR. Mirroring the library's own precondition is
 *    what makes this gate hold by construction rather than by hope.
 *
 * Any read failure answers `false`: the safe direction is always "don't try".
 */
async function hasLiveWalletConnectSession(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') return false;
  try {
    const db = await openWalletConnectDb();
    if (!db) return false;
    try {
      if (!Array.from(db.objectStoreNames).includes(WC_STORE)) return false;
      const raw = await idbGet(db, WC_STORE, WC_SESSION_KEY);
      const sessions: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(sessions)) return false;

      const floor = Date.now() + 60_000;
      const usable = sessions.filter((session: unknown) => {
        if (typeof session !== 'object' || session === null) return false;
        const { expiry, acknowledged } = session as { expiry?: unknown; acknowledged?: unknown };
        return typeof expiry === 'number' && expiry * 1000 > floor && acknowledged === true;
      });
      if (usable.length === 0) return false;

      const keychainRaw = await idbGet(db, WC_STORE, WC_KEYCHAIN_KEY);
      const keychain: unknown = typeof keychainRaw === 'string' ? JSON.parse(keychainRaw) : keychainRaw;
      if (typeof keychain !== 'object' || keychain === null) return false;
      const keyed = new Set(Object.keys(keychain as Record<string, unknown>));
      return usable.some((session) => {
        const { topic } = session as { topic?: unknown };
        return typeof topic === 'string' && keyed.has(topic);
      });
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

const WC_STORE = 'keyvaluestorage';
const WC_SESSION_KEY = 'wc@2:client:0.3:session';
const WC_KEYCHAIN_KEY = 'wc@2:core:0.3:keychain';

/**
 * Opens WalletConnect's database WITHOUT creating it.
 *
 * `indexedDB.open(name)` with no version creates an empty database when none
 * exists, which would leave a stray one behind on every page load for a customer
 * who has never used WalletConnect. `databases()` first avoids that.
 */
async function openWalletConnectDb(): Promise<IDBDatabase | null> {
  const list = await window.indexedDB.databases?.().catch(() => []);
  if (list && !list.some((entry) => entry.name === WC_DB)) return null;
  return new Promise<IDBDatabase | null>((resolve) => {
    const request = window.indexedDB.open(WC_DB);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
    // An upgrade means it did not exist (or is a different version) — abandon it
    // rather than hold a transaction we did not want.
    request.onupgradeneeded = () => {
      try {
        request.transaction?.abort();
      } catch {
        /* nothing to abort */
      }
      resolve(null);
    };
  });
}

function idbGet(db: IDBDatabase, store: string, key: string): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      const request = db.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Our own record of the last wallet label.
 *
 * Separate from `LAST_WALLET_KEY`, which is @web3-onboard's and which we only ever
 * CLEAR. Keeping them apart means re-enabling core's option later cannot make the
 * two writers fight over one value.
 */
const LAST_LABEL_KEY = 'cp.wallet:last-label';

function rememberLabel(wallet: ConnectedWallet | null): ConnectedWallet | null {
  if (!wallet) return wallet;
  try {
    window.localStorage.setItem(LAST_LABEL_KEY, wallet.label);
  } catch {
    /* storage disabled — then a refresh simply asks again */
  }
  return wallet;
}

function readLabel(): string | null {
  try {
    return window.localStorage.getItem(LAST_LABEL_KEY);
  } catch {
    return null;
  }
}

function forgetLabel(): void {
  try {
    window.localStorage.removeItem(LAST_LABEL_KEY);
  } catch {
    /* nothing was persisted to begin with */
  }
}

/**
 * Detaches every attached wallet AND forgets the picker's memory of it.
 *
 * Both halves matter. `disconnectWallet` alone leaves nothing behind in THIS
 * tab — but the stack is only booted on a page that offered a wallet, so after
 * a reload `api` is null and there is nothing to disconnect while
 * `onboard.js:last_connected_wallet` still names the provider. Clearing it is now
 * belt-and-braces rather than the fix it once was (see `LAST_WALLET_KEY`), and it
 * is the reason "use a different wallet" cannot hand back the same account.
 *
 * Never throws: signing out must not be blocked by a wallet that misbehaves on
 * teardown.
 */
export async function disconnectWallet(): Promise<void> {
  const onboardApi = api;
  if (onboardApi) {
    await Promise.all(
      onboardApi.state
        .get()
        .wallets.map(({ label }) => onboardApi.disconnectWallet({ label }).catch(() => undefined)),
    );
  }
  // Unconditional, and last: core's own disconnect REWRITES the persisted list
  // rather than removing it, and `api` is null whenever the stack never booted
  // in this tab.
  forgetLastWallet();
  // OURS TOO, or `restoreWallet()` would re-attach on the next page load the very
  // wallet somebody just asked to detach — the exact behaviour "use a different
  // wallet" exists to prevent.
  forgetLabel();
  await forgetWalletConnectSession();
}

function forgetLastWallet(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LAST_WALLET_KEY);
  } catch {
    /* storage disabled — then nothing was persisted to begin with */
  }
}

/** WalletConnect v2 persists its session, keychain and subscriptions here. */
const WC_DB = 'WALLET_CONNECT_V2_INDEXED_DB';

/**
 * Erases WalletConnect's own persisted state, because DISCONNECTING DOES NOT.
 *
 * `onboardApi.disconnectWallet({ label })` resolves successfully while the
 * WalletConnect session survives. Two dropped promises on the way down:
 * @web3-onboard/core does `provider.disconnect && provider.disconnect()` without
 * awaiting, and @web3-onboard/walletconnect's own handler is
 * `if (this.connector.session) { this.connector.disconnect(); instance = null }` —
 * also un-awaited. Neither reports failure, so a disconnect that threw leaves the
 * session in IndexedDB looking live.
 *
 * A SURVIVING SESSION IS NOT INERT. What is left behind is worse than a clean
 * slate: the subscription and keychain rows outlive the session row, so on the
 * next boot the relay client re-subscribes to a topic it has no session for, and
 * the first inbound message on it makes @walletconnect/sign-client's
 * `isValidSessionTopic` throw "No matching key. session topic doesn't exist: …"
 * from an un-awaited validator — an ownerless rejection no caller can catch. The
 * same half-restored state is what resolves `eth_requestAccounts` with an empty
 * account list and hangs core's connect (see `CONNECT_TIMEOUT_MS`).
 *
 * So "use a different wallet" and signing out clear it outright. That is the
 * honest meaning of both actions, and it is the only reset available to a customer
 * who would otherwise have to be talked through a browser devtools session.
 *
 * NEVER THROWS AND NEVER HANGS. `deleteDatabase` fires `blocked` instead of
 * completing while another connection holds the database open, which is likely
 * here — the client we just asked to disconnect may still have it. A blocked
 * delete is not a failure worth propagating: the caller's next act is a fresh
 * pairing either way.
 */
/**
 * Throw away the persisted WalletConnect session so the next connect RE-PAIRS.
 *
 * The self-heal for a session that has died. Without it, detecting a dead session
 * and calling `connect()` again just restores the same corpse from IndexedDB: the
 * subscription is re-subscribed, the relay delivers on a topic with no session row,
 * and @walletconnect/sign-client throws "No matching key. session topic doesn't
 * exist" from an un-awaited validator — forever, on every attempt. Clearing first
 * is what makes the retry a genuinely new pairing.
 *
 * Safe to call when nothing is stale: the cost is one extra QR scan.
 */
export async function resetWalletConnectSession(): Promise<void> {
  await forgetWalletConnectSession();
}

async function forgetWalletConnectSession(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    for (const key of Object.keys(window.localStorage)) {
      // Older clients (and the v1 shim some wallets still use) keep theirs here.
      if (key.startsWith('wc@') || key === 'walletconnect') {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* storage disabled — then nothing was persisted to begin with */
  }

  if (typeof window.indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    // Resolves on success, error OR blocked — all three mean "stop waiting".
    const settle = () => resolve();
    const done = window.setTimeout(settle, 1500);
    const finish = () => {
      window.clearTimeout(done);
      settle();
    };
    try {
      const request = window.indexedDB.deleteDatabase(WC_DB);
      request.onsuccess = finish;
      request.onerror = finish;
      request.onblocked = finish;
    } catch {
      finish();
    }
  });
}

/** The first attached wallet exposing a usable EVM account, if any. */
function firstEvmWallet(wallets: WalletState[]): ConnectedWallet | null {
  for (const wallet of wallets) {
    for (const account of wallet.accounts) {
      const address = toEvmAddress(account.address);
      if (address) return { address, provider: wallet.provider, label: wallet.label };
    }
  }
  return null;
}

/**
 * Narrows a wallet-supplied address to the `0x…` form the API expects. Wallets
 * can hand back an account for a namespace we never asked for (or nothing at
 * all), so this is a guard and not a cast.
 */
export function toEvmAddress(value: string | null | undefined): `0x${string}` | null {
  return value && EVM_ADDRESS.test(value) ? (value as `0x${string}`) : null;
}

/** Last resort for wallets that refuse without a code — deliberately narrow. */
const REJECTED = /\buser\s+(rejected|denied|cancell?ed)\b/i;

/**
 * "The person closed the wallet prompt" — a cancel, not a failure, so callers
 * stay silent rather than raise a banner.
 *
 * A dismissed PICKER never reaches here: Web3-Onboard resolves `connectWallet()`
 * with an empty list instead of throwing, which `connectWallet` above turns into
 * `null`. What does reach here is the wallet's own refusal, and the spelling
 * varies: EIP-1193 says code 4001, Web3-Onboard raises a `ProviderRpcError`
 * carrying that code, some SDKs only set the name, and a few send nothing but a
 * message. Any of them can arrive under a wrapper, so the check walks the
 * `cause` chain.
 */
export function isUserRejection(err: unknown): boolean {
  let node: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof node !== 'object' || node === null) return false;
    const record = node as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (record.code === 4001 || record.name === 'UserRejectedRequestError') return true;
    if (typeof record.message === 'string' && REJECTED.test(record.message)) return true;
    node = record.cause;
  }
  return false;
}
