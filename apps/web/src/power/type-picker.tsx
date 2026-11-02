import type { PowerActionType } from '@netschool/contracts';
import { Moon, Power, RotateCcw, Sunrise } from 'lucide-react';
import { useT } from '../i18n/i18n.tsx';
import { cn } from '../ui/cn.ts';

const TYPES: { type: PowerActionType; icon: typeof Power }[] = [
  { type: 'shutdown', icon: Power },
  { type: 'reboot', icon: RotateCcw },
  { type: 'sleep', icon: Moon },
  { type: 'wake', icon: Sunrise },
];

// Amal turi: to'rtta ikonali tugma (radio guruh).
export function TypePicker(props: { value: PowerActionType; onChange: (t: PowerActionType) => void }) {
  const t = useT();
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 px-3.5 text-[12px] font-semibold text-muted-foreground">{t('power.type')}</legend>
      <div className="grid grid-cols-4 gap-2">
        {TYPES.map(({ type, icon: Icon }) => {
          const active = props.value === type;
          return (
            <label
              key={type}
              className={cn(
                'group-box flex cursor-default flex-col items-center gap-1.5 px-2 py-3 text-center text-[12px] font-medium has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-primary/45',
                active && 'bg-primary text-primary-foreground shadow-control',
              )}
            >
              <input
                type="radio"
                name="power-type"
                className="sr-only"
                checked={active}
                onChange={() => props.onChange(type)}
              />
              <Icon className={cn('size-5', !active && 'text-primary')} />
              {t(`power.type.${type}`)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
