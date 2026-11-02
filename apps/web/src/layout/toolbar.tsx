import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';

// macOS "unified toolbar": sarlavha chapda, amallar o'ngda; kontent ustida yopishib turadi.
export function Toolbar(props: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-2 border-b-[0.5px] border-separator bg-window/85 px-5 py-2 backdrop-blur-xl',
        props.className,
      )}
    >
      {props.leading}
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate font-display text-[15px] leading-tight font-semibold">{props.title}</h1>
        {props.subtitle && <div className="truncate text-[12px] text-muted-foreground">{props.subtitle}</div>}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">{props.children}</div>
    </header>
  );
}

// Bo'sh holat va yuklanish uchun markaziy matn.
export function Notice(props: { children: ReactNode; tone?: 'muted' | 'error'; className?: string }) {
  return (
    <p
      role={props.tone === 'error' ? 'alert' : undefined}
      className={cn(
        'px-5 py-10 text-center text-[13px]',
        props.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
        props.className,
      )}
    >
      {props.children}
    </p>
  );
}
