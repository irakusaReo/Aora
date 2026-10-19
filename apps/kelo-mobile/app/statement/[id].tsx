import { useLocalSearchParams } from 'expo-router';
import { StatementScreen } from '../../src/screens/statement';

export default function Statement(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <StatementScreen purchaseId={id} />;
}
