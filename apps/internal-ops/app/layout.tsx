import { ClerkProvider, UserButton } from '@clerk/nextjs';
import type { Me } from '@aora/api-client';
import { BASE_CSS, SandboxBanner } from '@aora/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { api } from '../lib/api';

export const metadata: Metadata = {
  title: 'AORA operations (sandbox)',
  description: 'Internal operations console. Sandbox: no real money.',
};
export const dynamic = 'force-dynamic';

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const me = await (await api()).get<Me>('/v1/me');
  return (
    <html lang="en">
      <head>
        <style>{BASE_CSS}</style>
      </head>
      <body>
        <ClerkProvider>
          <SandboxBanner />
          <header className="aora-top">
            <strong>
              AORA operations <span className="pill">sandbox</span>
            </strong>
            <nav>
              <Link href="/">Exceptions</Link>
              <Link href="/reviews">Onboarding reviews</Link>
              <Link href="/lookup">Lookup</Link>
              <Link href="/audit">Audit trail</Link>
              <UserButton />
            </nav>
          </header>
          <main>
            {me.is_platform_operator ? (
              children
            ) : (
              <div className="card">
                <h1>Operator access required</h1>
                <p className="muted">
                  Your account is not a platform operator. Operator rights are granted in AORA,
                  never in the identity provider.
                </p>
              </div>
            )}
          </main>
        </ClerkProvider>
      </body>
    </html>
  );
}
