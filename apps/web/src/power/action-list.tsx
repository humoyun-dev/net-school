import { type PowerAction, powerActionSchema } from '@netschool/contracts';
import { ChevronRight, Moon, Power, RotateCcw, Sunrise } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { useT } from '../i18n/i18n.tsx';
import { Notice } from '../layout/toolbar.tsx';
import { Badge } from '../ui/badge.tsx';
import { ACTION_TONE } from './tones.ts';

const listSchema = z.object({ actions: z.array(powerActionSchema) });
const REFRESH_MS = 5_000;

// Yangi amaldan keyin ota-komponent `key` bilan qayta mount qiladi (ro'yxat darhol yangilanadi).
export function ActionList(props: { onOpen: (id: string) => void }) {
  const api = useApi();
  const t = useT();
  const [actions, setActions] = useState<PowerAction[] | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        setActions((await api.get('/api/v1/power-actions?limit=50', listSchema, abort.signal)).actions);
      } catch {
        // keyingi so'rovda qayta urinadi
      }
      if (!abort.signal.aborted) timer = setTimeout(load, REFRESH_MS);
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api]);
  if (!actions) return <Notice>{t('common.loading')}</Notice>;
  if (actions.length === 0)
    return (
      <div className="group-box">
        <Notice>{t('power.actions.empty')}</Notice>
      </div>
    );
  return (
    <ul className="action-list group-box overflow-hidden">
      {actions.map((a) => {
        const Icon = TYPE_ICON[a.type];
        return (
          <li key={a.id} className="group-row p-0">
            <button
              type="button"
              className="row-button flex min-h-12 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2 text-left hover:bg-hover"
              onClick={() => props.onOpen(a.id)}
            >
              <span className="grid size-7 place-items-center rounded-[7px] bg-primary/12 text-primary">
                <Icon className="size-4" />
              </span>
              <span className="flex min-w-[140px] flex-1 flex-col">
                <strong className="text-[13px] font-medium">{t(`power.type.${a.type}`)}</strong>
                <span className="tabular text-[11px] text-muted-foreground">{new Date(a.runAt).toLocaleString()}</span>
              </span>
              <span className="tabular flex gap-1">
                <Badge tone="success">
                  {t('power.target.succeeded')}: {a.summary.succeeded ?? 0}
                </Badge>
                {(a.summary.failed ?? 0) > 0 && (
                  <Badge tone="danger">
                    {t('power.target.failed')}: {a.summary.failed}
                  </Badge>
                )}
                {(a.summary.unknown ?? 0) > 0 && (
                  <Badge tone="warning">
                    {t('power.target.unknown')}: {a.summary.unknown}
                  </Badge>
                )}
              </span>
              <Badge tone={ACTION_TONE[a.status]}>{t(`power.status.${a.status}`)}</Badge>
              <ChevronRight aria-hidden className="size-4 text-muted-foreground/70" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export const TYPE_ICON = { shutdown: Power, reboot: RotateCcw, sleep: Moon, wake: Sunrise } as const;
