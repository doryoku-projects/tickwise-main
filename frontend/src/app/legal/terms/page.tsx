import type { Metadata } from 'next';
import { LegalPage } from '@/components/marketing/LegalPage';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description:
    'The terms of service for the Tickwise Dex API. Not yet published — this page is an explicit placeholder, not a summary of terms in force.',
  // Nothing to index while the document is a stub, and a search result
  // promising "Terms of Service — Tickwise" that lands on a placeholder is a
  // worse outcome than no result at all.
  robots: { index: false, follow: true },
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      subject="What you may do with the API, what we commit to, and how either side ends the arrangement."
    />
  );
}
