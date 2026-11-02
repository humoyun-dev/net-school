import { remoteSessionSchema, remoteTicketSchema } from '@netschool/contracts';
import {
  RemoteSessionController,
  type RenewTimer,
  type ViewerApi,
  ViewerApiError,
  type ViewerMode,
  type ViewerState,
  workerRenewTimer,
} from '@netschool/remote-viewer';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { type Api, ApiFailure } from '../api/client.ts';
import { useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';

// apps/web Api → viewer paketi interfeysi; HTTP xatolari ViewerApiError bo'ladi.
export function viewerApi(api: Api): ViewerApi {
  const wrap = async <T,>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      if (err instanceof ApiFailure) throw new ViewerApiError(err.status, err.code);
      throw err;
    }
  };
  return {
    openSession: (lessonId, deviceId, mode, key) =>
      wrap(
        api.send('POST', `/api/v1/lessons/${lessonId}/remote-sessions`, { deviceId, mode }, remoteSessionSchema, {
          idempotencyKey: key,
        }),
      ),
    ticket: (sessionId) =>
      wrap(api.send('POST', `/api/v1/remote-sessions/${sessionId}/ticket`, undefined, remoteTicketSchema)),
    renew: (sessionId, fencing) =>
      wrap(
        api.send(
          'POST',
          `/api/v1/remote-sessions/${sessionId}/renew`,
          fencing === undefined ? {} : { fencing },
          remoteSessionSchema,
        ),
      ),
    close: async (sessionId) => {
      await wrap(api.send('DELETE', `/api/v1/remote-sessions/${sessionId}`, undefined, null, { keepalive: true }));
    },
  };
}

const defaultTimer = (): RenewTimer =>
  workerRenewTimer(() => new Worker(new URL('./renew.worker.ts', import.meta.url), { type: 'module' }));

export function RemotePanel(props: {
  lessonId: string;
  deviceId: string;
  label: string;
  mode: ViewerMode;
  onClose: () => void;
  timer?: () => RenewTimer;
}) {
  const api = useApi();
  const t = useT();
  const [state, setState] = useState<ViewerState>({ kind: 'opening' });
  const makeTimer = props.timer ?? defaultTimer;
  // Har mount o'z controller'i (StrictMode'da ikki marta mount bo'lsa ham birinchisi to'liq yopiladi).
  useEffect(() => {
    const controller = new RemoteSessionController({
      api: viewerApi(api),
      timer: makeTimer(),
      idempotencyKey: () => crypto.randomUUID(),
    });
    const off = controller.subscribe(setState);
    void controller.open(props.lessonId, props.deviceId, props.mode);
    // Sahifadan chiqilganda ham sessiya yopiladi (keepalive DELETE).
    const onHide = () => void controller.close();
    addEventListener('pagehide', onHide);
    return () => {
      off();
      removeEventListener('pagehide', onHide);
      void controller.close();
    };
  }, [api, makeTimer, props.lessonId, props.deviceId, props.mode]);

  return (
    <div className="remote-backdrop" role="dialog" aria-label={t('remote.title', { name: props.label })}>
      <section className="remote-panel">
        <header>
          <strong>{t('remote.title', { name: props.label })}</strong>
          <span className="mode">{t(props.mode === 'control' ? 'remote.control' : 'remote.view')}</span>
          <span className="spacer" />
          <button type="button" className="secondary" onClick={props.onClose}>
            {t('remote.close')}
          </button>
        </header>
        {state.kind === 'opening' && <p className="notice">{t('remote.opening')}</p>}
        {state.kind === 'closed' && (
          <p className="error" role="alert">
            {t(`remote.closed.${state.reason}` as StringKey)}
          </p>
        )}
        {state.kind === 'open' && (
          <iframe
            title={props.label}
            src={state.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
            allow="clipboard-read; clipboard-write; fullscreen"
            referrerPolicy="no-referrer"
          />
        )}
      </section>
    </div>
  );
}

// Sinf sahifasi uchun: plitka tugmalari va bitta ochiq panel.
export function useRemoteViewer(timer?: () => RenewTimer): {
  actions: (deviceId: string, lessonId: string, label: string) => ReactNode;
  panel: ReactNode;
} {
  const t = useT();
  const [open, setOpen] = useState<{ deviceId: string; lessonId: string; label: string; mode: ViewerMode } | null>(
    null,
  );
  const close = useCallback(() => setOpen(null), []);
  return {
    actions: (deviceId, lessonId, label) => (
      <div className="tile-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => setOpen({ deviceId, lessonId, label, mode: 'view' })}
        >
          {t('remote.view')}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setOpen({ deviceId, lessonId, label, mode: 'control' })}
        >
          {t('remote.control')}
        </button>
      </div>
    ),
    panel: open ? <RemotePanel key={`${open.deviceId}-${open.mode}`} {...open} onClose={close} timer={timer} /> : null,
  };
}
