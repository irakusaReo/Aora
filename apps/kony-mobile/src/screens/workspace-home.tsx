import type { Me, Workspace } from '@aora/api-client';
import {
  Body,
  Card,
  ListItem,
  Muted,
  ResourceView,
  Screen,
  useResource,
  WebOnly,
} from '@aora/mobile';
import { t } from '../messages';

/** The workspace menu. Hiding an entry is presentation; the API enforces every role (ADR 0016 rule 8). */
export function WorkspaceHomeScreen({
  workspaceId,
  go,
}: {
  workspaceId: string;
  go: (path: string) => void;
}): React.JSX.Element {
  const me = useResource('me', (api) => api.get<Me>('/v1/me'));
  const workspace = useResource(
    `workspace:${workspaceId}`,
    (api) => api.get<Workspace>('/v1/workspace'),
    workspaceId,
  );
  const base = `/w/${workspaceId}`;
  const role =
    me.status === 'ready'
      ? me.data.memberships.find((entry) => entry.workspace_id === workspaceId)?.role
      : undefined;
  return (
    <Screen title={workspace.status === 'ready' ? workspace.data.name : t('app.name')}>
      <ResourceView resource={workspace}>
        {(data) => (
          <>
            {role ? <Muted>{t('workspaces.role', { role })}</Muted> : null}
            {data.restrictions.map((restriction) => (
              <Card key={restriction}>
                <Body strong>
                  {t('home.restricted', { restriction: t(`restriction.${restriction}`) })}
                </Body>
              </Card>
            ))}
            <ListItem
              title={t('home.collect')}
              onPress={() => {
                go(`${base}/collect`);
              }}
            />
            <ListItem
              title={t('home.collections')}
              onPress={() => {
                go(`${base}/collections`);
              }}
            />
            {role !== undefined && role !== 'cashier' && (
              <>
                <ListItem
                  title={t('home.money')}
                  onPress={() => {
                    go(`${base}/money`);
                  }}
                />
                <ListItem
                  title={t('home.payouts')}
                  onPress={() => {
                    go(`${base}/payouts`);
                  }}
                />
                <ListItem
                  title={t('home.treasury')}
                  onPress={() => {
                    go(`${base}/treasury`);
                  }}
                />
              </>
            )}
            <WebOnly what={t('home.web_only')} />
          </>
        )}
      </ResourceView>
    </Screen>
  );
}
