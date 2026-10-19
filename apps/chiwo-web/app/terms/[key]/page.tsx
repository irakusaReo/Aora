import { notFound } from 'next/navigation';
import { isNotFound, publicApi } from '../../../lib/api';

interface Terms {
  key: string;
  version: string;
  title: string;
  body: string;
  effective_from: string;
}

export default async function TermsPage({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<React.JSX.Element> {
  const { key } = await params;
  let terms: Terms;
  try {
    terms = await publicApi().get<Terms>(`/v1/terms/${encodeURIComponent(key)}`);
  } catch (error) {
    if (isNotFound(error)) notFound();
    throw error;
  }
  return (
    <div className="card">
      <h1>{terms.title}</h1>
      <p className="muted">Version {terms.version}</p>
      <p style={{ whiteSpace: 'pre-wrap' }}>{terms.body}</p>
    </div>
  );
}
