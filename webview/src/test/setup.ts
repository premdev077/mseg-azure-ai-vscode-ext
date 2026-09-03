import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom has no animation frames, and the store batches on one. Running the
 * callback synchronously makes event handling deterministic in tests without
 * changing how it behaves in the webview.
 */
vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  cb(0);
  return 0;
});
vi.stubGlobal('cancelAnimationFrame', () => undefined);

afterEach(() => {
  cleanup();
});
