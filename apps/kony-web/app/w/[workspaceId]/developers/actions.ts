'use server';

import { api, field, messageOf } from '../../../../lib/api';

export interface KeyState {
  readonly key: string | null;
  readonly error: string | null;
}

/**
 * Creates a key and returns it in the action's own response, to be shown once.
 * Never put in a URL, a cookie or storage.
 */
export async function createKey(_previous: KeyState, form: FormData): Promise<KeyState> {
  try {
    const created = await (
      await api(field(form, 'workspace_id'))
    ).post<{ key: string }>('/v1/api-keys', {
      name: field(form, 'name'),
      scope: field(form, 'scope'),
    });
    return { key: created.key, error: null };
  } catch (error) {
    return { key: null, error: messageOf(error) };
  }
}
