import { defineConfig } from 'prisma/config';

// Migrations run as the schema owner. The API and worker never use this URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env['DATABASE_URL_OWNER'] ?? 'postgresql://aora_owner@127.0.0.1:54329/aora_dev',
  },
});
