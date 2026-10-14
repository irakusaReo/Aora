'use client';

import { useActionState } from 'react';
import { createKey, type KeyState } from './actions';

const INITIAL: KeyState = { key: null, error: null };

export function CreateKeyForm({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [state, action, pending] = useActionState(createKey, INITIAL);
  return (
    <>
      {state.error && <p className="error">{state.error}</p>}
      {state.key && (
        <div className="card">
          <strong>Copy this key now. It will not be shown again.</strong>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{state.key}</pre>
        </div>
      )}
      <form action={action} className="stack">
        <input type="hidden" name="workspace_id" value={workspaceId} />
        <label>
          Name
          <input name="name" required maxLength={60} />
        </label>
        <label>
          Scope
          <select name="scope" defaultValue="collect">
            <option value="collect">Collect: create and read collections</option>
            <option value="full">Full: also read balances, payouts and settlements</option>
          </select>
        </label>
        <button type="submit" disabled={pending}>
          Create key
        </button>
      </form>
    </>
  );
}
