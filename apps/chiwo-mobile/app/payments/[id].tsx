import { useLocalSearchParams } from 'expo-router';
import { PaymentScreen } from '../../src/screens/payment';

export default function Payment(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PaymentScreen paymentId={id} />;
}
