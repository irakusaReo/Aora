import { ClerkProvider, Show, SignInButton, UserButton } from '@clerk/nextjs';
import { BASE_CSS, SandboxBanner } from '@aora/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '../lib/messages';

export const metadata: Metadata = {
  title: 'KELO (sandbox)',
  description: 'KELO marketplace. Sandbox: no real money, no real goods.',
};
// Listings change under review; nothing is pre-rendered.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <head>
        <style>{BASE_CSS}</style>
      </head>
      <body>
        <ClerkProvider>
          <SandboxBanner />
          <header className="aora-top">
            <Link href="/">
              <strong>{t('app.name')}</strong> <span className="pill">sandbox</span>
            </Link>
            <nav>
              <Link href="/">{t('nav.browse')}</Link>
              <Show when="signed-in">
                <Link href="/quotes">{t('nav.quotes')}</Link>
                <Link href="/purchases">{t('nav.purchases')}</Link>
                <UserButton />
              </Show>
              <Show when="signed-out">
                <SignInButton />
              </Show>
            </nav>
          </header>
          <main>{children}</main>
        </ClerkProvider>
      </body>
    </html>
  );
}
