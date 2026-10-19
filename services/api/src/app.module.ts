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
import { AssetsController, IdentityController } from './modules/identity/identity.controller.js';
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
import {
  DarajaPayoutWebhooksController,
  PayoutRecipientsController,
  PayoutsController,
  RefundsController,
  SettlementsController,
} from './modules/payments/money.controller.js';
import { PayoutsService } from './modules/payments/payouts.service.js';
import { RefundsService } from './modules/payments/refunds.service.js';
import { SettlementService } from './modules/payments/settlement.service.js';
import { DARAJA_ADAPTER, PaymentsService } from './modules/payments/payments.service.js';
import { ReconciliationService } from './modules/payments/reconciliation.service.js';
import { ChainService } from './modules/chain/chain.service.js';
import { AnchoringService } from './modules/chain/anchoring.service.js';
import { ChainOpsController } from './modules/chain/chain-ops.controller.js';
import { ChainReconciliationService } from './modules/chain/chain-reconciliation.service.js';
import { NamVaultGateway } from './modules/chain/nam-vault.gateway.js';
import { TreasuryController } from './modules/chain/treasury.controller.js';
import { NamController } from './modules/nam/nam.controller.js';
import { NamService } from './modules/nam/nam.service.js';
import { TreasuryService } from './modules/chain/treasury.service.js';
import { SimulatorProvider } from './modules/payments/simulator.js';
import {
  OnboardingController,
  OnboardingReviewsController,
} from './modules/onboarding/onboarding.controller.js';
import { OnboardingService } from './modules/onboarding/onboarding.service.js';
import { OpsLookupController } from './modules/ops/ops.controller.js';
import { FeatureFlagsService, OpsFeatureFlagsController } from './modules/ops/feature-flags.js';
import { KeloCreditController } from './modules/kelo/credit/credit.controller.js';
import { CreditService } from './modules/kelo/credit/credit.service.js';
import { CreditCollectionsService } from './modules/kelo/credit/collections.service.js';
import { ProvisioningService } from './modules/kelo/provisioning.service.js';
import {
  KeloProvisioningController,
  KeloStoresController,
  KeloStoreVettingController,
  WorkspaceRestrictionsController,
} from './modules/kelo/stores.controller.js';
import { StoresService } from './modules/kelo/stores.service.js';
import {
  KeloCategoriesController,
  KeloListingsController,
  KeloMarketplaceController,
  KeloModerationController,
  KeloWorkspaceStoreController,
} from './modules/kelo/catalogue.controller.js';
import { CatalogueService } from './modules/kelo/catalogue.service.js';
import {
  KeloBuyerQuotesController,
  KeloMerchantQuotesController,
} from './modules/kelo/quotes.controller.js';
import { QuotesService } from './modules/kelo/quotes.service.js';
import {
  KeloMerchantPurchasesController,
  KeloPlansController,
  KeloPurchasesController,
} from './modules/kelo/layaway.controller.js';
import { LayawayService } from './modules/kelo/layaway.service.js';
import { IMAGE_STORE, SimulatedImageStore, VercelBlobImageStore } from './modules/kelo/images.js';
import {
  ApiKeysController,
  WebhookDeliveriesController,
  WebhookEndpointsController,
  WebhookSigningKeyController,
} from './modules/developer/developer.controller.js';
import { DeveloperService } from './modules/developer/developer.service.js';
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
import { PayCodesController, PayCodesService } from './modules/tenancy/pay-codes.js';
import { ChiwoController } from './modules/chiwo/chiwo.controller.js';
import { ChiwoUsdcController } from './modules/chiwo/chiwo-usdc.controller.js';
import { ChiwoNamController } from './modules/chiwo/chiwo-nam.controller.js';
import { ConsumerGuard, ConsumerService } from './modules/chiwo/consumer.service.js';
import { MerchantPaymentsService } from './modules/chiwo/merchant-payments.service.js';
import { RequestsService } from './modules/chiwo/requests.service.js';
import { UsdcService } from './modules/chiwo/usdc.service.js';
import { APP_CONFIG, type AppConfig } from './platform/config.js';
import { Database } from './platform/database.js';
import type { WorkspaceHook } from './seed-data.js';
import { ErrorFilter } from './platform/errors.js';
import { CHAIN_HEALTH, HealthController } from './platform/health.controller.js';
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
  ChainService,
  TreasuryService,
  ChainReconciliationService,
  AnchoringService,
  NamService,
  NamVaultGateway,
  PaymentsService,
  SettlementService,
  PayoutsService,
  RefundsService,
  IdentityService,
  OnboardingService,
  DeveloperService,
  StoresService,
  ProvisioningService,
  SimulatedImageStore,
  CatalogueService,
  QuotesService,
  LayawayService,
  CreditService,
  CreditCollectionsService,
  FeatureFlagsService,
  PayCodesService,
  ConsumerService,
  MerchantPaymentsService,
  UsdcService,
  RequestsService,
  ConsumerGuard,
  SessionGuard,
  WorkspaceGuard,
  OperatorGuard,
  StepUpGuard,
];

export const CONTROLLERS = [
  TreasuryController,
  ChainOpsController,
  NamController,
  HealthController,
  IdentityController,
  AssetsController,
  PaymentIntentsController,
  TariffsController,
  WebhooksController,
  DarajaWebhooksController,
  DarajaPayoutWebhooksController,
  SettlementsController,
  PayoutRecipientsController,
  PayoutsController,
  RefundsController,
  OpsController,
  MembersController,
  InvitationsController,
  MyInvitationsController,
  WorkspaceController,
  BranchesController,
  OnboardingController,
  OnboardingReviewsController,
  OpsLookupController,
  OpsFeatureFlagsController,
  KeloCreditController,
  ApiKeysController,
  WebhookEndpointsController,
  WebhookDeliveriesController,
  WebhookSigningKeyController,
  BalancesController,
  ConsentController,
  KeloStoresController,
  KeloStoreVettingController,
  KeloProvisioningController,
  WorkspaceRestrictionsController,
  KeloCategoriesController,
  KeloMarketplaceController,
  KeloListingsController,
  KeloModerationController,
  KeloWorkspaceStoreController,
  KeloBuyerQuotesController,
  KeloMerchantQuotesController,
  KeloPlansController,
  KeloPurchasesController,
  KeloMerchantPurchasesController,
  CronController,
  NotificationsController,
  ProviderWebhooksController,
  PayCodesController,
  ChiwoController,
  ChiwoUsdcController,
  ChiwoNamController,
];

@Module({})
export class AppModule implements NestModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [...CONTROLLERS],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: CHAIN_HEALTH, useExisting: ChainService },
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
        {
          // KELO listing images go to Vercel Blob when a store is connected (O-7);
          // otherwise to the simulator, which keeps nothing real.
          provide: IMAGE_STORE,
          inject: [SimulatedImageStore],
          useFactory: (simulated: SimulatedImageStore) =>
            config.blob.readWriteToken
              ? new VercelBlobImageStore(config.blob.readWriteToken)
              : simulated,
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
