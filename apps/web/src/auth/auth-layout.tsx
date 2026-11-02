import type { FormEvent, ReactNode } from 'react';
import { useT } from '../i18n/i18n.tsx';
import { AppIcon } from '../ui/app-icon.tsx';

// Login va parol sahifalari: macOS kirish oynasi — ikonka, sarlavha, bitta guruhlangan forma.
export function AuthLayout(props: {
  title: string;
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const t = useT();
  return (
    <main className="grid min-h-dvh place-items-center bg-window px-4">
      <form onSubmit={props.onSubmit} className="flex w-full max-w-[340px] flex-col items-center">
        <AppIcon className="size-16 rounded-[15px] [&_svg]:size-9" />
        <h1 className="mt-4 font-display text-[22px] font-semibold">{props.title}</h1>
        <p className="mt-1 text-center text-[13px] text-muted-foreground">{t('login.subtitle')}</p>
        <div className="group-box mt-6 w-full">{props.children}</div>
        <div className="mt-4 flex w-full flex-col gap-3">{props.footer}</div>
      </form>
    </main>
  );
}

// Guruh ichidagi qator: chapda yorliq, o'ngda maydon (macOS forma uslubi). <label> o'rab oladi.
export function AuthField(props: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: boshqaruv elementi children/props orqali keladi
    <label className="group-row">
      <span className="w-[38%] shrink-0 text-[13px] text-foreground">{props.label}</span>
      {props.children}
    </label>
  );
}

export const authInputClass =
  'h-7 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground';
