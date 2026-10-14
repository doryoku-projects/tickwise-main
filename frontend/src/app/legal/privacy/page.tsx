import type { Metadata } from 'next';
import { LegalPage } from '@/components/marketing/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    'The privacy notice for Tickwise. Not yet published — this page is an explicit placeholder, not a summary of a notice in force.',
  robots: { index: false, follow: true },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      subject="What we collect from an account holder, why we hold it, how long for, and who else sees it."
    />
  );
}
