import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

// macOS "help tag": kichik, kechikib chiqadigan izoh.
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    // O'z provider'i bilan: sahifa Shell'siz (testlarda) render qilinsa ham ishlaydi.
    <TooltipPrimitive.Provider delayDuration={500}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-50 rounded-[5px] bg-card px-2 py-1 text-[12px] text-foreground shadow-window data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;
