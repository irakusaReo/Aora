import { useLocalSearchParams } from 'expo-router';
import { TreasuryScreen } from '../../../src/screens/treasury';

export default function Treasury(): React.JSX.Element {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  return <TreasuryScreen workspaceId={workspaceId} />;
}
