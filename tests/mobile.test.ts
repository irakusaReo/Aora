import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Rules for the native apps that a reviewer could miss (phase-9 P9-13, P9-15).

const root = fileURLToPath(new URL('..', import.meta.url));
const MOBILE_APPS = readdirSync(join(root, 'apps')).filter((name) => name.endsWith('-mobile'));

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', '.expo'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** App code that ships to a phone: each app's routes and screens, and the shared kit. */
const shipped = [
  ...MOBILE_APPS.flatMap((app) => [
    ...files(join(root, 'apps', app, 'app')),
    ...files(join(root, 'apps', app, 'src')),
  ]),
  ...files(join(root, 'packages/mobile/src')).filter((path) => !path.endsWith('testing.tsx')),
];

describe('mobile apps', () => {
  it('exist as planned', () => {
    expect(MOBILE_APPS.length).toBeGreaterThan(0);
    expect(shipped.length).toBeGreaterThan(0);
  });

  it('use no floating-point money helpers (CLAUDE.md rule 3)', () => {
    const offenders = shipped.filter((path) =>
      /\b(parseFloat|toFixed|Math\.round|Number\.parseFloat)\b/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('keep tokens out of plain storage and logs (ADR 0016 rule 4)', () => {
    const offenders = shipped.filter((path) =>
      /AsyncStorage|localStorage|console\.(log|info|debug|warn)/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('reach the network only through the API client', () => {
    const offenders = shipped.filter((path) => /\bfetch\(/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('never write Clerk metadata (ADR 0019)', () => {
    const offenders = shipped.filter((path) =>
      /(unsafe|public|private)Metadata/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('render every app inside the shared root: sandbox banner and secure token cache', () => {
    const appRoot = readFileSync(join(root, 'packages/mobile/src/app-root.tsx'), 'utf8');
    expect(appRoot).toContain('<SandboxBanner />');
    expect(appRoot).toContain('tokenCache={tokenCache}');
    expect(appRoot).toContain("from '@clerk/expo/token-cache'");
    for (const app of MOBILE_APPS) {
      const layout = readFileSync(join(root, 'apps', app, 'app/_layout.tsx'), 'utf8');
      expect(layout, app).toContain('<AppRoot');
    }
  });

  it('read only public configuration into the app (phase-9 P9-5)', () => {
    for (const app of MOBILE_APPS) {
      const config = readFileSync(join(root, 'apps', app, 'app.config.ts'), 'utf8');
      const read = [...config.matchAll(/env\['([A-Z0-9_]+)'\]/g)].map((match) => match[1]);
      expect(read.sort(), app).toEqual(['AORA_MOBILE_API_URL', 'CLERK_PUBLISHABLE_KEY']);
    }
  });
});

describe('mobile contract with the API (phase-9 P9-13)', () => {
  const spec = readFileSync(join(root, 'docs/api/openapi.yaml'), 'utf8').split('\n');
  const documented = new Set<string>();
  let path: string | null = null;
  for (const line of spec) {
    const route = /^ {2}(\/v1\S*):/.exec(line);
    if (route) {
      path = (route[1] ?? '').replace(/\{[^}]+\}/g, '{}');
      continue;
    }
    const method = /^ {4}(get|post|put|patch|delete):/.exec(line);
    if (method && path) documented.add(`${method[1] ?? ''} ${path}`);
  }

  it('calls only documented routes, with their documented methods', () => {
    const called = new Set<string>();
    for (const file of shipped) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(
        /\.(get|post|put|patch|delete)(?:<[\s\S]*?>)?\(\s*(['`])(\/v1\/[^'`]*)\2/g,
      )) {
        called.add(`${match[1] ?? ''} ${(match[3] ?? '').replace(/\$\{[^}]+\}/g, '{}')}`);
      }
    }
    expect(called.size).toBeGreaterThan(5);
    expect([...called].filter((call) => !documented.has(call))).toEqual([]);
  });
});
