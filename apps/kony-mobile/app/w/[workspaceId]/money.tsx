import { useLocalSearchParams } from 'expo-router';
import { MoneyScreen } from '../../../src/screens/money';

export default function Money(): React.JSX.Element {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  return <MoneyScreen workspaceId={workspaceId} />;
}
