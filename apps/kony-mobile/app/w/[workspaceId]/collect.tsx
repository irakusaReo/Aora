import { useLocalSearchParams, useRouter } from 'expo-router';
import { CollectScreen } from '../../../src/screens/collect';

export default function Collect(): React.JSX.Element {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  const router = useRouter();
  return (
    <CollectScreen
      workspaceId={workspaceId}
      go={(path) => {
        router.replace(path);
      }}
    />
  );
}
