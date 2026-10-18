import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { Database, type Tx } from '../../platform/database.js';
import { AppError } from '../../platform/errors.js';
import { contextOf, parseBody, type SessionContext, sessionOf } from '../../platform/http.js';
import { SessionGuard } from '../identity/guards.js';

export interface TermsView {
  readonly key: string;
  readonly version: string;
  readonly language: string;
  readonly title: string;
  readonly body: string;
  readonly body_sha256: string;
  readonly effective_from: string;
}

/**
 * Versioned terms and consent records (brief §7.4). A consent names the person,
 * the capacity in which they acted, the action, the time and the exact terms
 * version. Records are append-only; a published terms version is immutable.
 */
@Injectable()
export class ConsentService {
  constructor(@Inject(Database) private readonly db: Database) {}

  /** Publishes a new version and closes the one it replaces. */
  async publishTerms(
    tx: Tx,
    input: {
      key: string;
      version: string;
      language: string;
      title: string;
      body: string;
      effectiveFrom: Date;
    },
  ): Promise<string> {
    await tx.terms_document.updateMany({
      where: { key: input.key, language: input.language, effective_to: null },
      data: { effective_to: input.effectiveFrom },
    });
    const created = await tx.terms_document.create({
      data: {
        key: input.key,
        version: input.version,
        language: input.language,
        title: input.title,
        body: input.body,
        body_sha256: createHash('sha256').update(input.body).digest('hex'),
        effective_from: input.effectiveFrom,
      },
    });
    return created.id;
  }

  async currentTerms(key: string, language = 'en'): Promise<TermsView> {
    const now = new Date();
    const terms = await this.db.asPlatform((tx) =>
      tx.terms_document.findFirst({
        where: {
          key,
          language,
          effective_from: { lte: now },
          OR: [{ effective_to: null }, { effective_to: { gt: now } }],
        },
        orderBy: { effective_from: 'desc' },
      }),
    );
    if (!terms) throw new AppError('not_found', 'Terms not found.');
    return {
      key: terms.key,
      version: terms.version,
      language: terms.language,
      title: terms.title,
      body: terms.body,
      body_sha256: terms.body_sha256,
      effective_from: terms.effective_from.toISOString(),
    };
  }

  async record(
    session: SessionContext,
    requestId: string,
    input: {
      termsKey: string;
      termsVersion: string;
      action: string;
      capacity: 'personal' | 'business';
      tenantId: string | null;
    },
  ): Promise<{ id: string; created_at: string }> {
    if ((input.capacity === 'business') !== (input.tenantId !== null)) {
      throw new AppError('invalid_request', 'workspace_id is required for business capacity only.');
    }
    if (input.tenantId && !session.memberships.some((m) => m.tenantId === input.tenantId)) {
      throw new AppError('forbidden', 'You cannot consent on behalf of this workspace.');
    }
    return this.db.asPlatform((tx) => this.recordIn(tx, session.accountId, requestId, input));
  }

  /**
   * Records consent inside the caller's transaction, so an action and the
   * consent it depends on commit together. The caller has checked capacity.
   */
  async recordIn(
    tx: Tx,
    accountId: string,
    requestId: string,
    input: {
      termsKey: string;
      termsVersion: string;
      action: string;
      capacity: 'personal' | 'business';
      tenantId: string | null;
    },
  ): Promise<{ id: string; created_at: string }> {
    const now = new Date();
    const terms = await tx.terms_document.findFirst({
      where: {
        key: input.termsKey,
        version: input.termsVersion,
        effective_from: { lte: now },
        OR: [{ effective_to: null }, { effective_to: { gt: now } }],
      },
    });
    // Consent must name the version in effect, so nobody agrees to superseded terms.
    if (!terms) throw new AppError('invalid_request', 'That terms version is not in effect.');
    const account = await tx.user_account.findUniqueOrThrow({ where: { id: accountId } });
    const row = await tx.consent_record.create({
      data: {
        person_id: account.person_id,
        account_id: account.id,
        capacity: input.capacity,
        tenant_id: input.tenantId,
        action: input.action,
        terms_document_id: terms.id,
        request_id: requestId,
      },
    });
    return { id: row.id, created_at: row.created_at.toISOString() };
  }
}

const consentBody = z.strictObject({
  terms_key: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
  terms_version: z.string().min(1).max(40),
  action: z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/),
  capacity: z.enum(['personal', 'business']),
  workspace_id: z.uuid().optional(),
});

@Controller('v1')
export class ConsentController {
  constructor(@Inject(ConsentService) private readonly consent: ConsentService) {}

  @Get('terms/:key')
  terms(@Param('key') key: string): Promise<TermsView> {
    return this.consent.currentTerms(key);
  }

  @Post('consents')
  @HttpCode(201)
  @UseGuards(SessionGuard)
  record(
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<{ id: string; created_at: string }> {
    const input = parseBody(consentBody, body);
    return this.consent.record(sessionOf(request), contextOf(request).requestId, {
      termsKey: input.terms_key,
      termsVersion: input.terms_version,
      action: input.action,
      capacity: input.capacity,
      tenantId: input.workspace_id?.toLowerCase() ?? null,
    });
  }
}
