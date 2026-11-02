import { lessonSchema } from '@netschool/contracts';
import { ChevronLeft, Clock, Monitor, Play } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { useApi } from '../api/api-context.tsx';
import { useIntent } from '../api/intent.ts';
import { useMe } from '../auth/session.tsx';
import { useErrorText, useT } from '../i18n/i18n.tsx';
import { Toolbar } from '../layout/toolbar.tsx';
import { useRooms } from '../rooms/use-rooms.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { cn } from '../ui/cn.ts';
import { Field, Input } from '../ui/input.tsx';
import { CommandBar } from './command-bar.tsx';
import { CommandResults } from './command-results.tsx';
import { DeviceTile } from './device-tile.tsx';
import { latestResultFor } from './lesson-state.ts';
import { ThumbnailFeed } from './thumbnail-feed.ts';
import { useRoomDevices } from './use-devices.ts';
import { useLessonEvents } from './use-events.ts';

export type FeedFactory = (
  lessonId: string,
  onFrame: (deviceId: string, url: string) => void,
  accept: (deviceId: string) => boolean,
) => { close(): void };

const defaultFeed: FeedFactory = (lessonId, onFrame, accept) =>
  new ThumbnailFeed(`${location.origin.replace(/^http/, 'ws')}/api/v1/lessons/${lessonId}/thumbnails/stream`, onFrame, {
    accept,
    onUnauthenticated: () => location.assign(`/login?next=${encodeURIComponent(location.pathname)}`),
  });

export function RoomPage(props: {
  createFeed?: FeedFactory;
  renderActions?: (deviceId: string, lessonId: string, hostname: string) => ReactNode;
}) {
  const { roomId = '' } = useParams();
  const roomName = (useLocation().state as { name?: string } | null)?.name;
  const api = useApi();
  const me = useMe();
  const rooms = useRooms();
  const t = useT();
  const errorText = useErrorText();
  const [state, update] = useLessonEvents(roomId);
  const devices = useRoomDevices(roomId);
  const [selected, setSelected] = useState<string[]>([]);
  const [frames, setFrames] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(45);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const lesson = state.lesson?.status === 'active' ? state.lesson : null;
  const members = useMemo(() => new Set(lesson?.deviceIds ?? []), [lesson?.deviceIds]);
  const membersRef = useRef(members);
  membersRef.current = members;
  // Server qoidasi bilan bir xil: dars egasi yoki shu site'ning (yoki butun tashkilotning) school_admin'i.
  const canCommand =
    !!lesson &&
    (lesson.teacherUserId === me.user.id ||
      me.assignments.some((a) => a.role === 'school_admin' && (a.siteId === null || a.siteId === lesson.siteId)));
  const createFeed = props.createFeed ?? defaultFeed;

  const lessonId = lesson?.id ?? null;
  useEffect(() => {
    if (!lessonId || !canCommand) return;
    const feed = createFeed(
      lessonId,
      (deviceId, url) => setFrames((f) => ({ ...f, [deviceId]: url })),
      (deviceId) => membersRef.current.has(deviceId),
    );
    return () => {
      feed.close();
      setFrames({});
    };
  }, [lessonId, canCommand, createFeed]);

  const start = useIntent(async (key) => {
    const body = { ...(title.trim() ? { title: title.trim() } : {}), durationMinutes: duration };
    const started = await api.send('POST', `/api/v1/rooms/${roomId}/lessons`, body, lessonSchema, {
      idempotencyKey: key,
    });
    update((s) => ({ ...s, lesson: started }));
    return started;
  });
  const end = useIntent(async (key) => {
    if (!lesson) return null;
    const ended = await api.send('POST', `/api/v1/lessons/${lesson.id}/end`, undefined, lessonSchema, {
      idempotencyKey: key,
    });
    update((s) => ({ ...s, lesson: ended }));
    setConfirmEnd(false);
    return ended;
  });
  const clearHelp = (helpId: string) =>
    api
      .send('DELETE', `/api/v1/help-requests/${helpId}`, undefined, null)
      .then(() =>
        update((s) => {
          const help = new Map(s.help);
          help.delete(helpId);
          return { ...s, help };
        }),
      )
      .catch(() => {});

  const shown = lesson ? devices.filter((d) => members.has(d.id)) : devices;
  const helpByDevice = new Map([...state.help.values()].map((h) => [h.deviceId, h]));
  const name = roomName ?? rooms.data?.flatMap((s) => s.rooms).find((r) => r.id === roomId)?.name ?? t('room.title');

  return (
    <div className="room flex min-h-full flex-col">
      <Toolbar
        title={name}
        subtitle={lesson ? <span className="lesson-title">{lesson.title}</span> : undefined}
        leading={
          <Button asChild variant="ghost" size="icon" aria-label={t('nav.rooms')}>
            <Link to="/rooms">
              <ChevronLeft />
            </Link>
          </Button>
        }
      >
        {lesson && <Remaining endsAt={lesson.scheduledEndAt} />}
        {lesson && (
          <Badge className="tabular">
            <Monitor className="size-3" />
            {t('grid.count', { n: shown.length })}
          </Badge>
        )}
        {lesson && canCommand && <CommandResults commands={[...state.commands.values()]} />}
        {lesson && canCommand && !confirmEnd && (
          <Button variant="secondary" onClick={() => setConfirmEnd(true)}>
            {t('lesson.end')}
          </Button>
        )}
        {lesson && confirmEnd && (
          <>
            <Button variant="destructive" disabled={end.pending} onClick={() => void end.run()}>
              {t('lesson.endConfirm')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
              {t('common.cancel')}
            </Button>
          </>
        )}
      </Toolbar>

      <div className="flex flex-1 flex-col bg-stage px-5 pt-6 pb-4 text-stage-foreground">
        {!lesson && (
          <form
            className="start-lesson mx-auto mb-8 w-full max-w-[440px] rounded-[var(--radius-window)] bg-card p-5 text-foreground shadow-window"
            onSubmit={(e) => {
              e.preventDefault();
              void start.run();
            }}
          >
            <h2 className="font-display text-[15px] font-semibold">
              {state.lesson?.status === 'ended' ? t('lesson.ended') : t('lesson.none')}
            </h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{t('lesson.startHint')}</p>
            <div className="mt-4 grid grid-cols-[1fr_120px] gap-3">
              <Field label={t('lesson.titleLabel')}>
                <Input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label={t('lesson.duration')}>
                <Input
                  type="number"
                  min={5}
                  max={480}
                  value={duration}
                  className="tabular"
                  onChange={(e) => setDuration(Number(e.target.value))}
                />
              </Field>
            </div>
            {start.error ? (
              <p className="mt-3 text-[12px] text-destructive" role="alert">
                {errorText(start.error)}
              </p>
            ) : null}
            <Button type="submit" size="lg" className="mt-4 w-full" disabled={start.pending}>
              <Play />
              {t('lesson.start')}
            </Button>
          </form>
        )}

        {lesson && !canCommand && (
          <p className="mb-4 text-center text-[13px] text-stage-muted">{t('lesson.otherTeacher')}</p>
        )}
        {end.error ? (
          <p className="mb-4 text-center text-[13px] text-destructive" role="alert">
            {errorText(end.error)}
          </p>
        ) : null}
        {lesson && shown.length === 0 && (
          <p className="py-16 text-center text-[13px] text-stage-muted">{t('grid.empty')}</p>
        )}

        <div
          className={cn(
            'grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-x-5 gap-y-7',
            !lesson && 'opacity-55',
          )}
        >
          {shown.map((d) => {
            const result = latestResultFor(state, d.id);
            return (
              <DeviceTile
                key={d.id}
                device={d}
                frameUrl={frames[d.id] ?? null}
                help={lesson ? (helpByDevice.get(d.id) ?? null) : null}
                result={result ? { type: result.type, status: result.status } : null}
                selected={selected.includes(d.id)}
                canCommand={canCommand}
                onToggle={() => setSelected((s) => (s.includes(d.id) ? s.filter((x) => x !== d.id) : [...s, d.id]))}
                onClearHelp={clearHelp}
                actions={lesson && canCommand ? props.renderActions?.(d.id, lesson.id, d.hostname) : null}
              />
            );
          })}
        </div>

        <div className="flex-1" />
        {lesson && canCommand && (
          <CommandBar lessonId={lesson.id} selected={selected} onClearSelection={() => setSelected([])} />
        )}
      </div>
    </div>
  );
}

// Dars tugashiga qolgan vaqt (har 15 s yangilanadi).
function Remaining(props: { endsAt: string | null }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  if (!props.endsAt) return null;
  const minutes = Math.ceil((Date.parse(props.endsAt) - now) / 60_000);
  return (
    <Badge tone={minutes <= 5 ? 'warning' : 'info'} className="tabular">
      <Clock className="size-3" />
      {minutes > 0 ? t('lesson.remaining', { n: minutes }) : t('lesson.overtime')}
    </Badge>
  );
}
