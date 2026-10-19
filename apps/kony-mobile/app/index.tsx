import { useRouter } from 'expo-router';
import { WorkspacesScreen } from '../src/screens/workspaces';

export default function Index(): React.JSX.Element {
  const router = useRouter();
  return (
    <WorkspacesScreen
      go={(path) => {
        router.push(path);
      }}
    />
  );
}
