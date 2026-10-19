import { useLocalSearchParams } from 'expo-router';
import { PayoutsScreen } from '../../../src/screens/payouts';

export default function Payouts(): React.JSX.Element {
  const { workspaceId } = useLocalSearchParams<{ workspaceId: string }>();
  return <PayoutsScreen workspaceId={workspaceId} />;
}
