// Every screen says it is sandbox (CLAUDE.md rule 10). Rendered once by each
// app's root layout, above everything else, and never dismissible.

export const SANDBOX_TEXT =
  'SANDBOX — test environment. No real money moves and no real account is involved.';

export function SandboxBanner(): React.JSX.Element {
  return (
    <div role="status" aria-label="Sandbox environment" className="aora-sandbox-banner">
      {SANDBOX_TEXT}
    </div>
  );
}
