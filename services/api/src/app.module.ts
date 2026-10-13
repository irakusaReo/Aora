import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './modules/audit/audit.service.js';
import { BusinessService } from './modules/business/business.service.js';
import { ConsentController, ConsentService } from './modules/consent/consent.service.js';
import {
  AUTH_PROVIDER,
  OtpAuthProvider,
  SandboxAuthProvider,
  SMS_SENDER,
  type SmsSender,
} from './modules/identity/auth-provider.js';
import {
  OperatorGuard,
  SessionGuard,
  StepUpGuard,
  WorkspaceGuard,
} from './modules/identity/guards.js';
import { IdentityController } from './modules/identity/identity.controller.js';
import { IdentityService } from './modules/identity/identity.service.js';
import { SimulatedSmsSender } from './modules/identity/sms.js';
import {
  CronController,
  CronGuard,
  InboxGuard,
  SandboxInboxController,
} from './modules/jobs/jobs.js';
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
import { BalancesController, MembersController } from './modules/tenancy/members.controller.js';
import { TenancyService } from './modules/tenancy/tenancy.service.js';
import { APP_CONFIG, type AppConfig } from './platform/config.js';
import { Database } from './platform/database.js';
import type { WorkspaceHook } from './seed-data.js';
import { ErrorFilter } from './platform/errors.js';
import { HealthController } from './platform/health.controller.js';
import { RequestContextMiddleware, SandboxLabelInterceptor } from './platform/http.js';
import { RateLimiter } from './platform/rate-limit.js';

const SHARED = [
  Database,
  RateLimiter,
  ConsentService,
  SimulatedSmsSender,
  CronGuard,
  InboxGuard,
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
  MembersController,
  BalancesController,
  ConsentController,
  CronController,
  SandboxInboxController,
];

@Module({})
export class AppModule implements NestModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [...CONTROLLERS],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        // Until an SMS provider's sandbox is connected (checkpoint 2E), codes go to the simulated sender.
        { provide: SMS_SENDER, useExisting: SimulatedSmsSender },
        {
          provide: AUTH_PROVIDER,
          inject: [SMS_SENDER],
          useFactory: (sms: SmsSender) =>
            config.authProvider === 'fixed'
              ? new SandboxAuthProvider(config)
              : new OtpAuthProvider(sms),
        },
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
