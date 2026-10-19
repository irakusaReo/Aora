import type { List, Me, MyInvitation, Workspace } from '@aora/api-client';
import {
  Body,
  Button,
  Card,
  Heading,
  ListItem,
  Muted,
  MoneyActionView,
  ResourceView,
  Screen,
  useAction,
  useResource,
  useServices,
} from '@aora/mobile';
import { t } from '../messages';

export function WorkspacesScreen({ go }: { go: (path: string) => void }): React.JSX.Element {
  const me = useResource('me', (api) => api.get<Me>('/v1/me'));
  const invitations = useResource('me.invitations', (api) =>
    api.get<List<MyInvitation>>('/v1/me/invitations'),
  );
  const { signOut } = useServices();
  return (
    <Screen title={t('workspaces.title')}>
      <ResourceView resource={me}>
        {(data) => (
          <>
            {!data.phone_set && (
              <Card>
                <Body strong>{t('workspaces.phone_missing')}</Body>
                <Button
                  label={t('nav.security')}
                  onPress={() => {
                    go('/security');
                  }}
                  secondary
                />
              </Card>
            )}
            {data.memberships.length === 0 ? (
              <Muted>{t('workspaces.none')}</Muted>
            ) : (
              data.memberships.map((membership) => (
                <WorkspaceItem
                  key={membership.workspace_id}
                  workspaceId={membership.workspace_id}
                  role={membership.role}
                  onPress={() => {
                    go(`/w/${membership.workspace_id}`);
                  }}
                />
              ))
            )}
          </>
        )}
      </ResourceView>
      <ResourceView resource={invitations}>
        {(data) =>
          data.data.length > 0 ? (
            <>
              <Heading>{t('invitations.title')}</Heading>
              {data.data.map((invitation) => (
                <InvitationCard
                  key={invitation.id}
                  invitation={invitation}
                  onAccepted={() => {
                    me.reload();
                    invitations.reload();
                  }}
                />
              ))}
            </>
          ) : null
        }
      </ResourceView>
      <Button
        label={t('nav.security')}
        onPress={() => {
          go('/security');
        }}
        secondary
      />
      <Button label={t('nav.sign_out')} onPress={() => void signOut()} secondary />
    </Screen>
  );
}

function WorkspaceItem({
  workspaceId,
  role,
  onPress,
}: {
  workspaceId: string;
  role: string;
  onPress: () => void;
}): React.JSX.Element {
  const workspace = useResource(
    `workspace:${workspaceId}`,
    (api) => api.get<Workspace>('/v1/workspace'),
    workspaceId,
  );
  const name = workspace.status === 'ready' ? workspace.data.name : workspaceId;
  return <ListItem title={name} detail={t('workspaces.role', { role })} onPress={onPress} />;
}

function InvitationCard({
  invitation,
  onAccepted,
}: {
  invitation: MyInvitation;
  onAccepted: () => void;
}): React.JSX.Element {
  const accept = useAction({
    slot: `kony.invitation:${invitation.id}`,
    run: (api) => api.post(`/v1/me/invitations/${invitation.id}/accept`, {}),
    onDone: onAccepted,
  });
  return (
    <Card>
      <Body>
        {t('invitations.item', { workspace: invitation.workspace_name, role: invitation.role })}
      </Body>
      {accept.state === 'done' ? (
        <Muted>{t('invitations.accepted')}</Muted>
      ) : (
        <Button
          label={t('invitations.accept')}
          onPress={accept.start}
          disabled={accept.state === 'working'}
        />
      )}
      <MoneyActionView action={accept} />
    </Card>
  );
}
