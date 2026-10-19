import type { List, PaymentIntent } from '@aora/api-client';
import {
  exponentOf,
  ListItem,
  money,
  Muted,
  ResourceView,
  Screen,
  useAssets,
  useResource,
} from '@aora/mobile';
import { t, statusLabel } from '../messages';

export function CollectionsScreen({
  workspaceId,
  go,
}: {
  workspaceId: string;
  go: (path: string) => void;
}): React.JSX.Element {
  const assets = useAssets();
  const intents = useResource(
    `payment-intents:${workspaceId}`,
    (api) => api.get<List<PaymentIntent>>('/v1/payment-intents', { limit: 50 }),
    workspaceId,
  );
  return (
    <Screen title={t('collections.title')}>
      <ResourceView resource={assets}>
        {(list) => (
          <ResourceView resource={intents}>
            {(data) =>
              data.data.length === 0 ? (
                <Muted>{t('collections.empty')}</Muted>
              ) : (
                data.data.map((intent) => (
                  <ListItem
                    key={intent.id}
                    title={t('collections.item', {
                      amount: money(
                        intent.amount_minor,
                        intent.currency,
                        exponentOf(list, intent.currency),
                      ),
                      status: statusLabel(intent.status),
                    })}
                    detail={[new Date(intent.created_at).toLocaleString('en-KE'), intent.reference]
                      .filter(Boolean)
                      .join(' · ')}
                    onPress={() => {
                      go(`/w/${workspaceId}/collection/${intent.id}`);
                    }}
                  />
                ))
              )
            }
          </ResourceView>
        )}
      </ResourceView>
    </Screen>
  );
}
