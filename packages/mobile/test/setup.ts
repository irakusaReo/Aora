import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { clearResourceCache } from '../src/resource';

afterEach(() => {
  cleanup();
  clearResourceCache();
});
