import { api } from '../../lib/api';
import { t } from '../../lib/messages';

export default async function Purchases(): Promise<React.JSX.Element> {
  // Signed-in only; purchases arrive with layaway (checkpoint 4C).
  await api();
  return (
    <>
      <h1>{t('purchases.title')}</h1>
      <p className="muted">{t('purchases.empty')}</p>
    </>
  );
}
