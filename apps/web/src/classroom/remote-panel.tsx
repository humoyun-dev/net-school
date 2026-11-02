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
import { Eye, LoaderCircle, MousePointer2, X as XIcon } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useApi } from '../api/api-context.tsx';
import { type Api, ApiFailure } from '../api/client.ts';
import { useT } from '../i18n/i18n.tsx';
import type { StringKey } from '../i18n/strings.ts';
import { Badge } from '../ui/badge.tsx';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog.tsx';
import { TileActions, TileButton } from './device-tile.tsx';

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

  const title = t('remote.title', { name: props.label });
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="remote-panel flex h-[min(90vh,940px)] w-[min(96vw,1480px)] flex-col overflow-hidden p-0"
        overlayClassName="bg-black/45 backdrop-blur-[2px]"
      >
        <header className="relative flex h-10 shrink-0 items-center gap-2 border-b-[0.5px] border-separator bg-window px-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={t('remote.close')}
              onClick={props.onClose}
              className="group/close grid size-3 place-items-center rounded-full bg-[#ff5f57] ring-[0.5px] ring-black/15"
            >
              <XIcon className="size-2 text-black/60 opacity-0 group-hover/close:opacity-100" strokeWidth={3} />
            </button>
            <span aria-hidden className="size-3 rounded-full bg-black/10 dark:bg-white/15" />
            <span aria-hidden className="size-3 rounded-full bg-black/10 dark:bg-white/15" />
          </div>
          <div className="pointer-events-none absolute inset-x-0 flex items-center justify-center gap-2">
            <DialogTitle className="text-[13px]">{title}</DialogTitle>
            <Badge tone={props.mode === 'control' ? 'warning' : 'info'} className="mode">
              {props.mode === 'control' ? <MousePointer2 className="size-3" /> : <Eye className="size-3" />}
              {t(props.mode === 'control' ? 'remote.control' : 'remote.view')}
            </Badge>
          </div>
          {state.kind === 'open' && (
            <span className="ml-auto hidden max-w-[40%] truncate text-[11px] text-muted-foreground lg:block">
              {t('remote.connectHint')}
            </span>
          )}
        </header>
        <div className="relative flex flex-1 bg-black">
          {state.kind === 'opening' && (
            <p className="m-auto flex items-center gap-2 text-[13px] text-white/70">
              <LoaderCircle className="size-4 animate-spin" />
              {t('remote.opening')}
            </p>
          )}
          {state.kind === 'closed' && (
            <p className="m-auto text-center text-[13px] text-white/85" role="alert">
              {t(`remote.closed.${state.reason}` as StringKey)}
            </p>
          )}
          {state.kind === 'open' && (
            <iframe
              title={props.label}
              src={state.url}
              className="size-full flex-1 border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
              allow="clipboard-read; clipboard-write; fullscreen"
              referrerPolicy="no-referrer"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
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
      <TileActions>
        <TileButton
          icon={<Eye />}
          label={t('remote.view')}
          onClick={() => setOpen({ deviceId, lessonId, label, mode: 'view' })}
        />
        <TileButton
          icon={<MousePointer2 />}
          label={t('remote.control')}
          onClick={() => setOpen({ deviceId, lessonId, label, mode: 'control' })}
        />
      </TileActions>
    ),
    panel: open ? <RemotePanel key={`${open.deviceId}-${open.mode}`} {...open} onClose={close} timer={timer} /> : null,
  };
}
