import { useLocalSearchParams, useRouter } from 'expo-router';
import { DecisionScreen } from '../../src/screens/decision';

export default function Decision(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return (
    <DecisionScreen
      decisionId={id}
      go={(path) => {
        router.replace(path);
      }}
    />
  );
}
