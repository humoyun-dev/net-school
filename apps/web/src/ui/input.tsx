import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

// macOS matn maydoni: ingichka chegara, fokusda ko'k halqa.
export const inputClass =
  'h-7 w-full min-w-0 rounded-[var(--radius-control)] bg-control px-2 text-[13px] text-foreground shadow-control ring-[0.5px] ring-control-border outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-primary/45 disabled:opacity-50';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(inputClass, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(inputClass, 'w-auto pr-6', className)} {...props} />;
}

// Yorliq maydonni o'rab oladi (getByLabelText ishlashi uchun aynan <label>).
export function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: boshqaruv elementi children/props orqali keladi
    <label className={cn('flex flex-col gap-1', className)}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
