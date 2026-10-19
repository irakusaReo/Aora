import { useLocalSearchParams, useRouter } from 'expo-router';
import { WorkspaceHomeScreen } from '../../../src/screens/workspace-home';

export default function WorkspaceHome(): React.JSX.Element {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const router = useRouter();
  return (
    <WorkspaceHomeScreen
      workspaceId={workspaceId}
      go={(path) => {
        router.push(path);
      }}
    />
  );
}
