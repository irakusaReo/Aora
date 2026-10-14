import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

// A local stand-in for Safaricom Daraja's sandbox, for tests only. It speaks
// the request and response shapes documented on the Daraja portal and the
// behaviour AORA observed in the real sandbox (docs/providers/daraja.md). It
// is not a model of anything undocumented.

export type PushBehaviour = 'accept' | 'timeout' | 'reject_400' | 'busy_429' | 'invalid_token_once';
export type QueryState = 'pending' | 'success' | 'cancelled' | 'busy_429';

export interface DarajaStub {
  readonly baseUrl: string;
  readonly credentials: {
    consumerKey: string;
    consumerSecret: string;
    shortcode: string;
    passkey: string;
    testMsisdn: string;
  };
  /** How the next push requests behave, in order; then `accept`. */
  pushBehaviours: PushBehaviour[];
  /** What a query returns for each CheckoutRequestID; default `pending`. */
  readonly queryState: Map<string, QueryState>;
  readonly pushes: Record<string, unknown>[];
  readonly queries: Record<string, unknown>[];
  tokenRequests: number;
  b2cBehaviours: ('accept' | 'timeout')[];
  readonly b2cRequests: Record<string, unknown>[];
  readonly statusRequests: Record<string, unknown>[];
  /** The documented B2C result body for a payout (OriginatorConversationID = payout id). */
  b2cResult(payoutId: string, result: 'success' | 'failed', amount?: string): string;
  /** The documented Transaction Status result body. */
  statusResult(payoutId: string, status: string, amount: string): string;
  /** The documented callback body for a checkout. */
  callback(checkoutId: string, result: 'success' | 'cancelled', amount?: string): string;
  close(): Promise<void>;
}

const read = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      resolve(body);
    });
  });

export async function startDarajaStub(): Promise<DarajaStub> {
  const credentials = {
    consumerKey: 'stubConsumerKey000000000000000000',
    consumerSecret: 'stubConsumerSecret0000000000000000',
    shortcode: '174379',
    passkey: 'a'.repeat(64),
    testMsisdn: '254708374149',
  };
  const tokens = new Set<string>();
  const stub: Omit<DarajaStub, 'baseUrl' | 'close'> = {
    credentials,
    pushBehaviours: [],
    queryState: new Map(),
    pushes: [],
    queries: [],
    tokenRequests: 0,
    b2cBehaviours: [],
    b2cRequests: [],
    statusRequests: [],
    b2cResult(payoutId, result, amount = '10') {
      return result === 'success'
        ? `{"Result":{"ResultType":0,"ResultCode":0,"ResultDesc":"The service request is processed successfully.","OriginatorConversationID":"${payoutId}","ConversationID":"AG_${payoutId.slice(0, 8)}","TransactionID":"SBXB2C${payoutId.slice(0, 4).toUpperCase()}","ResultParameters":{"ResultParameter":[{"Key":"TransactionAmount","Value":${amount}},{"Key":"TransactionReceipt","Value":"SBXB2C${payoutId.slice(0, 4).toUpperCase()}"},{"Key":"ReceiverPartyPublicName","Value":"254708374149 - SANDBOX TEST"},{"Key":"B2CRecipientIsRegisteredCustomer","Value":"Y"}]},"ReferenceData":{"ReferenceItem":{"Key":"QueueTimeoutURL","Value":"https://internalsandbox.safaricom.co.ke/mpesa/b2cresults/v1/submit"}}}}`
        : `{"Result":{"ResultType":0,"ResultCode":2001,"ResultDesc":"The initiator information is invalid.","OriginatorConversationID":"${payoutId}","ConversationID":"AG_${payoutId.slice(0, 8)}","TransactionID":"SBX0000000"}}`;
    },
    statusResult(payoutId, status, amount) {
      return `{"Result":{"ConversationID":"AG_status","OriginatorConversationID":"status-${payoutId.slice(0, 8)}","ResultCode":0,"ResultDesc":"The service request is processed successfully.","ResultParameters":{"ResultParameter":[{"Key":"OriginatorConversationID","Value":"${payoutId}"},{"Key":"TransactionStatus","Value":"${status}"},{"Key":"Amount","Value":"${amount}"},{"Key":"ReceiptNo","Value":"SBXSTAT001"}]},"ResultType":0,"TransactionID":"SBXSTAT001"}}`;
    },
    callback(checkoutId, result, amount = '1.00') {
      const push = stub.pushes.find((entry) => entry['__checkout'] === checkoutId);
      const value = push?.['__merchant'];
      const merchant = typeof value === 'string' ? value : 'm-1';
      // Hand-written JSON so the amount keeps its decimal text exactly as sent.
      return result === 'success'
        ? `{"Body":{"stkCallback":{"MerchantRequestID":"${merchant}","CheckoutRequestID":"${checkoutId}","ResultCode":0,"ResultDesc":"The service request is processed successfully.","CallbackMetadata":{"Item":[{"Name":"Amount","Value":${amount}},{"Name":"MpesaReceiptNumber","Value":"SBX${checkoutId.slice(-7).toUpperCase()}"},{"Name":"TransactionDate","Value":20261014102115},{"Name":"PhoneNumber","Value":${credentials.testMsisdn}}]}}}}`
        : `{"Body":{"stkCallback":{"MerchantRequestID":"${merchant}","CheckoutRequestID":"${checkoutId}","ResultCode":1032,"ResultDesc":"Request cancelled by user"}}}`;
    },
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      const url = new URL(request.url ?? '/', 'http://stub');
      const raw = await read(request);
      const bearer = (request.headers.authorization ?? '').replace(/^Bearer /, '');

      if (url.pathname === '/oauth/v1/generate') {
        stub.tokenRequests += 1;
        const expected = `Basic ${Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString('base64')}`;
        if (request.headers.authorization !== expected) {
          send(400, { errorCode: '400.008.01', errorMessage: 'Invalid Authentication passed' });
          return;
        }
        const token = randomUUID().replaceAll('-', '');
        tokens.add(token);
        send(200, { access_token: token, expires_in: '3599' });
        return;
      }

      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const passwordOk =
        body['Password'] ===
        Buffer.from(
          `${credentials.shortcode}${credentials.passkey}${String(body['Timestamp'])}`,
        ).toString('base64');

      if (url.pathname === '/mpesa/stkpush/v1/processrequest') {
        const behaviour = stub.pushBehaviours.shift() ?? 'accept';
        stub.pushes.push({ ...body, __behaviour: behaviour });
        if (behaviour === 'invalid_token_once' || !tokens.has(bearer)) {
          send(404, {
            requestId: 'r',
            errorCode: '404.001.03',
            errorMessage: 'Invalid Access Token',
          });
          return;
        }
        if (behaviour === 'busy_429') {
          send(429, {
            fault: {
              faultstring: 'Spike arrest violation.',
              detail: { errorcode: 'policies.ratelimit.SpikeArrestViolation' },
            },
          });
          return;
        }
        if (behaviour === 'reject_400' || !passwordOk) {
          send(400, {
            requestId: 'r',
            errorCode: '400.002.02',
            errorMessage: 'Bad Request - Invalid PhoneNumber',
          });
          return;
        }
        const checkout = `ws_CO_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
        const merchant = randomUUID().slice(0, 18);
        const last = stub.pushes.at(-1);
        if (last) Object.assign(last, { __checkout: checkout, __merchant: merchant });
        if (behaviour === 'timeout') {
          // Accepted by the provider, but the answer never reaches the caller in time.
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        send(200, {
          MerchantRequestID: merchant,
          CheckoutRequestID: checkout,
          ResponseCode: '0',
          ResponseDescription: 'Success. Request accepted for processing',
          CustomerMessage: 'Success. Request accepted for processing',
        });
        return;
      }

      if (url.pathname === '/mpesa/b2c/v3/paymentrequest') {
        const behaviour = stub.b2cBehaviours.shift() ?? 'accept';
        stub.b2cRequests.push(body);
        if (!tokens.has(bearer)) {
          send(404, {
            requestId: 'r',
            errorCode: '404.001.03',
            errorMessage: 'Invalid Access Token',
          });
          return;
        }
        if (behaviour === 'timeout') await new Promise((resolve) => setTimeout(resolve, 3_000));
        send(200, {
          ConversationID: `AG_${randomUUID().slice(0, 12)}`,
          OriginatorConversationID: body['OriginatorConversationID'],
          ResponseCode: '0',
          ResponseDescription: 'Accept the service request successfully.',
        });
        return;
      }

      if (url.pathname === '/mpesa/transactionstatus/v1/query') {
        stub.statusRequests.push(body);
        if (!tokens.has(bearer)) {
          send(404, {
            requestId: 'r',
            errorCode: '404.001.03',
            errorMessage: 'Invalid Access Token',
          });
          return;
        }
        send(200, {
          OriginatorConversationID: `status-${randomUUID().slice(0, 8)}`,
          ConversationID: 'AG_status',
          ResponseCode: '0',
          ResponseDescription: 'Accept the service request successfully.',
        });
        return;
      }

      if (url.pathname === '/mpesa/stkpushquery/v1/query') {
        stub.queries.push(body);
        if (!tokens.has(bearer)) {
          send(404, {
            requestId: 'r',
            errorCode: '404.001.03',
            errorMessage: 'Invalid Access Token',
          });
          return;
        }
        const checkout = String(body['CheckoutRequestID']);
        const state = stub.queryState.get(checkout) ?? 'pending';
        if (state === 'busy_429') {
          send(429, {
            fault: {
              faultstring: 'Spike arrest violation.',
              detail: { errorcode: 'policies.ratelimit.SpikeArrestViolation' },
            },
          });
          return;
        }
        const [code, description] =
          state === 'success'
            ? ['0', 'The service request is processed successfully.']
            : state === 'cancelled'
              ? ['1032', 'Request Cancelled by user.']
              : ['4999', 'The transaction is still under processing'];
        send(200, {
          ResponseCode: '0',
          ResponseDescription: 'The service request has been accepted successfully',
          MerchantRequestID: 'm',
          CheckoutRequestID: checkout,
          ResultCode: code,
          ResultDesc: description,
        });
        return;
      }
      send(404, { errorCode: '404.001.01', errorMessage: 'Resource not found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    ...stub,
    get pushBehaviours() {
      return stub.pushBehaviours;
    },
    set pushBehaviours(value) {
      stub.pushBehaviours = value;
    },
    get b2cBehaviours() {
      return stub.b2cBehaviours;
    },
    set b2cBehaviours(value) {
      stub.b2cBehaviours = value;
    },
    get tokenRequests() {
      return stub.tokenRequests;
    },
    set tokenRequests(value) {
      stub.tokenRequests = value;
    },
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
