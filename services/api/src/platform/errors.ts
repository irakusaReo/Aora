import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** Stable, documented error codes. Changing one is a breaking API change. */
export type ErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'step_up_required'
  | 'reverification_required'
  | 'not_found'
  | 'idempotency_key_required'
  | 'idempotency_key_reused'
  | 'invalid_state_transition'
  | 'capability_not_supported'
  | 'limit_exceeded'
  | 'insufficient_funds'
  | 'fee_changed'
  | 'recipient_not_confirmed'
  | 'recipient_cooling_off'
  | 'refund_exceeds_collection'
  | 'invalid_signature'
  | 'too_many_attempts'
  | 'pin_not_set'
  | 'phone_required'
  | 'workspace_restricted'
  | 'prohibited_item'
  | 'sold_out'
  | 'conflict'
  | 'invalid_destination'
  | 'chain_unavailable'
  | 'context_mismatch'
  | 'sign_up_required'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  step_up_required: 403,
  reverification_required: 403,
  not_found: 404,
  idempotency_key_required: 400,
  idempotency_key_reused: 409,
  invalid_state_transition: 409,
  capability_not_supported: 422,
  limit_exceeded: 422,
  insufficient_funds: 422,
  fee_changed: 409,
  recipient_not_confirmed: 409,
  recipient_cooling_off: 409,
  refund_exceeds_collection: 409,
  invalid_signature: 401,
  too_many_attempts: 429,
  pin_not_set: 409,
  phone_required: 409,
  workspace_restricted: 409,
  prohibited_item: 422,
  sold_out: 409,
  conflict: 409,
  invalid_destination: 422,
  chain_unavailable: 503,
  context_mismatch: 400,
  sign_up_required: 403,
  internal_error: 500,
};

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = request.aora?.requestId ?? 'unknown';

    let code: ErrorCode = 'internal_error';
    let message = 'Unexpected error.';
    if (error instanceof AppError) {
      code = error.code;
      message = error.message;
    } else if (error instanceof HttpException) {
      const status = error.getStatus();
      code = status === 404 ? 'not_found' : status < 500 ? 'invalid_request' : 'internal_error';
      message = status === 404 ? 'Resource not found.' : 'The request could not be processed.';
    }
    if (code === 'internal_error') {
      // The error message may quote user input or SQL; log its type and stack origin only.
      const name = error instanceof Error ? error.name : typeof error;
      this.logger.error(`request ${requestId} failed with ${name}`);
    }
    response
      .status(STATUS[code])
      .setHeader('Aora-Mode', 'sandbox')
      .json({ error: { code, message, request_id: requestId }, mode: 'sandbox' });
  }
}
