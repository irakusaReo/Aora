'use client';

import { put } from '@vercel/blob/client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { attachImage, grantUpload } from './actions';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 4 * 1024 * 1024;

/** Uploads one photo straight to the image store, then asks the API to attach it. */
export function ImageUpload({
  workspaceId,
  listingId,
}: {
  workspaceId: string;
  listingId: string;
}): React.JSX.Element {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File): Promise<void> {
    if (!TYPES.includes(file.type)) {
      setStatus('Choose a JPEG, PNG or WebP photo.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setStatus('A photo may be at most 4 MB.');
      return;
    }
    setBusy(true);
    setStatus('Uploading…');
    try {
      const { grant, error } = await grantUpload(workspaceId, listingId, file.type, file.size);
      if (!grant) {
        setStatus(error ?? 'Could not start the upload.');
        return;
      }
      if (grant.provider === 'simulator') {
        setStatus(
          'Image storage is not connected in this environment (sandbox simulator), so photos cannot be uploaded yet.',
        );
        return;
      }
      await put(grant.pathname, file, {
        access: 'public',
        token: grant.token,
        contentType: file.type,
      });
      const attached = await attachImage(workspaceId, listingId, grant.pathname);
      setStatus(attached.error ?? 'Photo added.');
      router.refresh();
    } catch {
      setStatus('The upload did not finish. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <label>
        Add a photo (JPEG, PNG or WebP, up to 4 MB)
        <input
          type="file"
          accept={TYPES.join(',')}
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
      </label>
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
