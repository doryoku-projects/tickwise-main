import type { Metadata } from 'next';
import { PortalShell } from './PortalShell';

// A server layout purely so the portal gets a title and stays out of the index.
// Everything below it is client-rendered — the customer JWT is in localStorage.
export const metadata: Metadata = {
  title: { default: 'Dashboard', template: '%s · Tickwise' },
  robots: { index: false, follow: false },
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
