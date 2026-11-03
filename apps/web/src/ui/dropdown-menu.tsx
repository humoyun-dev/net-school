import * as Menu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from './cn.ts';

// shadcn DropdownMenu, macOS kontekst menyusi ko'rinishida (xira-shaffof, ko'k hover).
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

// container: menyu shu element ichida chiziladi (masalan to'liq ekrandagi oyna — body'ga chizilsa ko'rinmaydi).
export function DropdownMenuContent({
  className,
  sideOffset = 6,
  container,
  ...props
}: ComponentProps<typeof Menu.Content> & { container?: HTMLElement | null }) {
  return (
    <Menu.Portal container={container}>
      <Menu.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-48 rounded-[8px] bg-card/95 p-1 text-[13px] shadow-window backdrop-blur-xl data-[state=open]:animate-in data-[state=open]:fade-in-0',
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}

const itemClass =
  'flex cursor-default select-none items-center gap-2 rounded-[5px] px-2 py-1 outline-none data-[highlighted]:bg-primary data-[highlighted]:text-primary-foreground [&_svg]:size-[14px]';

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn(itemClass, className)} {...props} />;
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof Menu.RadioItem>) {
  return (
    <Menu.RadioItem className={cn(itemClass, 'pl-6 relative', className)} {...props}>
      <Menu.ItemIndicator className="absolute left-2">✓</Menu.ItemIndicator>
      {children}
    </Menu.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
  return (
    <Menu.Label
      className={cn('px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground', className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('mx-1 my-1 h-px bg-separator', className)} {...props} />;
}
