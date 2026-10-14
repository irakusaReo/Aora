import { ClerkProvider, Show, SignInButton, UserButton } from '@clerk/nextjs';
import { BASE_CSS, SandboxBanner } from '@aora/ui';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'KONY (sandbox)',
  description: 'KONY merchant workspace. Sandbox: no real money.',
};
// Every page reads the signed-in person's data; nothing is pre-rendered.
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
              <strong>KONY</strong> <span className="pill">sandbox</span>
            </Link>
            <nav>
              <Show when="signed-in">
                <Link href="/">Workspaces</Link>
                <Link href="/onboarding">Your details</Link>
                <Link href="/security">Security</Link>
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
