import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SANDBOX_TEXT, SandboxBanner } from '../src';

describe('sandbox banner (CLAUDE.md rule 10)', () => {
  it('says sandbox, as a status the screen reader announces', () => {
    const html = renderToStaticMarkup(<SandboxBanner />);
    expect(html).toContain('SANDBOX');
    expect(html).toContain('role="status"');
    expect(SANDBOX_TEXT).toMatch(/No real money/);
  });

  it('is rendered by the root layout of every web app, so every page carries it', () => {
    const apps = fileURLToPath(new URL('../../../apps/', import.meta.url));
    const names = readdirSync(apps, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith('-mobile'))
      .map((entry) => entry.name);
    expect(names.sort()).toEqual(['chiwo-web', 'internal-ops', 'kelo-web', 'kony-web']);
    for (const name of names) {
      const layout = readFileSync(`${apps}${name}/app/layout.tsx`, 'utf8');
      expect(layout, name).toContain('<SandboxBanner />');
    }
  });
});
