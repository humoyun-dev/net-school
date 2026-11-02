import { type PowerAction, powerActionSchema } from '@netschool/contracts';
import { ChevronLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { TYPE_ICON } from './action-list.tsx';
import { ACTION_TONE, TARGET_TONE } from './tones.ts';

const REFRESH_MS = 2_000;
const live = (a: PowerAction | null) => !a || a.status === 'running' || a.status === 'scheduled';

// Har kompyuter natijasi; ishlayotgan amal 2 s da yangilanadi, tugagach to'xtaydi.
export function ActionDetail(props: { id: string; onBack: () => void }) {
  const api = useApi();
  const t = useT();
  const errorText = useErrorText();
  const [action, setAction] = useState<PowerAction | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Zanjirli so'rov: ishlayotgan/rejalashtirilgan amal 2 s da yangilanadi, tugagach to'xtaydi.
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const a = await api.get(`/api/v1/power-actions/${props.id}`, powerActionSchema, abort.signal);
        setAction(a);
        setError(null);
        if (live(a)) timer = setTimeout(load, REFRESH_MS);
      } catch (err) {
        if (abort.signal.aborted) return;
        setError(err);
        timer = setTimeout(load, REFRESH_MS);
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [api, props.id]);

  async function cancel() {
    try {
      setAction(await api.send('POST', `/api/v1/power-actions/${props.id}/cancel`, undefined, powerActionSchema));
    } catch (err) {
      setError(err);
    }
  }

  const Icon = action ? TYPE_ICON[action.type] : null;
  return (
    <section className="flex flex-col gap-4">
      <Button variant="link" className="self-start" onClick={props.onBack}>
        <ChevronLeft />
        {t('power.back')}
      </Button>
      {error ? (
        <p className="text-[12px] text-destructive" role="alert">
          {errorText(error)}
        </p>
      ) : null}
      {action && (
        <>
          <div className="group-box flex flex-wrap items-center gap-3 p-4">
            {Icon && (
              <span className="grid size-10 place-items-center rounded-[10px] bg-primary/12 text-primary">
                <Icon className="size-5" />
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="font-display text-[17px] font-semibold">
                {t(`power.type.${action.type}`)}{' '}
                <Badge tone={ACTION_TONE[action.status]} className="ml-1 align-middle">
                  {t(`power.status.${action.status}`)}
                </Badge>
              </h2>
              <p className="tabular text-[12px] text-muted-foreground">{new Date(action.runAt).toLocaleString()}</p>
            </div>
            {(action.status === 'running' || action.status === 'scheduled') && (
              <Button variant="secondary" onClick={() => void cancel()}>
                {t('power.cancel')}
              </Button>
            )}
            <p className="summary tabular flex w-full flex-wrap gap-1.5">
              {(Object.entries(action.summary) as [string, number][])
                .filter(([, n]) => n > 0)
                .map(([s, n]) => (
                  <Badge key={s} tone={TARGET_TONE[s] ?? 'neutral'} className={`count power-${s}`}>
                    {t(`power.target.${s}` as StringKey)}: {n}
                  </Badge>
                ))}
            </p>
          </div>
          <div className="group-box overflow-hidden">
            <table className="targets w-full border-collapse text-[13px]">
              <tbody>
                {(action.targets ?? []).map((target) => (
                  <tr key={target.deviceId} className="border-separator [&+&]:border-t-[0.5px]">
                    <td className="px-3.5 py-2 font-medium">{target.hostname}</td>
                    <td className={`px-2 py-2 power-${target.status}`}>
                      <Badge tone={TARGET_TONE[target.status] ?? 'neutral'}>
                        {t(`power.target.${target.status}` as StringKey)}
                      </Badge>
                    </td>
                    <td className="px-3.5 py-2 text-[12px] text-muted-foreground">
                      {target.reason
                        ? t(`power.reason.${target.reason}` as StringKey)
                        : target.status === 'unknown'
                          ? t('power.unknownHint')
                          : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
