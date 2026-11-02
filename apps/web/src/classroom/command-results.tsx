import type { Command } from '@netschool/contracts';
import { History } from 'lucide-react';
import { useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '../ui/dropdown-menu.tsx';

const SHOWN: Command['targets'][number]['status'][] = [
  'succeeded',
  'failed',
  'pending',
  'sent',
  'acknowledged',
  'expired',
  'cancelled',
];

const TONE: Partial<Record<Command['targets'][number]['status'], 'success' | 'danger' | 'neutral' | 'info'>> = {
  succeeded: 'success',
  failed: 'danger',
  expired: 'danger',
  pending: 'info',
  sent: 'info',
  acknowledged: 'info',
};

// Oxirgi buyruqlar (asboblar satridagi menyu): har holat soni, umumiy "muvaffaqiyat" yo'q.
export function CommandResults(props: { commands: Command[] }) {
  const t = useT();
  const recent = [...props.commands].sort((a, b) => (BigInt(b.sequence) > BigInt(a.sequence) ? 1 : -1)).slice(0, 5);
  if (recent.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">
          <History />
          {t('cmd.results')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>{t('cmd.results')}</DropdownMenuLabel>
        <ul className="results flex flex-col">
          {recent.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-1.5 rounded-[5px] px-2 py-1.5">
              <strong className="mr-auto text-[13px] font-medium">{t(`cmd.type.${c.type}` as StringKey)}</strong>
              {SHOWN.filter((s) => (c.summary[s] ?? 0) > 0).map((s) => (
                <Badge key={s} tone={TONE[s] ?? 'neutral'} className={`count result-${s} tabular`}>
                  {t(`target.${s}` as StringKey)}: {c.summary[s]}
                </Badge>
              ))}
            </li>
          ))}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
