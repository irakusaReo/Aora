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
import { AUTH_PROVIDER, SandboxAuthProvider } from './modules/identity/auth-provider.js';
import { ClerkAuthProvider } from './modules/identity/clerk-auth-provider.js';
import {
  OperatorGuard,
  SessionGuard,
  StepUpGuard,
  WorkspaceGuard,
} from './modules/identity/guards.js';
import { IdentityController } from './modules/identity/identity.controller.js';
import { IdentityService } from './modules/identity/identity.service.js';
import { CronController, CronGuard, DrainAfterResponseInterceptor } from './modules/jobs/jobs.js';
import { EMAIL_CHANNEL, SimulatedEmailChannel } from './modules/notifications/channel.js';
import { NotificationsController } from './modules/notifications/notifications.controller.js';
import { NotificationsService } from './modules/notifications/notifications.service.js';
import { ResendEmailChannel } from './modules/notifications/resend-channel.js';
import { ProviderWebhooksController } from './modules/webhooks/provider-webhooks.controller.js';
import { LedgerService } from './modules/ledger/ledger.service.js';
import { OutboxService } from './modules/outbox/outbox.service.js';
import {
  DarajaWebhooksController,
  OpsController,
  PaymentIntentsController,
  TariffsController,
  WebhooksController,
} from './modules/payments/payments.controller.js';
import { DarajaAdapter } from './modules/payments/daraja.js';
import { DARAJA_ADAPTER, PaymentsService } from './modules/payments/payments.service.js';
import { ReconciliationService } from './modules/payments/reconciliation.service.js';
import { SimulatorProvider } from './modules/payments/simulator.js';
import {
  OnboardingController,
  OnboardingReviewsController,
} from './modules/onboarding/onboarding.controller.js';
import { OnboardingService } from './modules/onboarding/onboarding.service.js';
import { OpsLookupController } from './modules/ops/ops.controller.js';
import { PricingService } from './modules/pricing/pricing.service.js';
import {
  BalancesController,
  BranchesController,
  InvitationsController,
  MembersController,
  MyInvitationsController,
  WorkspaceController,
} from './modules/tenancy/members.controller.js';
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
  SimulatedEmailChannel,
  NotificationsService,
  CronGuard,
  AuditService,
  BusinessService,
  TenancyService,
  LedgerService,
  PricingService,
  OutboxService,
  SimulatorProvider,
  ReconciliationService,
  PaymentsService,
  IdentityService,
  OnboardingService,
  SessionGuard,
  WorkspaceGuard,
  OperatorGuard,
  StepUpGuard,
];

export const CONTROLLERS = [
  HealthController,
  IdentityController,
  PaymentIntentsController,
  TariffsController,
  WebhooksController,
  DarajaWebhooksController,
  OpsController,
  MembersController,
  InvitationsController,
  MyInvitationsController,
  WorkspaceController,
  BranchesController,
  OnboardingController,
  OnboardingReviewsController,
  OpsLookupController,
  BalancesController,
  ConsentController,
  CronController,
  NotificationsController,
  ProviderWebhooksController,
];

@Module({})
export class AppModule implements NestModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [...CONTROLLERS],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: AUTH_PROVIDER,
          useFactory: () =>
            config.authProvider === 'sandbox'
              ? new SandboxAuthProvider(config)
              : new ClerkAuthProvider(config),
        },
        {
          // Email goes to Resend when a key is configured (always, on a deployed
          // environment); otherwise to the simulated channel for tests and local work.
          provide: EMAIL_CHANNEL,
          inject: [SimulatedEmailChannel],
          useFactory: (simulated: SimulatedEmailChannel) =>
            config.email.resendApiKey
              ? new ResendEmailChannel({
                  apiKey: config.email.resendApiKey,
                  from: config.email.from,
                })
              : simulated,
        },
        {
          // Daraja serves the mpesa rail when it is configured; otherwise the simulator does.
          provide: DARAJA_ADAPTER,
          useFactory: () => (config.daraja ? new DarajaAdapter(config.daraja) : null),
        },
        { provide: APP_INTERCEPTOR, useClass: DrainAfterResponseInterceptor },
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: APP_INTERCEPTOR, useClass: SandboxLabelInterceptor },
        ...SHARED,
      ],
      exports: [APP_CONFIG, AUTH_PROVIDER, EMAIL_CHANNEL, ...SHARED],
    };
  }

  /** What must happen for every new workspace beyond the tenancy rows themselves. */
  static workspaceHook(): WorkspaceHook {
    const ledger = new LedgerService();
    return (tx, tenantId) => ledger.openWorkspaceAccounts(tx, tenantId);
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
