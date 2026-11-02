import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-hover text-muted-foreground',
        success: 'bg-success/14 text-success',
        warning: 'bg-warning/16 text-warning',
        danger: 'bg-destructive/14 text-destructive',
        info: 'bg-primary/12 text-primary',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

// Holat nuqtasi (sidebar/plitkalardagi kichik doira).
export function StatusDot({
  tone,
  className,
}: {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  className?: string;
}) {
  const color = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-destructive',
    neutral: 'bg-muted-foreground/50',
  }[tone];
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', color, className)} />;
}
