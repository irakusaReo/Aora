import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadConfig } from './platform/config.js';

const config = loadConfig(process.env);
const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config), {
  rawBody: true,
});
// Behind the hosting platform's proxy, the client address is in the forwarded header.
// It is used only as a rate-limit key, and stored only as a digest.
if (config.deployed) app.set('trust proxy', true);
app.enableShutdownHooks();
await app.listen(config.port);
new Logger('main').log(`AORA API listening on ${String(config.port)} (mode: ${config.mode})`);
