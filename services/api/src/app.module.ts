import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './modules/audit/audit.service.js';
import { BusinessService } from './modules/business/business.service.js';
import { AUTH_PROVIDER, SandboxAuthProvider } from './modules/identity/auth-provider.js';
import {
  OperatorGuard,
  SessionGuard,
  StepUpGuard,
  WorkspaceGuard,
} from './modules/identity/guards.js';
import { IdentityController } from './modules/identity/identity.controller.js';
import { IdentityService } from './modules/identity/identity.service.js';
import { LedgerService } from './modules/ledger/ledger.service.js';
import { OutboxService } from './modules/outbox/outbox.service.js';
import {
  OpsController,
  PaymentIntentsController,
  WebhooksController,
} from './modules/payments/payments.controller.js';
import { PaymentsService } from './modules/payments/payments.service.js';
import { ReconciliationService } from './modules/payments/reconciliation.service.js';
import { SimulatorProvider } from './modules/payments/simulator.js';
import { TenancyService } from './modules/tenancy/tenancy.service.js';
import { APP_CONFIG, type AppConfig } from './platform/config.js';
import { Database } from './platform/database.js';
import type { WorkspaceHook } from './seed-data.js';
import { ErrorFilter } from './platform/errors.js';
import { HealthController } from './platform/health.controller.js';
import { RequestContextMiddleware, SandboxLabelInterceptor } from './platform/http.js';

const SHARED = [
  Database,
  AuditService,
  BusinessService,
  TenancyService,
  LedgerService,
  OutboxService,
  SimulatorProvider,
  ReconciliationService,
  PaymentsService,
  IdentityService,
  SessionGuard,
  WorkspaceGuard,
  OperatorGuard,
  StepUpGuard,
];

export const CONTROLLERS = [
  HealthController,
  IdentityController,
  PaymentIntentsController,
  WebhooksController,
  OpsController,
];

@Module({})
export class AppModule implements NestModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [...CONTROLLERS],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: AUTH_PROVIDER, useFactory: () => new SandboxAuthProvider(config) },
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: APP_INTERCEPTOR, useClass: SandboxLabelInterceptor },
        ...SHARED,
      ],
      exports: [APP_CONFIG, ...SHARED],
    };
  }

  /** What must happen for every new workspace beyond the tenancy rows themselves. */
  static workspaceHook(): WorkspaceHook {
    const ledger = new LedgerService();
    return async (tx, tenantId) => {
      await ledger.openAccount(tx, {
        tenantId,
        type: 'merchant_collections_pending',
        assetCode: 'KES',
      });
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
