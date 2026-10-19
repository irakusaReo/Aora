import { useRouter } from 'expo-router';
import { PurchasesScreen } from '../src/screens/purchases';

export default function Purchases(): React.JSX.Element {
  const router = useRouter();
  return (
    <PurchasesScreen
      go={(path) => {
        router.push(path);
      }}
    />
  );
}
