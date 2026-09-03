import { useEffect } from 'react';
import type { Shortcut } from '../constants/shortcuts';

/**
 * Binds a global shortcut for the lifetime of the component.
 *
 * Centralised so shortcuts are declared in one place and can be checked
 * against VS Code's own bindings rather than discovered by collision.
 */
export function useKeyboardShortcut(
  shortcut: Shortcut,
  handler: () => void,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const modifier = shortcut.mod ? event.ctrlKey || event.metaKey : true;
      const shift = shortcut.shift ? event.shiftKey : !event.shiftKey;
      if (modifier && shift && event.key.toLowerCase() === shortcut.key) {
        event.preventDefault();
        handler();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcut, handler, enabled]);
}
