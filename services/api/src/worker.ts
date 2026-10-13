import 'reflect-metadata';
import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { OutboxService } from './modules/outbox/outbox.service.js';
import { SIM_SIGNATURE_HEADER, SimulatorProvider } from './modules/payments/simulator.js';
import { loadConfig } from './platform/config.js';

// The worker: drains the outbox and, in sandbox, plays the simulator provider's
// part by delivering its webhooks to the API over HTTP.

const config = loadConfig(process.env);
const logger = new Logger('worker');
const app = await NestFactory.createApplicationContext(AppModule.register(config));
const outbox = app.get(OutboxService);
const simulator = app.get(SimulatorProvider);

const state = { running: true };
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    state.running = false;
  });
}

const deliver = async (rawBody: string, signature: string): Promise<number> => {
  const response = await fetch(`${config.publicApiUrl}/v1/webhooks/sandbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIM_SIGNATURE_HEADER]: signature },
    body: rawBody,
  });
  return response.status;
};

logger.log(`AORA worker started (mode: ${config.mode})`);
while (state.running) {
  try {
    const handled = await outbox.runUntilIdle(100);
    const delivered = await simulator.deliverDueWebhooks(deliver);
    if (handled + delivered === 0) await sleep(500);
  } catch (error) {
    logger.error(
      `worker loop failed with ${error instanceof Error ? error.name : 'unknown error'}`,
    );
    await sleep(2000);
  }
}
await app.close();
logger.log('AORA worker stopped');
