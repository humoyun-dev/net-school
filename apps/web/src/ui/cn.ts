import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn/ui odatiy yordamchisi: shartli klasslar + Tailwind ziddiyatlarini birlashtirish.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
