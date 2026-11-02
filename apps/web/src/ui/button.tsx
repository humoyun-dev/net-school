import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

// macOS tugmalari: asosiy — to'liq ko'k, oddiy — oq "push button", xavfli — qizil, sokin — fonsiz.
export const buttonVariants = cva(
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] font-medium transition-[background-color,box-shadow,opacity] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-[15px] [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-control hover:brightness-105 active:brightness-95',
        secondary:
          'bg-control text-foreground shadow-control ring-[0.5px] ring-control-border hover:bg-hover active:brightness-95',
        destructive: 'bg-destructive text-white shadow-control hover:brightness-105 active:brightness-95',
        ghost: 'text-foreground hover:bg-hover',
        link: 'h-auto px-0 text-primary hover:underline',
      },
      size: {
        default: 'h-7 px-3 text-[13px]',
        sm: 'h-6 px-2.5 text-[12px]',
        lg: 'h-9 px-4 text-[14px]',
        icon: 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
