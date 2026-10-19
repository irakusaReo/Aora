import { useRouter } from 'expo-router';
import { PayScreen } from '../src/screens/pay';

export default function Pay(): React.JSX.Element {
  const router = useRouter();
  return (
    <PayScreen
      go={(path) => {
        router.replace(path);
      }}
    />
  );
}
