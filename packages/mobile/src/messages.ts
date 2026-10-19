import { translator } from './i18n';

// The words the shared pieces use. Each app has its own messages for its screens.
export const t = translator({
  'state.loading': 'Loading…',
  'state.stale': 'Showing what we last saw. It may be out of date.',
  'state.unreachable': 'We could not reach AORA. Check your connection and try again.',
  'state.retry': 'Try again',
  'action.working': 'Sending…',
  'action.unknown':
    'We are checking what happened. Nothing will be sent twice. Check again in a moment.',
  'action.check_again': 'Check again',
  'action.signed_out': 'Your session ended. Sign in again, then check again.',
  'pin.title': 'Confirm with your PIN',
  'pin.label': 'Transaction PIN',
  'pin.help': 'Your six-digit AORA PIN. It is never stored on this phone.',
  'pin.confirm': 'Confirm with PIN',
  'pin.cancel': 'Cancel',
  'pin.wrong': 'That PIN did not work.',
  'web.only': 'This is done on the web app: {url}',
});
