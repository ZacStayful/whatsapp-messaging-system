import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Root layout — placeholder.
 *
 * Phase 0a is the environment layer only. The real shell, typography and design
 * system arrive with the inbox in Phase 2.
 */

export const metadata: Metadata = {
  title: 'Stayful WhatsApp',
  description: 'WhatsApp messaging for the Stayful management leads pipeline.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
