'use client';

import type { ComponentProps } from 'react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button';

/**
 * Actiegroep in dezelfde taal als SegmentedControl: lichtgrijze rand, grijzer
 * vlak. Geen selectie, dus geen schuivend blok, wel dezelfde hoogte en plaat.
 */
export function QuietToolbar({
  children,
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      role="toolbar"
      className={cn(
        'flex h-8 items-center gap-0.5 rounded-lg bg-black/[0.05] p-1 ring-1 ring-black/[0.04]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function ToolbarButton({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      className={cn(
        'h-full rounded-md px-2.5 text-xs text-muted-foreground hover:bg-white hover:text-foreground',
        className
      )}
      {...props}
    />
  );
}

export function ToolbarRule() {
  return <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-black/10" />;
}
