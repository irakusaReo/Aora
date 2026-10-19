import { ClerkProvider, Show, SignInButton, UserButton } from '@clerk/nextjs';
import { BASE_CSS, SandboxBanner } from '@aora/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '../lib/messages';

export const metadata: Metadata = {
  title: 'CHIWO (sandbox)',
  description: 'CHIWO personal payments. Sandbox: no real money.',
};
// Payment status changes by the second; nothing is pre-rendered.
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
              <strong>{t('app.name')}</strong> <span className="pill">sandbox</span>{' '}
              <span className="pill">personal</span>
            </Link>
            <nav>
              <Show when="signed-in">
                <Link href="/">{t('nav.home')}</Link>
                <Link href="/pay">{t('nav.pay')}</Link>
                <Link href="/send">{t('nav.send')}</Link>
                <Link href="/requests">{t('nav.requests')}</Link>
                <Link href="/usdc">{t('nav.usdc')}</Link>
                <Link href="/security">{t('nav.security')}</Link>
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
