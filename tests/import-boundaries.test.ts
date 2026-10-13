import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';

// Proves the import-direction rule (ADR 0002 rule 3) is live, by planting
// violations and checking that lint rejects them.

const root = fileURLToPath(new URL('..', import.meta.url));
const planted: string[] = [];

async function lint(relativePath: string, source: string): Promise<string[]> {
  const path = `${root}${relativePath}`;
  writeFileSync(path, source);
  planted.push(path);
  const results = await new ESLint({ cwd: root }).lintFiles([path]);
  return results.flatMap((result) => result.messages.map((message) => message.message));
}

afterAll(() => {
  for (const path of planted) rmSync(path, { force: true });
});

describe('import boundaries', () => {
  it('stops the ledger importing from payments', async () => {
    const messages = await lint(
      'services/api/src/modules/ledger/zz-boundary-probe.ts',
      `import { TRANSITIONS } from '../payments/payments.service.js';\nexport const probe = TRANSITIONS;\n`,
    );
    expect(messages.join('\n')).toMatch(/ledger module may not import from payments/);
  });

  it('stops shared platform code importing from a module', async () => {
    const messages = await lint(
      'services/api/src/platform/zz-boundary-probe.ts',
      `import { LedgerService } from '../modules/ledger/ledger.service.js';\nexport const probe = LedgerService;\n`,
    );
    expect(messages.join('\n')).toMatch(/may not import from a module/);
  });

  it('stops a module using the database client directly, but allows its types', async () => {
    const value = await lint(
      'services/api/src/modules/audit/zz-boundary-probe.ts',
      `import { PrismaClient } from '../../generated/prisma/client.js';\nexport const probe = PrismaClient;\n`,
    );
    expect(value.join('\n')).toMatch(/Only src\/platform\/database.ts/);
    const typeOnly = await lint(
      'services/api/src/modules/audit/zz-boundary-probe.ts',
      `import type { Prisma } from '../../generated/prisma/client.js';\nexport type Probe = Prisma.JsonValue;\n`,
    );
    expect(typeOnly.join('\n')).not.toMatch(/Only src\/platform\/database.ts/);
  });

  it('lets a controller use the guards and the permission decorator from any module', async () => {
    const messages = await lint(
      'services/api/src/modules/ledger/zz-boundary-probe.ts',
      `import { SessionGuard } from '../identity/guards.js';\nimport { Permit } from '../tenancy/permissions.js';\nexport const probe = [SessionGuard, Permit];\n`,
    );
    expect(messages.join('\n')).not.toMatch(/may not import/);
  });
});
