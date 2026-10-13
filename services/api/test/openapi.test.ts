import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONTROLLERS } from '../src/app.module.js';
import { TRANSITIONS } from '../src/modules/payments/payments.service.js';
import { SCENARIOS } from '../src/modules/payments/simulator.js';

// docs/api/openapi.yaml is the API contract. These tests fail when the code
// and the contract drift apart.

const spec = parse(
  readFileSync(fileURLToPath(new URL('../../../docs/api/openapi.yaml', import.meta.url)), 'utf8'),
);

function implementedRoutes(): string[] {
  const routes: string[] = [];
  for (const controller of CONTROLLERS) {
    const base = Reflect.getMetadata('path', controller) as string;
    const prototype = controller.prototype as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const path = Reflect.getMetadata('path', handler) as string;
      const full = `/${[base, path].filter((part) => part && part !== '/').join('/')}`;
      routes.push(`${RequestMethod[method]} ${full.replace(/:([A-Za-z]+)/g, '{$1}')}`);
    }
  }
  return routes.sort();
}

function documentedRoutes(): string[] {
  const routes: string[] = [];
  for (const [path, item] of Object.entries(spec.paths as Record<string, object>)) {
    for (const method of Object.keys(item)) routes.push(`${method.toUpperCase()} ${path}`);
  }
  return routes.sort();
}

describe('OpenAPI contract', () => {
  it('documents exactly the routes the API implements', () => {
    expect(documentedRoutes()).toEqual(implementedRoutes());
  });

  it('lists exactly the payment statuses and sandbox scenarios the code uses', () => {
    expect([...spec.components.schemas.PaymentIntentStatus.enum].sort()).toEqual(
      Object.keys(TRANSITIONS).sort(),
    );
    const scenarios =
      spec.paths['/v1/payment-intents'].post.requestBody.content['application/json'].schema
        .properties.sandbox_scenario.enum;
    expect([...scenarios].sort()).toEqual([...SCENARIOS].sort());
  });

  it('says it is sandbox, and versions every path under /v1', () => {
    expect(spec.info.summary).toMatch(/SANDBOX ONLY/);
    expect(Object.keys(spec.paths).every((path) => path.startsWith('/v1/'))).toBe(true);
  });

  it('gives every operation an id and every error response the shared error schema', () => {
    for (const item of Object.values(
      spec.paths as Record<string, Record<string, { operationId: unknown; responses: object }>>,
    )) {
      for (const operation of Object.values(item)) {
        expect(operation.operationId).toEqual(expect.any(String));
        for (const [status, response] of Object.entries(operation.responses)) {
          if (Number(status) >= 400) {
            expect(response).toEqual({ $ref: '#/components/responses/Error' });
          }
        }
      }
    }
  });
});
