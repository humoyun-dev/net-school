import { type PowerAction, powerActionSchema } from '@netschool/contracts';
import { useEffect, useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';

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

  return (
    <section className="card">
      <button type="button" className="link" onClick={props.onBack}>
        {t('power.back')}
      </button>
      {error ? <p className="error">{errorText(error)}</p> : null}
      {action && (
        <>
          <h2>
            {t(`power.type.${action.type}`)} — {t(`power.status.${action.status}`)}
          </h2>
          <p className="muted">{new Date(action.runAt).toLocaleString()}</p>
          <p className="summary">
            {(Object.entries(action.summary) as [string, number][])
              .filter(([, n]) => n > 0)
              .map(([s, n]) => (
                <span key={s} className={`count power-${s}`}>
                  {t(`power.target.${s}` as StringKey)}: {n}
                </span>
              ))}
          </p>
          {(action.status === 'running' || action.status === 'scheduled') && (
            <button type="button" className="secondary" onClick={() => void cancel()}>
              {t('power.cancel')}
            </button>
          )}
          <table className="targets">
            <tbody>
              {(action.targets ?? []).map((target) => (
                <tr key={target.deviceId}>
                  <td>{target.hostname}</td>
                  <td className={`power-${target.status}`}>{t(`power.target.${target.status}` as StringKey)}</td>
                  <td className="muted">
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
        </>
      )}
    </section>
  );
}
