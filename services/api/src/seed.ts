import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './platform/config.js';
import { Database } from './platform/database.js';
import { seedSandbox } from './seed-data.js';

// Loads SANDBOX demo data into an empty database. Run once after migrating.

const config = loadConfig(process.env);
const app = await NestFactory.createApplicationContext(AppModule.register(config));
const seed = await seedSandbox(app.get(Database), AppModule.workspaceHook());
new Logger('seed').log(`sandbox data created: workspaces ${seed.tenantA} and ${seed.tenantB}`);
await app.close();
