import { useLocalSearchParams } from 'expo-router';
import { KeloScreen } from '../../../src/screens/kelo';

export default function Kelo(): React.JSX.Element {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  return <KeloScreen workspaceId={workspaceId} />;
}
