import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './platform/config.js';

const config = loadConfig(process.env);
const app = await NestFactory.create(AppModule.register(config), { rawBody: true });
app.enableShutdownHooks();
await app.listen(config.port);
new Logger('main').log(`AORA API listening on ${String(config.port)} (mode: ${config.mode})`);
