'use client';

import type { ReactNode } from 'react';
import { cn } from 'cn';

export interface SegmentOption<T extends string> {
  id: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/**
 * Keuze-schakelaar: lichtgrijze rand, grijzer spoor, wit vlak dat
 * achter de actieve optie schuift. Het contrast van dat vlak is de staat.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
  'aria-label': ariaLabel,
  className
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (id: T) => void;
  disabled?: boolean;
  'aria-label': string;
  className?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value)
  );
  const n = options.length;

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'relative isolate grid h-8 rounded-lg bg-black/[0.05] p-1 ring-1 ring-black/[0.04]',
        className
      )}
      style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-1 left-1 rounded-md bg-white shadow-sm motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out"
        style={{
          width: `calc((100% - 8px) / ${n})`,
          transform: `translateX(${index * 100}%)`
        }}
      />
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled || option.disabled}
            title={option.title}
            className={cn(
              'relative z-10 inline-flex h-full items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-40',
              on ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
