import { type PowerAction, powerActionSchema } from '@netschool/contracts';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useApi } from '../api/api-context.tsx';
import { useT } from '../i18n/i18n.tsx';

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
  if (!actions) return <p className="notice">{t('common.loading')}</p>;
  if (actions.length === 0) return <p className="notice">{t('power.actions.empty')}</p>;
  return (
    <ul className="action-list">
      {actions.map((a) => (
        <li key={a.id}>
          <button type="button" className="row-button" onClick={() => props.onOpen(a.id)}>
            <strong>{t(`power.type.${a.type}`)}</strong>
            <span>{t(`power.status.${a.status}`)}</span>
            <span className="muted">{new Date(a.runAt).toLocaleString()}</span>
            <span className="muted">
              {t('power.target.succeeded')}: {a.summary.succeeded ?? 0} · {t('power.target.failed')}:{' '}
              {a.summary.failed ?? 0} · {t('power.target.unknown')}: {a.summary.unknown ?? 0}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
