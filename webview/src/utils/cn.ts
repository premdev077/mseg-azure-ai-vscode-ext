import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names, letting later ones win.
 *
 * `tailwind-merge` is what makes a `className` prop able to override a
 * component's own utilities — without it `px-2` from a caller loses to the
 * component's `px-3` depending on stylesheet order rather than intent.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
