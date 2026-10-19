import { SANDBOX_TEXT } from '@aora/ui';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxBanner } from '../src/sandbox-banner';

afterEach(cleanup);

describe('native sandbox banner (CLAUDE.md rule 10, ADR 0016 rule 7)', () => {
  it('shows the same sandbox words as the web apps, as an announced status', () => {
    render(<SandboxBanner />);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toBe(SANDBOX_TEXT);
  });
});
