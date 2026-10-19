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
  'security.title': 'PIN and phone number',
  'security.phone': 'Phone number',
  'security.phone_set': 'Your phone number is saved. Changing it is done on the web app.',
  'security.phone_label': 'Phone number in international format, such as +254712345678',
  'security.phone_save': 'Save phone number',
  'security.phone_saved': 'Phone number saved.',
  'security.pin': 'Transaction PIN',
  'security.pin_help':
    'Six digits, not a repeated digit or a simple sequence. Setting it needs a recent sign-in: if asked, sign out and in again first.',
  'security.pin_label': 'New PIN',
  'security.pin_save': 'Set PIN',
  'security.pin_saved': 'PIN set.',
});
