import { useLocalSearchParams, useRouter } from 'expo-router';
import { CollectionsScreen } from '../../../src/screens/collections';

export default function Collections(): React.JSX.Element {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const router = useRouter();
  return (
    <CollectionsScreen
      workspaceId={workspaceId}
      go={(path) => {
        router.push(path);
      }}
    />
  );
}
