import type { ReactNode } from 'react';
import { cn } from './cn.ts';

// System Settings bo'limi: kichik sarlavha + oq guruh qutisi.
export function Section(props: { title?: ReactNode; children: ReactNode; className?: string; footer?: ReactNode }) {
  return (
    <section className={cn('flex flex-col gap-1.5', props.className)}>
      {props.title && <h2 className="px-3.5 text-[12px] font-semibold text-muted-foreground">{props.title}</h2>}
      <div className="group-box">{props.children}</div>
      {props.footer && <div className="px-3.5 text-[11px] text-muted-foreground">{props.footer}</div>}
    </section>
  );
}

// Guruh qatori: radio/checkbox va yorliq bitta <label> ichida.
export function ChoiceRow(props: { children: ReactNode; control: ReactNode; trailing?: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: boshqaruv elementi children/props orqali keladi
    <label className="group-row cursor-default hover:bg-hover/60">
      {props.control}
      <span className="flex-1 text-[13px]">{props.children}</span>
      {props.trailing}
    </label>
  );
}
