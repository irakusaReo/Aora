import { useRouter } from 'expo-router';
import { HomeScreen } from '../src/screens/home';

export default function Index(): React.JSX.Element {
  const router = useRouter();
  return (
    <HomeScreen
      go={(path) => {
        router.push(path);
      }}
    />
  );
}
