import { cn } from '../../utils/cn';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * A native select.
 *
 * Deliberately not Radix: the platform control already adopts VS Code's
 * styling and keyboard behaviour, renders correctly in every theme, and is
 * the most accessible option available. Radix earns its place for tooltips
 * and collapsibles, which have no accessible native equivalent.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  title,
  className
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  title?: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      title={title}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        'h-6 max-w-32 rounded-sm border border-line bg-field px-1 text-xs text-field-ink',
        className
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} title={option.description}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
