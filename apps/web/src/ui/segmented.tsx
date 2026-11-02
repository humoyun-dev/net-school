import { cn } from './cn.ts';

// macOS segmented control. role="tab" saqlanadi (Power sahifasi testlari va ekran o'quvchilar uchun).
export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={props.label}
      className={cn('inline-flex rounded-[7px] bg-hover p-0.5 ring-[0.5px] ring-control-border', props.className)}
    >
      {props.options.map((o) => {
        const active = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(o.value)}
            className={cn(
              'h-6 rounded-[5px] px-3 text-[12px] font-medium text-foreground/80 transition-colors',
              active && 'bg-card text-foreground shadow-control',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
