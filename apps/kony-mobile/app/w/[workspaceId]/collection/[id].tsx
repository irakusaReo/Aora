import { useLocalSearchParams } from 'expo-router';
import { CollectionScreen } from '../../../../src/screens/collection';

export default function Collection(): React.JSX.Element {
  const { workspaceId, id } = useLocalSearchParams<{ workspaceId: string; id: string }>();
  return <CollectionScreen workspaceId={workspaceId} intentId={id} />;
}
