import type { Metadata } from 'next';
import { JetBrains_Mono, Manrope, Sora } from 'next/font/google';
// Wallet seam (Web3-Onboard, loaded on demand). It is a CLIENT component, which
// is what lets this layout stay a server component.
import { WalletProvider } from '../components/providers/WalletProvider';
import { RouteProgress } from '../components/RouteProgress';
import { ThemeProvider } from '../components/theme-provider';
import { Toaster } from '../components/ui/sonner';
// The ONE stylesheet entry. It pulls in Tailwind, the Tickwise token layer and
// — until the last route is converted — the three Tickwise stylesheets, each
// in a `legacy` cascade layer. See the header comment in app.css; do not import
// globals.css / site.css / admin/panel.css anywhere else, or they land
// unlayered and outrank every utility.
import './app.css';

/*
 * Self-hosted by next/font, which mints a scoped family name per font — so the
 * `--font-*` variables are the only way to reach them. app.css maps all three
 * onto the design system's `--font-display` / `--font-sans` / `--font-mono`.
 *
 * JetBrains is `--font-mono-jb` rather than `--font-mono`: app.css declares
 * `--font-mono` in terms of it, and a custom property defined as itself is
 * invalid CSS and would drop the whole declaration.
 */
const sora = Sora({ subsets: ['latin'], display: 'swap', variable: '--font-sora' });
const manrope = Manrope({ subsets: ['latin'], display: 'swap', variable: '--font-manrope' });
const mono = JetBrains_Mono({ subsets: ['latin'], display: 'swap', variable: '--font-mono-jb' });

export const metadata: Metadata = {
  title: {
    default: 'Tickwise — Uniswap v4 liquidity position data API',
    template: '%s · Tickwise',
  },
  description:
    'A JSON API for Uniswap v4 liquidity positions and pools on Ethereum, Arbitrum and Avalanche: fees, PnL, APR and in-range state, indexed for you.',
};

// Apply persisted theme / accent / density before first paint to avoid a flash.
// Defaults: dark mode, turquoise accent. Values are written by the Tweaks panel
// and, for the theme, by ThemeProvider — both use the same `tk-theme` key, so
// the converted and unconverted halves of the site cannot disagree.
//
// THE `cp-` → `tk-` MIGRATION RUNS FIRST, and it is not cosmetic. The rebrand
// renamed every browser-storage key, and two of them are SESSIONS
// (`cp-portal-token`, `cp-admin-token`) — without this, shipping the rename
// signs out every customer and every operator at once, and resets everyone's
// theme to dark as a bonus. Prefix-matched rather than listed, so the
// per-address `cp-otp-issued:<addr>` keys come along too. It runs here because
// this script executes BEFORE hydration, so no reader can race it, and it is
// self-erasing: once the old key is gone the loop finds nothing and costs one
// `Object.keys` on `localStorage` per load. DELETE THIS after a release or two
// — anyone who has not visited by then can sign in again.
const storageMigration = `(function(){try{
var ks=Object.keys(localStorage);
for(var i=0;i<ks.length;i++){var k=ks[i];
if(k.indexOf('cp-')!==0)continue;
var n='tk-'+k.slice(3);
if(localStorage.getItem(n)===null)localStorage.setItem(n,localStorage.getItem(k));
localStorage.removeItem(k);}
}catch(e){}})();`;

const themeBootstrap = `(function(){try{
var r=document.documentElement;
r.setAttribute('data-theme', localStorage.getItem('tk-theme')||'dark');
r.setAttribute('data-density', localStorage.getItem('tk-density')||'regular');
r.style.setProperty('--tk-accent', localStorage.getItem('tk-accent')||'#2ee6c9');
r.style.setProperty('--tk-accent-ink', localStorage.getItem('tk-accent-ink')||'#03211b');
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${sora.variable} ${manrope.variable} ${mono.variable}`}
      data-theme="dark"
      data-density="regular"
      suppressHydrationWarning
    >
      <head>
        {/* Warm up the token-logo CDN connection (DNS + TLS) before the first
            batch of <img> requests fires, so icons paint faster on load. */}
        <link rel="preconnect" href="https://token-icons.llamao.fi" crossOrigin="" />
        <link rel="dns-prefetch" href="https://token-icons.llamao.fi" />
        {/* Before the theme bootstrap, so it reads the migrated keys. */}
        <script dangerouslySetInnerHTML={{ __html: storageMigration }} />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body>
        <ThemeProvider>
          {/* Sits above everything, outside the shells, so one mount covers
              every route — see RouteProgress for why it listens for clicks
              rather than using router events. */}
          <RouteProgress />
          <WalletProvider>{children}</WalletProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
