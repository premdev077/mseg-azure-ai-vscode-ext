import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keeps a scroll container pinned to the bottom while content streams in,
 * unless the user has scrolled up to read.
 *
 * Moving the viewport under someone who is reading is hostile, so the pin
 * releases as soon as they scroll away and re-engages when they come back.
 */
export function useStickyScroll<T extends HTMLElement>(
  dependency: unknown
): RefObject<T> {
  const ref = useRef<T>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const onScroll = (): void => {
      pinned.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (element && pinned.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [dependency]);

  return ref;
}
