import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { seedDemo } from './demo-data.js';
import { loadConfig } from './platform/config.js';

// Loads the SANDBOX demo catalogue (phase-10 10A). Safe to run again: it changes
// nothing the second time. Run after migrating; `scripts/seed-demo-env.mjs`
// points it at a Neon branch.

const config = loadConfig(process.env);
const app = await NestFactory.createApplicationContext(AppModule.register(config));
const result = await seedDemo((type) => app.get(type));
new Logger('seed-demo').log(
  `sandbox demo catalogue in place: ${String(result.stores)} stores, ${String(result.listings)} listings`,
);
await app.close();
