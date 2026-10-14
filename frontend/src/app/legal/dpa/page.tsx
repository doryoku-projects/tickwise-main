import type { Metadata } from 'next';
import { LegalPage } from '@/components/marketing/LegalPage';

export const metadata: Metadata = {
  title: 'Data Processing Addendum',
  description:
    'The data processing addendum for Tickwise. Not yet published — this page is an explicit placeholder, not a summary of an addendum in force.',
  robots: { index: false, follow: true },
};

export default function DpaPage() {
  return (
    <LegalPage
      title="Data Processing Addendum"
      subject="The processor-side commitments a customer needs before routing personal data anywhere near us."
    />
  );
}
