import type { Device } from '@netschool/contracts';
import { Hand, MonitorOff } from 'lucide-react';
import { useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';
import { Button } from '../ui/button.tsx';
import { cn } from '../ui/cn.ts';

export interface TileResult {
  type: 'message.show' | 'overlay.lock' | 'overlay.unlock';
  status: string;
}

const PRESENCE_DOT: Record<Device['companion']['presence'], string> = {
  online: 'bg-success',
  stale: 'bg-warning',
  never: 'bg-stage-muted/60',
};

const RESULT_TONE: Record<string, string> = {
  succeeded: 'text-success',
  failed: 'text-destructive',
  expired: 'text-destructive',
  cancelled: 'text-stage-muted',
};

// Mission Control oynasi: katta ekran rasmi, ostida nom va holat. Yordam — to'q sariq halqa, tanlov — ko'k halqa.
export function DeviceTile(props: {
  device: Device;
  frameUrl: string | null;
  help: { id: string } | null;
  result: TileResult | null;
  selected: boolean;
  canCommand: boolean;
  onToggle: () => void;
  onClearHelp: (helpId: string) => void;
  actions?: React.ReactNode;
}) {
  const t = useT();
  const { device, help, result } = props;
  return (
    <article
      className={cn(
        'tile group/tile flex min-w-0 flex-col gap-2',
        help && 'tile-help',
        props.selected && 'tile-selected',
      )}
    >
      <div
        className={cn(
          'relative aspect-video overflow-hidden rounded-[8px] bg-stage-raised ring-1 ring-white/8 transition-shadow',
          props.selected && 'ring-[3px] ring-primary',
          help && 'ring-[3px] ring-warning',
        )}
      >
        {props.frameUrl ? (
          <img src={props.frameUrl} alt={device.hostname} className="size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center text-stage-muted">
            <div className="flex flex-col items-center gap-1.5">
              <MonitorOff className="size-6 opacity-70" />
              <span className="text-[12px]">{t('tile.noFrame')}</span>
            </div>
          </div>
        )}
        {props.canCommand && (
          <label
            className={cn(
              'absolute top-2 left-2 grid size-6 place-items-center rounded-[6px] bg-black/45 backdrop-blur transition-opacity',
              !props.selected &&
                'opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100',
            )}
          >
            <input
              type="checkbox"
              aria-label={t('grid.select', { name: device.hostname })}
              checked={props.selected}
              onChange={props.onToggle}
            />
          </label>
        )}
        {help && (
          <div className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-[8px] bg-warning px-2.5 py-1.5 text-[12px] font-semibold text-black/85 shadow-control">
            <Hand className="size-4" />
            <span className="flex-1">{t('help.raised')}</span>
            {props.canCommand && (
              <button
                type="button"
                className="rounded-[5px] bg-black/12 px-2 py-0.5 text-[11px] hover:bg-black/20"
                onClick={() => props.onClearHelp(help.id)}
              >
                {t('help.clear')}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-start gap-2 px-0.5">
        <span
          className={cn('mt-[5px] size-2 shrink-0 rounded-full', PRESENCE_DOT[device.companion.presence])}
          title={t(`presence.${device.companion.presence}`)}
        />
        <div className="min-w-0 flex-1">
          <strong className="block truncate text-[13px] font-semibold text-stage-foreground">{device.hostname}</strong>
          <ul className="badges flex flex-wrap gap-x-2 text-[11px] text-stage-muted">
            <li className="sr-only">{t(`presence.${device.companion.presence}`)}</li>
            <li>{t(`agent.${device.agent}`)}</li>
          </ul>
          {result && (
            <p className={cn('result text-[11px]', RESULT_TONE[result.status] ?? 'text-stage-muted')}>
              {t(`cmd.type.${result.type}` as StringKey)}: {t(`target.${result.status}` as StringKey)}
            </p>
          )}
        </div>
      </div>
      {props.actions}
    </article>
  );
}

// Plitka ostidagi kichik tugmalar (Ko'rish / Boshqarish).
export function TileActions(props: { children: React.ReactNode }) {
  return (
    <div className="tile-actions flex gap-1.5 px-0.5 opacity-80 transition-opacity group-hover/tile:opacity-100 focus-within:opacity-100">
      {props.children}
    </div>
  );
}

export function TileButton(props: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={props.onClick}
      className="bg-white/8 text-stage-foreground ring-[0.5px] ring-white/10 hover:bg-white/16"
    >
      {props.icon}
      {props.label}
    </Button>
  );
}
