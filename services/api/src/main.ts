import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { loadConfig } from './platform/config.js';

// Started from a function, not with top-level await: the hosting platform loads
// this module and waits for it to finish evaluating before it lets the server's
// `listen` complete, so awaiting `listen` at the top level never returns there.
async function bootstrap(): Promise<void> {
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
}

bootstrap().catch((error: unknown) => {
  // Configuration errors name the variable, never its value, so this is safe to print.
  new Logger('main').error(error instanceof Error ? error.message : 'failed to start');
  process.exitCode = 1;
});
