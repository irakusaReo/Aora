import { useState } from 'react';
import { Button, Card, ErrorText, Heading, TextField } from './components';
import { t } from './messages';

// The PIN step-up (ADR 0019). The PIN lives in this component's state only
// until it is sent, and is cleared whatever the answer: it is never stored on
// the device (ADR 0016 rule 5).
export function PinPrompt({
  onConfirm,
  onCancel,
}: {
  /** Resolves to null when accepted, or the message to show. */
  onConfirm: (pin: string) => Promise<string | null>;
  onCancel: () => void;
}): React.JSX.Element {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = (): void => {
    const entered = pin;
    setPin('');
    setBusy(true);
    void onConfirm(entered).then((problem) => {
      setBusy(false);
      setError(problem);
    });
  };

  return (
    <Card>
      <Heading>{t('pin.title')}</Heading>
      <TextField
        label={t('pin.label')}
        value={pin}
        onChangeText={(text) => {
          setPin(text.replace(/[^0-9]/g, ''));
        }}
        help={t('pin.help')}
        secure
        numeric
        maxLength={6}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label={t('pin.confirm')} onPress={confirm} disabled={busy || pin.length !== 6} />
      <Button label={t('pin.cancel')} onPress={onCancel} secondary />
    </Card>
  );
}
