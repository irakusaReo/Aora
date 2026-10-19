import { useRouter } from 'expo-router';
import { BrowseScreen } from '../src/screens/browse';

export default function Index(): React.JSX.Element {
  const router = useRouter();
  return (
    <BrowseScreen
      go={(path) => {
        router.push(path);
      }}
    />
  );
}
