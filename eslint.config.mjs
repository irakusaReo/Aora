import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

// Import direction between backend modules (ADR 0002 rule 3). Each module lists
// what it may import; everything else under src/modules is off limits to it.
// `identity/guards.js` and `tenancy/permissions.js` are the two files a
// controller in any module may use to declare who can call it.
const MODULES = [
  'audit',
  'business',
  'consent',
  'identity',
  'jobs',
  'ledger',
  'notifications',
  'onboarding',
  'ops',
  'outbox',
  'payments',
  'pricing',
  'tenancy',
  'webhooks',
];
const MAY_IMPORT = {
  audit: [],
  business: [],
  ledger: [],
  outbox: [],
  pricing: [],
  tenancy: ['audit', 'notifications'],
  onboarding: ['audit', 'business', 'ledger', 'tenancy'],
  ops: ['audit'],
  consent: [],
  identity: ['audit', 'tenancy'],
  notifications: ['outbox'],
  payments: ['audit', 'ledger', 'notifications', 'outbox', 'pricing', 'tenancy'],
  jobs: ['outbox', 'payments'],
  webhooks: ['identity', 'notifications'],
};
const GENERATED_CLIENT = {
  group: ['**/generated/prisma/**'],
  allowTypeImports: true,
  message: 'Only src/platform/database.ts may use the database client. Import types only.',
};

const boundaries = MODULES.map((name) => ({
  files: [`services/api/src/modules/${name}/**/*.ts`],
  rules: {
    '@typescript-eslint/no-restricted-imports': [
      'error',
      {
        patterns: [
          GENERATED_CLIENT,
          ...MODULES.filter((other) => other !== name && !MAY_IMPORT[name].includes(other)).map(
            (other) => ({
              group:
                other === 'identity'
                  ? ['**/identity/**', '!**/identity/guards.js']
                  : other === 'tenancy'
                    ? ['**/tenancy/**', '!**/tenancy/permissions.js']
                    : [`**/${other}/**`],
              message: `The ${name} module may not import from ${other} (ADR 0002).`,
            }),
          ),
        ],
      },
    ],
  },
}));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/src/generated/**',
      '.claude/**',
      '.local/**',
      '.vercel/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Operational scripts run directly under Node.
    files: ['**/scripts/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
  },
  ...boundaries,
  {
    // Shared platform code depends on no module.
    files: ['services/api/src/platform/**/*.ts'],
    ignores: ['services/api/src/platform/database.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            GENERATED_CLIENT,
            {
              group: ['**/modules/**'],
              message: 'src/platform may not import from a module (ADR 0002).',
            },
          ],
        },
      ],
    },
  },
  {
    // HTTP response bodies in tests are untyped JSON; assertions check their shape.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    // NestJS modules and decorators are classes by design.
    files: ['**/*.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
  prettier,
);
