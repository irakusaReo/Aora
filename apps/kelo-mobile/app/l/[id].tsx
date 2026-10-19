import { useLocalSearchParams, useRouter } from 'expo-router';
import { ListingScreen } from '../../src/screens/listing';

export default function Listing(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return (
    <ListingScreen
      listingId={id}
      go={(path) => {
        router.push(path);
      }}
    />
  );
}
