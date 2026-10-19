import { Card, Muted } from './components';
import { t } from './messages';
import { useServices } from './services';

/** Points to the web app for a set-up task that is not on mobile (phase-9 P9-10). */
export function WebOnly({ what }: { what: string }): React.JSX.Element {
  const { webUrl } = useServices();
  return (
    <Card>
      <Muted>{what}</Muted>
      <Muted>{t('web.only', { url: webUrl })}</Muted>
    </Card>
  );
}
