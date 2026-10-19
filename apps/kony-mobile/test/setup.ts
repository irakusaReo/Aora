import { clearResourceCache } from '@aora/mobile';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
  clearResourceCache();
});
